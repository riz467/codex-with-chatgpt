import { spawnSync } from "node:child_process";
import { realpathSync, lstatSync, readdirSync, readFileSync, mkdtempSync, rmSync, openSync, fstatSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { dirname, resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configDefaults } from "vitest/config";
import { selectPolicy, validatePaths, requireTestCoverage } from "./verification-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = resolve(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
export const FULL_SHARD_COUNT = 8;

// Inventory semantics are deliberately pinned to the current reviewed config
// (LF-normalized), including its single tests/**/*.test.ts include. A config or
// Vitest default-exclude change requires reviewing this enumerator, never guessing
// a smaller expected set from the reports we are supposed to verify.
const fullConfigSha256 = "de5eaf9254bb368ddf61b83382eb126bf6ff3b184f5a2b169df57430c20e4dad";
const fullDefaultExcludes = ["**/node_modules/**", "**/dist/**", "**/cypress/**",
  "**/.{idea,git,cache,output,temp}/**",
  "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*"];
const excludedDirectories = new Set(["node_modules", "dist", "cypress", ".idea", ".git", ".cache", ".output", ".temp"]);
const excludedConfigName = /^(karma|rollup|webpack|vite|vitest|jest|ava|babel|nyc|cypress|tsup|build|eslint|prettier)\.config\./;

function plainEntry(full) {
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || realpathSync.native(full).replaceAll("\\", "/") !== full.replaceAll("\\", "/") ||
    !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Unsafe FULL inventory entry: ${full}`);
  return stat;
}

export function assertFullCaseNames(names) {
  const aliases = new Set();
  for (const name of names) {
    if (aliases.has(name.toLowerCase())) throw new Error("FULL inventory case alias");
    aliases.add(name.toLowerCase());
  }
}

function assertFullConfig(base) {
  const names = readdirSync(base);
  assertFullCaseNames(names);
  // Vitest discovers these independently of the root config. A project could
  // retain every filename while filtering assertions, so file union alone is
  // not enough. Do not evaluate any additional workspace/project configuration.
  if (names.some(name => /^vitest\.(workspace|projects)(?:\.|$)/i.test(name)))
    throw new Error("Additional FULL workspace/project configuration rejected");
  const config = join(base, "vitest.config.ts");
  if (!plainEntry(config).isFile() || createHash("sha256").update(readFileSync(config, "utf8").replaceAll("\r\n", "\n"))
    .digest("hex") !== fullConfigSha256 || JSON.stringify(configDefaults.exclude) !== JSON.stringify(fullDefaultExcludes))
    throw new Error("FULL inventory config semantics changed; review required");
}

/** Read-only host helper; CLI callers cannot select this root or the inventory. */
export function enumerateFullTests(repositoryRoot = root) {
  const base = resolve(repositoryRoot);
  for (let current = base; ; current = dirname(current)) {
    if (!plainEntry(current).isDirectory()) throw new Error("Invalid FULL repository root");
    if (dirname(current) === current) break;
  }
  assertFullConfig(base);
  const files = [];
  const walk = (directory) => {
    if (!plainEntry(directory).isDirectory()) throw new Error("Invalid FULL test directory");
    const names = readdirSync(directory).sort();
    assertFullCaseNames(names);
    for (const name of names) {
      const full = join(directory, name), stat = plainEntry(full);
      if (stat.isDirectory()) {
        if (excludedConfigName.test(name)) throw new Error("Unsupported FULL config-named directory");
        if (!excludedDirectories.has(name)) walk(full);
      } else if (name.endsWith(".test.ts") && !excludedConfigName.test(name)) {
        files.push(relative(base, full).replaceAll("\\", "/"));
      }
    }
  };
  walk(join(base, "tests"));
  const checked = validatePaths(files);
  if (!checked.length || checked.length !== files.length) throw new Error("Empty or duplicate FULL inventory");
  return checked;
}

function readShardReport(file) {
  const before = plainEntry(file);
  if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error("Invalid FULL report file");
  const fd = openSync(file, "r");
  try {
    const opened = fstatSync(fd), bytes = readFileSync(fd), after = fstatSync(fd), current = plainEntry(file);
    if (opened.dev !== before.dev || opened.ino !== before.ino || current.dev !== before.dev || current.ino !== before.ino ||
      bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs) throw new Error("FULL report changed during read");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { closeSync(fd); }
}

function validateShardReport(report) {
  const counts = ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"];
  if (!report || report.success !== true || counts.some(key => !Number.isSafeInteger(report[key]) || report[key] < 0) ||
    report.numFailedTests !== 0 || !Array.isArray(report.testResults)) throw new Error("Invalid or failed FULL shard report");
  const observed = { passed: 0, skipped: 0, todo: 0 }, files = [];
  for (const file of report.testResults) {
    if (!file || file.status !== "passed" || typeof file.name !== "string" || !isAbsolute(file.name) ||
      file.name.replaceAll("\\", "/").split("/").some(part => part === "." || part === "..") ||
      !Array.isArray(file.assertionResults)) throw new Error("Invalid FULL file result");
    const name = validatePaths([relative(root, file.name).replaceAll("\\", "/")])[0];
    if (file.name.replaceAll("\\", "/") !== resolve(root, name).replaceAll("\\", "/"))
      throw new Error("FULL report absolute path alias");
    files.push(name);
    for (const assertion of file.assertionResults) {
      if (!assertion || !Object.hasOwn(observed, assertion.status) || !Array.isArray(assertion.failureMessages) ||
        assertion.failureMessages.length) throw new Error("Unfinished or failed FULL assertion");
      observed[assertion.status]++;
    }
  }
  if (observed.passed !== report.numPassedTests || observed.skipped !== report.numPendingTests ||
    observed.todo !== report.numTodoTests || observed.passed + observed.skipped + observed.todo !== report.numTotalTests)
    throw new Error("FULL report count mismatch");
  return { files, tests: report.numTotalTests, ...observed };
}

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
      const expected = enumerateFullTests(), observed = new Set();
      summary.full_coverage = { expected_files: expected, observed_files: [], missing_files: [...expected], extra_files: [], exact: false };
      summary.full_shards = [];
      summary.full_test_counts = { total: 0, passed: 0, skipped: 0, todo: 0 };
      // A host-created report file avoids treating test/subprocess stdout as a
      // JSON report. No filename, shard, worker, timeout or test selector is input.
      const reports = mkdtempSync(join(realpathSync.native(tmpdir()), "rc02-full-reports-"));
      try {
        for (let index = 1; index <= FULL_SHARD_COUNT; index++) {
          const shard = { index, count: FULL_SHARD_COUNT, result: "FAIL", files: [], file_count: null,
            test_count: null, passed: null, skipped: null, todo: null, elapsed_seconds: 0 };
          summary.full_shards.push(shard);
          const started = performance.now(), reportFile = join(reports, `${index}.json`);
          try {
            assertFullConfig(root);
            await run({ executable: process.execPath, argv: [vitest, "run", "--maxWorkers=2",
              `--shard=${index}/${FULL_SHARD_COUNT}`, `--config=${join(root, "vitest.config.ts")}`,
              "--reporter=json", `--outputFile=${reportFile}`] }, true);
            const report = validateShardReport(readShardReport(reportFile));
            Object.assign(shard, { files: report.files, file_count: report.files.length, test_count: report.tests,
              passed: report.passed, skipped: report.skipped, todo: report.todo });
            for (const file of report.files) {
              if (observed.has(file)) throw new Error(`Duplicate FULL test file: ${file}`);
              observed.add(file);
            }
            summary.full_coverage.observed_files = [...observed].sort();
            summary.full_coverage.missing_files = expected.filter(file => !observed.has(file));
            summary.full_coverage.extra_files = [...observed].filter(file => !expected.includes(file)).sort();
            if (summary.full_coverage.extra_files.length) throw new Error("Unexpected FULL test file");
            summary.full_test_counts.total += report.tests;
            for (const key of ["passed", "skipped", "todo"]) summary.full_test_counts[key] += report[key];
            if (!Number.isSafeInteger(summary.full_test_counts.total)) throw new Error("FULL test count overflow");
            shard.result = "PASS";
          } catch (error) {
            shard.error = error.message;
            throw error; // Fixed fail-fast policy; no retry or inferred success.
          } finally {
            shard.elapsed_seconds = (performance.now() - started) / 1000;
            console.log(`FULL shard ${index}/${FULL_SHARD_COUNT}: ${shard.result}, ${shard.file_count} files, ${shard.test_count} tests, ${shard.elapsed_seconds.toFixed(3)}s`);
          }
        }
        if (JSON.stringify(enumerateFullTests()) !== JSON.stringify(expected)) throw new Error("FULL inventory changed during verification");
        if (summary.full_coverage.missing_files.length || summary.full_test_counts.total <= 0)
          throw new Error("FULL coverage mismatch or zero tests");
        summary.full_coverage.exact = true;
      } finally { rmSync(reports, { recursive: true, force: true }); }
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
