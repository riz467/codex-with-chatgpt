import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/status-codex-interactive-worker.ps1", import.meta.url));
const source = fs.readFileSync(script, "utf8");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const fixture = (observed: string, exitTimestamp?: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-status-date-")); dirs.push(dir);
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ pid: 2460, observed_utc: observed }));
  if (exitTimestamp) fs.writeFileSync(path.join(dir, "current-exit.json"), JSON.stringify({ event: "worker_exit", timestamp: exitTimestamp,
    reason_category: "PROCESS_EXIT", phase: "wrapper", exit_code: 1, graceful: false }));
  return dir;
};
const asOffset = (instant: number) => new Date(instant + 9 * 3600_000).toISOString().replace("Z", "+09:00");
function run(dir: string, timezone: string) {
  const escape = (value: string) => value.replaceAll("'", "''");
  const command = `$env:TZ='${escape(timezone)}'; function Get-ScheduledTask { [pscustomobject]@{ State='Running' } }; ` +
    `$source=[IO.File]::ReadAllText('${escape(script)}'); ` +
    `$source=$source.Replace('C:\\work\\ai-workspace-logs\\codex-worker','${escape(dir)}'); & ([scriptblock]::Create($source))`;
  return execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 12000 });
}
const age = (output: string) => {
  const match = /Last heartbeat: ([\d,]+)s ago \(last known PID 2460\)/.exec(output);
  return match ? Number(match[1].replaceAll(",", "")) : null;
};

describe.skipIf(process.platform !== "win32")("worker status ISO timestamp parsing", () => {
  it("keeps Z timestamps as UTC and reports a near-zero heartbeat age", () => {
    const output = run(fixture(new Date().toISOString()), "UTC");
    expect(output).toContain("Worker task: Running");
    expect(age(output)).not.toBeNull();
    expect(age(output)).toBeLessThan(10);
  });
  it("keeps +09:00 offsets as the same instant in UTC and JST environments", () => {
    for (const timezone of ["UTC", "Tokyo Standard Time"]) {
      const output = run(fixture(asOffset(Date.now())), timezone);
      expect(age(output)).not.toBeNull();
      expect(age(output)).toBeLessThan(10);
    }
  });
  it("normalizes current-exit timestamps to UTC without shifting the instant", () => {
    const instant = Date.parse("2026-09-25T19:10:15.817Z");
    for (const timestamp of ["2026-09-25T19:10:15.817Z", asOffset(instant)]) {
      const output = run(fixture(new Date().toISOString(), timestamp), "Tokyo Standard Time");
      expect(output).toContain("Last exit: time=2026-09-25T19:10:15.8170000+00:00");
    }
  });
  it("returns unknown for malformed or future heartbeat timestamps", () => {
    for (const timestamp of ["not-a-date", new Date(Date.now() + 3600_000).toISOString()]) {
      const output = run(fixture(timestamp), "Tokyo Standard Time");
      expect(output).toContain("Last heartbeat: unknown");
    }
  });
  it("returns unknown for a malformed exit timestamp", () => {
    const output = run(fixture(new Date().toISOString(), "not-a-date"), "UTC");
    expect(output).toContain("Last exit: unknown (missing or invalid evidence)");
  });
  it("parses both JSON date fields as strings", () => {
    expect(source.match(/ConvertFrom-Json -DateKind String/g)).toHaveLength(2);
  });
});
