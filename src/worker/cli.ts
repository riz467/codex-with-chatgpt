import crypto from "node:crypto";
import { QUEUE, REPOS, assertLive, diagnosticPromptHash, enginePromptHash, enqueue, readResult, worker } from "./codex-interactive.js";
import { rdpStatus, startRdpDiagnostic } from "./rdp-disconnect-diagnostic.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const [mode, repo, task_id, attemptText] = process.argv.slice(2);
  if (mode === "worker" && process.argv.length === 3) { await worker(); return; }
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
