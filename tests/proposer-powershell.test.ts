import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deployment } from "../src/config/deployment.js";

it("checks the real portable PowerShell schema, identity, OAuth, session and zero-tool contracts offline", () => {
  const result = spawnSync(deployment.pwsh, ["-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./fixtures/proposer-contract.ps1", import.meta.url))], {
    encoding: "utf8", timeout: 20000, windowsHide: true, shell: false,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
      HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.checks).toBeGreaterThanOrEqual(26);
  expect(report.provider_calls).toBe(0);
  expect(report.platform).toBe(process.platform);
});
