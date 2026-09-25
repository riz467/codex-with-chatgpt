import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { Category, Phase, LifecycleEvent } from "./exit-telemetry.js";

// This is a transport for the existing engine invocation, not a general command queue.
export const QUEUE = "C:\\work\\ai-workspace-logs\\codex-worker";
export const RDP_QUEUE = "C:\\work\\ai-workspace-logs\\codex-rdp-disconnect-diagnostic";
export const RDP_ID = "diag-rdp-disconnect-once";
export const NODE = "C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node.exe";
export const CODEX = "C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node_modules\\@openai\\codex\\bin\\codex.js";
export const SCHEMA = "C:\\Users\\workspace\\.config\\opencode\\templates\\task-ledger-v03\\proposal.schema.json";
export const REPOS = ["C:\\work\\pve-doc", "C:\\work\\ai-orchestration-config"];
const DIAGNOSTIC = "Fixed read-only runner diagnostic. In C:\\work\\pve-doc, run commands to (1) report pwd/current directory, (2) git status --short, (3) read AGENTS.md, (4) read the first 40 lines of 03_services/ai-workspace.md. Do not write or edit any files, run an orchestration task, commit, or push. Report briefly whether all four reads succeeded.";
const RDP_PROMPT = "Fixed RDP disconnect read-only diagnostic. In C:\\work\\pve-doc, read and report (1) current directory, (2) git status --short, (3) AGENTS.md, (4) the first 40 lines of 03_services/ai-workspace.md. Do not write or edit files, run an orchestration task, commit, or push. State whether all four reads succeeded.";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const own = (value: object, keys: string[]) => Object.keys(value).sort().join("|") === keys.sort().join("|");
const noLinks = (file: string) => {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Reparse path rejected");
  }
};
export type Request = { task_id: string; repo: string; attempt: number; kind: "orchestration" | "diagnostic" | "rdp-diagnostic"; nonce: string; prompt_sha256: string; request_hash: string };
export function requestHash(r: Omit<Request, "request_hash">): string {
  return hash(JSON.stringify([r.task_id, r.repo, r.attempt, r.kind, r.nonce, r.prompt_sha256]));
}
export function validate(raw: unknown): { request: Request; prompt: string; args: string[] } {
  if (!raw || typeof raw !== "object" || !own(raw, ["task_id", "repo", "attempt", "kind", "nonce", "prompt_sha256", "request_hash"])) throw new Error("Invalid request fields");
  const r = raw as Request;
  if (typeof r.task_id !== "string" || !idPattern.test(r.task_id) || typeof r.repo !== "string" ||
      !REPOS.includes(r.repo) || !Number.isInteger(r.attempt) || r.attempt < 1 || r.attempt > 2 ||
       !["orchestration", "diagnostic", "rdp-diagnostic"].includes(r.kind) || typeof r.nonce !== "string" || !/^[a-f0-9]{32}$/.test(r.nonce) ||
      typeof r.prompt_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.prompt_sha256) ||
      r.request_hash !== requestHash(r)) throw new Error("Invalid request identity");
  if (r.kind === "diagnostic" && (r.repo !== REPOS[0] || r.attempt !== 1 || !r.task_id.startsWith("diag-"))) throw new Error("Invalid diagnostic");
  if (r.kind === "rdp-diagnostic" && (r.repo !== REPOS[0] || r.attempt !== 1 || r.task_id !== RDP_ID || r.prompt_sha256 !== rdpPromptHash())) throw new Error("Invalid RDP diagnostic");
  noLinks(r.repo);
  let prompt: string;
  let args: string[];
  if (r.kind === "diagnostic" || r.kind === "rdp-diagnostic") {
    prompt = r.kind === "diagnostic" ? DIAGNOSTIC : RDP_PROMPT;
    args = r.kind === "diagnostic"
      ? [CODEX, "-a", "never", "-C", r.repo, "exec", "-s", "read-only", "--ephemeral", prompt]
      : [CODEX, "-a", "never", "-C", r.repo, "exec", "-s", "read-only", "--ephemeral", "-"];
  } else {
    const task = path.join(r.repo, ".ai", "tasks", r.task_id);
    const prefix = path.join(task, `codex-attempt-${r.attempt}`);
    noLinks(task);
    noLinks(path.join(task, "status.json"));
    noLinks(`${prefix}.prompt.txt`);
    noLinks(`${prefix}.argv.json`);
    noLinks(SCHEMA);
    const status = JSON.parse(fs.readFileSync(path.join(task, "status.json"), "utf8"));
    if (status.task_id !== r.task_id || status.state !== "EXECUTING" || status.approval_required !== false) throw new Error("Engine task mismatch");
    prompt = fs.readFileSync(`${prefix}.prompt.txt`, "utf8");
    const saved = JSON.parse(fs.readFileSync(`${prefix}.argv.json`, "utf8"));
    const expected = ["-a", "never", "-C", r.repo, "exec", "-s", "read-only", "--output-schema", SCHEMA, "-"];
    if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error("Engine argv mismatch");
    if (!prompt.includes(`task_id must be '${r.task_id}'`) || !prompt.includes("Return one JSON object matching the supplied schema only.")) throw new Error("Engine prompt mismatch");
    args = [CODEX, ...expected];
  }
  if (hash(prompt) !== r.prompt_sha256) throw new Error("Prompt hash mismatch");
  return { request: r, prompt, args };
}
function atomicJson(file: string, data: unknown) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data), { flag: "wx" }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
const files = (dir: string, id: string) => ({ request: path.join(dir, "requests", `${id}.json`), claim: path.join(dir, "claims", id), running: path.join(dir, "claims", `${id}.running`), result: path.join(dir, "results", `${id}.json`) });
export function prepare(dir = QUEUE) {
  for (const part of ["requests", "claims", "results"]) fs.mkdirSync(path.join(dir, part), { recursive: true });
}
export function assertLive(dir = QUEUE) {
  const beat = JSON.parse(fs.readFileSync(path.join(dir, "heartbeat.json"), "utf8"));
  if (!Number.isInteger(beat.session_id) || beat.session_id <= 0 || !Number.isInteger(beat.pid) || beat.pid <= 0 ||
      Date.now() - Date.parse(beat.observed_utc) > 10000 || Date.parse(beat.observed_utc) > Date.now() + 5000) throw new Error("Worker heartbeat expired");
  process.kill(beat.pid, 0);
}
export function enqueue(dir: string, input: Omit<Request, "request_hash">): Request {
  prepare(dir);
  const r: Request = { ...input, request_hash: requestHash(input) };
  validate(r);
  const f = files(dir, r.task_id + "-" + r.attempt);
  if (fs.existsSync(f.request) || fs.existsSync(f.claim) || fs.existsSync(f.running) || fs.existsSync(f.result)) throw new Error("Duplicate task attempt");
  // Exclusive reservation, never reused even if the caller times out.
  fs.mkdirSync(f.claim);
  atomicJson(f.request, r);
  return r;
}
export function readResult(dir: string, r: Request) {
  const f = files(dir, r.task_id + "-" + r.attempt);
  if (!fs.existsSync(f.result)) return null;
  const result = JSON.parse(fs.readFileSync(f.result, "utf8"));
  if (result.task_id !== r.task_id || result.attempt !== r.attempt || result.nonce !== r.nonce || result.request_hash !== r.request_hash) throw new Error("Result correlation mismatch");
  return result as { task_id: string; attempt: number; nonce: string; request_hash: string; exit_code: number; stdout: string; stderr: string; session_id: number };
}
export async function executeOne(dir: string, r: Request, sessionId: number, run = spawn) {
  const f = files(dir, r.task_id + "-" + r.attempt);
  if (fs.existsSync(f.result)) return null;
  let exit_code = -1, stdout = "", stderr = "";
  try {
    const checked = validate(r);
    const child = run(NODE, checked.args, { cwd: r.repo, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    if (r.kind === "orchestration") child.stdin?.end(checked.prompt); else child.stdin?.end();
    const timer = setTimeout(() => child.kill(), 300000);
    try { exit_code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? -1)); }); }
    finally { clearTimeout(timer); }
    stdout = Buffer.concat(out).toString("utf8"); stderr = Buffer.concat(err).toString("utf8");
  } catch (error) { stderr = String(error); }
  atomicJson(f.result, { task_id: r.task_id, attempt: r.attempt, nonce: r.nonce, request_hash: r.request_hash, exit_code, stdout, stderr, session_id: sessionId, completed_utc: new Date().toISOString() });
  return exit_code;
}
export type WorkerTelemetry = { phase: (phase: Phase) => void;
  record: (event: LifecycleEvent, opts?: { phase?: Phase; reason_category?: Category; task_id?: string; exit_code?: number | null; error?: unknown }) => void };
export async function worker(dir = QUEUE, sessionId = Number(process.env.AI_WORKER_SESSION_ID), telemetry?: WorkerTelemetry) {
  let phase: Phase = "init", idle = false, ready = false;
  const setPhase = (next: Phase) => { phase = next; telemetry?.phase(next); };
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new Error("Interactive session required");
  prepare(dir);
  const lock = path.join(dir, "worker.lock");
  // A restarted task may encounter the previous process's lock; never steal a live PID.
  if (fs.existsSync(lock)) {
    const old = Number(fs.readFileSync(lock, "utf8"));
    if (!Number.isInteger(old) || old <= 0) throw new Error("Unknown worker lock owner");
    try { process.kill(old, 0); throw new Error("Worker already running"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, "wx");
  fs.writeSync(fd, String(process.pid));
  try {
    const beat = () => {
      const previous = phase; setPhase("heartbeat");
      atomicJson(path.join(dir, "heartbeat.json"), { pid: process.pid, session_id: sessionId, observed_utc: new Date().toISOString(), rdp_diagnostic_version: 1 });
      setPhase(previous);
    };
    const pulse = setInterval(beat, 2000);
    try {
    for (;;) {
       beat();
       if (!ready) { telemetry?.record("worker_ready", { phase: "idle" }); ready = true; }
       setPhase("queue");
       // This fixed, one-shot diagnostic has its own queue and cannot consume an engine request.
       const rdpFile = path.join(RDP_QUEUE, "requests", `${RDP_ID}-1.json`);
       const rdpRunning = path.join(RDP_QUEUE, "claims", `${RDP_ID}-1.running`);
       if (fs.existsSync(rdpFile) && fs.existsSync(path.join(RDP_QUEUE, "claims", `${RDP_ID}-1`)) &&
           !fs.existsSync(rdpRunning) && !fs.existsSync(path.join(RDP_QUEUE, "results", `${RDP_ID}-1.json`))) {
         fs.writeFileSync(rdpRunning, rSafeHash(rdpFile), { flag: "wx" });
          const request: Request = JSON.parse(fs.readFileSync(rdpFile, "utf8"));
          // Keep the production queue responsive while the diagnostic holds Codex open.
          const { runRdpDiagnostic } = await import("./rdp-disconnect-diagnostic.js");
          telemetry?.record("worker_job_start", { phase: "job", task_id: RDP_ID });
          void runRdpDiagnostic(request, sessionId).then(
            () => telemetry?.record("worker_job_end", { phase: "job", task_id: RDP_ID }),
            error => telemetry?.record("worker_job_end", { phase: "job", task_id: RDP_ID, reason_category: "JOB_ERROR", error })
          );
       }
      for (const name of fs.readdirSync(path.join(dir, "requests")).filter(x => /^[A-Za-z0-9_-]+-[12]\.json$/.test(x))) {
        const id = name.slice(0, -5), f = files(dir, id);
        if (!fs.existsSync(f.claim) || fs.existsSync(f.running) || fs.existsSync(f.result)) continue;
        fs.writeFileSync(f.running, rSafeHash(f.request), { flag: "wx" });
        let jobStarted = false;
        try {
          const request: Request = JSON.parse(fs.readFileSync(f.request, "utf8"));
          if (`${request.task_id}-${request.attempt}` !== id) continue;
          jobStarted = true;
          idle = false; setPhase("job");
          telemetry?.record("worker_job_start", { phase: "job", task_id: request.task_id });
          const code = await executeOne(dir, request, sessionId);
          telemetry?.record("worker_job_end", { phase: "job", task_id: request.task_id, exit_code: code,
            reason_category: code !== 0 ? "JOB_ERROR" : "NORMAL_EXIT" });
        }
        catch (error) { telemetry?.record("worker_job_end", { phase: jobStarted ? "job" : "queue", reason_category: jobStarted ? "JOB_ERROR" : "QUEUE_ERROR", error }); /* Malformed request cannot dispatch; the caller times out closed. */ }
        finally { setPhase("queue"); }
      }
      setPhase("idle");
      if (!idle) { telemetry?.record("worker_idle", { phase: "idle" }); idle = true; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    } finally { clearInterval(pulse); }
  } finally { setPhase("shutdown"); fs.closeSync(fd); fs.unlinkSync(lock); }
}
function rSafeHash(file: string) { return hash(fs.readFileSync(file, "utf8")); }
export function diagnosticPromptHash() { return hash(DIAGNOSTIC); }
export function rdpPromptHash() { return hash(RDP_PROMPT); }
export function enginePromptHash(repo: string, id: string, attempt: number) { return hash(fs.readFileSync(path.join(repo, ".ai", "tasks", id, `codex-attempt-${attempt}.prompt.txt`), "utf8")); }
