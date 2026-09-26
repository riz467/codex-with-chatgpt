import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { GatewayError, REPOS, REVIEW_ROOT, safePath } from "./local-gateway.js";
import { reviewProfiles } from "./review-profiles.js";
import { autonomousState } from "./autonomous-read-model.js";

const source = "C:\\work\\ai-orchestration-config";
const profilesFile = path.join(source, "scripts", "autonomous-repo-profiles.json");
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const runPattern = /^auto-[a-f0-9]{32}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const file = (root: string, id: string) => safePath(root, `rpc-jobs/${id}/gateway-job.json`);
const read = (name: string) => JSON.parse(fs.readFileSync(name, "utf8")) as Record<string, unknown>;
const optional = (name: string) => fs.existsSync(name) && fs.statSync(name).size <= 1024 * 1024 ? read(name) : null;
type Registration = { job_id: string; run_id: string; task_id: string; repo_key: string; repo_path: string;
  goal_sha256: string; process_id: number; started_at: string; exit_code?: number | null };

function profile(repo: string) {
  if (Object.hasOwn(REPOS, repo)) return { root: REPOS[repo as keyof typeof REPOS], kind: "read_only" as const };
  const profiles = read(profilesFile);
  if (!Object.hasOwn(reviewProfiles, repo) || !Object.hasOwn(profiles, repo)) throw new GatewayError("INVALID_REPO", "Unknown autonomous repository key");
  const config = profiles[repo] as Record<string, unknown>;
  const review = reviewProfiles[repo];
  if (config.path !== review.workspace || config.review !== true || config.semantic_review !== true ||
      typeof config.edit_path !== "string" || !/^[A-Za-z0-9._/-]+$/.test(config.edit_path) || config.edit_path.includes("..")) {
    throw new GatewayError("INVALID_PROFILE", "Autonomous repository profile is not trusted for a bounded change");
  }
  return { root: review.workspace, kind: "change" as const, edit_path: config.edit_path };
}
function active(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function registered(root: string) {
  const dir = safePath(root, "rpc-jobs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && runPattern.test(e.name)).flatMap(e => {
    try { const record = optional(file(root, e.name)) as Registration | null;
      return record?.run_id === e.name && record.job_id && record.task_id === `rpc-${e.name.slice(5)}` ? [record] : []; }
    catch { return []; }
  });
}
export function startAutonomous(repo: string, goal: string, boundedScope?: string[], root = REVIEW_ROOT) {
  if (typeof goal !== "string" || !goal.trim() || goal.length > 800 || /[\x00-\x1f\x7f]/.test(goal)) throw new GatewayError("INVALID_GOAL", "Invalid bounded autonomous goal");
  const p = profile(repo);
  if (boundedScope !== undefined && (p.kind !== "change" || boundedScope.length !== 1 || boundedScope[0] !== p.edit_path)) {
    throw new GatewayError("INVALID_EDIT_PATHS", "Only the trusted fixed edit scope is accepted");
  }
  if (registered(root).some(job => job.repo_key === repo && active(job.process_id))) throw new GatewayError("REPO_BUSY", "Autonomous run already active");
  const run_id = `auto-${randomUUID().replaceAll("-", "")}`;
  const task_id = `rpc-${run_id.slice(5)}`;
  const dir = safePath(root, `rpc-jobs/${run_id}`);
  fs.mkdirSync(dir, { recursive: false });
  const out = fs.openSync(safePath(root, `rpc-jobs/${run_id}/gateway-stdout.log`), "wx");
  const err = fs.openSync(safePath(root, `rpc-jobs/${run_id}/gateway-stderr.log`), "wx");
  const script = path.join(source, "scripts", p.kind === "change" ? "ai-autonomous-change.ps1" : "ai-autonomous-readonly.ps1");
  let child;
  try {
    child = spawn(pwsh, ["-NoProfile", "-NonInteractive", "-File", script, "-Repo", repo, "-Goal", goal, "-RunId", run_id],
      { cwd: p.root, stdio: ["ignore", out, err], windowsHide: true, shell: false });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  if (!child.pid) throw new GatewayError("RUNTIME_UNAVAILABLE", "Autonomous worker did not start");
  const job: Registration = { job_id: run_id, run_id, task_id, repo_key: repo, repo_path: p.root,
    goal_sha256: hash(goal), process_id: child.pid, started_at: new Date().toISOString() };
  fs.writeFileSync(file(root, run_id), JSON.stringify(job), { flag: "wx" });
  child.on("exit", code => { try { fs.writeFileSync(file(root, run_id), JSON.stringify({ ...job, exit_code: code })); } catch { /* read-only status remains unknown */ } });
  child.on("error", () => { try { fs.writeFileSync(file(root, run_id), JSON.stringify({ ...job, exit_code: null })); } catch { /* unknown */ } });
  child.unref();
  return { job_id: run_id, run_id, task_id, repo, mode: "autonomous" as const, started_at: job.started_at };
}
export function autonomousObservation(id: string, root = REVIEW_ROOT) {
  if (!runPattern.test(id) && !/^rpc-[a-f0-9]{32}$/.test(id)) return null;
  const runId = id.startsWith("rpc-") ? `auto-${id.slice(4)}` : id;
  const record = optional(file(root, runId)) as Registration | null;
  if (!record) return null;
  if (record.run_id !== runId || record.task_id !== `rpc-${runId.slice(5)}` ||
      profile(record.repo_key).root !== record.repo_path) throw new GatewayError("INVALID_EVIDENCE", "Invalid autonomous job identity");
  const run = optional(safePath(root, `rpc-jobs/${runId}/autonomous-run.json`));
  const result = optional(safePath(root, `rpc-jobs/${runId}/result.json`));
  if ((run && (run.run_id !== runId || run.goal_sha256 !== record.goal_sha256 || run.task_id && run.task_id !== record.task_id)) ||
      (result && result.run_id !== runId)) throw new GatewayError("INVALID_EVIDENCE", "Autonomous evidence mismatch");
  const ledger = optional(safePath(record.repo_path, `.ai/tasks/${record.task_id}/status.json`));
  const { done, phase, waiting, actor, state, review_phase } = autonomousState(run, result, ledger, record.task_id);
  const decisionFile = safePath(root, `rpc-jobs/${runId}/decision-history.jsonl`);
  let decision: string | null = null;
  if (fs.existsSync(decisionFile) && fs.statSync(decisionFile).size <= 65536) {
    try { const lines = fs.readFileSync(decisionFile, "utf8").split(/\r?\n/).filter(Boolean);
      const row = JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown>;
      if (row.run_id === runId && typeof row.decision === "string") decision = row.decision;
    } catch { /* unknown */ }
  }
  const usage = (v: unknown) => v && typeof v === "object" ? v : null;
  return { job_id: runId, run_id: runId, task_id: record.task_id, repo: record.repo_key, mode: "autonomous" as const,
    process: record.exit_code !== undefined ? "exited" : active(record.process_id) ? "running" : "unknown",
    exit_code: record.exit_code ?? null, state,
    autonomous_phase: phase, current_actor: actor,
    decision, review_phase,
    human_action_required: waiting, recommended_next_action: waiting ? "Explicit human approval required" : done ? null : "Poll status or inspect evidence",
    stop_reason_category: waiting ? "HUMAN_APPROVAL_REQUIRED" as const : phase === "ESCALATE" ? "EXECUTION_BLOCKED" as const : null,
    stop_reason_summary: waiting ? "Independent Review PASS; explicit approval pending" : phase === "ESCALATE" ? "Autonomous run escalated" : null,
    result_category: done ? "DONE" : typeof result?.reason_category === "string" ? result.reason_category : null,
    final_result: done ? "DONE" : typeof result?.state === "string" ? result.state : null, done_state: done ? "DONE" : null,
    usage_summary: { opencode: usage(run?.token_usage_total), codex_invocation_count: run?.codex_invocation_count ?? 0,
      codex: usage(run?.codex_usage), review: usage(run?.review_token_usage) },
    review_job_id: run?.review_job_id ?? null, review_evidence_sha256: run?.review_evidence_sha256 ?? null,
    bundle_manifest_sha256: result?.review_bundle && typeof result.review_bundle === "string" ?
      optional(safePath(root, `reviews/${path.basename(result.review_bundle)}/review-bundle.json`))?.manifest_sha256 ?? null : null };
}
