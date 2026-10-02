import { spawnSync } from "node:child_process";
import { realpathSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectPolicy, validatePaths, requireTestCoverage } from "./verification-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = resolve(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

export function parseArguments(args) {
  const [profile, ...rest] = args;
  if (rest.length && rest[0] !== "--paths") throw new Error("Usage: PROFILE [--paths file ...]");
  if (rest.length === 1) throw new Error("--paths requires at least one file");
  // Validate before any command can execute.
  selectPolicy(profile, rest.length ? rest.slice(1) : []);
  return { profile, paths: rest.length ? rest.slice(1) : undefined };
}

export function parseGitPaths(output) {
  return validatePaths(output.split("\0").filter(Boolean));
}

function assertContained(paths) {
  const realRoot = realpathSync(root);
  for (const path of paths) {
    let ancestor = resolve(root, path);
    while (true) {
      try {
        // lstat also sees dangling symlinks: realpath below then fails closed.
        lstatSync(ancestor);
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || ancestor === dirname(ancestor)) throw error;
        ancestor = dirname(ancestor);
      }
    }
    const rel = relative(realRoot, realpathSync(ancestor));
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error(`Path escapes repository via symlink: ${path}`);
    }
  }
}

export function executeCommand(command) {
  const result = spawnSync(command.executable, command.argv, {
    cwd: root, encoding: "utf8", shell: false, timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`NOT COMPLETED: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function pnpmCommand(argv) {
  // Only repository-owned constant argv reaches the Windows command interpreter.
  return process.platform === "win32"
    ? { executable: process.env.ComSpec || "cmd.exe", argv: ["/d", "/s", "/c", `pnpm ${argv.join(" ")}`] }
    : { executable: "pnpm", argv };
}

export async function verify(args, execute = executeCommand, contain = assertContained) {
  const summary = {
    requested_profile: args[0] ?? null, effective_profile: null,
    escalation_required: false, escalation_reasons: [], changed_paths: [],
    declared_paths: null, observed_git_paths: [], out_of_scope_paths: [],
    related_tests: [], mandatory_tests: [], direct_tests: [], commands: [],
    result: "FAIL", pass: false,
  };
  const run = async (command, allowEmpty = false) => {
    const record = { ...command, status: null };
    summary.commands.push(record);
    const result = await execute(command);
    record.status = result.status;
    if (!allowEmpty && result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${command.executable}`);
    return result.stdout;
  };
  try {
    const { profile, paths } = parseArguments(args);
    summary.declared_paths = paths === undefined ? null : validatePaths(paths);
    // Explicit paths declare scope; they never replace observation of dirty paths.
    // --no-renames includes both rename endpoints. NUL preserves spaces/newlines safely.
    for (const argv of [
      ["diff", "--name-only", "-z", "--no-renames", "--"],
      ["diff", "--cached", "--name-only", "-z", "--no-renames", "--"],
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    ]) {
      summary.observed_git_paths = validatePaths([...summary.observed_git_paths,
        ...parseGitPaths(await run({ executable: "git", argv }, true))]);
    }
    const policy = selectPolicy(profile, [...(summary.declared_paths ?? []), ...summary.observed_git_paths]);
    Object.assign(summary, policy);
    contain(policy.changed_paths);
    if (summary.declared_paths !== null) {
      summary.out_of_scope_paths = summary.observed_git_paths.filter((path) => !summary.declared_paths.includes(path));
      if (summary.out_of_scope_paths.length) {
        summary.error_code = "EXPLICIT_SCOPE_MISMATCH";
        throw new Error("EXPLICIT_SCOPE_MISMATCH: observed Git changes are outside declared --paths scope");
      }
    }
    if (policy.escalation_required) throw new Error("FULL_REQUIRED: explicit human-approved FULL checkpoint required");
    if (profile === "FULL") {
      await run(pnpmCommand(["test", "--maxWorkers=2"]));
    } else {
      let testCount = 0;
      const focused = [...new Set([...policy.direct_tests, ...policy.mandatory_tests])];
      for (const [mode, files] of [["related", policy.related_sources], ["run", focused]]) {
        if (!files.length) continue;
        // Vitest 3's CLI does not forward positional files after `--`.
        // Validation rejects option-like components; literal paths use direct argv.
        const output = await run({ executable: process.execPath, argv: [vitest, mode, ...files,
          "--run", "--maxWorkers=2", "--reporter=json", ...(mode === "related" ? ["--passWithNoTests"] : [])] }, true);
        const report = JSON.parse(output);
        if (report.success !== true || !Number.isInteger(report.numTotalTests) || report.numTotalTests < 0) {
          throw new Error("Invalid or failed Vitest report");
        }
        testCount += report.numTotalTests;
        const tests = (report.testResults ?? []).map((test) => relative(root, test.name).replaceAll("\\", "/"));
        if (mode === "related") summary.related_tests = validatePaths(tests);
        console.log(`Focused ${mode}: ${report.numTotalTests} tests`);
      }
      requireTestCoverage(policy, testCount);
    }
    if (profile !== "FAST") {
      await run(pnpmCommand(["typecheck"]));
      await run({ executable: "git", argv: ["diff", "--check"] });
      await run({ executable: "git", argv: ["diff", "--cached", "--check"] });
    }
    summary.result = "PASS";
    summary.pass = true;
  } catch (error) {
    summary.error = error.message;
  }
  return summary;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const summary = await verify(process.argv.slice(2));
  console.log(JSON.stringify(summary));
  process.exitCode = summary.pass ? 0 : summary.escalation_required ? 2 : 1;
}
