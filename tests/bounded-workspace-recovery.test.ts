import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as gitModule from "../src/workspace/git.js";
import { Workspace } from "../src/workspace/manager.js";
import { BoundedTasks, type Contract, type Worker } from "../src/mcp/bounded-task.js";
import { GatewayError } from "../src/mcp/local-gateway.js";
import { recoverFailedBoundedWorkspace } from "../src/mcp/bounded-workspace-recovery.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
it("preserves durable before-bytes and rolls back a partial restore without touching other files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-recovery-rollback-")); roots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "core.autocrlf", "false");
  for (const name of ["one.txt", "two.txt", "other.txt"]) fs.writeFileSync(path.join(repo, name), "before\n");
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-qm", "seed");
  const worker: Worker = async () => ({ worker: "opencode", session_id: "ses_fixture", execution_id: "msg_fixture",
    provider: "fixture", model: "fixture", usage: null, state: "completed", tools: 0,
    output: JSON.stringify({ edits: ["one.txt", "two.txt"].map(p => ({ path: p, old_text: "before", new_text: "after" })) }) });
  const tasks = new BoundedTasks({ fixture: fs.realpathSync.native(repo) }, path.join(root, "tasks"), worker, {},
    () => { throw new GatewayError("VERIFY_FAILED", "Fixture verification failure"); });
  const contract: Contract = { repo: "fixture", goal: "Change two files", edit_paths: ["one.txt", "two.txt"], acceptance_criteria: ["Changed"],
    task_kind: "text_change", execution_profile: "tracked_utf8_text", worker: "opencode", codex: { allowed: false, max_calls: 0 }, max_revisions: 3, timeout_ms: 600000 };
  const started = tasks.start(contract);
  await expect(tasks.execute(started.task_id)).rejects.toThrow("Fixture verification failure");
  const original = gitModule.runGit;
  vi.spyOn(gitModule, "runGit").mockImplementation((root, args) => {
    if (args[0] !== "restore") return original(root, args);
    original(root, ["restore", "--source", "HEAD", "--worktree", "--", "one.txt"]);
    return { ok: false, stdout: "", stderr: "injected failure", code: 1 };
  });
  expect(() => tasks.withRecoveryLock(started.task_id, task => recoverFailedBoundedWorkspace(tasks, new Workspace(repo), task, repo)))
    .toThrow("Recovery failed");
  expect(fs.readFileSync(path.join(repo, "one.txt"), "utf8")).toBe("after\n");
  expect(fs.readFileSync(path.join(repo, "two.txt"), "utf8")).toBe("after\n");
  expect(fs.readFileSync(path.join(repo, "other.txt"), "utf8")).toBe("before\n");
  const snapshots = fs.readdirSync(path.join(root, "tasks", started.task_id)).filter(n => n.startsWith("recovery-before-"));
  expect(snapshots).toHaveLength(1);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "tasks", started.task_id, snapshots[0]), "utf8"));
  expect(saved.files.map((f: { path: string }) => f.path).sort()).toEqual(["one.txt", "two.txt"]);
  expect(tasks.verifiedFailedWorkspaceDiff(started.task_id)).toBe(true);
});
