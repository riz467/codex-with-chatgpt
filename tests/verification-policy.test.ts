import { describe, expect, it } from "vitest";
// These repository-local JS modules are deliberately outside production src/.
import { selectPolicy, validatePaths, requireTestCoverage } from "../scripts/verification-policy.mjs";
import { parseArguments, parseGitPaths, verify } from "../scripts/verify-ai-workspace.mjs";

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

  it.each(["REVIEW", "FULL"])("executes only owned commands for %s", async (profile) => {
    const result = await verify([profile, "--paths", "docs/example.md"],
      () => ({ status: 0, stdout: "", stderr: "" }), noContainment);
    expect(result.pass).toBe(true);
    expect(result.commands).toHaveLength(profile === "FULL" ? 7 : 6);
    expect(JSON.stringify(result.commands)).toContain("typecheck");
    expect(JSON.stringify(result.commands)).toContain("--check");
    expect(JSON.stringify(result.commands).includes("--maxWorkers=2")).toBe(profile === "FULL");
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
