import fs from "node:fs";
import { createHash } from "node:crypto";
import ignore from "ignore";
import { ledgerTask, safePath, REPOS, REVIEW_ROOT, GatewayError, getOrchestrationStatus } from "../mcp/local-gateway.js";
import { QUEUE } from "../worker/codex-interactive.js";
import { getStateDir } from "../config/paths.js";
import { SENSITIVE_PATTERNS } from "../workspace/ignore.js";
import { verifiedHealth, observeOsHealth, normalizeOsHealth, type OsHealth } from "./verified-health.js";
import { reviewProfiles, type ReviewProfile } from "../mcp/review-profiles.js";
import { autonomousState } from "../mcp/autonomous-read-model.js";
import { activeQueueTask, queueDepth } from "../worker/status-projection.js";

export type Roots = Readonly<Record<keyof typeof REPOS, string>>;
export type Stage = "complete" | "active" | "waiting" | "blocked" | "incomplete" | "not_started" | "unknown";
export const stages = ["Research", "Scope", "Plan", "Execute", "Verify", "Review", "Done"] as const;
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const date = (v: unknown): string | null => typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
const text = (v: unknown, max = 180): string | null => typeof v === "string" && /^[^\x00-\x1f\x7f]*$/.test(v) ? v.slice(0, max) : null;
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const allowedPath = (v: unknown): string | null => typeof v === "string" && v.length <= 240 && !/^[./]|[\\:\x00-\x1f\x7f]|(^|\/)\.\.?($|\/)|\/$/.test(v) && !/(^|\/)(?:\.env(?:\..*)?|\.npmrc|.*(?:secret|credential|token|service.account).*)(?:\/|$)/i.test(v) ? v : null;
const sensitive = ignore().add(SENSITIVE_PATTERNS);
const enumValue = (value: unknown, choices: readonly string[]): string | null => typeof value === "string" && choices.includes(value) ? value : null;
export function readJson(root: string, relative: string): Record<string, unknown> | null {
  const file = safePath(root, relative);
  try {
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) return null;
    return obj(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    return null;
  }
}
export function heartbeat(raw: unknown, now = Date.now()) {
  const beat = obj(raw);
  const pid = beat && Number.isSafeInteger(beat.pid) && (beat.pid as number) > 0 ? beat.pid as number : null;
  const session_id = beat && Number.isSafeInteger(beat.session_id) && (beat.session_id as number) > 0 ? beat.session_id as number : null;
  const observed = date(beat?.observed_utc);
  const age_seconds = observed && Date.parse(observed) <= now ? Math.floor((now - Date.parse(observed)) / 1000) : null;
  return { state: pid && session_id && observed && Date.parse(observed) <= now + 5000 && now - Date.parse(observed) < 10000 ? "heartbeat_fresh" : "unknown",
    pid, session_id, age_seconds };
}
export function pipeline(status: Record<string, unknown> | null, stopCategory: string | null = null): Record<(typeof stages)[number], Stage> {
  const result = Object.fromEntries(stages.map(s => [s, "unknown"])) as Record<(typeof stages)[number], Stage>;
  if (!status) return result;
  const transitions = Array.isArray(status.state_transition_history) ? status.state_transition_history.map(obj).filter((r): r is Record<string, unknown> => !!r) : [];
  const seen = new Set(transitions.map(r => r.to));
  const state = status.state;
  if (typeof state === "string") seen.add(state);
  if (!["PLANNING", "RESEARCHING", "EXECUTING", "VERIFYING", "READY_FOR_REVIEW", "DONE", "NEEDS_APPROVAL", "BLOCKED"].includes(String(state))) return result;
  result.Plan = seen.has("PLANNING") ? "complete" : "unknown";
  result.Research = seen.has("RESEARCHING") ? "complete" : "unknown";
  result.Scope = Array.isArray(status.edit_paths) && status.edit_paths.length > 0 ? "complete" : "unknown";
  result.Execute = seen.has("EXECUTING") ? "complete" : "not_started";
  result.Verify = status.verify_completed === true ? "complete" : seen.has("VERIFYING") ? "waiting" : "not_started";
  result.Review = seen.has("DONE") ? "complete" : seen.has("READY_FOR_REVIEW") ? "waiting" : "not_started";
  result.Done = state === "DONE" ? "complete" : "not_started";
  if (state === "RESEARCHING") result.Research = "active";
  if (state === "PLANNING") result.Plan = "active";
  if (state === "EXECUTING") result.Execute = "active";
  if (state === "VERIFYING") result.Verify = "active";
  if (state === "READY_FOR_REVIEW") result.Review = "waiting";
  if (state === "NEEDS_APPROVAL" && stopCategory === "EVIDENCE_INSUFFICIENT" && result.Verify !== "complete") result.Verify = "incomplete";
  if (state === "BLOCKED") {
    if (seen.has("VERIFYING") && result.Verify !== "complete") result.Verify = "blocked";
    else if (seen.has("EXECUTING")) result.Execute = "blocked";
  }
  return result;
}
const actors = new Set(["CHATGPT", "OPENCODE", "CODEX", "HUMAN", "REVIEW", "SYSTEM", "IDLE"]);
export function actor(v: unknown): string {
  if (typeof v !== "string") return "UNKNOWN";
  const normalized = v.trim().toUpperCase();
  return actors.has(normalized) ? normalized : "UNKNOWN";
}
export type DashboardEvent = { timestamp: string; event_type: string; actor: string; summary: string };
const auditActions = new Set(["research", "scope", "plan", "execute", "verify", "review", "complete", "transition"]);
const autonomousEventTypes = new Set(["autonomous.phase.started", "autonomous.decision.recorded", "codex.started", "codex.completed",
  "verify.started", "verify.completed", "retry.started", "review_handoff.started", "review.started", "review.completed", "human.final_approval_waiting"]);
const autonomousPhases = new Set(["RESEARCH", "PLAN", "EXECUTE", "VERIFY", "REVIEW_HANDOFF", "REVIEWING", "HUMAN_FINAL_APPROVAL", "ESCALATE", "DONE_CANDIDATE_NO_CHANGE", "READY_FOR_REVIEW"]);
const usage = (value: unknown) => {
  const row = obj(value);
  const cache = obj(row?.cache);
  const numeric = (key: string) => Number.isSafeInteger(row?.[key]) && (row?.[key] as number) >= 0 ? row?.[key] as number : null;
  return row ? { input: numeric("input"), output: numeric("output"), reasoning: numeric("reasoning"),
    cache_read: numeric("cache_read") ?? numeric("cacheRead") ?? (Number.isSafeInteger(cache?.read) ? cache?.read as number : null),
    cache_write: numeric("cache_write") ?? numeric("cacheWrite") ?? (Number.isSafeInteger(cache?.write) ? cache?.write as number : null) } : null;
};
export function eventsFor(root: string, taskId: string, status: Record<string, unknown> | null): DashboardEvent[] {
  if (!id.test(taskId)) throw new GatewayError("INVALID_ID", "Invalid task id");
  const events: DashboardEvent[] = [];
  if (Array.isArray(status?.state_transition_history)) for (const row of status.state_transition_history) {
    const r = obj(row), timestamp = date(r?.timestamp), to = text(r?.to, 40);
    if (timestamp && to && /^[A-Z_]+$/.test(to)) events.push({ timestamp, event_type: "state_transition", actor: "SYSTEM", summary: `State → ${to}` });
  }
  const file = safePath(root, `.ai/tasks/${taskId}/audit/coordinator-actions.jsonl`);
  try {
    if (fs.lstatSync(file).isFile() && fs.statSync(file).size <= 2 * 1024 * 1024) {
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-500)) {
        let row: Record<string, unknown> | null;
        try { row = obj(JSON.parse(line)); } catch { continue; }
        const timestamp = date(row?.timestamp), action = text(row?.action, 60);
        // Never return target, result, command, or arbitrary audit strings.
        if (timestamp && action && auditActions.has(action.toLowerCase())) events.push({ timestamp, event_type: action.toLowerCase(), actor: actor(row?.actor), summary: `${action.toLowerCase()} recorded` });
      }
    }
  } catch (error) { if (error instanceof GatewayError) throw error; }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-100);
}
const boundedId = /^bounded-[a-f0-9]{32}$/;
const sha256 = /^[a-f0-9]{64}$/;
const contractKeys = ["repo", "goal", "edit_paths", "acceptance_criteria", "task_kind", "execution_profile", "worker", "codex", "max_revisions", "timeout_ms"] as const;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const cleanString = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const boundedPath = (value: unknown): value is string => typeof value === "string" && value.length <= 240 &&
  !/^[./]|[\\:\x00-\x1f\x7f]|\/$/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..") &&
  !/(^|\/)(?:\.env(?:\..*)?|\.npmrc|.*(?:secret|credential|token|service.account).*)(?:\/|$)/i.test(value) && !sensitive.ignores(value);
function boundedProjection(raw: Record<string, unknown> | null, taskId: string) {
  if (!raw || raw.version !== 2 || raw.task_id !== taskId || !sha256.test(String(raw.contract_sha256)) ||
      !["RUNNING", "REVIEW_PENDING", "REVIEW_ACCEPTED", "ESCALATE"].includes(String(raw.state))) return null;
  const contract = obj(raw.contract), revisions = raw.revisions;
  if (!contract || !exactKeys(contract, contractKeys) || !cleanString(contract.repo, 180) || !cleanString(contract.goal, 2000) ||
      !Array.isArray(contract.edit_paths) || contract.edit_paths.length < 1 || contract.edit_paths.length > 3 ||
      !contract.edit_paths.every(boundedPath) || new Set(contract.edit_paths).size !== contract.edit_paths.length ||
      !Array.isArray(contract.acceptance_criteria) || contract.acceptance_criteria.length === 0 ||
      !contract.acceptance_criteria.every((entry: unknown) => cleanString(entry, 500)) ||
      contract.task_kind !== "text_change" || contract.execution_profile !== "tracked_typescript_dashboard" ||
      contract.worker !== "opencode" || !obj(contract.codex) || !exactKeys(obj(contract.codex)!, ["allowed", "max_calls"]) ||
      obj(contract.codex)!.allowed !== false || obj(contract.codex)!.max_calls !== 0 ||
      !Number.isInteger(contract.max_revisions) || (contract.max_revisions as number) < 1 || (contract.max_revisions as number) > 3 ||
      !Number.isInteger(contract.timeout_ms) || (contract.timeout_ms as number) < 1000 || (contract.timeout_ms as number) > 600000 ||
      !Array.isArray(revisions) || revisions.length > (contract.max_revisions as number)) return null;
  const canonical = Object.fromEntries(contractKeys.map(key => [key, contract[key]]));
  if (createHash("sha256").update(JSON.stringify(canonical)).digest("hex") !== raw.contract_sha256) return null;
  for (const [index, item] of revisions.entries()) {
    const revision = obj(item), worker = obj(revision?.worker);
    if (!revision || revision.revision !== index + 1 || !sha256.test(String(revision.manifest_sha256)) ||
        !obj(revision.verify) || !Array.isArray(revision.files) || !revision.files.every((file: unknown) => !!obj(file)) ||
        !worker || worker.worker !== "opencode" || !cleanString(worker.session_id, 500) || !cleanString(worker.execution_id, 500) ||
        !["provider", "model"].every(key => worker[key] === null || cleanString(worker[key], 500)) ||
        !(worker.usage === null || !!obj(worker.usage)) || worker.state !== "completed" ||
        !(worker.tools === null || typeof worker.tools === "number" && Number.isFinite(worker.tools) && worker.tools >= 0)) return null;
    if (revision.review !== undefined) {
      const review = obj(revision.review);
      if (!review || review.task_id !== taskId || review.revision !== revision.revision ||
          review.contract_sha256 !== raw.contract_sha256 || review.manifest_sha256 !== revision.manifest_sha256 ||
          review.reviewer !== "chatgpt" || !["PASS", "NEEDS_WORK"].includes(String(review.verdict))) return null;
    }
  }
  const latest = obj(revisions.at(-1)), review = obj(latest?.review);
  if ((raw.state === "REVIEW_PENDING" || raw.state === "REVIEW_ACCEPTED") && !latest) return null;
  if (raw.state === "REVIEW_ACCEPTED" && review?.verdict !== "PASS") return null;
  if (raw.stop_reason !== undefined && raw.stop_reason !== null && !cleanString(raw.stop_reason, 500)) return null;
  return { task_id: taskId, state: raw.state as string, stop_reason_present: raw.stop_reason !== undefined && raw.stop_reason !== null,
    contract_sha256: raw.contract_sha256 as string,
    goal: (contract.goal as string).replace(/[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").trim().slice(0, 500),
    edit_paths: contract.edit_paths as string[],
    latest_revision: latest?.revision as number | undefined ?? null, manifest_sha256: latest?.manifest_sha256 as string | undefined ?? null,
    verification_present: !!latest && Object.hasOwn(latest, "verify"), file_count: Array.isArray(latest?.files) ? latest.files.length : null,
    worker: "opencode", review_verdict: review?.verdict as string | undefined ?? null };
}
export class Collector {
  constructor(public readonly roots: Roots = REPOS, public readonly reviewRoot = REVIEW_ROOT, public readonly queueRoot = QUEUE,
    private readonly osProbe: () => Promise<OsHealth> = roots === REPOS ? observeOsHealth : async () => normalizeOsHealth(null),
    private readonly autonomousReviewProfiles: Readonly<Record<string, Pick<ReviewProfile, "workspace">>> = reviewProfiles) {}
  boundedTask(taskId: string) {
    if (!boundedId.test(taskId)) return null;
    try {
      const root = getStateDir();
      const dir = safePath(root, `bounded-v2/tasks/${taskId}`);
      if (!fs.lstatSync(dir).isDirectory()) return null;
      return boundedProjection(readJson(root, `bounded-v2/tasks/${taskId}/task.json`), taskId);
    } catch { return null; }
  }
  boundedTasks(limit = 20) {
    try {
      const root = getStateDir();
      const dir = safePath(root, "bounded-v2/tasks");
      return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && boundedId.test(entry.name))
        .map(entry => this.boundedTask(entry.name)).filter((task): task is NonNullable<typeof task> => task !== null)
        .sort((a, b) => a.task_id.localeCompare(b.task_id)).slice(0, Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0);
    } catch { return []; }
  }
  private jobs(): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    const dir = safePath(this.reviewRoot, "rpc-jobs");
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !id.test(entry.name)) continue;
        const job = readJson(this.reviewRoot, `rpc-jobs/${entry.name}/job.json`);
        if (job?.job_id === entry.name && typeof job.task_id === "string" && id.test(job.task_id) && Object.hasOwn(this.roots, String(job.repo_key))) map.set(job.task_id, job);
      }
    } catch (error) { if (error instanceof GatewayError) throw error; }
    return map;
  }
  autonomousRuns(limit = 20) {
    const dir = safePath(this.reviewRoot, "rpc-jobs");
    const runs = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^auto-[a-f0-9]{32}$/.test(entry.name)) continue;
        const run = readJson(this.reviewRoot, `rpc-jobs/${entry.name}/autonomous-run.json`);
        if (!run || run.run_id !== entry.name || run.task_id !== `rpc-${entry.name.slice(5)}` ||
            typeof run.repo_key !== "string" || !Object.hasOwn(reviewProfiles, run.repo_key) ||
            !Object.hasOwn(this.autonomousReviewProfiles, run.repo_key)) continue;
        const profile = this.autonomousReviewProfiles[run.repo_key];
        const result = readJson(this.reviewRoot, `rpc-jobs/${entry.name}/result.json`);
        const ledger = readJson(profile.workspace, `.ai/tasks/${run.task_id}/status.json`);
        const phase = enumValue(run.phase, [...autonomousPhases]);
        const progress = phase === "REVIEWING" ? readJson(this.reviewRoot, `rpc-jobs/review-progress/${run.task_id}.json`) : null;
        const projected = autonomousState(run, result, ledger, run.task_id as string);
        const { done, actor } = projected;
        const eventFile = safePath(this.reviewRoot, `rpc-jobs/${entry.name}/events.jsonl`);
        let events: DashboardEvent[] = [];
        if (fs.existsSync(eventFile) && fs.statSync(eventFile).size <= 65536) {
          events = fs.readFileSync(eventFile, "utf8").split(/\r?\n/).slice(-100).flatMap(line => {
            try {
              const record = obj(JSON.parse(line)), type = text(record?.event_type, 50), timestamp = date(record?.timestamp);
              return type && autonomousEventTypes.has(type) && timestamp ? [{ timestamp, event_type: type,
                actor: type.startsWith("codex.") ? "CODEX" : type.startsWith("review") ? "REVIEW" : type.startsWith("human.") ? "HUMAN" : "OPENCODE",
                summary: `${type} recorded` }] : [];
            } catch { return []; }
          });
        }
        const live_stage = progress?.task_id === run.task_id && ["STRUCTURAL_REVIEW", "SEMANTIC_REVIEW"].includes(String(progress.phase)) ? progress.phase :
          phase === "VERIFY" && events.map(e => e.event_type).lastIndexOf("retry.started") > events.map(e => e.event_type).lastIndexOf("verify.completed") ? "RETRY_VERIFY" : phase;
        const decisionFile = safePath(this.reviewRoot, `rpc-jobs/${entry.name}/decision-history.jsonl`);
        let decision: string | null = null;
        if (fs.existsSync(decisionFile) && fs.statSync(decisionFile).size <= 65536) {
          try {
            const lines = fs.readFileSync(decisionFile, "utf8").split(/\r?\n/).filter(Boolean);
            const last = obj(JSON.parse(lines.at(-1) ?? "null"));
            if (last?.run_id === entry.name) decision = enumValue(last.decision, ["NO_CHANGE_REQUIRED", "CONTINUE_RESEARCH", "PLAN_CHANGE",
              "EXECUTE_WITH_CODEX", "READY_FOR_REVIEW", "RETRY_VERIFY", "RESEARCH_AGAIN", "VERIFY_BLOCKED", "ESCALATE"]);
          } catch { /* unknown, not a success inference */ }
        }
        runs.push({ run_id: entry.name, task_id: run.task_id, repo: run.repo_key, phase, live_stage, actor,
          decision,
          review_phase: enumValue(projected.review_phase.structural, ["PASS", "NEEDS_WORK"]) && enumValue(projected.review_phase.semantic, ["PASS", "NEEDS_WORK", "NOT_RUN"]) ?
            projected.review_phase : null,
          human_action_required: projected.waiting, final_result: enumValue(result?.state, [...autonomousPhases]),
          done, usage: { opencode: usage(run.token_usage_total), codex_invocations: Number.isSafeInteger(run.codex_invocation_count) ? run.codex_invocation_count : null,
            codex: usage(run.codex_usage), review: usage(run.review_token_usage) }, events, started_at: date(run.started_at) });
      }
    } catch (error) { if (error instanceof GatewayError) throw error; }
    return runs.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? "")).slice(0, limit);
  }
  list(limit = 20) {
    const jobs = this.jobs();
    const ids = new Set<string>(jobs.keys());
    for (const root of Object.values(this.roots)) {
      const dir = safePath(root, ".ai/tasks");
      try { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && id.test(entry.name)) ids.add(entry.name); }
      catch (error) { if (error instanceof GatewayError) throw error; }
    }
    const tasks = [];
    for (const taskId of ids) {
      try { tasks.push(this.task(taskId, jobs)); }
      catch (error) { if (!(error instanceof GatewayError) || !["NOT_FOUND", "AMBIGUOUS_TASK", "INVALID_EVIDENCE"].includes(error.code)) throw error; }
    }
    return tasks.sort((a, b) => (b.updated_at ?? b.created_at ?? "").localeCompare(a.updated_at ?? a.created_at ?? "")).slice(0, limit);
  }
  task(taskId: string, jobs = this.jobs()) {
    if (!id.test(taskId)) throw new GatewayError("INVALID_ID", "Invalid task id");
    let ledger: ReturnType<typeof ledgerTask> | null = null;
    try { ledger = ledgerTask(taskId, this.roots); } catch (error) { if (!(error instanceof GatewayError) || error.code !== "NOT_FOUND") throw error; }
    const job = jobs.get(taskId);
    if (!ledger && !job) throw new GatewayError("NOT_FOUND", "Unknown task");
    if (ledger && job && ledger.repo !== job.repo_key) throw new GatewayError("AMBIGUOUS_TASK", "Registry and ledger repo mismatch");
    const repo = (ledger?.repo ?? job?.repo_key) as keyof typeof REPOS;
    const status = ledger?.status ?? null;
    const decision = status?.state === "DONE" ? readJson(this.roots[repo], `.ai/tasks/${taskId}/review-decision.json`) : null;
    const integration = status?.state === "DONE" ? readJson(this.roots[repo], `.ai/tasks/${taskId}/integration-completion.json`) : null;
    const transitions = Array.isArray(status?.state_transition_history) ? status.state_transition_history.map(obj).filter((x): x is Record<string, unknown> => !!x) : [];
    const created_at = date(transitions[0]?.timestamp) ?? date(job?.started_at);
    const completed_at = status?.state === "DONE" ? date(integration?.completed_at) ?? date([...transitions].reverse().find(x => x.to === "DONE")?.timestamp) : null;
    // Gateway's normalization is authoritative for registered jobs and durable rpc ledger tasks.
    let normalized: ReturnType<typeof getOrchestrationStatus> | null = null;
    if (this.roots === REPOS && this.reviewRoot === REVIEW_ROOT && taskId.startsWith("rpc-")) {
      try { normalized = getOrchestrationStatus(taskId); } catch { /* incomplete evidence remains unknown */ }
    }
    const edit_paths = Array.isArray(status?.edit_paths) ? status.edit_paths.map(allowedPath).filter((x): x is string => !!x && !sensitive.ignores(x)).slice(0, 20) : null;
    return { task_id: taskId, repo, state: enumValue(status?.state, ["PLANNING", "RESEARCHING", "EXECUTING", "VERIFYING", "READY_FOR_REVIEW", "NEEDS_APPROVAL", "BLOCKED", "DONE"]) ?? enumValue(normalized?.state, ["DONE"]) ?? null, mode: job?.mode === "read_only" ? "read_only" : status ? "change" : null,
      actor: actor(transitions.at(-1)?.actor), created_at, started_at: date(job?.started_at) ?? created_at, completed_at,
      updated_at: date(status?.last_updated) ?? date(job?.started_at), elapsed_seconds: created_at ? Math.max(0, Math.floor(((completed_at ? Date.parse(completed_at) : Date.now()) - Date.parse(created_at)) / 1000)) : null,
      attempt: Number.isInteger(job?.attempt) ? job?.attempt : Number.isInteger(status?.attempt) ? status?.attempt : null,
      retry_of: typeof (job?.retry_of ?? status?.retry_of) === "string" && id.test(String(job?.retry_of ?? status?.retry_of)) ? String(job?.retry_of ?? status?.retry_of) : null,
      stop_reason_category: normalized?.stop_reason_category ?? null,
      stop_reason_summary: normalized?.stop_reason_category ? `${normalized.stop_reason_category} recorded; inspect authorized evidence for details.` : null,
      human_action_required: normalized?.human_action_required ?? null,
      recommended_next_action: normalized?.recommended_next_action ?? null, edit_paths,
      verification: status ? { completed: status.verify_completed === true, exit_code: Number.isInteger(status.verify_exit_code) ? status.verify_exit_code : null } : null,
      review_bundle: decision?.task_id === taskId && typeof decision.review_bundle === "string" && /^reviews\/[A-Za-z0-9._-]{1,100}$/.test(decision.review_bundle) && !decision.review_bundle.includes("..") ? decision.review_bundle : null,
      review_result: decision?.task_id === taskId ? enumValue(decision.review_result, ["PASS", "FAIL"]) : null,
      completion_mode: decision?.task_id === taskId ? enumValue(decision.completion_mode, ["post_integration", "direct"]) : null,
      integrated_commit: integration?.task_id === taskId && /^[a-f0-9]{40}$/.test(String(integration.integrated_commit)) ? integration.integrated_commit : null,
      pipeline: pipeline(status, normalized?.stop_reason_category ?? enumValue(status?.stop_reason_category, ["EVIDENCE_INSUFFICIENT"]) ?? null), process: normalized?.process ?? "unknown" };
  }
  events(taskId: string) {
    const task = this.task(taskId);
    let status: Record<string, unknown> | null = null;
    try { status = ledgerTask(taskId, this.roots).status; } catch (error) { if (!(error instanceof GatewayError) || error.code !== "NOT_FOUND") throw error; }
    return eventsFor(this.roots[task.repo], taskId, status);
  }
  async health() {
    const verified_health = await verifiedHealth(this.osProbe);
    const beat = heartbeat(readJson(this.queueRoot, "heartbeat.json"));
    const queue_depth = queueDepth(this.queueRoot);
    return { execution_bridge: verified_health.execution_bridge.status, review_bridge: verified_health.review_bridge.status,
      tunnel: verified_health.tunnel.status, codex_worker: verified_health.codex_worker.status, interactive_session: verified_health.interactive_session.status,
      worker_pid: verified_health.codex_worker.status === "ready" ? verified_health.codex_worker.pid : null,
      session_id: verified_health.interactive_session.status === "verified" ? verified_health.interactive_session.session_id : null, heartbeat: beat.state,
      verified_health,
      last_known_pid: beat.pid, last_known_session: beat.session_id, last_heartbeat_age_seconds: beat.age_seconds, queue_depth };
  }
  private activeQueueTask(tasks: ReturnType<Collector["list"]>) {
    const beat = heartbeat(readJson(this.queueRoot, "heartbeat.json"));
    return activeQueueTask(this.queueRoot, this.roots, tasks, beat.state === "heartbeat_fresh");
  }
  async snapshot() {
    const tasks = this.list(Infinity);
    const stopped = new Set(["NEEDS_APPROVAL", "READY_FOR_REVIEW", "DONE", "BLOCKED"]);
    const current = tasks.find(t => t.process === "running" && !stopped.has(t.state ?? "")) ?? this.activeQueueTask(tasks);
    const latest = tasks[0] ?? null;
    const autonomous_runs = this.autonomousRuns();
    return { generated_at: new Date().toISOString(), health: await this.health(), current_task: current ?? null,
      latest_task: latest, recent_tasks: tasks.slice(0, 20), autonomous_runs, bounded_tasks: this.boundedTasks() };
  }
}
