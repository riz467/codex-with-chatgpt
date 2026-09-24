import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IgnoreRules } from "../workspace/ignore.js";

export const REVIEW_ROOT = "C:\\work\\ai-orchestration-review";
export const REPOS = {
  "pve-doc": "C:\\work\\pve-doc",
  "ai-orchestration-config": "C:\\work\\ai-orchestration-config",
} as const;
const AI_RUN = "C:\\Users\\workspace\\.local\\bin\\ai-run.ps1";
const POWERSHELL = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const READ_ONLY_WORKER = fileURLToPath(new URL("./read-only-worker.js", import.meta.url));
const AI_RUN_SCOPED = fileURLToPath(new URL("./invoke-ai-run.ps1", import.meta.url));
export type OrchestrationMode = "read_only" | "change";
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export class GatewayError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// Reject all reparse points (including Windows junctions) at every existing component.
function safePath(root: string, relative = ""): string {
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
    typeof metadata.source_workspace !== "string" || !Object.values(REPOS).some((repo) => repo.toLowerCase() === (metadata.source_workspace as string).toLowerCase())) {
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

type Job = { job_id: string; task_id: string; mode?: OrchestrationMode; process_id: number; repo_key: keyof typeof REPOS; started_at: string; goal_sha256: string; stdout_path: string; stderr_path: string; exit_code?: number | null };
function jobFile(root: string, id: string): string {
  if (!idPattern.test(id)) throw new GatewayError("INVALID_ID", "Invalid job id");
  return safePath(root, `rpc-jobs/${id}/job.json`);
}
function readJob(root: string, id: string): Job {
  const file = jobFile(root, id);
  if (!fs.existsSync(file)) throw new GatewayError("NOT_FOUND", "Unknown job");
  const job = jsonFile(file) as unknown as Job;
  if (job.job_id !== id || !idPattern.test(job.task_id) || !Object.hasOwn(REPOS, job.repo_key) ||
    (job.mode !== undefined && job.mode !== "read_only" && job.mode !== "change")) throw new GatewayError("INVALID_EVIDENCE", "Invalid job registry");
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
  if (!Object.hasOwn(REPOS, repo)) throw new GatewayError("INVALID_REPO", "Unknown repository key");
  if (mode !== "read_only" && mode !== "change") throw new GatewayError("INVALID_MODE", "Choose read_only or change");
  if (mode === "read_only" && editPaths !== undefined) throw new GatewayError("INVALID_EDIT_PATHS", "read_only does not accept edit_paths");
  if (typeof goal !== "string" || !goal.trim() || goal.length > 4000 || /[\x00-\x1f\x7f]/.test(goal)) {
    throw new GatewayError("INVALID_GOAL", "Goal must be nonempty, at most 4000 characters, without control characters");
  }
  const key = repo as keyof typeof REPOS;
  const repoPath = repoRoot(key);
  const scoped = editPaths === undefined ? undefined : validateEditPaths(repoPath, editPaths);
  if (mode === "change" && (!fs.existsSync(AI_RUN) || !fs.existsSync(POWERSHELL))) throw new GatewayError("RUNTIME_UNAVAILABLE", "Expected ai-run or pwsh not installed");
  if (scoped && !fs.existsSync(AI_RUN_SCOPED)) throw new GatewayError("RUNTIME_UNAVAILABLE", "Scoped ai-run adapter not built");
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
    child = mode === "change"
      ? spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-File", scoped ? AI_RUN_SCOPED : AI_RUN, "-Repo", repoPath, "-TaskId", task_id, "-Goal", goal,
          ...(scoped ? ["-EditPathsBase64", Buffer.from(JSON.stringify(scoped), "utf8").toString("base64")] : [])],
        { cwd: repoPath, shell: false, stdio: ["ignore", out, err], windowsHide: true })
      : spawn(process.execPath, [READ_ONLY_WORKER, key, job_id, task_id],
        { cwd: repoPath, shell: false, stdio: ["ignore", out, err], windowsHide: true });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  if (!child.pid) throw new GatewayError("RUNTIME_UNAVAILABLE", "Could not start ai-run");
  const job: Job = { job_id, task_id, mode, process_id: child.pid, repo_key: key, started_at: new Date().toISOString(), goal_sha256: hash(goal), stdout_path, stderr_path };
  const file = jobFile(root, job_id);
  fs.writeFileSync(file, JSON.stringify(job), { flag: "wx" });
  child.on("exit", (code) => {
    try { fs.writeFileSync(file, JSON.stringify({ ...job, exit_code: code })); } catch { /* best effort registry update */ }
  });
  child.on("error", () => {
    try { fs.writeFileSync(file, JSON.stringify({ ...job, exit_code: null })); } catch { /* best effort */ }
  });
  child.unref();
  return { job_id, task_id, repo: key, mode, started_at: job.started_at };
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
function evidence(job: Job) {
  const file = safePath(repoRoot(job.repo_key), `.ai/tasks/${job.task_id}/status.json`);
  if (!fs.existsSync(file)) return null;
  const status = jsonFile(file);
  if (status.task_id !== job.task_id || typeof status.state !== "string") throw new GatewayError("INVALID_EVIDENCE", "Task ledger identity mismatch");
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
export function getOrchestrationStatus(id: string, root = REVIEW_ROOT) {
  const job = findJob(id, root), mode = job.mode ?? "change";
  const status = mode === "change" ? evidence(job) : readOnlyEvidence(job, root);
  const active = running(job);
  const state = mode === "read_only" && (active || job.exit_code !== 0) ? null : status?.state as string | undefined ?? null;
  return { job_id: job.job_id, repo: job.repo_key, task_id: job.task_id, mode, process: active ? "running" : "exited",
    exit_code: job.exit_code ?? null, state, updated_at: status?.last_updated ?? status?.updated_at ?? null,
    next_action: mode === "read_only" ? active ? "Poll status" : state === "DONE" ? "Read result" : "Inspect local worker error" :
      state === "NEEDS_APPROVAL" ? "Human approval decision" : state === "BLOCKED" ? "Inspect task evidence" :
      state === "READY_FOR_REVIEW" ? "ChatGPT review" : active ? "Poll status" : "Inspect job output locally",
    result_category: mode === "read_only" ? state === "DONE" ? "READ_ONLY_COMPLETE" : active ? null : "FAILED" : resultLine(job, root)?.slice(8) ?? null };
}
export function getOrchestrationResult(id: string, root = REVIEW_ROOT) {
  const job = findJob(id, root), mode = job.mode ?? "change";
  const status = mode === "change" ? evidence(job) : readOnlyEvidence(job, root);
  if (mode === "read_only") {
    const done = job.exit_code === 0 && status !== null && !running(job);
    return { job_id: job.job_id, task_id: job.task_id, mode, state: done ? "DONE" : null,
      summary: done ? (status.summary as string).slice(0, 1000) : "", changed_paths: [],
      verification: done ? status.verification : { completed: false, exit_code: null },
      blocker_or_approval_reason: null, review_bundle: null, published: false,
      final_result_line: done ? "RESULT: READ_ONLY_COMPLETE" : null };
  }
  const state = status?.state as string | undefined ?? null;
  const bundle = bundleFor(job, root);
  return { job_id: job.job_id, task_id: job.task_id, mode, state, summary: String(status?.message ?? "").slice(0, 1000),
    changed_paths: Array.isArray(status?.allowed_paths) ? status.allowed_paths.filter((x): x is string => typeof x === "string").slice(0, 20) : [],
    verification: { completed: status?.verify_completed === true, exit_code: status?.verify_exit_code ?? null },
    blocker_or_approval_reason: state === "BLOCKED" || state === "NEEDS_APPROVAL" ? String(status?.message ?? "").slice(0, 1000) : null,
    review_bundle: bundle ? safePath(root, bundle) : null, published: bundle !== null, final_result_line: resultLine(job, root) };
}
