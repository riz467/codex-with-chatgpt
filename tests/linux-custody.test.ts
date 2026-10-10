import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { assessLinuxCustodyMetadata, inspectLinuxCustodyMetadata, type LinuxCustodyObservation } from "../src/linux-development/custody.js";
const dir = (ownerUid: number, mode: number) => ({ ownerUid, mode, type: "directory" as const, symlink: false, nlink: 2 });
const file = (ownerUid: number, mode: number) => ({ ownerUid, mode, type: "file" as const, symlink: false, nlink: 1 });
const candidate = (): LinuxCustodyObservation => ({ platform: "linux", realUid: 900, effectiveUid: 900, credentialUid: 900,
  untrustedUids: [994], privateRoot: dir(900, 0o700), credentialFile: file(900, 0o600),
  privateAncestors: [dir(900, 0o700), dir(0, 0o755)], trustedRuntime: file(0, 0o644), runtimeAncestors: [dir(0, 0o755)] });
function withMockLinux(action: () => void, unsafeAncestor = false, inaccessible = false) {
  const descriptors = ["platform", "getuid", "geteuid"].map(key => [key, Object.getOwnPropertyDescriptor(process, key)] as const);
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 900 });
  Object.defineProperty(process, "geteuid", { configurable: true, value: () => 900 });
  const stat = vi.spyOn(fs, "lstatSync").mockImplementation(p => {
    if (inaccessible) throw new Error("PRIVATE_FAILURE_MUST_NOT_LEAK");
    const name = String(p), s = new fs.Stats();
    const credential = name.endsWith("host-oauth.json"), runtime = name.endsWith("host-adapter.js");
    s.uid = name.startsWith("/var/lib/ai-linux-provider") ? 900 : 0;
    s.mode = credential ? 0o100600 : runtime ? 0o100644 : s.uid === 900 ? 0o040700 : 0o040755;
    s.nlink = credential || runtime ? 1 : 2;
    if (unsafeAncestor && name === "/opt/ai-linux-provider") s.mode = 0o040777;
    return s;
  });
  try { action(); } finally {
    stat.mockRestore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(process, key, descriptor); else Reflect.deleteProperty(process, key);
    }
  }
}
describe("Linux private custody metadata, never admission", () => {
  it("only identifies a metadata candidate, never authorizes or returns credentials", () => {
    expect(assessLinuxCustodyMetadata(candidate())).toMatchObject({ metadataCandidate: true, admitted: false, credentialBytesRead: 0, provider: "NOT_RUN", authority: "NONE" });
  });
  it.each([0, 994])("rejects custodian/root-executor UID overlap %s", id => {
    const x = candidate(); x.untrustedUids = [id === 0 ? 0 : x.credentialUid];
    expect(assessLinuxCustodyMetadata(x).reasons).toContain("SHARED_OR_ROOT_EXECUTOR_UID");
  });
  it.each(["realUid", "effectiveUid"] as const)("rejects privileged %s", field => {
    const x = candidate(); x[field] = 0; expect(assessLinuxCustodyMetadata(x).metadataCandidate).toBe(false);
  });
  it("rejects execution from another user", () => {
    const x = candidate(); x.realUid = x.effectiveUid = 994;
    expect(assessLinuxCustodyMetadata(x).reasons).toContain("CUSTODIAN_UID_MISMATCH");
  });
  it.each([0o644, 0o660, 0o4600])("rejects unsafe credential mode %s", mode => {
    const x = candidate(); x.credentialFile.mode = mode; expect(assessLinuxCustodyMetadata(x).metadataCandidate).toBe(false);
  });
  it("rejects aliases and multiply linked credentials", () => {
    const x = candidate(); x.credentialFile.symlink = true;
    expect(assessLinuxCustodyMetadata(x).metadataCandidate).toBe(false);
    x.credentialFile.symlink = false; x.credentialFile.nlink = 2;
    expect(assessLinuxCustodyMetadata(x).metadataCandidate).toBe(false);
  });
  it("rejects writable/aliased/private ancestors", () => {
    for (const m of [dir(994, 0o755), dir(0, 0o777), { ...dir(0, 0o755), symlink: true }]) {
      const x = candidate(); x.privateAncestors.push(m); expect(assessLinuxCustodyMetadata(x).metadataCandidate).toBe(false);
    }
  });
  it("rejects adapter owned by developer or custodian and group-writable runtime", () => {
    for (const m of [file(994, 0o644), file(900, 0o644), file(0, 0o664)]) {
      const x = candidate(); x.trustedRuntime = m; expect(assessLinuxCustodyMetadata(x).metadataCandidate).toBe(false);
    }
  });
  it("rejects runtime directory writable by untrusted code", () => {
    const x = candidate(); x.runtimeAncestors.push(dir(994, 0o700)); expect(assessLinuxCustodyMetadata(x).metadataCandidate).toBe(false);
  });
  it("invalid secret-bearing input is not echoed into evidence or errors", () => {
    const output = assessLinuxCustodyMetadata({ ...candidate(), access: "SECRET_MUST_NOT_BE_LOGGED" });
    expect(output.reasons).toEqual(["INVALID_METADATA"]); expect(JSON.stringify(output)).not.toContain("SECRET_MUST_NOT_BE_LOGGED");
  });
  it("metadata inspection never opens credential bytes", () => {
    const read = vi.spyOn(fs, "readFileSync");
    try { expect(inspectLinuxCustodyMetadata().admitted).toBe(false); expect(read).not.toHaveBeenCalled(); }
    finally { read.mockRestore(); }
  });
  it("collects fixed Linux metadata without opening any secret bytes", () => {
    withMockLinux(() => {
      const read = vi.spyOn(fs, "readFileSync");
      try {
        expect(inspectLinuxCustodyMetadata()).toMatchObject({ metadataCandidate: true, admitted: false, credentialBytesRead: 0 });
        expect(read).not.toHaveBeenCalled();
      } finally { read.mockRestore(); }
    });
  });
  it("Linux collector rejects inaccessible layout without echoing exceptions", () => {
    withMockLinux(() => {
      const result = inspectLinuxCustodyMetadata();
      expect(result.reasons).toEqual(["MISSING_OR_INACCESSIBLE_LAYOUT"]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_FAILURE_MUST_NOT_LEAK");
    }, false, true);
  });
  it("Linux collector actually inspects unsafe runtime ancestors", () => {
    withMockLinux(() => expect(inspectLinuxCustodyMetadata().reasons).toContain("TRUSTED_RUNTIME_UNSAFE"), true);
  });
  it("even plausible Linux metadata still never opens provider admission", () => {
    withMockLinux(() => expect(inspectLinuxCustodyMetadata()).toMatchObject({ admitted: false, provider: "NOT_RUN", productionDispatch: "CLOSED", authority: "NONE" }));
  });
});
