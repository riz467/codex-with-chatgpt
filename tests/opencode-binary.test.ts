import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pinned-"))); roots.push(root);
  const proposer = path.join(root, "proposer.exe"), reviewer = path.join(root, "reviewer.exe"), human = path.join(root, "human.exe");
  for (const file of [proposer, reviewer, human]) fs.writeFileSync(file, "fixture-release");
  const release = { version: "2.0.22", [process.platform]: { proposer, reviewer,
    sha256: createHash("sha256").update("fixture-release").digest("hex") } };
  const read = fs.readFileSync;
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, options: any) =>
    String(file).endsWith("opencode-release.json") ? JSON.stringify(release) : read(file, options)) as typeof fs.readFileSync);
  const binary = await import("../src/mcp/opencode-binary.js"); spy.mockRestore();
  return { ...binary, root, proposer, reviewer, human };
}
it("pins two independent roles, unaffected by replacing the Human CLI", async () => {
  const f = await fixture();
  fs.writeFileSync(f.human, "2.0.24 changed independently");
  expect(f.assertOpencodeBinary("proposer")).toBe(f.proposer);
  expect(f.assertOpencodeBinary("reviewer")).toBe(f.reviewer);
  fs.writeFileSync(f.proposer, "tampered");
  expect(() => f.assertOpencodeBinary("proposer")).toThrow("OPENCODE_BINARY_IDENTITY_MISMATCH");
  expect(f.assertOpencodeBinary("reviewer")).toBe(f.reviewer);
});
it.each(["missing", "directory", "hardlink", "ancestor-alias"])("rejects %s placement even before a subprocess can run", async kind => {
  const f = await fixture();
  if (kind === "ancestor-alias") {
    const moved = `${f.root}-moved`; fs.renameSync(f.root, moved); roots.push(moved);
    fs.symlinkSync(moved, f.root, process.platform === "win32" ? "junction" : "dir");
  } else {
    fs.unlinkSync(f.proposer);
    if (kind === "directory") fs.mkdirSync(f.proposer);
    if (kind === "hardlink") fs.linkSync(f.reviewer, f.proposer);
  }
  expect(() => f.assertOpencodeBinary("proposer")).toThrow("OPENCODE_BINARY_IDENTITY_MISMATCH");
});
it("ships versioned paths outside the global CLI and separate role copies on both OSes", () => {
  const release = JSON.parse(fs.readFileSync(new URL("../src/mcp/proposer/opencode-release.json", import.meta.url), "utf8"));
  expect(release.version).toBe("2.0.22");
  for (const platform of ["win32", "linux"]) {
    expect(release[platform].proposer).not.toBe(release[platform].reviewer);
    for (const role of ["proposer", "reviewer"]) {
      expect(release[platform][role]).toContain("2.0.22");
      expect(release[platform][role]).not.toMatch(/node_modules|\/opt\/opencode\//);
    }
    expect(release[platform].sha256).toMatch(/^[a-f0-9]{64}$/);
  }
});
