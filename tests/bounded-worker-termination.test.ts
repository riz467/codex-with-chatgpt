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
