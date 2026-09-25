import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { RDP_ID, REPOS, assertLive, diagnosticPromptHash, enqueue, prepare, rdpPromptHash, readResult, requestHash, validate } from "../src/worker/codex-interactive.js";
import { RDP_WAIT_MS, rdpContinuity, rdpReadChecks, recordedWorkerCheck } from "../src/worker/rdp-disconnect-diagnostic.js";

const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worker-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const base = () => ({ task_id: "diag-test", repo: REPOS[0], attempt: 1, kind: "diagnostic" as const, nonce: crypto.randomBytes(16).toString("hex"), prompt_sha256: diagnosticPromptHash() });
describe("interactive Codex worker boundary", () => {
  it("refuses arbitrary command or executable fields", () => {
    const r = base();
    expect(() => validate({ ...r, request_hash: requestHash(r), command: "cmd /c whoami" })).toThrow("Invalid request fields");
    expect(() => validate({ ...r, request_hash: requestHash(r), executable: "pwsh" })).toThrow("Invalid request fields");
  });
  it("refuses outside repos, forged hashes and diagnostic mode on other repos", () => {
    const outside = { ...base(), repo: "C:\\work\\outside" };
    expect(() => validate({ ...outside, request_hash: requestHash(outside) })).toThrow("Invalid request identity");
    const r = base();
    expect(() => validate({ ...r, prompt_sha256: "0".repeat(64), request_hash: requestHash(r) })).toThrow("Invalid request identity");
    const other = { ...base(), repo: REPOS[1] };
    expect(() => validate({ ...other, request_hash: requestHash(other) })).toThrow("Invalid diagnostic");
  });
  it("accepts only the pinned one-shot RDP request, read-only sandbox and never approval", () => {
    const r = { ...base(), task_id: RDP_ID, kind: "rdp-diagnostic" as const, prompt_sha256: rdpPromptHash() };
    const checked = validate({ ...r, request_hash: requestHash(r) });
    expect(checked.args).toEqual(expect.arrayContaining(["-a", "never", "-s", "read-only", "--ephemeral", "-"]));
    expect(checked.args).not.toContain("--output-schema");
    for (const changed of [
      { ...r, task_id: "diag-rdp-other" }, { ...r, repo: REPOS[1] },
      { ...r, attempt: 2 }, { ...r, prompt_sha256: "0".repeat(64) },
    ]) expect(() => validate({ ...changed, request_hash: requestHash(changed) })).toThrow("Invalid RDP diagnostic");
    for (const field of ["command", "executable", "path", "prompt"]) {
      expect(() => validate({ ...r, request_hash: requestHash(r), [field]: "untrusted" })).toThrow("Invalid request fields");
    }
  });
  it.skipIf(process.platform !== "win32")("reserves a task attempt once and rejects a mismatched result", () => {
    const dir = temp(), r = enqueue(dir, base());
    expect(() => enqueue(dir, base())).toThrow("Duplicate task attempt");
    const result = path.join(dir, "results", "diag-test-1.json");
    fs.writeFileSync(result, JSON.stringify({ task_id: r.task_id, attempt: 1, nonce: "wrong", request_hash: r.request_hash }));
    expect(() => readResult(dir, r)).toThrow("Result correlation mismatch");
    fs.writeFileSync(result, JSON.stringify({ task_id: r.task_id, attempt: 1, nonce: r.nonce, request_hash: r.request_hash, exit_code: 0 }));
    expect(readResult(dir, r)?.exit_code).toBe(0);
  });
  it("does not treat a queue directory as evidence of a running worker", () => {
    const dir = temp(); prepare(dir);
    expect(() => assertLive(dir)).toThrow();
    fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ pid: process.pid, session_id: 2, observed_utc: "2000-01-01T00:00:00Z" }));
    expect(() => assertLive(dir)).toThrow("Worker heartbeat expired");
  });
  it("requires a full ten-minute gap-free sample trail for the same worker and Codex process", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    const iso = (offset: number) => new Date(start + offset).toISOString();
    const baseline = { pid: 123, session_id: 2 };
    const started = { pid: 456, started_utc: iso(0) };
    const sent = { observed_utc: iso(RDP_WAIT_MS) };
    const samples = Array.from({ length: 301 }, (_, i) => ({ observed_utc: iso(i * 2000), worker_pid: 123, session_id: 2, codex_pid: 456, codex_running: true }));
    expect(rdpContinuity(baseline, started, sent, samples)).toEqual({ samples_continuous: true, held_ten_minutes: true });
    expect(rdpContinuity(baseline, started, { observed_utc: iso(RDP_WAIT_MS - 1) }, samples).held_ten_minutes).toBe(false);
    expect(rdpContinuity(baseline, started, sent, samples.slice(2)).held_ten_minutes).toBe(false);
    expect(rdpContinuity(baseline, started, sent, samples.map((s, i) => i === 150 ? { ...s, worker_pid: 999 } : s)).samples_continuous).toBe(false);
    expect(rdpContinuity(baseline, started, sent, samples.map((s, i) => i === 150 ? { ...s, codex_running: false } : s)).samples_continuous).toBe(false);
    expect(rdpContinuity(baseline, started, sent, samples.map((s, i) => i === 150 ? { ...s, observed_utc: iso(i * 2000 + 16000) } : s)).samples_continuous).toBe(false);
  });
  it("matches batched, out-of-order exec results using actual output, not Codex's prose", () => {
    const pwsh = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"';
    const run = (cmd: string) => `${pwsh} -Command '${cmd}' in C:\\work\\pve-doc`;
    const logs = ["codex", "all four reads succeeded", "exec", run("git status --short"), "exec", run("Get-Content -LiteralPath AGENTS.md"),
      "exec", run("Get-Location | Select-Object -ExpandProperty Path"), "exec", run("Get-Content -LiteralPath 03_services/ai-workspace.md -TotalCount 40"),
      " succeeded in 628ms:", "?? .ai/", " succeeded in 682ms:", "C:\\work\\pve-doc", " succeeded in 714ms:", "# AGENTS.md — guidance",
      " succeeded in 486ms:", "# 常設AI作業VM", "**HISTORY** VM111 ai-workspace-win", "codex", "all four reads succeeded"].join("\n");
    expect(rdpReadChecks(logs)).toEqual({ current_directory: true, git_status_short: true, agents_md: true, ai_workspace_md: true });
    for (const changed of [
      logs.replace("?? .ai/", "nothing to commit"),
      logs.replace("C:\\work\\pve-doc\n succeeded in 714ms", "C:\\work\\other\n succeeded in 714ms"),
      logs.replace(" succeeded in 628ms:", " failed in 628ms:"),
      logs.replace(" succeeded in 628ms:\n?? .ai/", ""),
      logs.replace("# AGENTS.md — guidance", "no file content"),
      logs.replace("**HISTORY** VM111 ai-workspace-win", "unrelated text"),
    ]) expect(Object.values(rdpReadChecks(changed)).every(Boolean)).toBe(false);
    expect(Object.values(rdpReadChecks("codex\n4項目すべて読み取りに成功しました。\nC:\\work\\pve-doc\n?? .ai/\nAGENTS.md\nVM111 ai-workspace-win")).every(Boolean)).toBe(false);
  });
  it("accepts a historical live check only for the same baseline after completion", () => {
    const baseline = { pid: 123, session_id: 2, started_utc: "2026-01-01T00:00:00Z" };
    const recorded = { same_worker: true, baseline, current_heartbeat: { pid: 123, session_id: 2, observed_utc: "2026-01-01T00:12:00Z" } };
    const completed = "2026-01-01T00:11:00Z", now = Date.parse("2026-01-01T00:13:00Z");
    expect(recordedWorkerCheck(recorded, baseline, completed, now)).toBe(true);
    expect(recordedWorkerCheck({ ...recorded, same_worker: false }, baseline, completed, now)).toBe(false);
    expect(recordedWorkerCheck(recorded, { ...baseline, pid: 999 }, completed, now)).toBe(false);
    expect(recordedWorkerCheck({ ...recorded, current_heartbeat: { ...recorded.current_heartbeat, session_id: 3 } }, baseline, completed, now)).toBe(false);
    expect(recordedWorkerCheck(recorded, baseline, "2026-01-01T00:12:01Z", now)).toBe(false);
    expect(recordedWorkerCheck(recorded, baseline, completed, Date.parse("2026-01-01T00:11:59Z"))).toBe(false);
  });
});
