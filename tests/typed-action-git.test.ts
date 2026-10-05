import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, lstat, realpath, rm, symlink } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindActionAttempt, hashActionRequest } from "../src/mcp/typed-actions.js";
import { createGitIntegrateMainFixtureAdapter, gitIntegrateMainFixturePolicy,
  type TrustedFixtureRepository, type GitAdapterOutcome } from "../src/mcp/typed-action-git.js";

// Faults sit at the OS process boundary, never in the adapter's public API.
// Every unaffected invocation uses real Git against disposable repositories.
const interception = vi.hoisted(() => ({
  before: undefined as undefined | ((operation: string, cwd: string) => void),
  after: undefined as undefined | ((operation: string, cwd: string) => void),
  calls: [] as { executable: string; argv: string[]; options: any }[],
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: (executable: string, argv: string[], options: any, callback: any) => {
    const verbs = ["config", "rev-parse", "for-each-ref", "symbolic-ref", "ls-tree", "ls-files", "fetch", "rev-list", "diff", "merge", "push"];
    const offset = argv.findIndex((arg) => verbs.includes(arg));
    const operation = argv.slice(offset).join(" ");
    interception.calls.push({ executable, argv: [...argv], options });
    try { interception.before?.(operation, options.cwd); }
    catch (error) { callback(error, Buffer.alloc(0)); return; }
    return actual.execFile(executable, argv, options, (error: any, stdout: any, stderr: any) => {
      try { interception.after?.(operation, options.cwd); }
      catch (fault) { callback(fault, stdout, stderr); return; }
      callback(error, stdout, stderr);
    });
  } };
});

const gitExe = process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const nullFile = "/dev/null";
let isolationDirectory: string | undefined;
let configFile = nullFile, hooksDirectory = nullFile;
const dirs: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitExe, ["-c", `core.hooksPath=${hooksDirectory.replaceAll("\\", "/")}`, ...args], {
    cwd, shell: false, timeout: 30_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_SYSTEM: configFile, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function configure(root: string) {
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.filemode", "false");
}
async function fileIdentity(root: string) {
  const stat = await lstat(root); return { device: stat.dev, inode: stat.ino };
}
function put(root: string, name: string, content: string) { writeFileSync(path.join(root, name), content); }
function commit(root: string, name: string, content: string) {
  put(root, name, content); git(root, "add", "--", name); git(root, "commit", "-m", "fixture change");
}
let template: string;
beforeAll(async () => {
  const base = path.join(await realpath(tmpdir()), "opencode"); await mkdir(base, { recursive: true });
  template = await mkdtemp(path.join(base, "typed-git-template-"));
  if (process.platform === "win32") {
    isolationDirectory = await mkdtemp(path.join(base, "typed-git-test-isolation-"));
    configFile = path.join(isolationDirectory, "empty"); hooksDirectory = path.join(isolationDirectory, "hooks");
    writeFileSync(configFile, "", { flag: "wx" }); await mkdir(hooksDirectory);
  }
  const directory = template;
  const origin = path.join(directory, "origin.git"), seed = path.join(directory, "seed"), root = path.join(directory, "local");
  await mkdir(origin); await mkdir(seed);
  git(origin, "init", "--bare", "--initial-branch=main");
  git(seed, "init", "--initial-branch=main"); configure(seed);
  for (const file of ["A", "B", "C"]) put(seed, file, `${file}1\n`);
  git(seed, "add", "."); git(seed, "commit", "-m", "fixture base");
  git(seed, "remote", "add", "origin", origin); git(seed, "push", "-u", "origin", "main");
  git(directory, "clone", "--single-branch", "--branch", "main", origin, root); configure(root);
});
afterAll(async () => { if (isolationDirectory) await rm(isolationDirectory, { recursive: true, force: true }); if (template) await rm(template, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function fixture() {
  const directory = await mkdtemp(path.join(path.dirname(template), "typed-git-")); dirs.push(directory);
  // Only immutable baseline bytes are reused. Each case gets independent copies
  // of all three repositories (no hardlinks), fresh identities and a fresh adapter.
  for (const name of ["origin.git", "seed", "local"])
    await cp(path.join(template, name), path.join(directory, name), { recursive: true, force: false, errorOnExist: true });
  const origin = path.join(directory, "origin.git"), seed = path.join(directory, "seed"), root = path.join(directory, "local");
  git(seed, "config", "remote.origin.url", origin); git(root, "config", "remote.origin.url", origin);
  const record: TrustedFixtureRepository = {
    id: randomUUID(), root, rootIdentity: await fileIdentity(root), gitIdentity: await fileIdentity(path.join(root, ".git")),
    origin, originIdentity: await fileIdentity(origin), generation: 7,
    policyIdentity: gitIntegrateMainFixturePolicy.identity, policySha256: gitIntegrateMainFixturePolicy.sha256,
  };
  const adapter = createGitIntegrateMainFixtureAdapter([record]);
  return { directory, origin, seed, root, record, adapter };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function publish(f: Fixture, file = "A", content = "A2\n") {
  commit(f.seed, file, content); git(f.seed, "push", "origin", "main"); git(f.root, "fetch", "--no-tags", "origin");
}
async function request(f: Fixture): Promise<any> {
  return {
    schemaVersion: 1, kind: "GitIntegrateMain", actionId: randomUUID(), target: { kind: "repository", id: f.record.id },
    preconditions: { targetGeneration: 7, policySha256: gitIntegrateMainFixturePolicy.sha256,
      maintenanceWindowId: randomUUID(), recheck: "immediately-before-mutation-under-exclusive-fence" },
    timeout: { preflightMs: 60_000, executionMs: 120_000, verificationMs: 60_000, onExpiry: "stop-and-reconcile" },
    rollback: { mode: "none", onFailure: "block-and-reconcile" },
    retry: { automaticMutationRetries: 0, recovery: "new-request-fresh-preflight-and-new-approval" }, retryOf: null,
    risk: "elevated", approval: { human: "required", independentReview: "required", binding: "request-hash-and-attempt",
      destructive: "not-applicable", reboot: "not-applicable" }, reboot: "forbidden",
    expected: await f.adapter.observe(f.record.id),
    desired: { branch: "main", remote: "origin", operation: "merge-origin-main-no-edit-and-push", fetch: "no-tags",
      remoteHeadCheck: "match-expected-after-fetch", divergenceCheck: "recheck-before-merge",
      overlapCheck: "remote-only-paths-disjoint-from-local-change-paths", onConflict: "merge-abort-and-block",
      parentCheck: "verify-against-premerge-heads", localState: "preserve-staged-unstaged-and-untracked-deltas",
      finalRelation: "origin-main-equals-head", finalVerification: "fetch-and-check-zero-ahead-zero-behind-and-local-state" },
  };
}
function attempt(r: any) {
  return bindActionAttempt({ schemaVersion: 1, attemptId: randomUUID(), actionId: r.actionId,
    requestHash: hashActionRequest(r), sequence: 1, createdAt: new Date().toISOString(),
    approvalIdentity: "typed-action-attempt-sha256-v1" }, r);
}
const mutations = (result: GitAdapterOutcome) => result.invocations.map((i) => i.operation)
  .filter((op) => ["fetch", "merge", "abort", "push"].includes(op));
const localKeys = ["stagedDeltaSha256", "unstagedDeltaSha256", "untrackedStateSha256", "localChangePathsSha256"] as const;
function verified(result: GitAdapterOutcome, r: any, integration: string) {
  expect(result.status, result.status === "BLOCKED" ? result.reason : "").toBe("VERIFIED");
  if (result.status !== "VERIFIED") throw new Error(result.reason);
  expect(result.gitResult.integration).toBe(integration);
  expect(result.gitResult.finalHead).toEqual(result.gitResult.originMainHead);
  expect([result.gitResult.ahead, result.gitResult.behind]).toEqual([0, 0]);
  for (const key of localKeys) expect(result.gitResult[key]).toBe(r.expected[key]);
  expect(result).not.toHaveProperty("authorization");
  expect(mutations(result)).toEqual(["fetch", "merge", "push", "fetch"]);
  return result.gitResult;
}
function blocked(result: GitAdapterOutcome, reason?: RegExp) {
  expect(result.status).toBe("BLOCKED");
  if (result.status !== "BLOCKED") throw new Error("Unexpected verified result");
  if (reason) expect(result.reason).toMatch(reason);
  expect(result).not.toHaveProperty("gitResult");
  return result;
}
beforeEach(() => { interception.calls = []; interception.before = undefined; interception.after = undefined; });
afterEach(async () => {
  interception.before = undefined; interception.after = undefined;
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("GitIntegrateMain real Git fixture", () => {
  it("unchanged, fixed allowlist, final 0/0 and no approval issuance", async () => {
    const f = await fixture(), r = await request(f);
    const result = await f.adapter.execute(r, attempt(r));
    const receipt = verified(result, r, "unchanged");
    expect(receipt.mergeCommit).toBeNull(); expect(receipt.mergeParents).toEqual([]);
    expect(git(f.root, "rev-list", "--left-right", "--count", "HEAD...origin/main")).toBe("0\t0");
    const allowed = new Set([
      "config --local --null --list", "rev-parse --show-toplevel", "symbolic-ref --quiet HEAD",
      "rev-parse --verify HEAD^{commit}", "rev-parse --verify refs/remotes/origin/main^{commit}", "rev-parse --show-object-format",
      "for-each-ref --format=%(refname) %(objectname) %(symref)",
      "ls-tree -r -z --full-tree HEAD", "ls-files --stage -z", "ls-files -v -z", "ls-files --others -z",
      "fetch --no-tags origin", "rev-list --left-right --count HEAD...refs/remotes/origin/main",
      "diff --no-ext-diff --no-textconv --no-renames --name-only -z HEAD...refs/remotes/origin/main --",
      "merge --no-edit origin/main", "merge --abort", "rev-list --parents -n 1 HEAD", "push origin main",
    ]);
    for (const call of interception.calls) {
      expect(call.executable).toBe(gitExe); expect(call.options.shell).toBe(false);
      expect(call.options.timeout).toBeGreaterThan(0); expect(call.options.timeout).toBeLessThanOrEqual(30_000);
      expect(call.options.maxBuffer).toBe(8 * 1024 * 1024);
      expect(call.options.env.GIT_TERMINAL_PROMPT).toBe("0");
      if (process.platform === "win32") {
        expect(path.isAbsolute(call.options.env.GIT_CONFIG_GLOBAL)).toBe(true);
        expect(call.options.env.GIT_CONFIG_GLOBAL).not.toBe("NUL");
        expect(call.options.env.GIT_CONFIG_SYSTEM).toBe(call.options.env.GIT_CONFIG_GLOBAL);
        expect(call.argv).toContain(`core.attributesFile=${call.options.env.GIT_CONFIG_GLOBAL.replaceAll("\\", "/")}`);
      } else expect(call.options.env.GIT_CONFIG_GLOBAL).toBe(nullFile);
      expect(call.options.env).not.toHaveProperty("GIT_CONFIG_COUNT");
      const index = call.argv.findIndex((arg) => ["config", "rev-parse", "for-each-ref", "symbolic-ref", "ls-tree", "ls-files", "fetch", "rev-list", "diff", "merge", "push"].includes(arg));
      expect(allowed.has(call.argv.slice(index).join(" "))).toBe(true);
      for (const forbidden of ["--force", "--force-with-lease", "pull", "rebase", "stash", "--autostash", "reset", "checkout", "switch", "clean", "--amend", "cherry-pick"]) {
        expect(call.argv).not.toContain(forbidden);
      }
    }
  }, 120_000);

  it.skipIf(process.platform !== "win32").each(["config", "hooks"])("rejects changed Windows Git isolation %s before another invocation", async (target) => {
    const f = await fixture(), r = await request(f);
    interception.calls = [];
    let changed = false;
    interception.after = () => {
      if (changed) return;
      changed = true;
      const call = interception.calls.at(-1)!;
      const config = call.options.env.GIT_CONFIG_GLOBAL;
      expect(readFileSync(config, "utf8")).toBe("");
      if (target === "config") writeFileSync(config, "[alias]\nunsafe = !whoami\n");
      else {
        const option = call.argv.find((arg) => arg.startsWith("core.hooksPath="))!;
        writeFileSync(path.join(option.slice("core.hooksPath=".length), "pre-merge-commit"), "exit 1\n");
      }
    };
    const result = blocked(await f.adapter.execute(r, attempt(r)), /Git isolation/);
    expect(changed).toBe(true);
    expect(interception.calls).toHaveLength(1);
    expect(mutations(result)).toEqual([]);
  });

  it("clean fast-forward", async () => {
    const f = await fixture(); publish(f); const r = await request(f);
    const result = verified(await f.adapter.execute(r, attempt(r)), r, "fast-forward");
    expect(result.finalHead).toEqual(r.expected.remoteHead); expect(result.mergeParents).toEqual([]);
    expect(readFileSync(path.join(f.root, "A"), "utf8")).toBe("A2\n");
  }, 120_000);

  it("diverged normal merge verifies generated parents and pushes to final 0/0", async () => {
    const f = await fixture(); commit(f.root, "C", "C2\n"); publish(f); const r = await request(f);
    const result = verified(await f.adapter.execute(r, attempt(r)), r, "merge");
    expect(result.mergeParents).toEqual([r.expected.head, r.expected.remoteHead]);
    expect(result.mergeCommit).toEqual(result.finalHead);
    expect(git(f.root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toEqual([
      result.finalHead.digest, r.expected.head.digest, r.expected.remoteHead.digest,
    ]);
    expect(git(f.origin, "rev-parse", "main")).toBe(result.finalHead.digest);
  }, 120_000);

  it.each(["staged", "unstaged", "untracked", "combined"])("preserves unrelated %s state through real fast-forward", async (kind) => {
    const f = await fixture();
    if (kind === "staged" || kind === "combined") { put(f.root, "B", "B2\n"); git(f.root, "add", "B"); }
    if (kind === "unstaged" || kind === "combined") put(f.root, kind === "combined" ? "C" : "B", "local working content\n");
    if (kind === "untracked" || kind === "combined") put(f.root, "new local file", "untracked content\n");
    publish(f); const r = await request(f), indexBefore = git(f.root, "write-tree");
    verified(await f.adapter.execute(r, attempt(r)), r, "fast-forward");
    expect(git(f.root, "show", "HEAD:A")).toBe("A2");
    expect(git(f.root, "show", ":A")).toBe("A2");
    expect(git(f.root, "write-tree")).not.toBe(indexBefore);
    if (kind === "staged" || kind === "combined") {
      expect(git(f.root, "show", "HEAD:B")).toBe("B1"); expect(git(f.root, "show", ":B")).toBe("B2");
      expect(git(f.root, "diff", "--cached", "--name-only")).toBe("B");
    }
  }, 120_000);

  it.each(["staged", "unstaged", "untracked"])("%s overlap blocks before merge, preserves index/worktree, never pushes", async (kind) => {
    const f = await fixture(); const file = kind === "untracked" ? "new" : "A";
    put(f.root, file, "local\n"); if (kind === "staged") git(f.root, "add", "A");
    publish(f, file, "remote\n"); const r = await request(f), index = readFileSync(path.join(f.root, ".git/index"));
    const result = blocked(await f.adapter.execute(r, attempt(r)), /overlap/);
    expect(mutations(result)).toEqual(["fetch"]);
    expect(git(f.root, "rev-parse", "HEAD")).toBe(r.expected.head.digest);
    expect(readFileSync(path.join(f.root, ".git/index"))).toEqual(index);
    expect(readFileSync(path.join(f.root, file), "utf8")).toBe("local\n");
  }, 120_000);

  it("remote advances after proposal: fetched remote HEAD mismatch blocks", async () => {
    const f = await fixture(), r = await request(f);
    commit(f.seed, "A", "new remote\n"); git(f.seed, "push", "origin", "main");
    const result = blocked(await f.adapter.execute(r, attempt(r)), /Fetched remote HEAD mismatch/);
    expect(mutations(result)).toEqual(["fetch"]);
  }, 120_000);

  it.each(["head", "remoteHead", ...localKeys])("%s mismatch blocks without any Git mutation", async (key) => {
    const f = await fixture(), r = await request(f);
    if (key === "head" || key === "remoteHead") r.expected[key].digest = "0".repeat(40);
    else r.expected[key] = "0".repeat(64);
    const result = blocked(await f.adapter.execute(r, attempt(r)), /mismatch/i);
    expect(mutations(result)).toEqual([]);
  }, 120_000);

  it("unmerged index stages block without fetch", async () => {
    const f = await fixture(); commit(f.root, "A", "local\n"); publish(f, "A", "remote\n"); const r = await request(f);
    expect(() => git(f.root, "merge", "--no-edit", "origin/main")).toThrow();
    // Retain unmerged stages but remove the operation marker to exercise index detection itself.
    unlinkSync(path.join(f.root, ".git/MERGE_HEAD"));
    const result = blocked(await f.adapter.execute(r, attempt(r)), /Unmerged/);
    expect(mutations(result)).toEqual([]);
  }, 120_000);

  it("real merge conflict aborts, verifies restoration and never pushes", async () => {
    const f = await fixture(); commit(f.root, "A", "local\n"); publish(f, "A", "remote\n");
    put(f.root, "B", "unrelated working\n"); put(f.root, "new", "untracked\n");
    const r = await request(f), before = await f.adapter.observe(f.record.id);
    const result = blocked(await f.adapter.execute(r, attempt(r)), /state restored/);
    expect(result.restoration).toBe("verified"); expect(mutations(result)).toEqual(["fetch", "merge", "abort"]);
    expect(await f.adapter.observe(f.record.id)).toEqual(before);
    expect(git(f.origin, "rev-parse", "main")).toBe(r.expected.remoteHead.digest);
    expect(existsSync(path.join(f.root, ".git/MERGE_HEAD"))).toBe(false);
  }, 120_000);

  it.each(["abort-failure", "restoration-failure"])("%s blocks with unverified restoration and no push", async (fault) => {
    const f = await fixture(); commit(f.root, "A", "local\n"); publish(f, "A", "remote\n"); const r = await request(f);
    interception.before = (op) => { if (op === "merge --abort" && fault === "abort-failure") put(f.root, ".git/index.lock", "fixture contention"); };
    interception.after = (op) => { if (op === "merge --abort" && fault === "restoration-failure") put(f.root, "B", "not restored\n"); };
    const result = blocked(await f.adapter.execute(r, attempt(r)));
    expect(result.restoration).toBe("unverified"); expect(mutations(result)).not.toContain("push");
  }, 120_000);

  it("wrong branch blocks before Git mutation", async () => {
    const f = await fixture(), r = await request(f);
    git(f.root, "branch", "-m", "other");
    const result = blocked(await f.adapter.execute(r, attempt(r)));
    expect(mutations(result)).toEqual([]);
  }, 120_000);

  it.each(["rootIdentity", "gitIdentity", "originIdentity"])("wrong %s blocks", async (key) => {
    const f = await fixture(), r = await request(f);
    const adapter = createGitIntegrateMainFixtureAdapter([{ ...f.record, [key]: { device: -1, inode: -1 } }]);
    const result = blocked(await adapter.execute(r, attempt(r)), /identity mismatch/);
    expect(mutations(result)).toEqual([]);
  }, 120_000);

  it("symlink/reparse root blocks before Git invocation", async () => {
    const f = await fixture(), r = await request(f), alias = path.join(f.directory, "alias");
    await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    const adapter = createGitIntegrateMainFixtureAdapter([{ ...f.record, root: alias }]);
    const result = blocked(await adapter.execute(r, attempt(r)), /Symlink|reparse/);
    expect(result.invocations).toEqual([]);
  }, 120_000);

  it("push failure returns no success result", async () => {
    const f = await fixture(); commit(f.root, "B", "local commit\n"); const r = await request(f);
    let remoteHead = "";
    interception.before = (op) => {
      if (op === "push origin main") {
        commit(f.seed, "A", "concurrent remote commit\n"); git(f.seed, "push", "origin", "main");
        remoteHead = git(f.origin, "rev-parse", "main");
      }
    };
    const result = blocked(await f.adapter.execute(r, attempt(r)), /push/);
    expect(mutations(result)).toEqual(["fetch", "merge", "push"]);
    expect(git(f.origin, "rev-parse", "main")).toBe(remoteHead);
    expect(remoteHead).not.toBe(r.expected.remoteHead.digest);
  }, 120_000);

  it.each(["remote", "local-state", "fetch-error"])("final verification %s failure does not claim SUCCEEDED", async (fault) => {
    const f = await fixture(); publish(f); const r = await request(f); let fetches = 0;
    interception.before = (op) => {
      if (op === "fetch --no-tags origin" && ++fetches === 2) {
        if (fault === "fetch-error") throw new Error("network failure");
        if (fault === "remote") { commit(f.seed, "A", "third\n"); git(f.seed, "push", "origin", "main"); }
        if (fault === "local-state") put(f.root, "B", "changed after push\n");
      }
    };
    const result = blocked(await f.adapter.execute(r, attempt(r)));
    expect(mutations(result)).toEqual(["fetch", "merge", "push", "fetch"]);
    expect(result).not.toHaveProperty("finalState");
  }, 120_000);

  it.each(["request", "attempt", "head", "parents", "staged", "unstaged", "untracked", "origin", "conflict"])("push gate rejects changed %s", async (fault) => {
    const f = await fixture(); commit(f.root, "C", "local committed\n"); publish(f); const r = await request(f);
    const bound: any = structuredClone(attempt(r));
    interception.after = (op) => {
      if (op !== "merge --no-edit origin/main") return;
      if (fault === "request") r.actionId = randomUUID();
      if (fault === "attempt") bound.attempt.attemptId = randomUUID();
      if (fault === "head") commit(f.root, "B", "extra commit\n");
      if (fault === "parents") {
        // Replace generated commit by one with the same tree and wrong parent count.
        const tree = git(f.root, "rev-parse", "HEAD^{tree}");
        const wrong = git(f.root, "commit-tree", tree, "-p", r.expected.head.digest, "-m", "fixture wrong parent");
        git(f.root, "update-ref", "refs/heads/main", wrong);
      }
      if (fault === "staged") { put(f.root, "B", "changed\n"); git(f.root, "add", "B"); }
      if (fault === "unstaged") put(f.root, "B", "changed\n");
      if (fault === "untracked") put(f.root, "unexpected", "changed\n");
      if (fault === "origin") git(f.root, "config", "remote.origin.url", f.seed);
      if (fault === "conflict") put(f.root, ".git/MERGE_HEAD", `${r.expected.remoteHead.digest}\n`);
    };
    const result = blocked(await f.adapter.execute(r, bound));
    expect(mutations(result)).toEqual(["fetch", "merge"]);
  }, 120_000);

  it.each(["generation", "policy", "policyIdentity", "unknown-target"])("%s mismatch blocks before fetch", async (fault) => {
    const f = await fixture(), r = await request(f);
    let adapter = f.adapter;
    if (fault === "generation") r.preconditions.targetGeneration++;
    if (fault === "policy") r.preconditions.policySha256 = "0".repeat(64);
    if (fault === "policyIdentity") adapter = createGitIntegrateMainFixtureAdapter([{ ...f.record, policyIdentity: "other" }]);
    if (fault === "unknown-target") r.target.id = randomUUID();
    const result = blocked(await adapter.execute(r, attempt(r)));
    expect(mutations(result)).toEqual([]);
  }, 120_000);

  it("exclusive repository lock blocks a competing adapter and is released", async () => {
    const f = await fixture(), r = await request(f), second = createGitIntegrateMainFixtureAdapter([f.record]);
    let competing: Promise<GitAdapterOutcome> | undefined;
    interception.before = (op) => {
      if (op === "fetch --no-tags origin" && !competing) competing = second.execute(r, attempt(r));
    };
    verified(await f.adapter.execute(r, attempt(r)), r, "unchanged");
    expect(competing).toBeDefined();
    const result = blocked(await competing!); expect(result.invocations).toEqual([]);
    expect(existsSync(path.join(f.root, ".git/typed-action-integrate.lock"))).toBe(false);
  }, 120_000);

  it("consumes attempts without retrying mutations", async () => {
    const f = await fixture(), r = await request(f), bound = attempt(r);
    verified(await f.adapter.execute(r, bound), r, "unchanged");
    const result = blocked(await f.adapter.execute(r, bound), /already consumed/);
    expect(result.invocations).toEqual([]);
  }, 120_000);

  it.each(["command", "argv", "executable", "cwd", "path", "branch", "remote", "ref", "strategy", "commitMessage"])("has no arbitrary %s selector API", async (selector) => {
    const f = await fixture(), r = await request(f), bound = attempt(r);
    expect(Object.keys(f.adapter).sort()).toEqual(["execute", "observe"]);
    r[selector] = "caller-controlled";
    const result = blocked(await f.adapter.execute(r, bound)); expect(result.invocations).toEqual([]);
  }, 120_000);

  it.each(["core.hooksPath", "include.path", "merge.tool", "merge.autoStash", "diff.external", "filter.evil.clean", "remote.origin.push", "branch.main.mergeOptions"])("rejects config injection %s", async (key) => {
    const f = await fixture(), r = await request(f);
    git(f.root, "config", key, "caller-controlled");
    const result = blocked(await f.adapter.execute(r, attempt(r)), /configuration/);
    expect(mutations(result)).toEqual([]);
  }, 120_000);

  it("canonical staged digest binds only changed paths and explicit side identities", async () => {
    const f = await fixture(); put(f.root, "B", "B2\n"); git(f.root, "add", "B");
    const r = await request(f);
    const canonical = [["B", ["100644", "sha1", git(f.root, "rev-parse", "HEAD:B")],
      ["100644", "sha1", git(f.root, "rev-parse", ":B")]]];
    expect(r.expected.stagedDeltaSha256).toBe(createHash("sha256").update(`git-staged-delta-v1\n${JSON.stringify(canonical)}`).digest("hex"));
    publish(f); const updated = await request(f);
    verified(await f.adapter.execute(updated, attempt(updated)), updated, "fast-forward");
    expect((await f.adapter.observe(f.record.id)).stagedDeltaSha256).toBe(r.expected.stagedDeltaSha256);
  }, 120_000);

  it("canonical deltas bind add/delete, index absence, content and exact path ordering", async () => {
    const f = await fixture();
    git(f.root, "rm", "B"); put(f.root, "added", "staged addition\n"); git(f.root, "add", "added");
    put(f.root, "A", "working delta\n"); put(f.root, "z untracked", "new bytes\n");
    const observation = await f.adapter.observe(f.record.id);
    const hash = (v: string) => createHash("sha256").update(v).digest("hex");
    const encoded = (domain: string, v: unknown) => hash(`${domain}\n${JSON.stringify(v)}`);
    expect(observation.stagedDeltaSha256).toBe(encoded("git-staged-delta-v1", [
      ["B", ["100644", "sha1", git(f.root, "rev-parse", "HEAD:B")], null],
      ["added", null, ["100644", "sha1", git(f.root, "rev-parse", ":added")]],
    ]));
    expect(observation.unstagedDeltaSha256).toBe(encoded("git-unstaged-delta-v1", [
      ["A", ["100644", "sha1", git(f.root, "rev-parse", ":A")], ["file", "100644", "sha256", hash("working delta\n")]],
      ["z untracked", null, ["file", "100644", "sha256", hash("new bytes\n")]],
    ]));
    expect(observation.untrackedStateSha256).toBe(encoded("git-untracked-state-v1", [
      ["z untracked", "file", ["sha256", hash("new bytes\n")]],
    ]));
    expect(observation.localChangePathsSha256).toBe(encoded("git-local-change-paths-v1", ["A", "B", "added", "z untracked"]));
  }, 120_000);

  it("missing working directory encodes deletions rather than following absent parents", async () => {
    const f = await fixture(); await mkdir(path.join(f.root, "nested"));
    commit(f.root, "nested/file", "tracked\n"); await rm(path.join(f.root, "nested"), { recursive: true });
    publish(f); const r = await request(f);
    verified(await f.adapter.execute(r, attempt(r)), r, "merge");
    expect(existsSync(path.join(f.root, "nested/file"))).toBe(false);
  }, 120_000);

  it("file/directory remote overlap blocks before merge", async () => {
    const f = await fixture(); await mkdir(path.join(f.root, "new")); put(f.root, "new/child", "local\n");
    publish(f, "new", "remote file\n"); const r = await request(f);
    expect(mutations(blocked(await f.adapter.execute(r, attempt(r)), /overlap/))).toEqual(["fetch"]);
  }, 120_000);

  it("temporary-only boundary rejects a non-fixture root without touching it", async () => {
    const f = await fixture(), r = await request(f);
    const root = path.join(path.parse(f.root).root, "not-a-fixture");
    const adapter = createGitIntegrateMainFixtureAdapter([{ ...f.record, root }]);
    expect(blocked(await adapter.execute(r, attempt(r)), /Fixture boundary/).invocations).toEqual([]);
  }, 120_000);

  it("working parent reparse escape blocks before fetch", async () => {
    const f = await fixture(), r = await request(f);
    await symlink(f.seed, path.join(f.root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const result = blocked(await f.adapter.execute(r, attempt(r)));
    expect(mutations(result)).toEqual([]);
  }, 120_000);

  it("local state changed during fetch blocks before merge", async () => {
    const f = await fixture(); publish(f); const r = await request(f);
    interception.after = (op) => { if (op === "fetch --no-tags origin") put(f.root, "B", "racing writer\n"); };
    expect(mutations(blocked(await f.adapter.execute(r, attempt(r)), /mismatch/))).toEqual(["fetch"]);
  }, 120_000);

  it("ambiguous origin/main ref blocks before fetch", async () => {
    const f = await fixture(), r = await request(f);
    git(f.root, "branch", "origin/main");
    expect(mutations(blocked(await f.adapter.execute(r, attempt(r)), /ambiguous ref/))).toEqual([]);
  }, 120_000);

  it.each(["timeout", "output-limit"])("%s retains the fence for reconciliation and forbids push/retry", async (fault) => {
    const f = await fixture(), r = await request(f);
    interception.before = (op) => {
      if (op === "merge --no-edit origin/main") throw Object.assign(new Error("OS termination"),
        fault === "timeout" ? { killed: true } : { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    };
    const result = blocked(await f.adapter.execute(r, attempt(r)), /Indeterminate merge/);
    expect(result.restoration).toBe("unverified"); expect(mutations(result)).toEqual(["fetch", "merge"]);
    expect(existsSync(path.join(f.root, ".git/typed-action-integrate.lock"))).toBe(true);
    const other = createGitIntegrateMainFixtureAdapter([f.record]);
    expect(blocked(await other.execute(r, attempt(r))).invocations).toEqual([]);
  }, 120_000);
});
