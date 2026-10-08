import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Workspace } from "../workspace/manager.js";
import { runGit, gitStatus } from "../workspace/git.js";
import { BoundedTasks, headWorktreeBaselineSha } from "./bounded-task.js";
import { GatewayError, safePath } from "./local-gateway.js";

type RecoveryTasks = Pick<BoundedTasks, "executing" | "verifiedExhaustedWorkspaceDiff" | "verifiedFailedWorkspaceDiff" | "recordRecoverySnapshot">;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function recoverFailedBoundedWorkspace(tasks: RecoveryTasks, workspace: Workspace,
  task: ReturnType<BoundedTasks["status"]>, root: string) {
  const proof = () => task.stop_reason === "REVISION_BUDGET_EXHAUSTED"
    ? tasks.verifiedExhaustedWorkspaceDiff(task.task_id) : tasks.verifiedFailedWorkspaceDiff(task.task_id);
  if (task.state !== "ESCALATE" || !proof() || tasks.executing(task.task_id) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(task.baseline_head)) {
    throw new GatewayError("RECOVERY_NOT_ALLOWED", "This task is not eligible for workspace recovery");
  }
  const head = () => { const r = runGit(root, ["rev-parse", "HEAD"]); return r.ok ? r.stdout.trim() : null; };
  const status = gitStatus(workspace);
  if (head() !== task.baseline_head || !status.isRepo || status.staged.length || status.untracked.length ||
      status.conflicted.length || status.hidden.changes || status.hidden.conflicts) {
    throw new GatewayError("RECOVERY_NOT_ALLOWED", "Workspace is not at a safe recovery baseline");
  }
  const scope = new Set(task.contract.edit_paths), observed = status.unstaged.map(c => c.path);
  if (new Set(observed.map(p => p.toLowerCase())).size !== observed.length || observed.some(p => !scope.has(p))) {
    throw new GatewayError("RECOVERY_NOT_ALLOWED", "Unstaged changes exceed the task scope");
  }
  // Every baseline and untouched scoped file must be checked before restore.
  for (const rel of task.contract.edit_paths) {
    const file = safePath(root, rel), blob = runGit(root, ["cat-file", "blob", `${task.baseline_head}:${rel}`]);
    if (!fs.lstatSync(file).isFile() || !blob.ok || hash(Buffer.from(blob.stdout)) !== task.baseline[rel] ||
        (!observed.includes(rel) && headWorktreeBaselineSha(root, rel, file) !== task.baseline[rel])) {
      throw new GatewayError("RECOVERY_NOT_ALLOWED", "Baseline evidence does not match HEAD");
    }
  }
  const before = observed.map(rel => ({ path: rel, bytes: fs.readFileSync(safePath(root, rel)) }));
  if (before.length) tasks.recordRecoverySnapshot(task.task_id, before.map(row => ({
    path: row.path, sha256: hash(row.bytes), content_base64: row.bytes.toString("base64"),
  })));
  try {
    if (before.length) {
      if (tasks.executing(task.task_id) || head() !== task.baseline_head || !proof() ||
          before.some(row => !fs.readFileSync(safePath(root, row.path)).equals(row.bytes))) throw new Error("RECOVERY_CHANGED");
      const restore = runGit(root, ["restore", "--source", task.baseline_head, "--worktree", "--", ...observed]);
      if (!restore.ok) throw new Error("RESTORE_FAILED");
      runGit(root, ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "update-index", "--really-refresh", "--", ...observed]);
    }
    const after = gitStatus(workspace);
    if (head() !== task.baseline_head || !after.isRepo || after.staged.length || after.unstaged.length ||
        after.untracked.length || after.conflicted.length || after.hidden.changes || after.hidden.conflicts ||
        task.contract.edit_paths.some(rel => headWorktreeBaselineSha(root, rel, safePath(root, rel)) !== task.baseline[rel])) {
      throw new Error("RECOVERY_POSTCHECK_FAILED");
    }
  } catch {
    // Undo partial restores only when current bytes are still exactly the known
    // checkout baseline. Concurrent, unrecognized edits are never overwritten.
    if (head() === task.baseline_head) for (const row of before) {
      const file = safePath(root, row.path);
      if (headWorktreeBaselineSha(root, row.path, file) === task.baseline[row.path]) fs.writeFileSync(file, row.bytes);
    }
    throw new GatewayError("RECOVERY_FAILED", "Recovery failed; inspect preserved recovery-before evidence and affected paths");
  }
  return { task_id: task.task_id, result: observed.length ? "recovered" : "already_clean" };
}
