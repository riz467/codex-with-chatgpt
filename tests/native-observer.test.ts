import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_PUBLIC_RESULTS, readNativePublicReceipt, parseNativeObserverCli, publishNativePublicReceipt, assertNativePublicResultProvisioning } from "../src/linux-development/native-observer.js";
const receipt = { version: 1, task: "COUNTER_JSON_V1", taskId: "20261011-0000-4000-8000-000000000001", receiptId: "receipt-001",
  mode: "NATIVE_LINUX_HOST", result: "UNKNOWN_NO_REPLAY", authority: "NONE", productionDispatch: "CLOSED", replay: false,
  qualification: "NOT_RUN", candidateCode: "NOT_EXECUTED", fastOsProof: "NOT_CLAIMED", sourceCommit: "a".repeat(40),
  manifestSha256: "b".repeat(64), requestDigest: "c".repeat(64), proposerSessionId: null, reviewerSessionId: null,
  candidateDigest: null, settlements: [], evidence: [] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mockObserver(variant = "safe") {
  const realProcess = process;
  vi.stubGlobal("process", Object.create(realProcess, { platform: { value: "linux" }, getuid: { value: () => variant === "wrong_uid" ? 993 : 994 }, geteuid: { value: () => 994 } }));
  const file = `${NATIVE_PUBLIC_RESULTS}/handoff.json`;
  const body = Buffer.from(JSON.stringify(variant === "secret_extension" ? { ...receipt, token: "mustreject" } : receipt));
  const stat = (p: string) => {
    const isFile = p === file;
    return { uid: isFile || p === NATIVE_PUBLIC_RESULTS ? 993 : 0, gid: 985, mode: isFile ? variant === "file_writable" ? 0o660 : 0o640 : p === NATIVE_PUBLIC_RESULTS ? 0o2750 : 0o755,
      dev: 1, ino: 1, size: body.length, nlink: variant === "hardlink" && isFile ? 2 : 1, mtimeMs: 1, ctimeMs: 1,
      isFile: () => isFile, isDirectory: () => !isFile, isSymbolicLink: () => variant === "symlink" && isFile } as fs.Stats;
  };
  vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike) => stat(String(p))) as typeof fs.lstatSync);
  const open = vi.spyOn(fs, "openSync").mockReturnValue(71);
  vi.spyOn(fs, "fstatSync").mockImplementation(() => ({ ...stat(file), ino: variant === "changed_inode" ? 2 : 1 }) as fs.Stats);
  vi.spyOn(fs, "closeSync").mockImplementation(() => {});
  const read = vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    if (variant === "concurrent_growth") { buffer.fill(120, offset, offset + length); return length; }
    const bytes = body.subarray(position, position + length); bytes.copy(buffer, offset); return bytes.length;
  }) as typeof fs.readSync);
  return { open, read, file };
}
describe("sanitized developer observer (offline filesystem observations only)", () => {
  it("requires custodian result-group admission before task dispatch", () => {
    const realProcess = process; mockObserver();
    vi.stubGlobal("process", Object.create(realProcess, { platform: { value: "linux" }, getuid: { value: () => 993 },
      geteuid: { value: () => 993 }, getgroups: { value: () => [] } }));
    expect(assertNativePublicResultProvisioning).toThrow();
    vi.stubGlobal("process", Object.create(realProcess, { platform: { value: "linux" }, getuid: { value: () => 993 },
      geteuid: { value: () => 993 }, getgroups: { value: () => [984, 985] } }));
    expect(assertNativePublicResultProvisioning).not.toThrow();
  });
  it("UID994 reads only one public DATA file, never custody/journal", () => {
    const f = mockObserver(); expect(readNativePublicReceipt()).toEqual(receipt);
    expect(f.open).toHaveBeenCalledOnce(); expect(f.open.mock.calls[0][0]).toBe(f.file);
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.read.mock.calls[0][0]).toBe(71);
  });
  it.each(["wrong_uid", "file_writable", "hardlink", "symlink", "changed_inode", "secret_extension", "concurrent_growth"])("fails closed on %s", variant => {
    mockObserver(variant); expect(readNativePublicReceipt).toThrow();
  });
  it.each([[], ["run"], ["status", "--credential"], ["readreceipt", "/private"]])("never accepts dispatch/path grammar %j", args => {
    expect(() => parseNativeObserverCli(args)).toThrow();
  });
  it("does not publish on Windows or developer principal", () => {
    if (process.platform === "win32") expect(() => publishNativePublicReceipt(receipt as never)).toThrow();
  });
});
