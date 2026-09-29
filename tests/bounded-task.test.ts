import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { BoundedTasks, type Contract, type Verifier, type Worker } from "../src/mcp/bounded-task.js";
import { getStateDir } from "../src/config/paths.js";
import { GatewayError } from "../src/mcp/local-gateway.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(withSecond = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-v2-")); roots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q"); fs.writeFileSync(path.join(repo, "README.md"), "Old text.\nssh delete publish are words.\n");
  if (withSecond) fs.writeFileSync(path.join(repo, "SECOND.md"), "Keep this unchanged.\n");
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const contract: Contract = { repo: "fixture", goal: "Document why ssh delete publish are words, do not execute operations", edit_paths: ["README.md"],
    acceptance_criteria: ["Update tracked text"], task_kind: "text_change", execution_profile: "tracked_utf8_text",
    worker: "opencode", codex: { allowed: false, max_calls: 0 }, max_revisions: 3, timeout_ms: 600000 };
  return { root, repo: fs.realpathSync.native(repo), contract };
}
const mock: Worker = async (_repo, prompt) => {
  const revision = JSON.parse(prompt.slice(prompt.indexOf("Contract: ") + 10)).revision as number;
  return { worker: "opencode", session_id: `ses_mock${revision}`, execution_id: `msg_mock${revision}`,
    provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
    output: JSON.stringify({ edits: [{ path: "README.md", old_text: revision === 1 ? "Old text." : "First draft.",
      new_text: revision === 1 ? "First draft." : "Revised draft." }] }) };
};
function review(task_id: string, revision: number, contract_sha256: string, manifest_sha256: string, verdict: "PASS" | "NEEDS_WORK") {
  return { review_id: `review-${randomUUID()}`, task_id, revision, contract_sha256, manifest_sha256,
    reviewer: "chatgpt" as const, verdict, findings: verdict === "NEEDS_WORK" ? ["Improve draft within scope"] : [] };
}
describe("bounded OpenCode contract and review", () => {
  it("hashes a canonical contract regardless of property insertion order and reloads it from durable state", () => {
    const f = fixture(), store = path.join(f.root, "store");
    const reordered = { ...Object.fromEntries(Object.entries(f.contract).reverse()), codex: { max_calls: 0, allowed: false } } as Contract;
    const first = new BoundedTasks({ fixture: f.repo }, store, mock);
    const started = first.start(reordered);
    const restarted = new BoundedTasks({ fixture: f.repo }, store, mock);
    expect(restarted.status(started.task_id).contract_sha256).toBe(started.contract_sha256);
    const saved = restarted.status(started.task_id).contract;
    expect(saved).toEqual(f.contract);
    expect(started.contract_sha256).toBe(createHash("sha256").update(JSON.stringify(f.contract)).digest("hex"));
    const file = path.join(store, started.task_id, "task.json");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original.toString()), contract: { ...saved, extra: "unbound" } }));
    expect(() => restarted.status(started.task_id)).toThrow("CONTRACT_MISMATCH");
    fs.writeFileSync(file, original);
  });
  it("defaults to the platform state directory, never TEMP or TMP", () => {
    const previous = process.env.C2C_STATE_DIR;
    try {
      delete process.env.C2C_STATE_DIR;
      const state = getStateDir();
      expect(state).not.toBe(os.tmpdir());
      if (process.platform === "win32") expect(state.toLowerCase()).toBe(
        path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "codex-with-chatgpt").toLowerCase());
    } finally {
      if (previous === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previous;
    }
  });
  it("stores default task state outside TEMP and survives a controller restart", () => {
    const f = fixture();
    const state = path.join(f.root, "durable-state");
    const firstTemp = path.join(f.root, "temp-a");
    const secondTemp = path.join(f.root, "temp-b");
    fs.mkdirSync(firstTemp);
    fs.mkdirSync(secondTemp);

    const previousState = process.env.C2C_STATE_DIR;
    const previousTemp = process.env.TEMP;
    const previousTmp = process.env.TMP;

    try {
      process.env.C2C_STATE_DIR = state;
      process.env.TEMP = firstTemp;
      process.env.TMP = firstTemp;

      const first = new BoundedTasks({ fixture: f.repo });
      const started = first.start(f.contract);

      const taskFile = path.join(
        state,
        "bounded-v2",
        "tasks",
        started.task_id,
        "task.json",
      );

      expect(fs.existsSync(taskFile)).toBe(true);
      expect(
        fs.readdirSync(path.join(state, "bounded-v2", "repo-locks")),
      ).toHaveLength(1);

      expect(
        fs.existsSync(path.join(firstTemp, "opencode", "bounded-tasks-v2")),
      ).toBe(false);

      process.env.TEMP = secondTemp;
      process.env.TMP = secondTemp;

      const restarted = new BoundedTasks({ fixture: f.repo });
      expect(restarted.status(started.task_id).state).toBe("RUNNING");
    } finally {
      if (previousState === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousState;

      if (previousTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = previousTemp;

      if (previousTmp === undefined) delete process.env.TMP;
      else process.env.TMP = previousTmp;
    }
  });
  it("keeps one task, immutable contract, versioned evidence, no Codex and accepts only latest review", async () => {
    const f = fixture(), tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), mock);
    const started = tasks.start(f.contract), first = await tasks.execute(started.task_id);
    expect(tasks.status(started.task_id).codex_calls).toBe(0);
    expect(tasks.status(started.task_id).codex_usage).toBeNull();
    expect(tasks.artifacts(started.task_id, 1).worker.worker).toBe("opencode");
    expect(tasks.artifacts(started.task_id, 1).files.map(f => f.name)).toEqual([
      "revision-1-input.json", "revision-1-proposal.json", "revision-1-diff.patch", "revision-1-verification.json",
    ]);
    const page = tasks.readArtifact(started.task_id, 1, "revision-1-diff.patch");
    expect(Buffer.from(page.content_base64, "base64").toString()).toContain("First draft.");
    const feedback = review(started.task_id, 1, started.contract_sha256, first.manifest_sha256, "NEEDS_WORK");
    expect(tasks.submitReview(feedback).next_revision).toBe(2);
    expect(tasks.submitReview(feedback).duplicate).toBe(true);
    const second = await tasks.execute(started.task_id);
    expect(second.revision).toBe(2);
    expect(tasks.artifacts(started.task_id, 2).manifest_sha256).toBe(second.manifest_sha256);
    expect(() => tasks.submitReview(review(started.task_id, 1, started.contract_sha256, first.manifest_sha256, "PASS"))).toThrow();
    expect(() => tasks.submitReview(review("bounded-" + "0".repeat(32), 2, started.contract_sha256, second.manifest_sha256, "PASS"))).toThrow();
    expect(() => tasks.submitReview(review(started.task_id, 2, started.contract_sha256, first.manifest_sha256, "PASS"))).toThrow();
    const pass = review(started.task_id, 2, started.contract_sha256, second.manifest_sha256, "PASS");
    expect(tasks.submitReview(pass).state).toBe("REVIEW_ACCEPTED");
    expect(tasks.submitReview(pass).duplicate).toBe(true);
    expect(tasks.status(started.task_id).revisions.map(r => r.review?.verdict)).toEqual(["NEEDS_WORK", "PASS"]);
    await expect(tasks.execute(started.task_id)).rejects.toThrow();
  });
  it("recovers waiting state after restart and rejects modified reviewed diff", async () => {
    const f = fixture(), store = path.join(f.root, "store"), tasks = new BoundedTasks({ fixture: f.repo }, store, mock);
    const started = tasks.start(f.contract), done = await tasks.execute(started.task_id);
    const restarted = new BoundedTasks({ fixture: f.repo }, store, mock);
    expect(restarted.status(started.task_id).state).toBe("REVIEW_PENDING");
    fs.appendFileSync(path.join(f.repo, "README.md"), "tampered\n");
    expect(() => restarted.submitReview(review(started.task_id, 1, started.contract_sha256, done.manifest_sha256, "PASS"))).toThrow();
  });
  it("rejects corrupted manifest entries and changed artifact bytes", async () => {
    const f = fixture(), store = path.join(f.root, "store"), tasks = new BoundedTasks({ fixture: f.repo }, store, mock);
    const started = tasks.start(f.contract);
    const done = await tasks.execute(started.task_id);
    const proposal = path.join(store, started.task_id, "revision-1-proposal.json");
    const original = fs.readFileSync(proposal);
    fs.appendFileSync(proposal, " ");
    expect(() => tasks.artifacts(started.task_id, 1)).toThrow("MANIFEST_MISMATCH");
    expect(() => tasks.submitReview(review(started.task_id, 1, started.contract_sha256, done.manifest_sha256, "PASS")))
      .toThrow("MANIFEST_MISMATCH");
    fs.writeFileSync(proposal, original);
    const ledger = path.join(store, started.task_id, "task.json");
    const saved = fs.readFileSync(ledger);
    const corrupted = JSON.parse(saved.toString());
    corrupted.revisions[0].files[0].size++;
    fs.writeFileSync(ledger, JSON.stringify(corrupted));
    expect(() => tasks.artifacts(started.task_id, 1)).toThrow("MANIFEST_MISMATCH");
    fs.writeFileSync(ledger, saved);
    expect(tasks.artifacts(started.task_id, 1).manifest_sha256).toBe(done.manifest_sha256);
  });
  it("escalates when fixed verification cannot observe the tracked change", async () => {
    const f = fixture(), tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), mock);
    const started = tasks.start(f.contract);
    execFileSync("git", ["-C", f.repo, "update-index", "--assume-unchanged", "README.md"]);
    try {
      await expect(tasks.execute(started.task_id)).rejects.toThrow("VERIFY_FAILED");
      expect(tasks.status(started.task_id)).toMatchObject({ state: "ESCALATE", stop_reason: "VERIFY_FAILED", revisions: [] });
    } finally {
      execFileSync("git", ["-C", f.repo, "update-index", "--no-assume-unchanged", "README.md"]);
    }
  });
  it("does not accept a modified saved review after a controller restart", async () => {
    const f = fixture(), store = path.join(f.root, "store"), tasks = new BoundedTasks({ fixture: f.repo }, store, mock);
    const started = tasks.start(f.contract), done = await tasks.execute(started.task_id);
    tasks.submitReview(review(started.task_id, 1, started.contract_sha256, done.manifest_sha256, "PASS"));
    const restarted = new BoundedTasks({ fixture: f.repo }, store, mock);
    expect(restarted.acceptedSnapshot(started.task_id).review_result).toBe("PASS");
    const file = path.join(store, started.task_id, "revision-1-review.json");
    fs.writeFileSync(file, "{}");
    expect(() => restarted.acceptedSnapshot(started.task_id)).toThrow("REVIEW_RECORD_MISMATCH");
  });
  it("refuses unknown operation profiles, Codex budget, scope and repeated failed proposal", async () => {
    const f = fixture(), tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), async () => ({ ...await mock("", "Contract: {\"revision\":1}", 1), output: "PASS" }));
    expect(() => tasks.start({ ...f.contract, codex: { allowed: true, max_calls: 1 } as never })).toThrow();
    expect(() => tasks.start({ ...f.contract, edit_paths: ["../README.md"] })).toThrow();
    expect(() => tasks.start({ ...f.contract, execution_profile: "shell" as never })).toThrow();
    const started = tasks.start(f.contract);
    await expect(tasks.execute(started.task_id)).rejects.toThrow();
    expect(tasks.status(started.task_id).state).toBe("ESCALATE");
    expect(tasks.status(started.task_id).revisions).toHaveLength(0);
  });
  it("stops at revision budget rather than retrying review indefinitely", async () => {
    const f = fixture(), tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), mock);
    const started = tasks.start({ ...f.contract, max_revisions: 1 }), one = await tasks.execute(started.task_id);
    expect(tasks.submitReview(review(started.task_id, 1, started.contract_sha256, one.manifest_sha256, "NEEDS_WORK")).state).toBe("ESCALATE");
    expect(tasks.status(started.task_id).stop_reason).toBe("REVISION_BUDGET_EXHAUSTED");
  });
  it("applies replacement dollars literally and does not force every scoped path to change", async () => {
    const f = fixture(true), replacement = "Literal $& $$ $` $' stays unchanged.";
    const worker: Worker = async () => ({ ...await mock("", "Contract: {\"revision\":1}", 1),
      output: JSON.stringify({ edits: [{ path: "README.md", old_text: "Old text.", new_text: replacement }] }) });
    const tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), worker);
    const started = tasks.start({ ...f.contract, edit_paths: ["README.md", "SECOND.md"] });
    const done = await tasks.execute(started.task_id);
    expect(done.state).toBe("REVIEW_PENDING");
    expect(fs.readFileSync(path.join(f.repo, "README.md"), "utf8")).toContain(replacement);
    expect(fs.readFileSync(path.join(f.repo, "SECOND.md"), "utf8")).toBe("Keep this unchanged.\n");
    expect(Buffer.from(tasks.readArtifact(started.task_id, 1, "revision-1-diff.patch").content_base64, "base64").toString()).not.toContain("SECOND.md");
  });
  it("rejects a proposal editing a path outside the allowed scope", async () => {
    const f = fixture(true);
    const worker: Worker = async () => ({ ...await mock("", "Contract: {\"revision\":1}", 1),
      output: JSON.stringify({ edits: [{ path: "SECOND.md", old_text: "Keep this unchanged.", new_text: "Not allowed." }] }) });
    const tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), worker);
    const started = tasks.start(f.contract);
    await expect(tasks.execute(started.task_id)).rejects.toThrow("INVALID_PROPOSAL");
    expect(fs.readFileSync(path.join(f.repo, "SECOND.md"), "utf8")).toBe("Keep this unchanged.\n");
  });
  it("applies SHA-bound non-overlapping line edits without whole-file output", async () => {
    const f = fixture();
    const worker: Worker = async (_repo, prompt) => {
      const input = JSON.parse(prompt.slice(prompt.indexOf("Contract: ") + 10)) as {
        current: { path: string; sha256: string }[];
      };
      const current = input.current[0];
      return {
        worker: "opencode", session_id: "ses_range", execution_id: "msg_range",
        provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
        output: JSON.stringify({ edits: [
          { path: "README.md", expected_sha256: current.sha256, start_line: 1, delete_count: 1, new_text: "First draft.\n" },
          { path: "README.md", expected_sha256: current.sha256, start_line: 3, delete_count: 0, new_text: "Appended.\n" },
        ] }),
      };
    };
    const tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), worker);
    const started = tasks.start(f.contract);
    expect((await tasks.execute(started.task_id)).state).toBe("REVIEW_PENDING");
    expect(fs.readFileSync(path.join(f.repo, "README.md"), "utf8")).toBe(
      "First draft.\nssh delete publish are words.\nAppended.\n",
    );
  });

  it("rejects stale SHA-bound range proposals before writing", async () => {
    const f = fixture();
    const worker: Worker = async () => ({
      worker: "opencode", session_id: "ses_stale", execution_id: "msg_stale",
      provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
      output: JSON.stringify({ edits: [{
        path: "README.md", expected_sha256: "0".repeat(64),
        start_line: 1, delete_count: 1, new_text: "Wrong.\n",
      }] }),
    });
    const tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), worker);
    const started = tasks.start(f.contract);
    await expect(tasks.execute(started.task_id)).rejects.toThrow("SCOPE_CHANGED");
    expect(fs.readFileSync(path.join(f.repo, "README.md"), "utf8")).toContain("Old text.");
  });

  it("rejects overlapping SHA-bound line edits", async () => {
    const f = fixture();
    const worker: Worker = async (_repo, prompt) => {
      const input = JSON.parse(prompt.slice(prompt.indexOf("Contract: ") + 10)) as {
        current: { sha256: string }[];
      };
      const expected = input.current[0].sha256;
      return {
        worker: "opencode", session_id: "ses_overlap", execution_id: "msg_overlap",
        provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
        output: JSON.stringify({ edits: [
          { path: "README.md", expected_sha256: expected, start_line: 1, delete_count: 2, new_text: "A\n" },
          { path: "README.md", expected_sha256: expected, start_line: 2, delete_count: 1, new_text: "B\n" },
        ] }),
      };
    };
    const tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), worker);
    const started = tasks.start(f.contract);
    await expect(tasks.execute(started.task_id)).rejects.toThrow("INVALID_PROPOSAL");
    expect(fs.readFileSync(path.join(f.repo, "README.md"), "utf8")).toContain("Old text.");
  });
  it("reserves process overhead outside the 120 second OpenCode prompt budget", async () => {
    const f = fixture();
    let observedTimeout = 0;
    const worker: Worker = async (repo, prompt, timeout) => {
      observedTimeout = timeout;
      return mock(repo, prompt, timeout);
    };
    const tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), worker);
    const started = tasks.start(f.contract);
    expect((await tasks.execute(started.task_id)).state).toBe("REVIEW_PENDING");
    expect(observedTimeout).toBe(150000);
  });
  it("does not charge review wait against worker time budget", async () => {
    const f = fixture(), store = path.join(f.root, "store"), tasks = new BoundedTasks({ fixture: f.repo }, store, mock);
    const started = tasks.start({ ...f.contract, timeout_ms: 1000 }), first = await tasks.execute(started.task_id);
    const taskFile = path.join(store, started.task_id, "task.json");
    const saved = JSON.parse(fs.readFileSync(taskFile, "utf8")); saved.started_at = "2020-01-01T00:00:00.000Z";
    fs.writeFileSync(taskFile, JSON.stringify(saved));
    const next = tasks.submitReview(review(started.task_id, 1, started.contract_sha256, first.manifest_sha256, "NEEDS_WORK"));
    expect(next.next_revision).toBe(2);
    expect((await tasks.execute(started.task_id)).state).toBe("REVIEW_PENDING");
  });
  it("persists only sanitized OpenCode worker diagnostics", async () => {
    const f = fixture();
    const worker: Worker = async () => {
      throw new GatewayError(
        "WORKER_FAILED",
        "PROMPT_ATTEMPTED:OPENCODE_TIMEOUT:ses_safe123",
      );
    };
    const tasks = new BoundedTasks(
      { fixture: f.repo },
      path.join(f.root, "store"),
      worker,
    );
    const started = tasks.start(f.contract);

    await expect(tasks.execute(started.task_id)).rejects.toMatchObject({
      code: "WORKER_FAILED",
    });

    expect(tasks.status(started.task_id)).toMatchObject({
      state: "ESCALATE",
      stop_reason: "WORKER_FAILED",
      worker_diagnostic: {
        phase: "PROMPT_ATTEMPTED",
        error_code: "OPENCODE_TIMEOUT",
        session_id: "ses_safe123",
      },
    });
  });
  it("forces a permanently hung worker to timeout and releases execution and repo locks", async () => {
    const f = fixture(), store = path.join(f.root, "store");
    const hung: Worker = () => new Promise(() => {});
    const tasks = new BoundedTasks({ fixture: f.repo }, store, hung);
    const started = tasks.start({ ...f.contract, timeout_ms: 1000 });
    const began = Date.now();

    await expect(tasks.execute(started.task_id)).rejects.toMatchObject({
      code: "WORKER_TIMEOUT",
      message: "CONTROLLER_TIMEOUT",
    });

    expect(Date.now() - began).toBeLessThan(7000);
    expect(tasks.status(started.task_id)).toMatchObject({
      state: "ESCALATE",
      stop_reason: "WORKER_TIMEOUT",
      worker_diagnostic: {
        phase: "CONTROLLER",
        error_code: "WORKER_TIMEOUT",
        session_id: null,
      },
      revisions: [],
      worker_time_ms: 1000,
    });
    expect(fs.existsSync(path.join(store, started.task_id, "execution.lock"))).toBe(false);

    // A timed-out worker must not leave the repo reservation behind.
    expect(() => tasks.start(f.contract)).not.toThrow();
  });
  it("rejects changed snapshot even when the worker selected another scoped path", async () => {
    const f = fixture(true);
    const worker: Worker = async (repo) => {
      fs.writeFileSync(path.join(repo, "SECOND.md"), "Concurrent change.\n");
      return { ...await mock("", "Contract: {\"revision\":1}", 1), output: JSON.stringify({ edits: [{ path: "README.md", old_text: "Old text.", new_text: "Proposed." }] }) };
    };
    const tasks = new BoundedTasks({ fixture: f.repo }, path.join(f.root, "store"), worker);
    const started = tasks.start({ ...f.contract, edit_paths: ["README.md", "SECOND.md"] });
    await expect(tasks.execute(started.task_id)).rejects.toThrow("SCOPE_CHANGED");
    expect(fs.readFileSync(path.join(f.repo, "README.md"), "utf8")).toContain("Old text.");
  });
  it("holds a repo-wide reservation across execution and review wait, then releases on PASS", async () => {
    const f = fixture(), store = path.join(f.root, "store"), tasks = new BoundedTasks({ fixture: f.repo }, store, mock);
    const started = tasks.start(f.contract);
    expect(() => new BoundedTasks({ fixture: f.repo }, path.join(f.root, "other-store"), mock).start(f.contract)).toThrow("REPO_BUSY");
    const done = await tasks.execute(started.task_id);
    expect(() => tasks.start(f.contract)).toThrow("REPO_BUSY");
    expect(tasks.submitReview(review(started.task_id, 1, started.contract_sha256, done.manifest_sha256, "PASS")).state).toBe("REVIEW_ACCEPTED");
    // The old change remains dirty, so the reservation is gone but a new task still cannot silently absorb it.
    expect(() => tasks.start(f.contract)).toThrow("DIRTY_REPO");
  });
  it("binds the codex-with-chatgpt Dashboard TypeScript profile to safe paths and controller verification", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-v2-ts-")); roots.push(root);
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "src", "dashboard"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src", "mcp"), { recursive: true });
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "dashboard", "collector.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repo, "src", "mcp", "server.ts"), "export const protectedValue = 1;\n");
    fs.writeFileSync(path.join(repo, "tests", "dashboard-profile.test.ts"), "export const fixture = true;\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
    const actual = fs.realpathSync.native(repo);
    const contract: Contract = { repo: "self", goal: "Change the Dashboard projection only",
      edit_paths: ["src/dashboard/collector.ts", "tests/dashboard-profile.test.ts"], acceptance_criteria: ["Dashboard remains type-safe"],
      task_kind: "text_change", execution_profile: "tracked_typescript_dashboard", worker: "opencode",
      codex: { allowed: false, max_calls: 0 }, max_revisions: 1, timeout_ms: 600000 };
    const worker: Worker = async () => ({ worker: "opencode", session_id: "ses_dashboard", execution_id: "msg_dashboard",
      provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
      output: JSON.stringify({ edits: [{ path: "src/dashboard/collector.ts", old_text: "export const value = 1;",
        new_text: "export const value = 2;" }] }) });
    const verificationCalls: { profile: string; paths: string[] }[] = [];
    const verifier: Verifier = (_repo, profile, paths) => {
      verificationCalls.push({ profile, paths: [...paths] });
      return { profile, passed: true, paths: [...paths], tests_run: 2, checks: [
        { name: "typecheck", exit_code: 0, duration_ms: 1, tool_sha256: "0".repeat(64), stdout_sha256: "1".repeat(64), stderr_sha256: "2".repeat(64), stdout_bytes: 0, stderr_bytes: 0 },
        { name: "full_regression", exit_code: 0, duration_ms: 1, tool_sha256: "3".repeat(64), stdout_sha256: "4".repeat(64), stderr_sha256: "5".repeat(64), stdout_bytes: 0, stderr_bytes: 0 },
      ] };
    };
    const tasks = new BoundedTasks({ self: actual }, path.join(root, "store"), worker,
      { self: "tracked_typescript_dashboard" }, verifier);
    expect(() => tasks.start({ ...contract, execution_profile: "tracked_utf8_text" })).toThrow("INVALID_CONTRACT");
    expect(() => tasks.start({ ...contract, edit_paths: ["src/mcp/server.ts"] })).toThrow("INVALID_CONTRACT");
    expect(() => tasks.start({ ...contract, edit_paths: ["src/dashboard/passkey-fixture.ts"] })).toThrow("INVALID_CONTRACT");
    const started = tasks.start(contract);
    const done = await tasks.execute(started.task_id);
    expect(done.state).toBe("REVIEW_PENDING");
    expect(tasks.status(started.task_id).codex_calls).toBe(0);
    expect(tasks.artifacts(started.task_id, 1).verify).toMatchObject({
      profile: "tracked_typescript_dashboard", passed: true, tests_run: 2,
      paths: ["src/dashboard/collector.ts"],
    });
    expect(verificationCalls).toEqual([{ profile: "tracked_typescript_dashboard", paths: ["src/dashboard/collector.ts"] }]);
  });
});
