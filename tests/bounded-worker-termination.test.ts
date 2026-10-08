import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { opencodeWorker } from "../src/mcp/bounded-task.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), ...mocked,
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("surfaces taskkill failure as a non-retryable inspection error and releases stdio handles", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("process", { ...process, platform: "win32" });
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn().mockReturnValue(true), unref: vi.fn(),
  });
  mocked.spawn.mockReturnValue(child);
  mocked.spawnSync.mockReturnValue({ status: 1 });
  const result = expect(opencodeWorker("fixture", "fixture prompt", 10)).rejects.toMatchObject({
    code: "PROCESS_TERMINATION_REQUIRES_INSPECTION",
  });
  await vi.advanceTimersByTimeAsync(10); await result;
  expect(mocked.spawnSync).toHaveBeenCalledWith("taskkill.exe", ["/PID", "12345", "/T", "/F"], expect.any(Object));
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
  expect(child.unref).toHaveBeenCalledOnce();
});

it.each(["close-missing", "group-present", "group-denied", "powershell-evidence"])("preserves uncertainty from %s on the portable worker path", async mode => {
  vi.useFakeTimers();
  const kill = vi.fn((_pid, signal) => {
    if (signal === 0 && mode !== "group-present") throw Object.assign(new Error(), { code: mode === "group-denied" ? "EPERM" : "ESRCH" });
    return true;
  });
  vi.stubGlobal("process", { ...process, platform: "linux", kill });
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null as number | null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(), unref: vi.fn(),
  });
  mocked.spawn.mockReturnValue(child);
  const outcome = expect(opencodeWorker("fixture", "fixture", mode === "close-missing" ? 10 : 10000)).rejects.toMatchObject({
    code: "PROCESS_TERMINATION_REQUIRES_INSPECTION",
  });
  if (mode !== "close-missing") {
    if (mode === "powershell-evidence") child.stderr.write('BOUNDED_EVIDENCE:{"phase":"PREFLIGHT","error_code":"PROCESS_TERMINATION_REQUIRES_INSPECTION","session_id":"ses_fixture"}');
    child.exitCode = 1; child.emit("close", 1);
  }
  await vi.advanceTimersByTimeAsync(2000); await outcome;
  if (mode === "close-missing") {
    expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
  }
});

it.each([0, 1])("selects only the packaged script and enforces zero tools (tools=%i)", async tools => {
  vi.stubGlobal("process", { ...process, platform: "linux", kill: vi.fn((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error(), { code: "ESRCH" });
    return true;
  }) });
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null as number | null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  mocked.spawn.mockReturnValue(child);
  const pending = opencodeWorker("fixture", "fixture", 10000);
  const outcome = tools ? expect(pending).rejects.toMatchObject({ code: "WORKER_EVIDENCE_INVALID" })
    : expect(pending).resolves.toMatchObject({ tools: 0, provider: "openai", model: "gpt-6-sol" });
  child.stdout.write(JSON.stringify({ worker: "opencode", state: "completed", provider: "openai", model: "gpt-6-sol",
    tools, session_id: "ses_fixture", execution_id: "msg_fixture", output: "{}" }));
  child.exitCode = 0; child.emit("close", 0);
  await outcome;
  expect(mocked.spawn.mock.calls[0][1][3].replaceAll("\\", "/")).toMatch(/\/src\/mcp\/proposer\/bounded-opencode-proposal\.ps1$/);
  expect(mocked.spawn.mock.calls[0][2]).toMatchObject({ detached: true, shell: false });
});
