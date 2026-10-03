import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("Stage 1 package contains fixture closure, no credentials or authority services, and does not overwrite", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ct704-pack-test-"));
  const output = path.join(base, "package");
  const root = path.resolve(import.meta.dirname, "..");
  try {
    const pack = () => spawnSync(process.execPath, ["scripts/pack-ct704-stage1.mjs", output], { cwd: root, encoding: "utf8" });
    expect(pack().status).toBe(0);
    const inventory: string[] = JSON.parse(fs.readFileSync(path.join(output, "stage1-files.json"), "utf8"));
    expect(inventory).toContain("src/execution-orchestrator/development/sandbox.ts");
    expect(inventory).toContain("tests/rc02-development-e0-fixture.ts");
    expect(inventory).toContain("src/execution-orchestrator/development/opencode-core-adapter.ts");
    expect(inventory.some(n => /(?:human-approver|review-service|signer|auth\.json|\.git\/|\.ai\/|node_modules\/)/.test(n))).toBe(false);
    for (const name of inventory) expect(fs.readFileSync(path.join(output, name), "utf8")).not.toContain("\r\n");
    const manifest = fs.readFileSync(path.join(output, "package.json"), "utf8");
    expect(pack().status).not.toBe(0);
    expect(fs.readFileSync(path.join(output, "package.json"), "utf8")).toBe(manifest);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
