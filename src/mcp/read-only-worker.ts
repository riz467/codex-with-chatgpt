/** Fixed, non-agent inspection worker. No caller-supplied commands or paths. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPOS, REVIEW_ROOT } from "./local-gateway.js";

const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

function inspect(repo: string, args: string[]): string {
  const result = spawnSync(GIT, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", repo, ...args], {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
  });
  if (result.status !== 0 || result.error) throw new Error("Git read-only inspection failed");
  return result.stdout;
}

export function runReadOnlyJob(repoKey: keyof typeof REPOS, jobId: string, taskId: string, root = REVIEW_ROOT): void {
  if (!Object.hasOwn(REPOS, repoKey) || !idPattern.test(jobId) || !idPattern.test(taskId)) throw new Error("Invalid read-only job identity");
  const repo = REPOS[repoKey];
  const directory = path.join(root, "rpc-jobs", jobId);
  if (!fs.existsSync(directory) || fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(directory).isSymbolicLink() ||
    !fs.realpathSync.native(directory).toLowerCase().startsWith(fs.realpathSync.native(root).toLowerCase() + path.sep)) {
    throw new Error("Unsafe job directory");
  }
  if (fs.realpathSync.native(repo).toLowerCase() !== path.resolve(repo).toLowerCase()) throw new Error("Unsafe repo root");
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  const head = inspect(repo, ["rev-parse", "HEAD"]).trim();
  const branch = inspect(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const before = inspect(repo, statusArgs);
  // A small, fixed inventory; never return file bodies, secrets or unbounded logs.
  const entries = fs.readdirSync(repo, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".") && entry.isDirectory()).length;
  const after = inspect(repo, statusArgs);
  if (before !== after || head !== inspect(repo, ["rev-parse", "HEAD"]).trim()) throw new Error("Repository state changed during inspection");
  const changedCount = before.split("\0").filter(Boolean).length;
  const summary = `Git branch ${branch.slice(0, 100)}, HEAD ${head.slice(0, 40)}; working tree ${changedCount === 0 ? "clean" : `${changedCount} existing status entries`}; ${entries} root directories inspected. No edits attempted.`;
  const record = { version: 1, mode: "read_only", task_id: taskId, state: "DONE", summary,
    changed_paths: [], verification: { completed: true, exit_code: 0 }, updated_at: new Date().toISOString(), published: false };
  fs.writeFileSync(path.join(directory, "read-only-result.json"), JSON.stringify(record), { flag: "wx" });
  process.stdout.write("RESULT: READ_ONLY_COMPLETE\n");
}

// Invoked only by the fixed Node executable and fixed script path in local-gateway.ts.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error("Invalid worker arguments");
    runReadOnlyJob(process.argv[2] as keyof typeof REPOS, process.argv[3], process.argv[4]);
  } catch (error) {
    process.stderr.write(`Read-only inspection failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    process.exitCode = 1;
  }
}
