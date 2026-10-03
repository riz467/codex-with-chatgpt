import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
// These repository-local JS modules are deliberately outside production src/.
import { selectPolicy, validatePaths, requireTestCoverage } from "../scripts/verification-policy.mjs";
import { parseArguments, parseGitPaths, verify, FULL_SHARD_COUNT, enumerateFullTests, assertFullCaseNames, executeCommand }
  from "../scripts/verify-ai-workspace.mjs";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporary: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawnSync).mockReset();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

const report = (count = 1, names = ["tests/example.test.ts"]) => ({
  status: 0, stderr: "", stdout: JSON.stringify({ success: true, numTotalTests: count,
    testResults: names.map((name) => ({ name })) }),
});
const noContainment = () => {};
// Fake Git observation keeps runner tests independent of the real working tree.
const withGit = (execute: (command: any) => any, observed: string[] = []) => (command: any) =>
  command.executable === "git" && command.argv.includes("-z")
    ? { status: 0, stderr: "", stdout: command.argv.includes("--cached") || command.argv[0] === "ls-files"
      ? "" : observed.map((path) => `${path}\0`).join("") }
    : execute(command);

describe("repository-owned verification policy", () => {
  it("keeps ordinary source changes FAST and docs-only changes lightweight", () => {
    expect(selectPolicy("FAST", ["src/example.ts"]).effective_profile).toBe("FAST");
    const docs = selectPolicy("FAST", ["docs/example.md"]);
    expect(docs.escalation_required).toBe(false);
    expect(() => requireTestCoverage(docs, 0)).not.toThrow();
    expect(selectPolicy("FAST", ["docs/example.js"]).docs_only).toBe(false);
  });

  it.each(["docs/example.md", "docs/nested/example.txt", "docs/example.rst", "README.md", "README.zh-CN.md"])(
    "allows only owned documentation locations: %s", (path) => {
      const policy = selectPolicy("FAST", [path]);
      expect(policy.docs_only).toBe(true);
      expect(() => requireTestCoverage(policy, 0)).not.toThrow();
    });

  it.each(["skill/SKILL.md", "src/runtime-policy.md", "agents/prompt.md", "tests/fixtures/input.txt", "example.rst"])(
    "does not exempt behavioral Markdown/text: %s", (path) => {
      const policy = selectPolicy("FAST", [path]);
      expect(policy.docs_only).toBe(false);
      expect(policy.related_sources).toEqual([path]);
      expect(() => requireTestCoverage(policy, 0)).toThrow("ZERO_TESTS_FOR_CODE");
    });

  it.each([
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
    "vitest.config.ts", "tests/helpers.ts", "tests/support/nested/helper.ts",
    "scripts/copy-runtime.mjs", "scripts/pack-ct702-review.mjs",
    "scripts/verify-ct702-review-package.mjs", "scripts/verification-policy.mjs",
    "scripts/verify-ai-workspace.mjs", "tests/verification-policy.test.ts",
  ])("requires FULL for %s without allowing caller downgrade", (path) => {
    for (const profile of ["FAST", "REVIEW"]) {
      const policy = selectPolicy(profile, [path]);
      expect(policy.effective_profile).toBe("FULL_REQUIRED");
      expect(policy.escalation_reasons).toEqual([{ code: "TEST_OR_PACKAGE_BOUNDARY", path }]);
    }
    expect(selectPolicy("FULL", [path]).effective_profile).toBe("FULL");
  });

  it("owns gateway, approval and task-contract mandatory mappings", () => {
    expect(selectPolicy("FAST", ["src/mcp/local-gateway.ts"]).mandatory_tests)
      .toEqual(["tests/local-gateway.test.ts", "tests/mcp-integration.test.ts"]);
    expect(selectPolicy("FAST", ["src/mcp/autonomous-approval.ts"]).mandatory_tests)
      .toEqual(["tests/autonomous-approval.test.ts", "tests/autonomous-mcp-approval.test.ts"]);
    expect(selectPolicy("FAST", ["src/task-contract/new-module.ts"]).mandatory_tests)
      .toEqual(["tests/rc02-lifecycle.test.ts", "tests/rc02-research-capability.test.ts", "tests/rc02-task-contract.test.ts"]);
  });

  it.each(["../outside.ts", "src/../../outside.ts", "/tmp/source.ts", "C:/source.ts",
    "C:\\source.ts", "\\\\server\\file", "src\\file.ts", "--config", "src/-option.ts",
    "src//file.ts", "./src/file.ts", "src/./file.ts", "file\u0000.ts", ""]) (
    "rejects unsafe explicit path %j", (path) => expect(() => validatePaths([path])).toThrow());

  it("rejects unknown profiles and command/options input", () => {
    expect(() => selectPolicy("QUICK", [])).toThrow();
    expect(() => parseArguments(["FAST", "--command", "echo pass"])).toThrow();
    expect(() => parseArguments(["FAST", "--paths"])).toThrow();
    expect(() => parseArguments(["FAST", "--paths", "../escape"])).toThrow();
  });

  it("fails closed for code with zero tests", () => {
    expect(() => requireTestCoverage(selectPolicy("FAST", ["src/orphan.ts"]), 0)).toThrow("ZERO_TESTS_FOR_CODE");
  });
});

describe("hermetic runner contract", () => {
  it("discovers staged, unstaged and untracked paths using fixed Git argv", async () => {
    const commands: any[] = [];
    const result = await verify(["FAST"], (command: any) => {
      commands.push(command);
      return { status: 0, stderr: "", stdout: command.argv.includes("--cached")
        ? "docs/staged.md\0" : command.argv[0] === "ls-files" ? "docs/new.md\0" : "docs/old.md\0docs/renamed.md\0" };
    }, noContainment);
    expect(result.pass).toBe(true);
    expect(result.changed_paths).toEqual(["docs/new.md", "docs/old.md", "docs/renamed.md", "docs/staged.md"]);
    expect(result.observed_git_paths).toEqual(result.changed_paths);
    expect(result.declared_paths).toBeNull();
    expect(commands).toHaveLength(3);
    expect(commands.slice(0, 2).every((c) => c.argv.includes("--no-renames"))).toBe(true);
    expect(parseGitPaths("docs/space name.md\0")).toEqual(["docs/space name.md"]);
  });

  it.each(["unstaged", "staged", "untracked"])("cannot hide observed package.json (%s) behind explicit source scope", async (origin) => {
    const result = await verify(["FAST", "--paths", "src/example.ts"], (command: any) => {
      if (command.executable !== "git") throw new Error("must not execute Vitest");
      const kind = command.argv[0] === "ls-files" ? "untracked" : command.argv.includes("--cached") ? "staged" : "unstaged";
      return { status: 0, stderr: "", stdout: kind === origin ? "package.json\0" : "" };
    }, noContainment);
    expect(result.pass).toBe(false);
    expect(result.error_code).toBe("EXPLICIT_SCOPE_MISMATCH");
    expect(result.out_of_scope_paths).toEqual(["package.json"]);
    expect(result.declared_paths).toEqual(["src/example.ts"]);
    expect(result.observed_git_paths).toEqual(["package.json"]);
    expect(result.changed_paths).toEqual(["package.json", "src/example.ts"]);
    expect(result.effective_profile).toBe("FULL_REQUIRED");
    expect(result.escalation_required).toBe(true);
    expect(result.commands).toHaveLength(3);
  });

  it("requires FULL when explicit scope includes the observed package boundary", async () => {
    const result = await verify(["FAST", "--paths", "src/example.ts", "package.json"],
      withGit(() => { throw new Error("must not execute tests"); }, ["package.json"]), noContainment);
    expect(result.pass).toBe(false);
    expect(result.effective_profile).toBe("FULL_REQUIRED");
    expect(result.out_of_scope_paths).toEqual([]);
    expect(result.commands).toHaveLength(3);
  });

  it("allows a complete ordinary-source scope, including future unchanged files", async () => {
    const result = await verify(["FAST", "--paths", "src/example.ts", "src/future.ts"],
      withGit(() => report(), ["src/example.ts"]), noContainment);
    expect(result.pass).toBe(true);
    expect(result.effective_profile).toBe("FAST");
    expect(result.changed_paths).toEqual(["src/example.ts", "src/future.ts"]);
    expect(result.observed_git_paths).toEqual(["src/example.ts"]);
    expect(result.commands[3].argv).toContain("src/future.ts");
  });

  it.each(["FAST", "REVIEW", "FULL"])("fails scope mismatch before verification for %s", async (profile) => {
    const result = await verify([profile, "--paths", "docs/example.md"],
      withGit(() => { throw new Error("must not execute verification"); }, ["src/example.ts"]), noContainment);
    expect(result.error_code).toBe("EXPLICIT_SCOPE_MISMATCH");
    expect(result.pass).toBe(false);
    expect(result.commands).toHaveLength(3);
  });

  it.each(["--force-fast", "--ignore-scope-mismatch", "--command", "--argv", "--root", "--git-options"])(
    "does not accept bypass or command input %s", async (option) => {
      for (const args of [["FAST", option], ["FAST", "--paths", "src/example.ts", option]]) {
        const result = await verify(args, () => { throw new Error("must not run"); }, noContainment);
        expect(result.pass).toBe(false);
        expect(result.commands).toEqual([]);
      }
    });

  it("validates observed Git paths even with valid explicit scope", async () => {
    const result = await verify(["FAST", "--paths", "src/example.ts"],
      withGit(() => report(), ["../outside.ts"]), noContainment);
    expect(result.pass).toBe(false);
    expect(result.error).toContain("Invalid repo-relative path");
    expect(result.commands).toHaveLength(1);
  });

  it("uses official related, runs changed tests directly and adds mandatory tests", async () => {
    const commands: any[] = [];
    const result = await verify(["FAST", "--paths", "src/mcp/local-gateway.ts", "tests/example.test.ts"],
      withGit((command: any) => { commands.push(command); return report(); }), noContainment);
    expect(result.pass).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands[0].argv).toContain("related");
    expect(commands[0].argv[2]).toBe("src/mcp/local-gateway.ts");
    expect(commands.every((command) => !command.argv.includes("--"))).toBe(true);
    expect(commands[1].argv).toContain("tests/example.test.ts");
    expect(commands[1].argv).toContain("tests/local-gateway.test.ts");
    expect(commands[1].argv).toContain("tests/mcp-integration.test.ts");
    expect(result.related_tests).toEqual(["tests/example.test.ts"]);
  });

  it("does not pass changed code when related finds zero tests", async () => {
    const result = await verify(["FAST", "--paths", "src/orphan.ts"], withGit(() => report(0, [])), noContainment);
    expect(result.pass).toBe(false);
    expect(result.error).toContain("ZERO_TESTS_FOR_CODE");
  });

  it.each(["skill/SKILL.md", "src/runtime-policy.md"])("fails FAST for behavioral Markdown with zero tests: %s", async (path) => {
    const result = await verify(["FAST", "--paths", path], withGit(() => report(0, []), [path]), noContainment);
    expect(result.docs_only).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.error).toContain("ZERO_TESTS_FOR_CODE");
    expect(result.commands[3].argv).toContain(path);
  });

  it("keeps shell metacharacters in literal path argv, not executable commands", async () => {
    const path = "src/file;echo injected&$(whoami).ts";
    const result = await verify(["FAST", "--paths", path], withGit(() => report()), noContainment);
    expect(result.pass).toBe(true);
    expect(result.commands[3].executable).toBe(process.execPath);
    expect(result.commands[3].argv[2]).toBe(path);
  });

  it("does not execute FULL automatically or accept caller override", async () => {
    const result = await verify(["REVIEW", "--paths", "package.json"], withGit(() => { throw new Error("must not run"); }), noContainment);
    expect(result.effective_profile).toBe("FULL_REQUIRED");
    expect(result.commands).toHaveLength(3);
    expect(result.pass).toBe(false);
    const invalid = await verify(["FAST", "--force-fast"], () => { throw new Error("must not run"); }, noContainment);
    expect(invalid.commands).toEqual([]);
    expect(invalid.pass).toBe(false);
  });

  it("executes only owned commands for REVIEW", async () => {
    const result = await verify(["REVIEW", "--paths", "docs/example.md"],
      () => ({ status: 0, stdout: "", stderr: "" }), noContainment);
    expect(result.pass).toBe(true);
    expect(result.commands).toHaveLength(6);
    expect(JSON.stringify(result.commands)).toContain("typecheck");
    expect(JSON.stringify(result.commands)).toContain("--check");
    expect(JSON.stringify(result.commands)).not.toContain("--maxWorkers=2");
  });

  it("returns a final failure summary on command failure, invalid JSON, containment or timeout", async () => {
    for (const execute of [
      () => ({ status: 1, stdout: "", stderr: "" }),
      () => ({ status: 0, stdout: "not JSON", stderr: "" }),
      () => ({ status: 0, stdout: JSON.stringify({ success: true }), stderr: "" }),
      () => { throw new Error("NOT COMPLETED: timeout"); },
    ]) {
      const result = await verify(["FAST", "--paths", "src/example.ts"], withGit(execute), noContainment);
      expect(result.pass).toBe(false);
      expect(result.commands).toHaveLength(4);
      expect(result.error).toBeTruthy();
    }
    const escaped = await verify(["FAST", "--paths", "src/link.ts"], withGit(() => report()),
      () => { throw new Error("Path escapes repository via symlink"); });
    expect(escaped.pass).toBe(false);
    expect(escaped.commands).toHaveLength(3);
  });
});

const fullReport = (files: string[]) => ({ success: true, numTotalTests: files.length, numPassedTests: files.length,
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: files.map(name => ({
    name: resolve(repositoryRoot, name), status: "passed", assertionResults: [{ status: "passed", failureMessages: [] }],
  })) });
function fullExecutor(change?: (index: number, report: ReturnType<typeof fullReport>, command: any) => unknown) {
  const expected = enumerateFullTests();
  const execute = vi.fn(withGit((command: any) => {
    const selection = command.argv.find((arg: string) => arg.startsWith("--shard="));
    if (selection) {
      const index = Number(selection.match(/^--shard=(\d)\/8$/)?.[1]);
      if (!index) throw new Error("Unexpected shard selector");
      const report = fullReport(expected.filter((_: string, i: number) => i % FULL_SHARD_COUNT === index - 1));
      const replacement = change?.(index, report, command);
      const output = command.argv.find((arg: string) => arg.startsWith("--outputFile="))?.slice("--outputFile=".length);
      writeFileSync(output, typeof replacement === "string" ? replacement : JSON.stringify(replacement ?? report), { flag: "wx" });
      return { status: 0, stdout: "test subprocess output is not the report\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }));
  return { execute, expected };
}

describe("FULL fixed sequential shards and exact coverage proof", () => {
  it("executes exactly 1/8..8/8 then typecheck and both diff checks, even with a declared path", async () => {
    const { execute, expected } = fullExecutor();
    const result = await verify(["FULL", "--paths", "tests/verification-policy.test.ts"], execute, noContainment);
    expect(result.pass).toBe(true); expect(FULL_SHARD_COUNT).toBe(8);
    expect(result.commands).toHaveLength(14);
    const entry = resolve(createRequire(import.meta.url).resolve("vitest/package.json"), "..", "vitest.mjs");
    for (const [offset, command] of result.commands.slice(3, 11).entries()) {
      expect(command.executable).toBe(process.execPath);
      expect(command.argv).toEqual([entry, "run", "--maxWorkers=2", `--shard=${offset + 1}/8`,
        `--config=${resolve(repositoryRoot, "vitest.config.ts")}`, "--reporter=json", expect.stringMatching(/^--outputFile=/)]);
      expect(command.argv).not.toContain("tests/verification-policy.test.ts");
    }
    expect(JSON.stringify(result.commands[11])).toContain("typecheck");
    expect(result.commands.slice(12).map((c: any) => c.argv)).toEqual([["diff", "--check"], ["diff", "--cached", "--check"]]);
    expect(result.full_coverage).toEqual({ expected_files: expected, observed_files: expected, missing_files: [], extra_files: [], exact: true });
    expect(result.full_shards.map((s: any) => s.result)).toEqual(Array(8).fill("PASS"));
    expect(result.full_shards.every((s: any) => Number.isFinite(s.elapsed_seconds) && s.elapsed_seconds >= 0)).toBe(true);
    expect(result.full_test_counts).toEqual({ total: expected.length, passed: expected.length, skipped: 0, todo: 0 });
  });
  it("awaits each shard before admitting the next", async () => {
    const { execute } = fullExecutor(); let active = false;
    const result = await verify(["FULL"], async (command: any) => {
      expect(active).toBe(false); active = true;
      await Promise.resolve(); const value = execute(command); active = false; return value;
    }, noContainment);
    expect(result.pass).toBe(true);
  });
  it.each(["--shard", "--shard=1/8", "--shard-count", "--workers", "--maxWorkers=9", "--timeout", "--testNamePattern", "--test-path"])(
    "rejects caller selector %s before execution", async option => {
      for (const args of [["FULL", option], ["FULL", "--paths", option]]) {
        const execute = vi.fn(); const result = await verify(args, execute, noContainment);
        expect(result.pass).toBe(false); expect(execute).not.toHaveBeenCalled();
      }
    });
  it.each(["nonzero", "timeout", "missing report"])("fails closed and stops on shard 3 %s", async mode => {
    const { execute } = fullExecutor();
    const result = await verify(["FULL"], (command: any) => {
      if (command.argv.includes("--shard=3/8")) {
        if (mode === "timeout") throw new Error("NOT COMPLETED: ETIMEDOUT");
        return { status: mode === "nonzero" ? 1 : 0, stdout: "", stderr: "" };
      }
      return execute(command);
    }, noContainment);
    expect(result.pass).toBe(false); expect(result.full_shards).toHaveLength(3);
    expect(result.full_shards[2].result).toBe("FAIL"); expect(result.full_coverage.exact).toBe(false);
    expect(result.commands).toHaveLength(6); expect(JSON.stringify(result.commands)).not.toContain("typecheck");
    if (mode === "timeout") expect(result.error).toContain("ETIMEDOUT");
  });
  it.each(["JSON", "false success", "missing results", "invalid integer", "negative count", "unsafe integer", "missing count",
    "count mismatch", "failed file", "running assertion", "failed assertion", "relative name", "path escape", "case alias", "root case alias", "drive case alias"])(
    "rejects invalid report: %s", async mode => {
      const { execute } = fullExecutor((index, report) => {
        if (index !== 2) return;
        if (mode === "JSON") return "{not JSON";
        if (mode === "false success") report.success = false;
        if (mode === "missing results") delete (report as any).testResults;
        if (mode === "invalid integer") report.numTotalTests = 1.5;
        if (mode === "negative count") report.numTotalTests = -1;
        if (mode === "unsafe integer") report.numTotalTests = Number.MAX_SAFE_INTEGER + 1;
        if (mode === "missing count") delete (report as any).numTotalTests;
        if (mode === "count mismatch") report.numTotalTests++;
        if (mode === "failed file") report.testResults[0].status = "failed";
        if (mode === "running assertion") report.testResults[0].assertionResults[0].status = "pending";
        if (mode === "failed assertion") report.testResults[0].assertionResults[0].status = "failed";
        if (mode === "relative name") report.testResults[0].name = "tests/verification-policy.test.ts";
        if (mode === "path escape") report.testResults[0].name = resolve(repositoryRoot, "../outside.test.ts");
        if (mode === "case alias") report.testResults[0].name = report.testResults[0].name.replace("tests", "TESTS");
        if (mode === "root case alias") report.testResults[0].name = report.testResults[0].name.replace("codex-with-chatgpt", "CODEX-WITH-CHATGPT");
        if (mode === "drive case alias") report.testResults[0].name = report.testResults[0].name.replace(process.platform === "win32" ? /^[A-Z]/ : /work/, s => s === s.toUpperCase() ? s.toLowerCase() : s.toUpperCase());
        return report;
      });
      const result = await verify(["FULL"], execute, noContainment);
      expect(result.pass).toBe(false); expect(result.full_shards.at(-1).index).toBe(2);
      expect(result.full_coverage.exact).toBe(false);
    });
  it.each(["cross-shard duplicate", "within-shard duplicate", "missing", "extra", "zero"])("rejects %s coverage", async mode => {
    const expected = enumerateFullTests();
    const { execute } = fullExecutor((index, report) => {
      if (mode === "zero") return fullReport([]);
      if (mode === "cross-shard duplicate" && index === 2) return fullReport([expected[0]]);
      if (index !== 1) return;
      const files = report.testResults.map(f => f.name);
      if (mode === "within-shard duplicate") return fullReport([...files, files[0]]);
      if (mode === "missing") return fullReport(files.slice(1));
      if (mode === "extra") return fullReport([...files, "tests/unexpected.test.ts"]);
    });
    const result = await verify(["FULL"], execute, noContainment);
    expect(result.pass).toBe(false); expect(result.full_coverage.exact).toBe(false);
    expect(JSON.stringify(result.commands)).not.toContain("typecheck");
    if (mode === "missing" || mode === "zero") expect(result.full_shards).toHaveLength(8);
  });
  it("retains acknowledged skipped counts without treating pending execution as a skip", async () => {
    const { execute, expected } = fullExecutor((index, report) => {
      if (index !== 1) return;
      report.numPassedTests--; report.numPendingTests++;
      report.testResults[0].assertionResults[0].status = "skipped"; return report;
    });
    const result = await verify(["FULL"], execute, noContainment);
    expect(result.pass).toBe(true); expect(result.full_test_counts).toEqual({ total: expected.length, passed: expected.length - 1, skipped: 1, todo: 0 });
  });
  it("keeps the actual executor at exactly 600000ms, shell=false and bounded output", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "{}", stderr: "", output: [], pid: 1, signal: null });
    const command = { executable: process.execPath, argv: ["fixed-entry"] };
    expect(executeCommand(command).status).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(command.executable, command.argv,
      expect.objectContaining({ timeout: 600000, shell: false, maxBuffer: 64 * 1024 * 1024 }));
    vi.mocked(spawnSync).mockReturnValue({ status: null, stdout: "", stderr: "", output: [], pid: 1, signal: "SIGTERM",
      error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) });
    expect(() => executeCommand(command)).toThrow("NOT COMPLETED");
  });
});

function inventoryFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "full-inventory-"))); temporary.push(root);
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "vitest.config.ts"), readFileSync(join(repositoryRoot, "vitest.config.ts")));
  return root;
}
describe("FULL independently enumerated include semantics", () => {
  it.each(["vitest.workspace.ts", "vitest.workspace.json", "vitest.projects.js", "VITEST.WORKSPACE.MTS"])(
    "rejects discovered assertion-filtering workspace %s even with the same file include", name => {
      const root = inventoryFixture(); writeFileSync(join(root, "tests", "one.test.ts"), "");
      writeFileSync(join(root, name), 'export default [{ test: { include: ["tests/**/*.test.ts"], testNamePattern: "NEVER_MATCH" } }];');
      expect(() => enumerateFullTests(root)).toThrow("workspace/project");
    });
  it("enumerates nested and hidden test files with exactly the current default exclusions", () => {
    const root = inventoryFixture();
    for (const name of ["one.test.ts", "nested/two.test.ts", ".hidden/three.test.ts", "not.test.tsx", "helper.ts",
      "dist/excluded.test.ts", "node_modules/excluded.test.ts", ".git/excluded.test.ts", "cypress/excluded.test.ts", "vitest.config.test.ts"]) {
      const full = join(root, "tests", name); mkdirSync(resolve(full, ".."), { recursive: true }); writeFileSync(full, "");
    }
    expect(enumerateFullTests(root)).toEqual(["tests/.hidden/three.test.ts", "tests/nested/two.test.ts", "tests/one.test.ts"]);
  });
  it("fails closed on config/include drift and empty inventories", () => {
    const root = inventoryFixture(); expect(() => enumerateFullTests(root)).toThrow("Empty");
    writeFileSync(join(root, "tests", "one.test.ts"), "");
    writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: ["tests/one.test.ts"] } };');
    expect(() => enumerateFullTests(root)).toThrow("semantics changed");
  });
  it.each(["link", "dangling link", "root alias", "hardlink"])("rejects %s without following an escape", mode => {
    const root = inventoryFixture(), outside = inventoryFixture();
    writeFileSync(join(outside, "tests", "one.test.ts"), "");
    if (mode === "hardlink") {
      linkSync(join(outside, "tests", "one.test.ts"), join(root, "tests", "one.test.ts"));
      expect(() => enumerateFullTests(root)).toThrow("Unsafe");
    } else {
      const link = join(root, mode === "root alias" ? "alias" : "tests/alias");
      symlinkSync(mode === "dangling link" ? join(outside, "missing") : outside, link, process.platform === "win32" ? "junction" : "dir");
      expect(() => enumerateFullTests(mode === "root alias" ? link : root)).toThrow("Unsafe");
    }
  });
  it("rejects Windows case aliases independently of the host filesystem case mode", () => {
    expect(() => assertFullCaseNames(["one.test.ts", "ONE.test.ts"])).toThrow("case alias");
    expect(() => assertFullCaseNames(["nested", "NESTED"])).toThrow("case alias");
    const root = inventoryFixture(); writeFileSync(join(root, "tests", "one.test.ts"), "");
    expect(() => enumerateFullTests(root.replace("full-inventory", "FULL-INVENTORY"))).toThrow();
  });
});
