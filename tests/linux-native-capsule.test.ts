import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error build-host script has no TS declaration
import { assertLinuxBuilder, assertLinuxElf, inventory, assertDryCertification, assertRuntimeCustodyRows, packagePayloadSha256, sha } from "../scripts/linux-native-capsule.mjs";
const roots: string[] = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-capsule-offline-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe("Linux capsule builder policies, not a built capsule", () => {
  it("pins nested tool dependencies with deterministic path ordering", () => {
    const root = fixture(); fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "z"), "z"); fs.writeFileSync(path.join(root, "node_modules", "a"), "a");
    expect(packagePayloadSha256(root)).toEqual({ files: 2, sha256: sha("node_modules/a\0" + "1\0a" + "z\0" + "1\0z") });
  });
  it("rejects multiply linked tool payload before reads", () => {
    const root = fixture(); fs.writeFileSync(path.join(root, "one"), "x"); fs.linkSync(path.join(root, "one"), path.join(root, "two"));
    expect(() => packagePayloadSha256(root)).toThrow("BUILD_TOOL_PAYLOAD_LIMIT");
  });
  it("never admits internal links or oversized rows to strict deployment runtime", () => {
    expect(() => assertRuntimeCustodyRows([{ path: "binary", type: "FILE", bytes: 123438592 }])).not.toThrow();
    expect(() => assertRuntimeCustodyRows([{ path: "link", type: "SYMLINK", target: "inside" }])).toThrow();
    expect(() => assertRuntimeCustodyRows([{ path: "binary", type: "FILE", bytes: 129 * 1024 ** 2 }])).toThrow();
    expect(() => assertRuntimeCustodyRows(Array(20001).fill({ type: "DIRECTORY" }))).toThrow();
  });
  it.each([["win32", "x64", 993, 993], ["linux", "arm64", 993, 993], ["linux", "x64", 0, 993], ["linux", "x64", 993, 0]])("rejects unsupported/privileged builder %j", (...args) => {
    expect(() => assertLinuxBuilder(...args)).toThrow("NONROOT_LINUX_X64");
  });
  it("requires Linux x64 ELF, never PE or arbitrary bytes", () => {
    for (const b of [Buffer.from("MZfake"), Buffer.alloc(20)]) expect(() => assertLinuxElf(b)).toThrow();
    const b = Buffer.alloc(120); b.set([127, 69, 76, 70, 2, 1, 1]); b.writeUInt16LE(62, 18);
    b.writeBigUInt64LE(64n, 32); b.writeUInt16LE(64, 52); b.writeUInt16LE(56, 54); b.writeUInt16LE(1, 56);
    // Synthetic structural test only, not proof of a loadable ELF/ABI.
    expect(() => assertLinuxElf(b)).not.toThrow();
    b.writeBigUInt64LE(999n, 72); expect(() => assertLinuxElf(b)).toThrow("ELF_SEGMENT_BOUNDS");
  });
  it("records file byte pins without pretending it is Linux execution", () => {
    const root = fixture(); fs.writeFileSync(path.join(root, "package.json"), "{}");
    const rows = inventory(root); expect(rows[0]).toMatchObject({ path: "package.json", type: "FILE", bytes: 2, nativeModule: false });
    expect(rows[0].sha256).toHaveLength(64);
  });
  it.each(["auth.json", ".env", ".env.production", "opencode.db", "opencode.sqlite3", ".npmrc"])("rejects private payload path %s", name => {
    const root = fixture(); fs.writeFileSync(path.join(root, name), "never ship"); expect(() => inventory(root)).toThrow("CAPSULE_PATH");
  });
  it("rejects a Windows native addon", () => {
    const root = fixture(); fs.writeFileSync(path.join(root, "sqlite.node"), "MZ"); expect(() => inventory(root)).toThrow("LINUX_X64_ELF");
  });
  it("rejects a SQLite header regardless of its file extension", () => {
    const root = fixture(); fs.writeFileSync(path.join(root, "state.bin"), "SQLite format 3\0");
    expect(() => inventory(root)).toThrow("CAPSULE_DATABASE");
  });
  it("does not accept a compatible boolean without actual dry deny evidence", () => {
    expect(() => assertDryCertification({ compatible: true })).toThrow();
    const r = { kind: "OPENCODE_CORE_CERTIFICATION_ONLY", result: "COMPATIBLE", compatible: true,
      effectivePermission: "DENY_ALL", directTools: 0, codeModeTools: 0, preparedTools: 0,
      activity: { network: 0, processes: 0, forbiddenReads: 0 }, networkEnforcement: "APPLICATION_NO_NETWORK_DRY_PROFILE_ONLY" };
    expect(() => assertDryCertification(r)).not.toThrow();
    expect(() => assertDryCertification({ ...r, activity: { ...r.activity, network: 1 } })).toThrow();
  });
  it("rejects multiply linked payloads", () => {
    const root = fixture(); fs.writeFileSync(path.join(root, "one"), "x"); fs.linkSync(path.join(root, "one"), path.join(root, "two"));
    expect(() => inventory(root)).toThrow("CAPSULE_SPECIAL_OR_HARDLINK");
  });
});
