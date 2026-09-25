import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CODEX, NODE, QUEUE, RDP_ID, RDP_QUEUE, REPOS, assertLive, enqueue, rdpPromptHash, requestHash, validate, type Request } from "./codex-interactive.js";

export const RDP_WAIT_MS = 600_000;
const RDP_TIMEOUT_MS = 900_000;
const file = (name: string) => path.join(RDP_QUEUE, name);
const resultFile = file(`results/${RDP_ID}-1.json`);
const requestFile = file(`requests/${RDP_ID}-1.json`);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function rdpContinuity(baseline: { pid: number; session_id: number }, started: { pid: number; started_utc: string } | null, sent: { observed_utc: string } | null, observations: Array<{ observed_utc: string; worker_pid: number; session_id: number; codex_pid: number; codex_running: boolean }>) {
  const samples_continuous = !!(started && observations.length >= 300 && Date.parse(observations[0].observed_utc) >= Date.parse(started.started_utc) && observations.every((sample, i) => {
    const gap = i === 0 ? 0 : Date.parse(sample.observed_utc) - Date.parse(observations[i - 1].observed_utc);
    return sample.worker_pid === baseline.pid && sample.session_id === baseline.session_id && sample.codex_pid === started.pid && sample.codex_running && gap >= 0 && gap <= 15000;
  }));
  const held_ten_minutes = !!(started && sent && Date.parse(sent.observed_utc) - Date.parse(started.started_utc) >= RDP_WAIT_MS && observations.length && Date.parse(observations.at(-1)!.observed_utc) - Date.parse(observations[0].observed_utc) >= RDP_WAIT_MS - 2000);
  return { samples_continuous, held_ten_minutes };
}

type ReadName = "current_directory" | "git_status_short" | "agents_md" | "ai_workspace_md";
const readNames: ReadName[] = ["current_directory", "git_status_short", "agents_md", "ai_workspace_md"];

// Codex can launch several exec calls before emitting any result. The results are
// not necessarily reported in command order, so match the entire batch instead
// of treating the line following a command as its exit status.
export function rdpReadChecks(stderr: string): Record<ReadName, boolean> {
  const reads = Object.fromEntries(readNames.map(name => [name, false])) as Record<ReadName, boolean>;
  const lines = stderr.split(/\r?\n/);
  const command = (line: string): ReadName | null => {
    const match = /^"[^"]+pwsh\.exe" -Command '([^']+)' in C:\\work\\pve-doc$/i.exec(line);
    if (!match) return null;
    const cmd = match[1];
    if (/^Get-Location(?:\s*\|\s*Select-Object -ExpandProperty Path)?$/i.test(cmd)) return "current_directory";
    if (/^git status --short$/i.test(cmd)) return "git_status_short";
    if (/^Get-Content -LiteralPath AGENTS\.md(?: -Encoding UTF8)?$/i.test(cmd)) return "agents_md";
    if (/^Get-Content -LiteralPath 03_services[/\\]ai-workspace\.md(?: -Encoding UTF8)? -TotalCount 40$/i.test(cmd)) return "ai_workspace_md";
    return null;
  };
  const outputMatches: Record<ReadName, (output: string) => boolean> = {
    current_directory: output => output.trim() === "C:\\work\\pve-doc",
    git_status_short: output => output.trim() === "?? .ai/",
    agents_md: output => /^# AGENTS\.md\b/m.test(output),
    ai_workspace_md: output => /^# .+/m.test(output) && output.includes("VM111 ai-workspace-win"),
  };
  let commands: Array<ReadName | null> = [], results: Array<{ success: boolean; output: string }> = [];
  let active = -1;
  const finish = () => {
    if (commands.length && commands.length === results.length && commands.every((name): name is ReadName => name !== null) && results.every(result => result.success)) {
      const available = [...results];
      const matched = commands.every(name => {
        const index = available.findIndex(result => outputMatches[name](result.output));
        if (index < 0) return false;
        available.splice(index, 1);
        return true;
      });
      if (matched) for (const name of commands) reads[name!] = true;
    }
    commands = []; results = []; active = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "exec" && i + 1 < lines.length) {
      if (results.length) finish();
      commands.push(command(lines[++i]));
      active = -1;
    } else if (/^\s*(?:succeeded in|failed in|exited with code \d+ in)\b.*:\s*$/i.test(line) && commands.length) {
      results.push({ success: /^\s*succeeded in\b/i.test(line), output: "" });
      active = results.length - 1;
    } else if (line === "codex" || line === "tokens used") {
      finish();
    } else if (active >= 0) {
      results[active].output += line + "\n";
    }
  }
  finish();
  return reads;
}

export function recordedWorkerCheck(recorded: any, baseline: { pid: number; session_id: number; started_utc: string }, completedUtc: string | undefined, now = Date.now()): boolean {
  return !!(recorded?.same_worker === true && recorded.baseline?.pid === baseline.pid &&
    recorded.baseline?.session_id === baseline.session_id && recorded.baseline?.started_utc === baseline.started_utc &&
    baseline.session_id > 0 && recorded.current_heartbeat?.pid === baseline.pid &&
    recorded.current_heartbeat?.session_id === baseline.session_id && completedUtc &&
    Number.isFinite(Date.parse(completedUtc)) &&
    Date.parse(recorded.current_heartbeat.observed_utc) >= Date.parse(completedUtc) &&
    Date.parse(recorded.current_heartbeat.observed_utc) <= now);
}

export function startRdpDiagnostic() {
  assertLive();
  const beat = JSON.parse(fs.readFileSync(path.join(QUEUE, "heartbeat.json"), "utf8"));
  if (beat.rdp_diagnostic_version !== 1) throw new Error("Restart the interactive worker with the new build before starting the RDP diagnostic");
  // A dedicated queue and an exclusive baseline make this a one-time run, not an engine task.
  fs.mkdirSync(RDP_QUEUE, { recursive: false });
  fs.writeFileSync(file("baseline.json"), JSON.stringify({ pid: beat.pid, session_id: beat.session_id, observed_utc: beat.observed_utc, started_utc: new Date().toISOString() }), { flag: "wx" });
  const input = { task_id: RDP_ID, repo: REPOS[0], attempt: 1, kind: "rdp-diagnostic" as const, nonce: crypto.randomBytes(16).toString("hex"), prompt_sha256: rdpPromptHash() };
  enqueue(RDP_QUEUE, input);
  return { queue: RDP_QUEUE, baseline: JSON.parse(fs.readFileSync(file("baseline.json"), "utf8")) };
}

export async function runRdpDiagnostic(request: Request, sessionId: number) {
  let exit_code = -1, stdout = "", stderr = "", childPid = 0;
  let child: ReturnType<typeof spawn> | undefined;
  let samples: ReturnType<typeof setInterval> | undefined;
  const started = Date.now();
  try {
    const checked = validate(request);
    if (request.kind !== "rdp-diagnostic") throw new Error("Not an RDP diagnostic request");
    child = spawn(NODE, checked.args, { cwd: REPOS[0], stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    childPid = child.pid ?? 0;
    if (!childPid) throw new Error("Codex process did not start");
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    const closed = new Promise<number>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", code => resolve(code ?? -1));
    });
    fs.writeFileSync(file("codex-started.json"), JSON.stringify({ pid: childPid, worker_pid: process.pid, session_id: sessionId, started_utc: new Date(started).toISOString() }), { flag: "wx" });
    const observe = () => fs.appendFileSync(file("observations.jsonl"), JSON.stringify({ observed_utc: new Date().toISOString(), worker_pid: process.pid, session_id: sessionId, codex_pid: childPid, codex_running: child!.exitCode === null }) + "\n");
    observe();
    samples = setInterval(observe, 2000);
    // Keep one fixed read-only Codex process open across the disconnect; only then
    // send the pinned prompt and verify the four reads after reconnection.
    const first = await Promise.race([pause(RDP_WAIT_MS).then(() => "elapsed"), closed.then(() => "closed")]);
    if (first !== "elapsed") throw new Error("Codex exited before the ten-minute hold completed");
    if (child.exitCode !== null) throw new Error("Codex exited before the fixed prompt was sent");
    fs.writeFileSync(file("prompt-sent.json"), JSON.stringify({ observed_utc: new Date().toISOString() }), { flag: "wx" });
    child.stdin?.end(checked.prompt);
    const outcome = await Promise.race([closed, pause(RDP_TIMEOUT_MS - RDP_WAIT_MS).then(() => { child!.kill(); throw new Error("Codex result timed out"); })]);
    exit_code = outcome;
    stdout = Buffer.concat(out).toString("utf8");
    stderr = Buffer.concat(err).toString("utf8");
  } catch (error) {
    if (child && child.exitCode === null) child.kill();
    stderr += `\n${String(error)}`;
  } finally {
    if (samples) clearInterval(samples);
    fs.writeFileSync(resultFile, JSON.stringify({ task_id: request.task_id, attempt: request.attempt, nonce: request.nonce, request_hash: request.request_hash, exit_code, stdout, stderr, session_id: sessionId, codex_pid: childPid, started_utc: new Date(started).toISOString(), completed_utc: new Date().toISOString() }), { flag: "wx" });
  }
}

export function rdpStatus(persist = true, historical = false) {
  if (!fs.existsSync(file("baseline.json"))) return { state: "NOT STARTED", queue: RDP_QUEUE };
  const baseline = JSON.parse(fs.readFileSync(file("baseline.json"), "utf8"));
  const request = fs.existsSync(requestFile) ? JSON.parse(fs.readFileSync(requestFile, "utf8")) as Request : null;
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : null;
  const started = fs.existsSync(file("codex-started.json")) ? JSON.parse(fs.readFileSync(file("codex-started.json"), "utf8")) : null;
  const sent = fs.existsSync(file("prompt-sent.json")) ? JSON.parse(fs.readFileSync(file("prompt-sent.json"), "utf8")) : null;
  const observations = fs.existsSync(file("observations.jsonl")) ? fs.readFileSync(file("observations.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const beat = fs.existsSync(path.join(QUEUE, "heartbeat.json")) ? JSON.parse(fs.readFileSync(path.join(QUEUE, "heartbeat.json"), "utf8")) : null;
  let workerAlive = false;
  try { if (beat && Date.now() - Date.parse(beat.observed_utc) < 10000) { process.kill(beat.pid, 0); workerAlive = true; } } catch { /* missing process */ }
  const recorded = historical && fs.existsSync(file("summary.json")) ? JSON.parse(fs.readFileSync(file("summary.json"), "utf8")) : null;
  // Historical review cannot re-test a process that has since exited. Only a
  // previously recorded successful live check, bound to this baseline and a
  // heartbeat after the result, can stand in for the old live observation.
  const recordedWorker = historical && recordedWorkerCheck(recorded, baseline, result?.completed_utc);
  const sameWorker = !!(beat && workerAlive && beat.pid === baseline.pid && beat.session_id === baseline.session_id && baseline.session_id > 0) || recordedWorker;
  const { samples_continuous: samplesContinuous, held_ten_minutes: heldTenMinutes } = rdpContinuity(baseline, started, sent, observations);
  const stderr = result?.stderr ?? "", stdout = result?.stdout ?? "";
  const reads = rdpReadChecks(stderr);
  const runner_pipe_timeout = /runner pipe.*timeout|timed out after 15000ms connecting runner pipe-in/i.test(stderr + stdout);
  const runner_0xc0000142 = /0xc0000142/i.test(stderr + stdout);
  const matchingResult = !!(result && request && result.task_id === RDP_ID && result.nonce === request.nonce && result.request_hash === requestHash(request) && result.request_hash === request.request_hash && result.session_id === baseline.session_id);
  const passed = matchingResult && sameWorker && samplesContinuous && heldTenMinutes && result.exit_code === 0 && !runner_pipe_timeout && !runner_0xc0000142 && Object.values(reads).every(Boolean);
  const summary = { state: !result ? "RUNNING OR INCOMPLETE" : passed ? "PASS" : "FAIL", baseline, current_heartbeat: recordedWorker ? recorded.current_heartbeat : beat, same_worker: sameWorker, worker_evidence: recordedWorker ? "recorded_live_check" : "current_live_check", observation_count: observations.length, samples_continuous: samplesContinuous, codex_started: started, prompt_sent: sent, held_ten_minutes: heldTenMinutes, matching_result: matchingResult, codex_exit_code: result?.exit_code ?? null, runner_pipe_timeout, runner_0xc0000142, reads, stdout_file: result ? file("stdout.log") : null, stderr_file: result ? file("stderr.log") : null, note: "Worker observations establish continuity, not RDP disconnection itself. Codex remains open for ten minutes before the fixed read-only prompt is sent; this does not measure ten minutes of model computation." };
  if (result && persist) {
    fs.writeFileSync(file("stdout.log"), stdout);
    fs.writeFileSync(file("stderr.log"), stderr);
    fs.writeFileSync(file("summary.json"), JSON.stringify(summary, null, 2));
  }
  return summary;
}
