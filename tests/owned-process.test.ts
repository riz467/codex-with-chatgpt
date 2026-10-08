import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { terminateOwnedProcess, terminateOwnedProcessAndWait } from "../src/mcp/owned-process.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("waits for delayed exit before allowing a caller to retry", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null }) as ChildProcess;
  vi.stubGlobal("process", { ...process, platform: "linux", kill: vi.fn((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error(), { code: "ESRCH" });
    setTimeout(() => child.emit("exit", null, "SIGKILL"), 100); return true;
  }) });
  const retry = vi.fn();
  const stopped = terminateOwnedProcessAndWait(child).then(retry);
  await vi.advanceTimersByTimeAsync(99); expect(retry).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await stopped; expect(retry).toHaveBeenCalledOnce();
  expect(child.listenerCount("exit")).toBe(0);
});

it("waits for the group after leader exit, and refuses an unobservable group exit", async () => {
  vi.useFakeTimers();
  const child = { pid: 12345, exitCode: 0, signalCode: null } as ChildProcess;
  let present = true;
  vi.stubGlobal("process", { ...process, platform: "linux", kill: vi.fn((_pid, signal) => {
    if (signal === 0 && !present) throw Object.assign(new Error(), { code: "ESRCH" });
    return true;
  }) });
  const completed = vi.fn();
  const waiting = terminateOwnedProcessAndWait(child).then(completed);
  await vi.advanceTimersByTimeAsync(100); expect(completed).not.toHaveBeenCalled();
  present = false; await vi.advanceTimersByTimeAsync(25); await waiting;
  expect(completed).toHaveBeenCalledOnce();
  present = true;
  const failure = expect(terminateOwnedProcessAndWait(child)).rejects.toThrow("PROCESS_GROUP_EXIT_REQUIRES_INSPECTION");
  await vi.advanceTimersByTimeAsync(2000); await failure;
});

it("bounds exit waiting and requires inspection if termination is not observed", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null }) as ChildProcess;
  vi.stubGlobal("process", { ...process, platform: "linux", kill: vi.fn().mockReturnValue(true) });
  const result = expect(terminateOwnedProcessAndWait(child)).rejects.toThrow("PROCESS_EXIT_REQUIRES_INSPECTION");
  await vi.advanceTimersByTimeAsync(2000); await result;
  expect(child.listenerCount("exit")).toBe(0);
});

it("signals a private POSIX group even after its leader exits", () => {
  const kill = vi.fn().mockReturnValue(true);
  vi.stubGlobal("process", { ...process, platform: "linux", kill });
  terminateOwnedProcess({ pid: 12345, exitCode: 0 } as ChildProcess);
  expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
  kill.mockImplementation(() => { throw Object.assign(new Error(), { code: "ESRCH" }); });
  expect(() => terminateOwnedProcess({ pid: 12345 } as ChildProcess)).not.toThrow();
  kill.mockImplementation(() => { throw Object.assign(new Error(), { code: "EPERM" }); });
  expect(() => terminateOwnedProcess({ pid: 12345 } as ChildProcess)).toThrow();
});

it.skipIf(process.platform !== "linux")("kills a timeout child's descendant that ignores SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
    grandchild.stdout.once('data',()=>console.log(grandchild.pid));setInterval(()=>{},1000);
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    const closed = new Promise(resolve => child.once("close", resolve));
    terminateOwnedProcess(child);
    // An inherited stderr handle keeps close pending if the grandchild survives.
    await closed;
    expect(child.signalCode).toBe("SIGKILL");
  } finally { terminateOwnedProcess(child); }
});
