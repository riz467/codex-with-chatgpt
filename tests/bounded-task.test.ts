import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { BoundedTasks, type Contract, type Worker } from "../src/mcp/bounded-task.js";
import { getStateDir } from "../src/config/paths.js";

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
});
