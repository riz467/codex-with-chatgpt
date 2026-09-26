import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { safePath } from "./local-gateway.js";

// Completion is an engine operation, not an approval issuer operation. The
// caller must validate and consume independently issued approval evidence.
export function preflightAutonomousCompletion(repo: string, taskId: string): "CompleteReview" | "CompleteIntegratedReview" {
  const direct = invoke(repo, taskId, "CompleteReview", true);
  if (direct.status === 0 && direct.stdout?.includes("ELIGIBLE:")) return "CompleteReview";
  const integrated = invoke(repo, taskId, "CompleteIntegratedReview", true);
  if (integrated.status !== 0 || !integrated.stdout?.includes("ELIGIBLE: integrated_commit=")) throw new Error("AUTONOMOUS_APPROVAL_REJECTED");
  return "CompleteIntegratedReview";
}

function invoke(repo: string, taskId: string, mode: string, preflight: boolean) {
  const engine = path.join(process.env.USERPROFILE ?? "C:\\Users\\workspace", ".config", "opencode", "scripts", "orchestrate-v03.ps1");
  return spawnSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", engine,
    "-Mode", mode, "-Repo", repo, "-TaskId", taskId,
    ...(preflight ? ["-Preflight"] : ["-ReviewResult", "PASS", "-DoneApproved"])],
    { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 65536 });
}

export function completeAutonomousTask(repo: string, taskId: string, mode: "CompleteReview" | "CompleteIntegratedReview") {
  const result = invoke(repo, taskId, mode, false);
  if (result.status !== 0 || !result.stdout?.trim().endsWith("DONE")) throw new Error("AUTONOMOUS_APPROVAL_REJECTED");
  const status = JSON.parse(fs.readFileSync(safePath(repo, `.ai/tasks/${taskId}/status.json`), "utf8")) as Record<string, unknown>;
  if (status.task_id !== taskId || status.state !== "DONE") throw new Error("AUTONOMOUS_APPROVAL_REJECTED");
  return { task_id: taskId, state: "DONE" as const, completion_mode: mode };
}
