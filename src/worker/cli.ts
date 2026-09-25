import crypto from "node:crypto";
import { QUEUE, REPOS, assertLive, diagnosticPromptHash, enginePromptHash, enqueue, readResult, worker } from "./codex-interactive.js";
import { rdpStatus, startRdpDiagnostic } from "./rdp-disconnect-diagnostic.js";
import { categoryFor, createExitTelemetry, type Phase } from "./exit-telemetry.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const [mode, repo, task_id, attemptText] = process.argv.slice(2);
  if (mode === "worker" && process.argv.length === 3) {
    const telemetry = createExitTelemetry();
    let phase: Phase = "init";
    telemetry.record("worker_start", { phase });
    process.on("uncaughtExceptionMonitor", (error, origin) => {
      telemetry.record("worker_exit", { phase, exit_code: 1, reason_category: origin === "unhandledRejection" ? "UNHANDLED_EXCEPTION" : categoryFor(phase), error });
    });
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      process.once(signal, () => { telemetry.record("worker_exit", { phase, exit_code: code, reason_category: "SIGNAL_EXIT" }); process.exit(code); });
    }
    process.on("exit", code => {
      if (!telemetry.hasExit()) telemetry.record("worker_exit", { phase, exit_code: code, reason_category: code ? "PROCESS_EXIT" : "NORMAL_EXIT", graceful: code === 0 });
    });
    try {
      await worker(undefined, undefined, { phase: next => { phase = next; }, record: telemetry.record });
      phase = "shutdown";
      telemetry.record("worker_shutdown", { phase, graceful: true });
      telemetry.record("worker_exit", { phase, exit_code: 0, reason_category: "NORMAL_EXIT", graceful: true });
    } catch (error) {
      telemetry.record("worker_exit", { phase, exit_code: 1, reason_category: categoryFor(phase), error });
      process.exitCode = 1;
      console.error("Worker failed:", categoryFor(phase));
    }
    return;
  }
  if (mode === "rdp-start" && process.argv.length === 3) { process.stdout.write(JSON.stringify(startRdpDiagnostic())); return; }
  if (mode === "rdp-status" && process.argv.length === 3) { process.stdout.write(JSON.stringify(rdpStatus())); return; }
  if (mode === "rdp-review" && process.argv.length === 3) { process.stdout.write(JSON.stringify(rdpStatus(false, true))); return; }
  if (!(["engine", "diagnostic"].includes(mode)) || !repo || !task_id || !attemptText || process.argv.length !== 6) throw new Error("Usage: cli engine|diagnostic <fixed-repo> <task-id> <attempt>");
  const attempt = Number(attemptText);
  if (!REPOS.includes(repo) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(task_id) || !Number.isInteger(attempt) || attempt < 1 || attempt > 2) throw new Error("Invalid fixed request identity");
  if (mode === "diagnostic" && repo !== REPOS[0]) throw new Error("Invalid diagnostic repo");
  const prompt_sha256 = mode === "diagnostic" ? diagnosticPromptHash() : enginePromptHash(repo, task_id, attempt);
  assertLive(); // Do not leave an unbounded job behind if no interactive session is present.
  const request = enqueue(QUEUE, { repo, task_id, attempt, kind: mode === "engine" ? "orchestration" : "diagnostic", nonce: crypto.randomBytes(16).toString("hex"), prompt_sha256 });
  const deadline = Date.now() + 330000;
  do {
    const result = readResult(QUEUE, request);
    if (result) { process.stdout.write(JSON.stringify(result)); return; }
    await sleep(500);
  } while (Date.now() < deadline);
  throw new Error("Worker result timeout; request remains reserved and must not be retried automatically");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
