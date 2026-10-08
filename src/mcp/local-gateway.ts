import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IgnoreRules } from "../workspace/ignore.js";
import { reviewProfiles, reviewWorkspaces } from "./review-profiles.js";
import { autonomousObservation } from "./autonomous-gateway.js";
import { deployment } from "../config/deployment.js";

export const REVIEW_ROOT = deployment.reviewRoot;
export const REPOS = {
  "pve-doc": deployment.pveDocsRoot,
  "ai-orchestration-config": deployment.configRoot,
} as const;
/** Filesystem locations for legacy read-only lookup. Logical identities remain fixed in REPOS. */
export type LedgerReadRoots = Readonly<Record<keyof typeof REPOS, string>>;
/** Trusted in-process composition only; never a tool argument or mutation dependency. */
export type OrchestrationReadDependencies = Readonly<{ reviewRoot: string; repoRoots: LedgerReadRoots }>;
const READ_ONLY_WORKER = fileURLToPath(new URL("./read-only-worker.js", import.meta.url));
export type OrchestrationMode = "read_only" | "change" | "autonomous";
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export class GatewayError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// Reject all reparse points (including Windows junctions) at every existing component.
export function safePath(root: string, relative = ""): string {
  if (relative && (path.isAbsolute(relative) || /[\\:]|(^|\/)\.{1,2}(\/|$)|\/\//.test(relative) || relative.startsWith("/"))) {
    throw new GatewayError("INVALID_PATH", "Invalid relative path");
  }
  const resolvedRoot = path.resolve(root);
  const base = path.parse(resolvedRoot).root;
  let current = base;
  for (const part of path.relative(base, path.resolve(root, ...relative.split("/").filter(Boolean))).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new GatewayError("INVALID_PATH", "Reparse or escaped path");
      }
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const target = path.resolve(root, ...relative.split("/").filter(Boolean));
  if (target.toLowerCase() !== resolvedRoot.toLowerCase() && !target.toLowerCase().startsWith(resolvedRoot.toLowerCase() + path.sep)) {
    throw new GatewayError("INVALID_PATH", "Outside workspace");
  }
  return target;
}

function jsonFile(file: string): Record<string, unknown> {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new GatewayError("INVALID_EVIDENCE", "Invalid JSON object");
  return data as Record<string, unknown>;
}

export function verifyBundleIntegrity(bundle?: string, root = REVIEW_ROOT) {
  if (bundle === undefined && !fs.existsSync(safePath(root, "CURRENT_REVIEW.json"))) {
    return { bundle: null, valid: false, issues: [{ kind: "missing" as const, path: "CURRENT_REVIEW.json" }] };
  }
  const pointer = bundle === undefined ? jsonFile(safePath(root, "CURRENT_REVIEW.json")).review_bundle : bundle;
  if (typeof pointer !== "string" || !/^reviews\/[a-zA-Z0-9._-]+$/.test(pointer) || pointer.includes("..")) {
    throw new GatewayError("INVALID_PATH", "Only published review bundles under reviews/ are allowed");
  }
  const dir = safePath(root, pointer);
  const issues: { kind: "missing" | "mismatch" | "extra" | "invalid"; path: string }[] = [];
  const report = (kind: "missing" | "mismatch" | "extra" | "invalid", file: string) => issues.push({ kind, path: file });
  const metadataPath = safePath(root, `${pointer}/review-bundle.json`);
  const manifestPath = safePath(root, `${pointer}/manifest.json`);
  for (const [name, file] of [["review-bundle.json", metadataPath], ["manifest.json", manifestPath]]) {
    if (!fs.existsSync(file)) report("missing", name);
  }
  if (issues.length) return { bundle: pointer, valid: false, issues };
  let metadata: Record<string, unknown>, manifest: Record<string, unknown>;
  try { metadata = jsonFile(metadataPath); manifest = jsonFile(manifestPath); }
  catch { return { bundle: pointer, valid: false, issues: [{ kind: "invalid" as const, path: "metadata/manifest" }] }; }
  if (metadata.version !== 1 || manifest.version !== 1 || !Array.isArray(manifest.files)) report("invalid", "metadata/manifest");
  if (typeof metadata.task_id !== "string" || !idPattern.test(metadata.task_id) ||
    typeof metadata.source_workspace !== "string" || ![...Object.values(REPOS), ...reviewWorkspaces].some((repo) => repo.toLowerCase() === (metadata.source_workspace as string).toLowerCase())) {
    report("invalid", "review-bundle.json");
  }
  if (typeof metadata.manifest_sha256 !== "string" || metadata.manifest_sha256 !== hash(fs.readFileSync(manifestPath))) report("mismatch", "manifest.json");
  const listed = new Set<string>();
  if (Array.isArray(manifest.files)) for (const raw of manifest.files) {
    if (!raw || typeof raw !== "object") { report("invalid", "manifest entry"); continue; }
    const entry = raw as Record<string, unknown>;
    const name = entry.path;
    if (typeof name !== "string" || !name || name === "manifest.json" || name === "review-bundle.json" ||
      !/^[a-f0-9]{64}$/.test(String(entry.sha256)) || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      report("invalid", String(name).slice(0, 120)); continue;
    }
    let file: string;
    try { file = safePath(root, `${pointer}/${name}`); if (!file.toLowerCase().startsWith(dir.toLowerCase() + path.sep)) throw new Error("outside bundle"); }
    catch { report("invalid", name.slice(0, 120)); continue; }
    if (listed.has(name)) { report("invalid", name); continue; }
    listed.add(name);
    if (!fs.existsSync(file)) { report("missing", name); continue; }
    if (!fs.statSync(file).isFile()) { report("invalid", name); continue; }
    if (fs.statSync(file).size !== entry.size || hash(fs.readFileSync(file)) !== entry.sha256) report("mismatch", name);
  }
  const walk = (directory: string, prefix = "") => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      try { safePath(root, `${pointer}/${name}`); } catch { report("invalid", name); continue; }
      if (item.isDirectory()) walk(path.join(directory, item.name), name);
      else if (!item.isFile()) report("invalid", name);
      else if (name !== "manifest.json" && name !== "review-bundle.json" && !listed.has(name)) report("extra", name);
    }
  };
  walk(dir);
  if (bundle === undefined) {
    const current = jsonFile(safePath(root, "CURRENT_REVIEW.json"));
    if (current.task_id !== metadata.task_id || current.source_workspace !== metadata.source_workspace) report("invalid", "CURRENT_REVIEW.json");
  }
  if (!listed.size) report("invalid", "manifest.files");
  return { bundle: pointer, valid: issues.length === 0, issues };
}

export function startTestJob(root = REVIEW_ROOT) {
  const dir = safePath(root, "rpc-test");
  fs.mkdirSync(dir, { recursive: true });
  const request_id = randomUUID();
  const marker = { request_id, timestamp: new Date().toISOString(), marker: "rpc-test", source: "chatgpt-mcp" };
  fs.writeFileSync(safePath(root, `rpc-test/${request_id}.json`), JSON.stringify(marker), { flag: "wx" });
  return marker;
}

export function completeOrchestration(_taskId: string, _reviewResult: string, _doneApproved: boolean): never {
  throw new GatewayError("LEGACY_COMPLETION_DISABLED", "Legacy authoritative completion is disabled; caller PASS / DoneApproved is historical evidence, not authority. An RC-02 bound request is required.");
}

export function completeIntegratedOrchestration(_taskId: string, _reviewResult: string, _doneApproved: boolean): never {
  throw new GatewayError("LEGACY_COMPLETION_DISABLED", "Legacy integrated authoritative completion is disabled; an RC-02 bound request is required.");
}

type Job = { job_id: string; task_id: string; mode?: OrchestrationMode; process_id: number; repo_key: keyof typeof REPOS; started_at: string;
  goal_sha256: string; goal?: string; edit_paths?: string[]; stdout_path: string; stderr_path: string; exit_code?: number | null;
  parent_task_id?: string; retry_of?: string; retry_reason?: string; attempt?: number };
function jobFile(root: string, id: string): string {
  if (!idPattern.test(id)) throw new GatewayError("INVALID_ID", "Invalid job id");
  return safePath(root, `rpc-jobs/${id}/job.json`);
}
function readJob(root: string, id: string): Job {
  const file = jobFile(root, id);
  if (!fs.existsSync(file)) throw new GatewayError("NOT_FOUND", "Unknown job");
  const job = jsonFile(file) as unknown as Job;
  if (job.job_id !== id || !idPattern.test(job.task_id) || !Object.hasOwn(REPOS, job.repo_key) ||
    (job.mode !== undefined && job.mode !== "read_only" && job.mode !== "change") ||
    (job.goal !== undefined && (typeof job.goal !== "string" || hash(job.goal) !== job.goal_sha256)) ||
    (job.edit_paths !== undefined && (!Array.isArray(job.edit_paths) || job.edit_paths.some((item) => typeof item !== "string"))) ||
    (job.parent_task_id !== undefined && (typeof job.parent_task_id !== "string" || !idPattern.test(job.parent_task_id))) ||
    (job.retry_of !== undefined && (typeof job.retry_of !== "string" || !idPattern.test(job.retry_of))) ||
    (job.attempt !== undefined && (!Number.isInteger(job.attempt) || job.attempt < 1 || job.attempt > 3))) throw new GatewayError("INVALID_EVIDENCE", "Invalid job registry");
  return job;
}
function running(job: Job): boolean {
  if (job.exit_code !== undefined) return false;
  try { process.kill(job.process_id, 0); return true; } catch { return false; }
}
function repoRoot(key: keyof typeof REPOS): string {
  const repo = REPOS[key];
  if (!fs.statSync(repo).isDirectory() || fs.realpathSync.native(repo).toLowerCase() !== path.resolve(repo).toLowerCase()) {
    throw new GatewayError("INVALID_REPO", "Allowlisted repo root is not a real directory");
  }
  return repo;
}

function readRepoRoot(key: keyof typeof REPOS, roots: LedgerReadRoots): string {
  if (roots === REPOS) return repoRoot(key);
  if (!Object.hasOwn(REPOS, key) || !Object.hasOwn(roots, key) || typeof roots[key] !== "string") {
    throw new GatewayError("INVALID_REPO", "Unknown read repository");
  }
  const root = safePath(roots[key]);
  if (!fs.statSync(root).isDirectory() || fs.realpathSync.native(root).toLowerCase() !== path.resolve(root).toLowerCase()) {
    throw new GatewayError("INVALID_REPO", "Read repo root is not a real directory");
  }
  return root;
}

export function validateEditPaths(repo: string, paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 5) throw new GatewayError("INVALID_EDIT_PATHS", "Provide 1-5 edit paths");
  const rules = new IgnoreRules(repo);
  const unique = new Map<string, string>();
  for (const input of paths) {
    if (typeof input !== "string" || !input || input.length > 240 ||
      /[\x00-\x1f\x7f\\:<>"|?*\[\]{}]/.test(input) || input.startsWith("/") || input.endsWith("/") || input.includes("//") ||
      input.split("/").some((part) => part === "." || part === ".." || !part || part.endsWith(".") || part.endsWith(" ") || part === ".git" || part === ".ai")) {
      throw new GatewayError("INVALID_EDIT_PATHS", "Only existing repo-relative files without traversal, globs or reparse points are allowed");
    }
    let file: string;
    try {
      file = safePath(repo, input);
      if (!fs.statSync(file).isFile()) throw new Error("Not a file");
    } catch { throw new GatewayError("INVALID_EDIT_PATHS", "Edit path must be an existing regular file inside the repository"); }
    const relative = path.relative(fs.realpathSync.native(repo), fs.realpathSync.native(file)).split(path.sep).join("/").normalize("NFC");
    if (!relative || relative.startsWith("../") || rules.isSensitive(relative)) throw new GatewayError("INVALID_EDIT_PATHS", "Protected or outside edit path");
    unique.set(relative.toLowerCase(), relative);
  }
  return [...unique.values()];
}

export function startOrchestration(repo: string, goal: string, mode: OrchestrationMode, root = REVIEW_ROOT, editPaths?: string[]) {
  // Preserve pure identity rejection without consulting profiles on disk or dispatching a controller.
  if (mode === "autonomous" && !Object.hasOwn(REPOS, repo) && !Object.hasOwn(reviewProfiles, repo)) {
    throw new GatewayError("INVALID_REPO", "Unknown autonomous repository key");
  }
  return launchOrchestration(repo, goal, mode, root, editPaths);
}
function launchOrchestration(repo: string, goal: string, mode: OrchestrationMode, root: string, editPaths?: string[]) {
  if (mode !== "autonomous" && !Object.hasOwn(REPOS, repo)) throw new GatewayError("INVALID_REPO", "Unknown repository key");
  // Before any filesystem repository inspection, registry writes or dispatch.
  if (mode === "change" || mode === "autonomous") throw new GatewayError("FRESH_REQUEST_REQUIRED",
    "Legacy change/autonomous start is quarantined; an RC-02 bound request is required. Read-only inspection remains available.");
  if (mode !== "read_only") throw new GatewayError("INVALID_MODE", "Only read_only inspection is available");
  if (mode === "read_only" && editPaths !== undefined) throw new GatewayError("INVALID_EDIT_PATHS", "read_only does not accept edit_paths");
  if (typeof goal !== "string" || !goal.trim() || goal.length > 4000 || /[\x00-\x1f\x7f]/.test(goal)) {
    throw new GatewayError("INVALID_GOAL", "Goal must be nonempty, at most 4000 characters, without control characters");
  }
  const key = repo as keyof typeof REPOS;
  const repoPath = repoRoot(key);
  if (mode === "read_only" && !fs.existsSync(READ_ONLY_WORKER)) throw new GatewayError("RUNTIME_UNAVAILABLE", "Read-only worker not built");
  const jobsDir = safePath(root, "rpc-jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  for (const id of fs.readdirSync(jobsDir)) {
    if (!idPattern.test(id) || !fs.existsSync(jobFile(root, id))) continue;
    const previous = readJob(root, id);
    if (previous.repo_key === key && running(previous)) throw new GatewayError("REPO_BUSY", "An RPC job is already running for this repository");
  }
  const job_id = randomUUID();
  const task_id = `rpc-${job_id.replaceAll("-", "")}`;
  const dir = safePath(root, `rpc-jobs/${job_id}`);
  fs.mkdirSync(dir);
  const stdout_path = safePath(root, `rpc-jobs/${job_id}/stdout.log`);
  const stderr_path = safePath(root, `rpc-jobs/${job_id}/stderr.log`);
  const out = fs.openSync(stdout_path, "wx"), err = fs.openSync(stderr_path, "wx");
  let child;
  try {
    child = spawn(process.execPath, [READ_ONLY_WORKER, key, job_id, task_id],
      { cwd: repoPath, shell: false, stdio: ["ignore", out, err], windowsHide: true });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  if (!child.pid) throw new GatewayError("RUNTIME_UNAVAILABLE", "Could not start read-only worker");
  const job: Job = { job_id, task_id, mode, process_id: child.pid, repo_key: key, started_at: new Date().toISOString(), goal_sha256: hash(goal),
    goal, stdout_path, stderr_path };
  const file = jobFile(root, job_id);
  fs.writeFileSync(file, JSON.stringify(job), { flag: "wx" });
  child.on("exit", (code) => {
    try { fs.writeFileSync(file, JSON.stringify({ ...job, exit_code: code })); } catch { /* best effort registry update */ }
  });
  child.on("error", () => {
    try { fs.writeFileSync(file, JSON.stringify({ ...job, exit_code: null })); } catch { /* best effort */ }
  });
  child.unref();
  return { job_id, task_id, repo: key, mode, started_at: job.started_at,
    parent_task_id: null, retry_of: null, attempt: 1 };
}

function findJob(id: string, root: string): Job {
  if (!idPattern.test(id)) throw new GatewayError("INVALID_ID", "Invalid job/task id");
  const dir = safePath(root, "rpc-jobs");
  if (!fs.existsSync(dir)) throw new GatewayError("NOT_FOUND", "Unknown job");
  if (fs.existsSync(jobFile(root, id))) return readJob(root, id);
  for (const candidate of fs.readdirSync(dir)) {
    if (idPattern.test(candidate) && fs.existsSync(jobFile(root, candidate))) {
      const job = readJob(root, candidate);
      if (job.task_id === id) return job;
    }
  }
  throw new GatewayError("NOT_FOUND", "Unknown job/task id");
}
// Registry IDs take precedence. Only a syntactically valid task ID can fall back
// to the two fixed engine ledgers; no repository or directory is caller-selected.
export function ledgerTask(id: string, roots: Readonly<Record<keyof typeof REPOS, string>> = REPOS): { repo: keyof typeof REPOS; status: Record<string, unknown> } {
  if (!idPattern.test(id)) throw new GatewayError("INVALID_ID", "Invalid task id");
  const matches: { repo: keyof typeof REPOS; status: Record<string, unknown> }[] = [];
  for (const key of Object.keys(REPOS) as (keyof typeof REPOS)[]) {
    const root = roots === REPOS ? repoRoot(key) : roots[key];
    const file = safePath(root, `.ai/tasks/${id}/status.json`);
    if (!fs.existsSync(file)) continue;
    const status = jsonFile(file);
    if (status.task_id !== id || typeof status.state !== "string") throw new GatewayError("INVALID_EVIDENCE", "Task ledger identity mismatch");
    matches.push({ repo: key, status });
  }
  if (matches.length > 1) throw new GatewayError("AMBIGUOUS_TASK", "Task exists in multiple allowlisted repositories");
  if (!matches.length) throw new GatewayError("NOT_FOUND", "Unknown job/task id");
  return matches[0];
}
function lookupForRead(id: string, root: string, roots: LedgerReadRoots): { job: Job | null; repo: keyof typeof REPOS; status: Record<string, unknown> | null } {
  try {
    const job = findJob(id, root);
    return { job, repo: job.repo_key, status: (job.mode ?? "change") === "change" ? readTaskEvidence(readRepoRoot(job.repo_key, roots), job.task_id) : null };
  } catch (error) {
    if (!(error instanceof GatewayError) || error.code !== "NOT_FOUND" || !/^rpc-[a-zA-Z0-9_-]{1,75}$/.test(id)) throw error;
    const { repo, status } = ledgerTask(id, roots);
    return { job: null, repo, status };
  }
}
function evidence(job: Job) {
  return readTaskEvidence(repoRoot(job.repo_key), job.task_id);
}

/** Preserve stored autonomous evidence, but never project legacy local DONE as authority. */
function legacyAutonomousObservation(id: string, root: string) {
  const observation = autonomousObservation(id, root);
  if (!observation) return null;
  const done = observation.state === "DONE" || observation.result_category === "DONE" || observation.done_state === "DONE";
  return { ...observation, authoritative_done: false,
    result_category: done ? "LEGACY_LOCAL_DONE" : observation.result_category,
    final_result: done ? "LEGACY_LOCAL_DONE" : observation.final_result,
    done_state: done ? "LEGACY_LOCAL_DONE" : observation.done_state };
}
function readTaskEvidence(repo: string, taskId: string) {
  const file = safePath(repo, `.ai/tasks/${taskId}/status.json`);
  if (!fs.existsSync(file)) return null;
  const status = jsonFile(file);
  if (status.task_id !== taskId || typeof status.state !== "string") throw new GatewayError("INVALID_EVIDENCE", "Task ledger identity mismatch");
  return status;
}
function readOnlyEvidence(job: Job, root: string) {
  const file = safePath(root, `rpc-jobs/${job.job_id}/read-only-result.json`);
  if (!fs.existsSync(file)) return null;
  const result = jsonFile(file);
  if (result.version !== 1 || result.mode !== "read_only" || result.task_id !== job.task_id ||
    result.state !== "DONE" || typeof result.summary !== "string" || typeof result.updated_at !== "string" ||
    !result.verification || typeof result.verification !== "object" ||
    (result.verification as Record<string, unknown>).completed !== true || (result.verification as Record<string, unknown>).exit_code !== 0 ||
    !Array.isArray(result.changed_paths) ||
    result.changed_paths.length !== 0 || result.published !== false) throw new GatewayError("INVALID_EVIDENCE", "Invalid read-only result");
  return result;
}
function resultLine(job: Job, root: string): string | null {
  const file = safePath(root, `rpc-jobs/${job.job_id}/stdout.log`);
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, 16384));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString("utf8").match(/^RESULT: [A-Z_]+$/gm)?.at(-1) ?? null;
  } finally { fs.closeSync(fd); }
}
function bundleFor(job: Job, root: string): string | null {
  const current = safePath(root, "CURRENT_REVIEW.json");
  if (!fs.existsSync(current)) return null;
  const pointer = jsonFile(current);
  if (pointer.task_id !== job.task_id || String(pointer.source_workspace).toLowerCase() !== REPOS[job.repo_key].toLowerCase()) return null;
  try { return verifyBundleIntegrity(pointer.review_bundle as string, root).valid ? pointer.review_bundle as string : null; }
  catch { return null; }
}
function completionDetails(taskId: string, repo: keyof typeof REPOS, status: Record<string, unknown>, root: string, roots: LedgerReadRoots) {
  if (status.state !== "DONE") return {};
  const base = `.ai/tasks/${taskId}`;
  const decisionFile = safePath(readRepoRoot(repo, roots), `${base}/review-decision.json`);
  if (!fs.existsSync(decisionFile)) throw new GatewayError("INVALID_EVIDENCE", "DONE review decision missing");
  const decision = jsonFile(decisionFile);
  if (decision.task_id !== taskId || decision.new_state !== "DONE" || decision.review_result !== "PASS" || decision.done_approved !== true) {
    throw new GatewayError("INVALID_EVIDENCE", "Invalid DONE review decision");
  }
  const integrationFile = safePath(readRepoRoot(repo, roots), `${base}/integration-completion.json`);
  const integration = fs.existsSync(integrationFile) ? jsonFile(integrationFile) : null;
  if (integration && (integration.task_id !== taskId || integration.new_state !== "DONE" || integration.review_bundle !== decision.review_bundle ||
    integration.completion_mode !== "post_integration" || integration.review_result !== "PASS" || integration.done_approved !== true ||
    decision.completion_mode !== "post_integration" || !/^[a-f0-9]{40}$/.test(String(integration.integrated_commit)))) {
    throw new GatewayError("INVALID_EVIDENCE", "Invalid integration completion");
  }
  if (decision.completion_mode === "post_integration" && !integration) throw new GatewayError("INVALID_EVIDENCE", "Integration completion missing");
  let bundle: string | null = null;
  const pointer = decision.review_bundle;
  if (typeof pointer === "string" && /^reviews\/[a-zA-Z0-9._-]+$/.test(pointer) && !pointer.includes("..")) {
    const metadataFile = safePath(root, `${pointer}/review-bundle.json`);
    if (fs.existsSync(metadataFile)) {
      const metadata = jsonFile(metadataFile);
      if (metadata.task_id === taskId && metadata.source_workspace === REPOS[repo] &&
        metadata.manifest_sha256 === decision.manifest_sha256 && verifyBundleIntegrity(pointer, root).valid) bundle = safePath(root, pointer);
    }
  }
  const transitions = Array.isArray(status.state_transition_history) ? status.state_transition_history : [];
  const doneTransition = transitions.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && (row as Record<string, unknown>).to === "DONE").at(-1);
  return { result_category: "LEGACY_LOCAL_DONE", authoritative_done: false, review_bundle: bundle, published: bundle !== null,
    completion_mode: typeof decision.completion_mode === "string" ? decision.completion_mode : null,
    review_result: decision.review_result, done_approved: decision.done_approved,
    completed_at: typeof integration?.completed_at === "string" ? integration.completed_at :
      typeof doneTransition?.timestamp === "string" ? doneTransition.timestamp : null,
    integrated_commit: typeof integration?.integrated_commit === "string" ? integration.integrated_commit : null };
}
function short(value: unknown, limit = 1000): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}
function strings(value: unknown, limit = 20): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit).map((item) => item.slice(0, 240)) : [];
}
type StopReasonCategory = "HUMAN_APPROVAL_REQUIRED" | "SCOPE_CONFIRMATION_REQUIRED" | "EVIDENCE_INSUFFICIENT" |
  "VERIFY_BLOCKED" | "EXECUTION_BLOCKED" | "READY_FOR_REVIEW";
function stopReason(category: StopReasonCategory | null, summary: string | null) {
  const actions: Record<StopReasonCategory, string> = {
    HUMAN_APPROVAL_REQUIRED: "Human review of the recorded proposal is required; the engine has no approval/resume route for this task.",
    SCOPE_CONFIRMATION_REQUIRED: "Inspect candidate paths; a fresh RC-02 request / attempt is required. Legacy retry / redispatch is unavailable.",
    EVIDENCE_INSUFFICIENT: "Inspect historical research evidence; a fresh RC-02 request / attempt is required. Legacy retry / redispatch is unavailable.",
    VERIFY_BLOCKED: "Inspect verification evidence; a fresh RC-02 request / attempt is required. Legacy retry / redispatch is unavailable.",
    EXECUTION_BLOCKED: "Inspect the execution environment; a fresh RC-02 request / attempt is required. Legacy retry / redispatch is unavailable.",
    READY_FOR_REVIEW: "Perform independent review of the verified changes.",
  };
  return { stop_reason_category: category, stop_reason_summary: summary,
    human_action_required: category === "HUMAN_APPROVAL_REQUIRED" || category === "SCOPE_CONFIRMATION_REQUIRED",
    recommended_next_action: category ? actions[category] : null };
}
function insufficientResearchEvidence(message: string): boolean {
  // Only the final structured proposal's own diagnostic is considered. An empty
  // edit list alone is not evidence of a failed investigation: it can also be
  // a genuine request for human approval or an ambiguous proposal.
  const readFailure = /(?:読み取り|読取|read(?:ing)?|read\s+access).{0,45}(?:失敗|タイムアウト|確認でき|取得でき|アクセスでき|failed|failure|timed?\s*out|denied|unavailable|unable)|(?:接続タイムアウト|根拠不足|調査.{0,25}(?:失敗|不足))|(?:対象(?:文書|ファイル|資料)|target\s+(?:files?|documents?)).{0,45}(?:確認でき|読め|取得でき|アクセスでき|unable to (?:read|inspect)|could not (?:read|inspect))|(?:unable to (?:read|inspect|verify)|could not (?:read|inspect|verify)|insufficient)\s+(?:the\s+)?(?:evidence|repository|target\s+files?|files?)/i;
  const cannotPropose = /(?:置換箇所|編集案|変更案).{0,35}(?:特定でき|提示でき|作成でき|示せ|不明)|(?:unable|could not|cannot)\s+(?:to\s+)?(?:propose|identify)\s+(?:an?\s+)?(?:edit|replacement)/i;
  return readFailure.test(message) || cannotPropose.test(message);
}
// Older ledgers omit gate_decision altogether. A present but incomplete gate is
// not permission: the engine's v1 bounded allow requires the matching scope and
// BOUNDED_EDIT reason (see orchestrate-v03 Check-Ledger).
function gateDisposition(status: Record<string, unknown> | null): "legacy" | "allow" | "refuse" | "unverified" {
  if (!status || !Object.hasOwn(status, "gate_decision")) return "legacy";
  const gate = status.gate_decision;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return "unverified";
  const decision = gate as Record<string, unknown>;
  if (decision.version !== 1) return "unverified";
  if (decision.decision !== "ALLOW_BOUNDED_EDIT") return typeof decision.decision === "string" &&
    ["STOP_SCOPE", "STOP_UNRESOLVED_INTENT", "STOP_OPERATION", "STOP_INVALID_PROPOSAL"].includes(decision.decision)
    ? "refuse" : "unverified";
  const scope = decision.scope, paths = status.edit_paths;
  return decision.reason_code === "BOUNDED_EDIT" && typeof decision.reason === "string" && !!decision.reason &&
    Array.isArray(scope) && Array.isArray(paths) && scope.length === paths.length &&
    scope.every((entry, index) => typeof entry === "string" && entry === paths[index]) &&
    Array.isArray(decision.allowed_operations) && Array.isArray(decision.operations) &&
    Array.isArray(decision.unresolved_intent) && Array.isArray(decision.evidence) &&
    decision.evidence.length > 0 ? "allow" : "unverified";
}
function classifyStop(status: Record<string, unknown> | null, result: string | null, active: boolean,
  proposal: Record<string, unknown> | null = null) {
  if (status?.state === "READY_FOR_REVIEW") return stopReason("READY_FOR_REVIEW", short(status.message)?.trim() || "Verified task is ready for independent review.");
  if (status?.state === "BLOCKED") {
    const message = short(status.message)?.trim() || "Execution stopped; inspect task evidence.";
    // A policy refusal is not a transient worker failure and cannot be retried under the same permission.
    if (["refuse", "unverified"].includes(gateDisposition(status))) return {
      ...stopReason("EXECUTION_BLOCKED", message),
      recommended_next_action: "Inspect the policy gate; a newly authorized contract is required, not an automatic retry.",
    };
    // A VerifyInternal failure is the only failure that ai-resume can consider.
    const verify = /^VerifyInternal failed:/i.test(message) && Number.isInteger(status.verify_exit_code) &&
      Array.isArray(status.state_transition_history) && status.state_transition_history.some((row: unknown) =>
        !!row && typeof row === "object" && (row as Record<string, unknown>).from === "VERIFYING" && (row as Record<string, unknown>).to === "BLOCKED");
    return stopReason(verify ? "VERIFY_BLOCKED" : "EXECUTION_BLOCKED", message);
  }
  if (status?.state === "NEEDS_APPROVAL") {
    const message = short(proposal?.message)?.trim() || "";
    const reason = short(status.message)?.trim() || "approval reason unavailable";
    const command = short(proposal?.proposed_command)?.trim() || "";
    const noEdits = Array.isArray(proposal?.edits) && proposal.edits.length === 0;
    // Only the structured proposal's own diagnostic can disambiguate a generic
    // engine approval reason. Never classify from goal text, logs, or edit content.
    const riskyOperation = /\b(?:git\s+(?:commit|push|tag|clean|reset)|ssh|scp|sftp|rsync|sudo|deploy|restart|reboot|shutdown)\b/i;
    if (noEdits && !command && !riskyOperation.test(message) &&
      !riskyOperation.test(short(status.proposed_command) ?? "") &&
      !/(?:承認|許可|\bapprov(?:al|e)\b|\bpermission\b)/i.test(message) &&
      insufficientResearchEvidence(message)) {
      return stopReason("EVIDENCE_INSUFFICIENT", message);
    }
    if (noEdits && !command && /(?:scope|edit paths?|編集範囲|対象(?:ファイル|パス)).{0,35}(?:ambiguous|unclear|unspecified|曖昧|不明|未指定)/i.test(message)) {
      return stopReason("SCOPE_CONFIRMATION_REQUIRED", message);
    }
    if (status.codex_attempts === 0 && Array.isArray(status.edit_paths) && status.edit_paths.length === 0 &&
      !short(status.proposed_command)?.match(/\bgit\s+(?:push|commit)|\bssh\b/i) &&
      /no explicit edit paths/i.test(reason)) return stopReason("SCOPE_CONFIRMATION_REQUIRED", reason);
    return stopReason("HUMAN_APPROVAL_REQUIRED", message || reason);
  }
  if (!status && result === "HUMAN_SCOPE_CONFIRMATION_REQUIRED") return stopReason("SCOPE_CONFIRMATION_REQUIRED", "Scope discovery stopped before the task ledger was created.");
  if (!status && !active) return stopReason("EXECUTION_BLOCKED", "No task evidence was produced; inspect the execution environment.");
  return stopReason(null, null);
}
function lineage(job: Job) {
  return { parent_task_id: job.parent_task_id ?? null, retry_of: job.retry_of ?? null, attempt: job.attempt ?? 1 };
}
function retryPlan(id: string, root: string) {
  const job = findJob(id, root);
  const mode = job.mode ?? "change";
  const active = running(job);
  const status = mode === "change" ? evidence(job) : readOnlyEvidence(job, root);
  const result = resultLine(job, root)?.slice(8) ?? null;
  const category = mode === "change" ? classifyStop(status, result, active,
    status?.state === "NEEDS_APPROVAL" ? finalProposal(job, status).proposal : null).stop_reason_category :
    active || (job.exit_code === 0 && status?.state === "DONE") ? null : "EXECUTION_BLOCKED";
  const fail = (reason: string) => ({ job_id: job.job_id, task_id: job.task_id, repo: job.repo_key, mode,
    state: status?.state ?? null, stop_reason_category: category, eligible: false, reason,
    inherited_goal: null, inherited_edit_paths: null, ...lineage(job) });
  return fail("Fresh RC-02 request / attempt required; original evidence remains immutable. Legacy retry / redispatch is unavailable.");
}
export function getOrchestrationRetryPlan(id: string, root = REVIEW_ROOT) { return retryPlan(id, root); }
export function retryOrchestration(_id: string, _retryReason = "User requested a same-scope retry", _root = REVIEW_ROOT): never {
  throw new GatewayError("FRESH_REQUEST_REQUIRED", "Legacy retry / redispatch is quarantined; a fresh RC-02 request / attempt is required. Original evidence remains immutable.");
}
function finalProposal(job: Job, status: Record<string, unknown>, roots: LedgerReadRoots = REPOS): { proposal: Record<string, unknown> | null; proposal_hash: string | null } {
  const repo = readRepoRoot(job.repo_key, roots);
  const attempt = status.codex_attempts;
  const proposalPath = Number.isInteger(attempt) && (attempt as number) >= 1 && (attempt as number) <= 2
    ? safePath(repo, `.ai/tasks/${job.task_id}/codex-attempt-${attempt}.stdout.txt`) : null;
  let proposal: Record<string, unknown> | null = null;
  let proposal_hash: string | null = null;
  if (proposalPath && fs.existsSync(proposalPath)) {
    const bytes = fs.readFileSync(proposalPath);
    if (bytes.length <= 1048576) {
      proposal_hash = hash(bytes);
      try {
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          (parsed as Record<string, unknown>).task_id === job.task_id) proposal = parsed as Record<string, unknown>;
      } catch { /* malformed stdout is not a structured proposal */ }
    }
  }
  return { proposal, proposal_hash };
}
function approvalDetails(job: Job, status: Record<string, unknown>, roots: LedgerReadRoots = REPOS) {
  const attempt = status.codex_attempts;
  // The engine's final structured stdout is the sole proposal source. Never expose
  // raw replacement text, arbitrary logs, or an oversized/unparseable candidate.
  const { proposal, proposal_hash } = finalProposal(job, status, roots);
  const edits = Array.isArray(proposal?.edits) ? proposal.edits.slice(0, 20).map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { path: null };
    const edit = entry as Record<string, unknown>;
    return { path: short(edit.path, 240), old_text_sha256: typeof edit.old_text === "string" ? hash(edit.old_text) : null,
      new_text_sha256: typeof edit.new_text === "string" ? hash(edit.new_text) : null };
  }) : [];
  const command = short(proposal?.proposed_command, 500) || short(status.proposed_command, 500);
  const message = short(proposal?.message);
  const reason = short(status.message)?.trim() || "approval reason unavailable";
  // Classify only explicit structured fields, never keywords in old/new text or
  // negated requests in the goal. Unknown is not the same as safe.
  const actions = [command, message].filter((x): x is string => !!x);
  const risky_actions = actions.filter((text) => /\b(?:git\s+(?:commit|push|tag|clean|reset)|ssh|scp|sftp|rsync|sudo|deploy|restart|reboot|shutdown)\b/i.test(text)).map((text) => text.slice(0, 500));
  const explicit = command && !command.startsWith("Unspecified:") ? command : "";
  const commit_requested = /\bgit\s+commit\b/i.test(explicit);
  const push_requested = /\bgit\s+push\b/i.test(explicit);
  const planned_paths = strings(status.edit_paths);
  const structured_proposal = proposal ? { task_id: job.task_id, state: short(proposal.state, 80), approval_required: proposal.approval_required === true,
    message, proposed_command: short(proposal.proposed_command, 500), edits } : null;
  return { approval_required: true, approval_type: proposal ? "structured_proposal" : attempt === 0 ? "goal_or_scope" : "unavailable",
    approval_reason: reason, proposal_summary: message ?? reason, proposal_hash,
    structured_proposal, planned_paths, planned_changes: edits,
    risky_actions, commit_requested, push_requested,
    verification_status: { completed: status.verify_completed === true, exit_code: status.verify_exit_code ?? null },
    changed_paths_so_far: Array.isArray(status.edits) ? status.edits.slice(0, 20).map((edit: unknown) => edit && typeof edit === "object" ? short((edit as Record<string, unknown>).path, 240) : null).filter((x): x is string => x !== null) : [],
    next_action: classifyStop(status, null, false, proposal).recommended_next_action,
    human_decision_required: "Engine gate remains in force; approval cannot resume this task with the current engine.",
    ...classifyStop(status, null, false, proposal) };
}
export function getOrchestrationApproval(id: string, root = REVIEW_ROOT) {
  const job = findJob(id, root);
  if ((job.mode ?? "change") !== "change") throw new GatewayError("INVALID_MODE", "Only change tasks have engine approval evidence");
  const status = evidence(job);
  if (!status || status.state !== "NEEDS_APPROVAL") throw new GatewayError("INVALID_STATE", "Task is not NEEDS_APPROVAL");
  return { job_id: job.job_id, task_id: job.task_id, repo: job.repo_key, state: "NEEDS_APPROVAL", ...approvalDetails(job, status) };
}
export function getOrchestrationStatus(id: string, root = REVIEW_ROOT, roots: LedgerReadRoots = REPOS) {
  const autonomous = legacyAutonomousObservation(id, root);
  if (autonomous) return autonomous;
  const lookup = lookupForRead(id, root, roots), { job, repo } = lookup;
  if (!job) {
    const status = lookup.status!;
    const state = status.state as string;
    return { job_id: null, repo, task_id: id, mode: "change" as const, process: "not_running", exit_code: null,
      state, updated_at: status.last_updated ?? null, next_action: state === "DONE" ? "None" :
        state === "READY_FOR_REVIEW" ? "ChatGPT review" : "Inspect task evidence",
      result_category: state === "DONE" ? "LEGACY_LOCAL_DONE" : null, authoritative_done: false, ...classifyStop(status, null, false),
      parent_task_id: typeof status.parent_task_id === "string" ? status.parent_task_id : null,
      retry_of: typeof status.retry_of === "string" ? status.retry_of : null,
      attempt: typeof status.attempt === "number" ? status.attempt : null };
  }
  const mode = job.mode ?? "change";
  const status = mode === "change" ? lookup.status : readOnlyEvidence(job, root);
  const active = running(job);
  const state = mode === "read_only" && (active || job.exit_code !== 0) ? null : status?.state as string | undefined ?? null;
  const result = mode === "read_only" ? state === "DONE" ? "READ_ONLY_COMPLETE" : active ? null : "FAILED" : resultLine(job, root)?.slice(8) ?? null;
  const stop = mode === "change" ? classifyStop(status, result, active, state === "NEEDS_APPROVAL" ? finalProposal(job, status!, roots).proposal : null) :
    state === "DONE" || active ? stopReason(null, null) : stopReason("EXECUTION_BLOCKED", "Read-only worker did not complete successfully.");
  return { job_id: job.job_id, repo: job.repo_key, task_id: job.task_id, mode, process: active ? "running" : "exited",
    exit_code: job.exit_code ?? null, state, updated_at: status?.last_updated ?? status?.updated_at ?? null,
    next_action: mode === "read_only" ? active ? "Poll status" : state === "DONE" ? "Read result" : "Inspect local worker error" :
      state === "NEEDS_APPROVAL" ? "Inspect approval evidence; engine has no approval/resume route" : state === "BLOCKED" ? "Inspect task evidence" :
       state === "DONE" ? "None" : state === "READY_FOR_REVIEW" ? "ChatGPT review" : active ? "Poll status" : "Inspect job output locally",
    result_category: mode === "change" && (state === "DONE" || result === "DONE") ? "LEGACY_LOCAL_DONE" : result,
    authoritative_done: false, ...stop, ...lineage(job) };
}
export function getOrchestrationResult(id: string, root = REVIEW_ROOT, roots: LedgerReadRoots = REPOS) {
  const autonomous = legacyAutonomousObservation(id, root);
  if (autonomous) return autonomous;
  const lookup = lookupForRead(id, root, roots), { job, repo } = lookup;
  const mode = job?.mode ?? "change";
  const status = mode === "change" ? lookup.status : readOnlyEvidence(job!, root);
  if (mode === "read_only" && job) {
    const done = job.exit_code === 0 && status !== null && !running(job);
    return { job_id: job.job_id, task_id: job.task_id, mode, state: done ? "DONE" : null, authoritative_done: false,
      summary: done ? (status.summary as string).slice(0, 1000) : "", changed_paths: [],
      verification: done ? status.verification : { completed: false, exit_code: null },
      blocker_or_approval_reason: null, review_bundle: null, published: false,
       final_result_line: done ? "RESULT: READ_ONLY_COMPLETE" : null,
       ...done || running(job) ? stopReason(null, null) : stopReason("EXECUTION_BLOCKED", "Read-only worker did not complete successfully."), ...lineage(job) };
  }
  const state = status?.state as string | undefined ?? null;
  const bundle = job ? bundleFor(job, root) : null;
  const taskId = job?.task_id ?? id;
  const completion = status && state === "DONE" ? completionDetails(taskId, repo, status, root, roots) : {};
  return { job_id: job?.job_id ?? null, task_id: taskId, repo, mode, state, authoritative_done: false, summary: String(status?.message ?? "").slice(0, 1000),
    changed_paths: Array.isArray(status?.edits) ? status.edits.slice(0, 20).map((edit: unknown) => edit && typeof edit === "object" ? short((edit as Record<string, unknown>).path, 240) : null).filter((x): x is string => x !== null) : [],
    verification: { completed: status?.verify_completed === true, exit_code: status?.verify_exit_code ?? null },
    blocker_or_approval_reason: state === "BLOCKED" || state === "NEEDS_APPROVAL" ? String(status?.message ?? "").slice(0, 1000) : null,
    review_bundle: bundle ? safePath(root, bundle) : null, published: bundle !== null, final_result_line: job ? resultLine(job, root) : null,
    ...(state === "NEEDS_APPROVAL" && job ? { result_category: resultLine(job, root) === "RESULT: DONE" ? "LEGACY_LOCAL_DONE" :
      resultLine(job, root)?.slice(8) ?? "HUMAN_APPROVAL_REQUIRED", ...approvalDetails(job, status!, roots) } :
      { ...classifyStop(status, job ? resultLine(job, root)?.slice(8) ?? null : null, job ? running(job) : false) }),
    ...(job ? lineage(job) : { parent_task_id: typeof status?.parent_task_id === "string" ? status.parent_task_id : null,
      retry_of: typeof status?.retry_of === "string" ? status.retry_of : null, attempt: typeof status?.attempt === "number" ? status.attempt : null }),
    ...completion };
}
