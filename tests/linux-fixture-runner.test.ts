import { expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validFixtureReport } from "../scripts/verify-linux-portability-fixture.mjs";

it("rejects incomplete, skipped, duplicate and contradictory Linux evidence", () => {
  const root = path.resolve("."), tests = ["tests/linux-process-lifecycle.test.ts"];
  const report = () => ({ success: true, numTotalTests: 1, numPassedTests: 1,
    testResults: [{ name: path.join(root, tests[0]), status: "passed", assertionResults: [{ status: "passed" }] }] });
  expect(validFixtureReport(report(), root, tests)).toBe(true);
  expect(validFixtureReport(undefined, root, tests)).toBe(false);
  for (const status of ["pending", "skipped", "todo", "failed"]) {
    const value = report(); value.testResults[0].assertionResults[0].status = status;
    expect(validFixtureReport(value, root, tests)).toBe(false);
  }
  const duplicate = report(); duplicate.testResults.push(duplicate.testResults[0]);
  expect(validFixtureReport(duplicate, root, tests)).toBe(false);
  const missing = report(); missing.testResults = [];
  expect(validFixtureReport(missing, root, tests)).toBe(false);
  const wrong = report(); wrong.testResults[0].name = path.join(root, "other.test.ts");
  expect(validFixtureReport(wrong, root, tests)).toBe(false);
  const relative = report(); relative.testResults[0].name = tests[0];
  expect(validFixtureReport(relative, root, tests)).toBe(false);
  expect(validFixtureReport({ ...report(), testResults: [null] }, root, tests)).toBe(false);
  const counts = report(); counts.numTotalTests = counts.numPassedTests = 2;
  expect(validFixtureReport(counts, root, tests)).toBe(false);
});
it.skipIf(process.platform === "linux")("cannot turn a Windows fixture run into Linux PASS", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-linux-portability-fixture.mjs"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("NON_ROOT_LINUX_FIXTURE_REQUIRED");
});
