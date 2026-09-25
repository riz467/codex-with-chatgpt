import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { QUEUE } from "./codex-interactive.js";

export type Phase = "init" | "heartbeat" | "idle" | "queue" | "job" | "shutdown" | "process" | "wrapper";
export type Category = "NORMAL_EXIT" | "UNHANDLED_EXCEPTION" | "QUEUE_ERROR" | "HEARTBEAT_ERROR" | "WORKER_INIT_ERROR" | "JOB_ERROR" | "SIGNAL_EXIT" | "PROCESS_EXIT" | "UNKNOWN";
export type LifecycleEvent = "worker_start" | "worker_ready" | "worker_idle" | "worker_job_start" | "worker_job_end" | "worker_shutdown" | "worker_exit";
export type ExitEvidence = { timestamp: string; pid: number; session_id: number | null; event: LifecycleEvent; exit_code: number | null;
  reason_category: Category; short_summary: string; error_name: string | null; task_id: string | null; phase: Phase; uptime_seconds: number; graceful: boolean };
const MAX_LOG = 128 * 1024;
const names = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError", "AggregateError", "SystemError"]);
const codes = new Set(["ENOENT", "EACCES", "EPERM", "EEXIST", "EBUSY", "ENOSPC", "EMFILE", "EIO", "EINVAL", "ESRCH"]);
const summaries: Record<Category, string> = {
  NORMAL_EXIT: "Worker exited normally", UNHANDLED_EXCEPTION: "Unexpected Node exception", QUEUE_ERROR: "Queue operation failed",
  HEARTBEAT_ERROR: "Heartbeat update failed", WORKER_INIT_ERROR: "Worker initialization failed", JOB_ERROR: "Job execution failed",
  SIGNAL_EXIT: "Worker received a termination signal", PROCESS_EXIT: "Child process exit observed", UNKNOWN: "Worker exit reason not verified"
};
const knownMessages: Record<string, string> = {
  "Unknown worker lock owner": "Worker lock owner is invalid", "Worker already running": "Worker lock belongs to a live process",
  "Interactive session required": "Interactive session is missing", "Reparse path rejected": "A reparse path was rejected"
};
export function safeError(error: unknown): { error_name: string | null; detail: string } {
  if (!error || typeof error !== "object") return { error_name: null, detail: "" };
  const value = error as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof value.name === "string" && names.has(value.name) ? value.name : null;
  const code = typeof value.code === "string" && codes.has(value.code) ? value.code : null;
  const message = typeof value.message === "string" && Object.hasOwn(knownMessages, value.message) ? knownMessages[value.message] : null;
  // Never persist arbitrary exception messages: they may contain tokens, request bodies or paths.
  return { error_name: name, detail: [code, message].filter(Boolean).join(" · ") };
}
export function categoryFor(phase: Phase): Category {
  return { init: "WORKER_INIT_ERROR", heartbeat: "HEARTBEAT_ERROR", queue: "QUEUE_ERROR", job: "JOB_ERROR", idle: "UNHANDLED_EXCEPTION",
    shutdown: "UNHANDLED_EXCEPTION", process: "UNHANDLED_EXCEPTION", wrapper: "UNKNOWN" }[phase] as Category;
}
function safeFile(file: string) {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Linked telemetry path"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export function createExitTelemetry(dir = QUEUE, pid = process.pid, sessionId = Number(process.env.AI_WORKER_SESSION_ID), now = () => Date.now()) {
  const start = now();
  let exited = false;
  const record = (event: LifecycleEvent, opts: Partial<Pick<ExitEvidence, "exit_code" | "reason_category" | "task_id" | "phase" | "graceful">> & { error?: unknown } = {}) => {
    if (event === "worker_exit" && exited) return;
    if (event === "worker_exit") exited = true;
    try {
    const category = opts.reason_category ?? (event === "worker_exit" ? "UNKNOWN" : "NORMAL_EXIT");
    const error = safeError(opts.error);
    const entry: ExitEvidence = { timestamp: new Date(now()).toISOString(), pid, session_id: Number.isInteger(sessionId) && sessionId > 0 ? sessionId : null,
      event, exit_code: Number.isInteger(opts.exit_code) ? opts.exit_code! : null, reason_category: category,
      short_summary: `${summaries[category]}${error.detail ? `: ${error.detail}` : ""}`.slice(0, 200), error_name: error.error_name,
      task_id: typeof opts.task_id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(opts.task_id) ? opts.task_id : null,
      phase: opts.phase ?? "process", uptime_seconds: Math.max(0, Math.floor((now() - start) / 1000)), graceful: opts.graceful === true };
      const log = path.join(dir, "lifecycle.jsonl"), old = path.join(dir, "lifecycle.1.jsonl"), current = path.join(dir, "current-exit.json");
      for (const file of [log, old, current]) safeFile(file);
      if (fs.existsSync(log)) {
        const size = fs.statSync(log).size;
        if (size > MAX_LOG || (size && fs.readFileSync(log, "utf8").split("\n").some(line => line && !validLine(line)))) {
          fs.renameSync(log, old);
          if (fs.statSync(old).size > MAX_LOG) fs.truncateSync(old, MAX_LOG);
        } else if (size + Buffer.byteLength(JSON.stringify(entry)) + 1 > MAX_LOG) fs.renameSync(log, old);
      }
      fs.appendFileSync(log, JSON.stringify(entry) + "\n", { flag: "a" });
      if (event === "worker_exit") {
        const temp = path.join(dir, `current-exit.${crypto.randomUUID()}.tmp`);
        safeFile(temp);
        try { fs.writeFileSync(temp, JSON.stringify(entry), { flag: "wx" }); fs.renameSync(temp, current); }
        finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      }
    } catch { /* telemetry must never interrupt the worker or change queue semantics */ }
  };
  return { record, hasExit: () => exited };
}
function validLine(line: string) {
  try { const value = JSON.parse(line) as { event?: unknown }; return typeof value.event === "string" && value.event.startsWith("worker_"); }
  catch { return false; }
}
