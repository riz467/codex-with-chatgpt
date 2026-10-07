import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { BoundedTasks, type Contract, type Verifier, type Worker } from "../src/mcp/bounded-task.js";
import { boundedFinalizationRoot, productionVerificationPlan } from "../src/mcp/server.js";
import { prepareBoundedCommit, commitBoundedPatch, getBoundedCommitStatus } from "../src/mcp/typed-actions.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("bounded control-plane profile", () => {
  it("allows only the exact bootstrap control-plane files and keeps the profile gate out of scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-control-plane-")); roots.push(root);
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "src", "mcp"), { recursive: true });
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });

    fs.writeFileSync(path.join(repo, "src", "mcp", "server.ts"), "export const server = 1;\n");
    fs.writeFileSync(path.join(repo, "src", "mcp", "typed-actions.ts"), "export const action = 1;\n");
    fs.writeFileSync(path.join(repo, "tests", "typed-actions.test.ts"), "export const test = 1;\n");
    fs.writeFileSync(path.join(repo, "tests", "mcp-integration.test.ts"), "export const integration = 1;\n");
    fs.writeFileSync(path.join(repo, "src", "mcp", "bounded-task.ts"), "export const gate = 1;\n");
    fs.writeFileSync(path.join(repo, "src", "mcp", "local-gateway.ts"), "export const gateway = 1;\n");

    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");

    const actual = fs.realpathSync.native(repo);
    const observedBudgets: { timeout: number; promptTimeout?: number }[] = [];
    const worker: Worker = async (_repo, _prompt, timeout, promptTimeout) => {
      observedBudgets.push({ timeout, promptTimeout });
      return ({
      worker: "opencode", session_id: "ses_control", execution_id: "msg_control",
      provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
      output: JSON.stringify({ edits: [{
        path: "src/mcp/typed-actions.ts",
        old_text: "export const action = 1;",
        new_text: "export const action = 2;",
      }] }),
      });
    };
    const verifier: Verifier = (_repo, profile, paths) => ({
      profile, passed: true, paths: [...paths], tests_run: 0, checks: [],
    });
    const tasks = new BoundedTasks(
      { control: actual },
      path.join(root, "store"),
      worker,
      { control: "tracked_typescript_control_plane" },
      verifier,
    );

    const base: Contract = {
      repo: "control",
      goal: "Implement one bounded typed action",
      edit_paths: ["src/mcp/server.ts", "src/mcp/typed-actions.ts", "tests/typed-actions.test.ts"],
      acceptance_criteria: ["Remain inside the fixed control-plane scope"],
      task_kind: "text_change",
      execution_profile: "tracked_typescript_control_plane",
      worker: "opencode",
      codex: { allowed: false, max_calls: 0 },
      max_revisions: 1,
      timeout_ms: 600000,
    };

    // Temporary bootstrap scope permits bounded-task policy edits; local-gateway remains denied.
    expect(() => tasks.start({ ...base, edit_paths: ["src/mcp/local-gateway.ts"] })).toThrow("INVALID_CONTRACT");
    expect(() => tasks.start({ ...base, execution_profile: "tracked_typescript_dashboard" })).toThrow("INVALID_CONTRACT");

    const integrationOnly = tasks.start({ ...base, edit_paths: ["tests/mcp-integration.test.ts"] });
    await expect(tasks.execute(integrationOnly.task_id)).rejects.toThrow("INVALID_PROPOSAL");

    const started = tasks.start(base);
    const result = await tasks.execute(started.task_id);
    expect(result.state).toBe("REVIEW_PENDING");
    expect(tasks.status(started.task_id).codex_calls).toBe(0);
    expect(observedBudgets).toEqual([
      { timeout: 330000, promptTimeout: 300000 },
      { timeout: 330000, promptTimeout: 300000 },
    ]);
    expect(tasks.artifacts(started.task_id, 1).verify).toMatchObject({
      profile: "tracked_typescript_control_plane",
      passed: true,
      paths: ["src/mcp/typed-actions.ts"],
    });
  });
});
describe("bounded authority-transport profile", () => {
  const alias = "codex-with-chatgpt-authority-transport";
  const profile = "tracked_typescript_authority_transport" as const;
  const allowed = [
    "src/typed-action-finalizer/authority-ingestor.ts",
    "tests/typed-action-authority-ingestor.test.ts",
    "docs/ct701-authority-ingestor.md",
  ];

  it("uses only the fixed authority verification plan", () => {
    expect(productionVerificationPlan(profile)).toEqual([
      { name: "tsc", toolPath: "typescript/bin/tsc", args: ["--noEmit"], timeout_ms: 120000 },
      { name: "vitest", toolPath: "vitest/vitest.mjs", args: [
        "run", "--maxWorkers=2",
        "tests/typed-action-authority-ingestor.test.ts",
        "tests/typed-action-approval.test.ts",
        "tests/ct700-production-approver.test.ts",
      ], timeout_ms: 180000 },
    ]);
  });

  it("pins finalization to the fixed bridge root", () => {
    const bridge = "C:\\work\\codex-with-chatgpt";
    expect(boundedFinalizationRoot(bridge, alias)).toBe(bridge);
    expect(boundedFinalizationRoot("C:\\work\\other", alias)).toBeNull();
    expect(boundedFinalizationRoot(bridge, `${alias}-other`)).toBeNull();
  });

  for (const allowedPath of allowed) {
    it(`starts only the single allowed path ${allowedPath} and rejects adjacent paths`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-authority-")); roots.push(root);
      const repo = path.join(root, "repo");
      const adjacent = [
        "src/typed-action-finalizer/authority-ingestor-helper.ts",
        "tests/typed-action-authority-ingestor-extra.test.ts",
        "docs/ct701-authority-ingestor-extra.md",
      ];
      for (const name of [...allowed, ...adjacent]) {
        const file = path.join(repo, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "fixture\n");
      }
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      git("init", "-q"); git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
      const actual = fs.realpathSync.native(repo);
      const tasks = new BoundedTasks({ [alias]: actual, control: actual }, path.join(root, "store"),
        undefined, { [alias]: profile, control: "tracked_typescript_control_plane" });
      const contract: Contract = {
        repo: alias, goal: "Start authority transport scope", edit_paths: [allowedPath],
        acceptance_criteria: ["Stay within the fixed path"], task_kind: "text_change",
        execution_profile: profile, worker: "opencode", codex: { allowed: false, max_calls: 0 },
        max_revisions: 1, timeout_ms: 600000,
      };
      for (const name of adjacent) {
        expect(() => tasks.start({ ...contract, edit_paths: [name] })).toThrow("INVALID_CONTRACT");
      }
      expect(() => tasks.start({ ...contract, execution_profile: "tracked_typescript_control_plane" })).toThrow("INVALID_CONTRACT");
      expect(() => tasks.start({ ...contract, repo: "control" })).toThrow("INVALID_CONTRACT");
      const started = tasks.start(contract);
      expect(tasks.status(started.task_id).contract).toEqual(contract);
      expect(tasks.status(started.task_id).codex_calls).toBe(0);
    });
  }
  it("prepares and commits one reviewed authority-transport edit locally without advancing origin", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-authority-commit-")); roots.push(root);
    const repo = path.join(root, "repo");
    const origin = path.join(root, "origin.git");
    const name = "src/typed-action-finalizer/authority-ingestor.ts";
    const file = path.join(repo, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export const authority = 1;\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--bare", "-q", origin]);
    git("init", "-q");
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("add", "."); git("commit", "-qm", "initial");
    const baseline = git("rev-parse", "HEAD");
    const branch = git("branch", "--show-current");
    git("remote", "add", "origin", origin);
    git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    const originHead = () => execFileSync("git", ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
    expect(originHead()).toBe(baseline);

    const observedBudgets: { timeout: number; promptTimeout?: number }[] = [];
    const worker: Worker = async (_repo, _prompt, timeout, promptTimeout) => {
      observedBudgets.push({ timeout, promptTimeout });
      return {
        worker: "opencode", session_id: "ses_authority", execution_id: "msg_authority",
        provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
        output: JSON.stringify({ edits: [{ path: name,
          expected_sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
          start_line: 1, delete_count: 1, new_text: "export const authority = 2;\n",
        }] }),
      };
    };
    const verifier: Verifier = (_repo, verifiedProfile, paths) => ({
      profile: verifiedProfile, passed: true, paths: [...paths], tests_run: 1, checks: [],
    });
    const stateDir = path.join(root, "commit-state");
    fs.mkdirSync(stateDir);
    const tasks = new BoundedTasks({ [alias]: fs.realpathSync.native(repo) }, path.join(root, "store"),
      worker, { [alias]: profile }, verifier);
    const contract: Contract = {
      repo: alias, goal: "Change the authority ingestor locally", edit_paths: [name],
      acceptance_criteria: ["One reviewed local edit"], task_kind: "text_change",
      execution_profile: profile, worker: "opencode", codex: { allowed: false, max_calls: 0 },
      max_revisions: 1, timeout_ms: 600000,
    };
    const started = tasks.start(contract);
    const executed = await tasks.execute(started.task_id);
    expect(executed.state).toBe("REVIEW_PENDING");
    expect(observedBudgets).toEqual([{ timeout: 330000, promptTimeout: 300000 }]);
    expect(tasks.artifacts(started.task_id, 1).verify).toMatchObject({
      profile, passed: true, paths: [name],
    });
    expect(tasks.submitReview({
      review_id: `review-${randomUUID()}`, task_id: started.task_id, revision: 1,
      contract_sha256: started.contract_sha256, manifest_sha256: executed.manifest_sha256,
      reviewer: "chatgpt", verdict: "PASS", findings: [],
    }).state).toBe("REVIEW_ACCEPTED");

    expect(prepareBoundedCommit(tasks, started.task_id, stateDir)).toMatchObject({
      state: "PREPARED", authoritative_done: false,
    });
    expect(getBoundedCommitStatus(tasks, started.task_id, stateDir)).toMatchObject({
      state: "PREPARED", authoritative_done: false,
    });
    expect(commitBoundedPatch(tasks, started.task_id, stateDir, repo)).toMatchObject({
      state: "COMMITTED", authoritative_done: false,
    });
    expect(getBoundedCommitStatus(tasks, started.task_id, stateDir)).toMatchObject({
      state: "COMMITTED", authoritative_done: false,
    });
    expect(git("rev-list", "--count", `${baseline}..HEAD`)).toBe("1");
    expect(git("rev-parse", "HEAD^")).toBe(baseline);
    expect(git("status", "--porcelain=v1", "-uall")).toBe("");
    expect(originHead()).toBe(baseline);
    expect(tasks.status(started.task_id).codex_calls).toBe(0);
  });
});
describe("bounded CT700 peer gateway profile", () => {
  const alias = "codex-with-chatgpt-ct700-peer-gateway";
  const profile = "tracked_typescript_ct700_peer_gateway" as const;
  const allowed = [
    "src/approver-service/production.ts",
    "tests/ct700-production-approver.test.ts",
    "docs/ct700-production-approver.md",
  ];
  const adjacent = [
    "src/approver-service/production-helper.ts",
    "tests/ct700-production-approver-extra.test.ts",
    "docs/ct700-production-approver-extra.md",
    "src/typed-action-finalizer/authority-ingestor.ts",
    "tests/typed-action-authority-ingestor.test.ts",
    "docs/ct701-authority-ingestor.md",
  ];

  it("uses only the fixed CT700 verification plan", () => {
    expect(productionVerificationPlan(profile)).toEqual([
      { name: "tsc", toolPath: "typescript/bin/tsc", args: ["--noEmit"], timeout_ms: 120000 },
      { name: "vitest", toolPath: "vitest/vitest.mjs", args: [
        "run", "--maxWorkers=2",
        "tests/ct700-production-approver.test.ts",
        "tests/typed-action-authority-ingestor.test.ts",
        "tests/typed-action-approval.test.ts",
      ], timeout_ms: 180000 },
    ]);
  });

  it("pins the alias to the bridge finalization root", () => {
    const bridge = "C:\\work\\codex-with-chatgpt";
    expect(boundedFinalizationRoot(bridge, alias)).toBe(bridge);
    expect(boundedFinalizationRoot("C:\\work\\other", alias)).toBeNull();
    expect(boundedFinalizationRoot(bridge, `${alias}-other`)).toBeNull();
  });

  it("accepts exactly the three CT700 paths, rejects adjacent and authority paths, and uses the long worker budget", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-ct700-peer-")); roots.push(root);
    const repo = path.join(root, "repo");
    for (const name of [...allowed, ...adjacent]) {
      const file = path.join(repo, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "fixture\n");
    }
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
    const observedBudgets: { timeout: number; promptTimeout?: number }[] = [];
    const worker: Worker = async (_repo, _prompt, timeout, promptTimeout) => {
      observedBudgets.push({ timeout, promptTimeout });
      return {
        worker: "opencode", session_id: "ses_ct700", execution_id: "msg_ct700",
        provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
        output: JSON.stringify({ edits: [{ path: allowed[0],
          expected_sha256: createHash("sha256").update("fixture\n").digest("hex"),
          start_line: 1, delete_count: 1, new_text: "updated\n",
        }] }),
      };
    };
    const verifier: Verifier = (_repo, verifiedProfile, paths) => ({
      profile: verifiedProfile, passed: true, paths: [...paths], tests_run: 0, checks: [],
    });
    const actual = fs.realpathSync.native(repo);
    const tasks = new BoundedTasks({ [alias]: actual, control: actual, authority: actual },
      path.join(root, "store"), worker, { [alias]: profile,
        control: "tracked_typescript_control_plane",
        authority: "tracked_typescript_authority_transport" }, verifier);
    const contract: Contract = {
      repo: alias, goal: "Change CT700 production peer gateway", edit_paths: [...allowed],
      acceptance_criteria: ["Only the three fixed CT700 paths"], task_kind: "text_change",
      execution_profile: profile, worker: "opencode", codex: { allowed: false, max_calls: 0 },
      max_revisions: 1, timeout_ms: 600000,
    };
    for (const name of adjacent) {
      expect(() => tasks.start({ ...contract, edit_paths: [name] })).toThrow("INVALID_CONTRACT");
    }
    for (const wrongProfile of ["tracked_typescript_control_plane", "tracked_typescript_authority_transport"] as const) {
      expect(() => tasks.start({ ...contract, execution_profile: wrongProfile })).toThrow("INVALID_CONTRACT");
    }
    for (const wrongRepo of ["control", "authority"]) {
      expect(() => tasks.start({ ...contract, repo: wrongRepo })).toThrow("INVALID_CONTRACT");
    }
    const started = tasks.start(contract);
    expect(tasks.status(started.task_id).contract.edit_paths).toEqual(allowed);
    expect((await tasks.execute(started.task_id)).state).toBe("REVIEW_PENDING");
    expect(observedBudgets).toEqual([{ timeout: 330000, promptTimeout: 300000 }]);
    expect(tasks.artifacts(started.task_id, 1).verify).toMatchObject({
      profile, passed: true, paths: [allowed[0]],
    });
  });
});
