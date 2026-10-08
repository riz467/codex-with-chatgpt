// Fixed offline qualification set. Run only in a Human-approved disposable Linux fixture.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export function validFixtureReport(report, root, tests) {
  if (report?.success !== true || !Number.isSafeInteger(report.numTotalTests) || report.numTotalTests < 1 ||
      report.numPassedTests !== report.numTotalTests || !Array.isArray(report.testResults)) return false;
  const names = report.testResults.map(test => typeof test?.name === "string" && path.isAbsolute(test.name) ? path.relative(root, test.name).replaceAll(path.sep, "/") : "");
  if (names.length !== tests.length || new Set(names).size !== tests.length || !tests.every(test => names.includes(test))) return false;
  if (report.testResults.some(test => test?.status !== "passed" || !Array.isArray(test.assertionResults) || !test.assertionResults.length ||
      test.assertionResults.some(assertion => assertion?.status !== "passed"))) return false;
  return report.testResults.reduce((total, test) => total + test.assertionResults.length, 0) === report.numTotalTests;
}

function main() {
  if (process.argv.length !== 2 || process.platform !== "linux" || process.getuid() === 0) {
    throw new Error("NON_ROOT_LINUX_FIXTURE_REQUIRED; no caller-selected commands or paths");
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "linux-portability-evidence-"));
  fs.chmodSync(output, 0o700);
  const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: path.join(output, "home"),
    XDG_CONFIG_HOME: path.join(output, "config"), XDG_DATA_HOME: path.join(output, "data"),
    XDG_CACHE_HOME: path.join(output, "cache"), XDG_STATE_HOME: path.join(output, "state"),
    C2C_STATE_DIR: path.join(output, "c2c"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CI: "1" };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "C2C_STATE_DIR"]) fs.mkdirSync(env[key]);
  const tests = ["linux-portability", "linux-process-lifecycle", "owned-process", "bounded-process-lock",
    "bounded-worker-termination", "proposer-powershell", "bounded-task", "bounded-campaign", "bounded-reference-evidence",
    "semantic-session-transport", "review-workspace-info", "mcp-integration"].map(name => `tests/${name}.test.ts`);
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=2",
    "--reporter=json", `--outputFile=${path.join(output, "vitest.json")}`, ...tests],
  { cwd: root, env, encoding: "utf8", timeout: 900000, maxBuffer: 8 * 1024 * 1024, shell: false });
  fs.writeFileSync(path.join(output, "stdout.log"), result.stdout ?? "");
  fs.writeFileSync(path.join(output, "stderr.log"), result.stderr ?? "");
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(output, "vitest.json"), "utf8")); } catch { /* incomplete is FAIL */ }
  const pass = !result.error && result.status === 0 && validFixtureReport(report, root, tests);
  const receipt = { phase: "linux-portability-offline-fixture", pass, platform: process.platform, node: process.version,
    tests, source_sha256: Object.fromEntries(["src/config/deployment.ts", "src/mcp/bounded-task.ts", "src/mcp/owned-process.ts",
      "src/mcp/bounded-process-lock.ts", "src/mcp/proposer/opencode-session.ps1", "src/mcp/proposer/bounded-opencode-proposal.ps1"]
      .map(file => [file, createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")])),
    provider_qualification: "NOT_RUN", production_dispatch: "DISABLED", error: result.error?.code ?? null };
  fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ pass, evidence_directory: output, provider_qualification: "NOT_RUN", production_dispatch: "DISABLED" }));
  process.exitCode = pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
