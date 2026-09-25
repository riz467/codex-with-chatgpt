import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { categoryFor, createExitTelemetry, safeError } from "../src/worker/exit-telemetry.js";

const dirs: string[] = [];
const dir = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "worker-exit-")); dirs.push(value); return value; };
afterEach(() => { for (const value of dirs.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });
const entries = (root: string) => fs.readFileSync(path.join(root, "lifecycle.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const current = (root: string) => JSON.parse(fs.readFileSync(path.join(root, "current-exit.json"), "utf8"));

describe("bounded worker exit telemetry", () => {
  it("records lifecycle and normal exit with fixed schema", () => {
    const root = dir(), clock = Date.parse("2026-01-01T00:00:00Z"); let now = clock;
    const t = createExitTelemetry(root, 42, 1, () => now);
    t.record("worker_start", { phase: "init" }); t.record("worker_ready", { phase: "idle" }); t.record("worker_idle", { phase: "idle" });
    now += 3200;
    t.record("worker_shutdown", { phase: "shutdown", graceful: true });
    t.record("worker_exit", { phase: "shutdown", exit_code: 0, reason_category: "NORMAL_EXIT", graceful: true });
    t.record("worker_exit", { phase: "process", exit_code: 1 });
    expect(entries(root).map(x => x.event)).toEqual(["worker_start", "worker_ready", "worker_idle", "worker_shutdown", "worker_exit"]);
    expect(current(root)).toMatchObject({ timestamp: "2026-01-01T00:00:03.200Z", pid: 42, session_id: 1, exit_code: 0,
      reason_category: "NORMAL_EXIT", phase: "shutdown", uptime_seconds: 3, graceful: true });
  });
  it("classifies init, heartbeat, queue, job and unhandled exceptions without persisting raw messages", () => {
    expect(categoryFor("init")).toBe("WORKER_INIT_ERROR");
    expect(categoryFor("heartbeat")).toBe("HEARTBEAT_ERROR");
    expect(categoryFor("queue")).toBe("QUEUE_ERROR");
    expect(categoryFor("job")).toBe("JOB_ERROR");
    expect(categoryFor("idle")).toBe("UNHANDLED_EXCEPTION");
    const root = dir();
    createExitTelemetry(root, 42, 1).record("worker_exit", { phase: "heartbeat", reason_category: "HEARTBEAT_ERROR", exit_code: 1,
      error: Object.assign(new Error("Bearer secret123 password=x C:\\private\\token.txt\nstack"), { code: "EACCES" }) });
    const text = fs.readFileSync(path.join(root, "current-exit.json"), "utf8");
    expect(text).toContain("EACCES");
    expect(text).not.toMatch(/secret123|password|private|token\.txt|stack|Bearer/);
    expect(current(root)).toMatchObject({ reason_category: "HEARTBEAT_ERROR", error_name: "Error", graceful: false });
    expect(safeError({ name: "SecretCustomClass", message: "token=xyz", code: "SECRET" })).toEqual({ error_name: null, detail: "" });
  });
  it("records init, queue, job, unhandled and signal exits as separate bounded categories", () => {
    for (const [phase, category] of [["init", "WORKER_INIT_ERROR"], ["queue", "QUEUE_ERROR"], ["job", "JOB_ERROR"],
      ["idle", "UNHANDLED_EXCEPTION"]] as const) {
      const root = dir();
      createExitTelemetry(root, 42, 1).record("worker_exit", { phase, reason_category: category, exit_code: 1, error: new Error("token=never-log") });
      expect(current(root)).toMatchObject({ reason_category: category, phase, exit_code: 1, graceful: false });
      expect(JSON.stringify(current(root))).not.toContain("never-log");
    }
    const root = dir();
    createExitTelemetry(root, 42, 1).record("worker_exit", { phase: "idle", reason_category: "SIGNAL_EXIT", exit_code: 143 });
    expect(current(root)).toMatchObject({ reason_category: "SIGNAL_EXIT", exit_code: 143, graceful: false });
  });
  it("records job ends safely and restricts task IDs, summaries and lengths", () => {
    const root = dir(), t = createExitTelemetry(root, 42, 1);
    t.record("worker_job_start", { phase: "job", task_id: "rpc-safe" });
    t.record("worker_job_end", { phase: "job", task_id: "../secret", reason_category: "JOB_ERROR", exit_code: 2,
      error: new Error("x".repeat(1000)) });
    expect(entries(root)[0].task_id).toBe("rpc-safe");
    expect(entries(root)[1].task_id).toBeNull();
    expect(entries(root)[1].short_summary.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(entries(root))).not.toContain("../secret");
  });
  it("overwrites current exit, rotates bounded history and handles malformed old telemetry", () => {
    const root = dir(), t = createExitTelemetry(root, 42, 1);
    fs.writeFileSync(path.join(root, "lifecycle.jsonl"), "not json\n");
    fs.writeFileSync(path.join(root, "current-exit.json"), "not json");
    t.record("worker_start", { phase: "init" });
    expect(entries(root)).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "lifecycle.1.jsonl"))).toBe(true);
    fs.writeFileSync(path.join(root, "lifecycle.jsonl"), "x".repeat(150_000));
    t.record("worker_exit", { phase: "init", reason_category: "WORKER_INIT_ERROR", exit_code: 1 });
    expect(current(root).reason_category).toBe("WORKER_INIT_ERROR");
    expect(fs.statSync(path.join(root, "lifecycle.jsonl")).size).toBeLessThan(131_072);
    expect(fs.statSync(path.join(root, "lifecycle.1.jsonl")).size).toBeLessThanOrEqual(131_072);
  });
  it("ignores write failure and never creates queue files", () => {
    const root = path.join(dir(), "missing");
    expect(() => createExitTelemetry(root, 42, 1).record("worker_exit", { exit_code: 1 })).not.toThrow();
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32")("wrapper fallback evidence", () => {
  const helper = fileURLToPath(new URL("../scripts/codex-worker-exit-evidence.ps1", import.meta.url));
  const wrapper = fileURLToPath(new URL("../scripts/start-codex-interactive-worker.ps1", import.meta.url));
  const call = (root: string, code: number, nodeStarted: boolean) => {
    const escaped = root.replaceAll("'", "''");
    execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `. '${helper}'; Write-CodexWorkerFallbackExit -Started ([DateTimeOffset]::UtcNow.AddSeconds(-3)) -ExitCode ${code} -NodeStarted $${nodeStarted} -EvidenceDir '${escaped}'`],
    { windowsHide: true, timeout: 12000 });
  };
  it("records a nonzero child exit without claiming the cause", () => {
    const root = dir(); call(root, 1, true);
    expect(current(root)).toMatchObject({ event: "worker_exit", exit_code: 1, reason_category: "PROCESS_EXIT", phase: "wrapper", graceful: false });
    expect(fs.readFileSync(wrapper, "utf8")).toContain("exit $exitCode");
  });
  it("reports pre-Node failure and preserves a richer Node exit from this invocation", () => {
    const root = dir(); call(root, 1, false);
    expect(current(root).reason_category).toBe("WORKER_INIT_ERROR");
    createExitTelemetry(root, 42, 1).record("worker_exit", { phase: "idle", exit_code: 1, reason_category: "UNHANDLED_EXCEPTION" });
    call(root, 1, true);
    expect(current(root).reason_category).toBe("UNHANDLED_EXCEPTION");
  });
});
