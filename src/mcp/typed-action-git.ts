/** Fixture-only GitIntegrateMain execution seam. No approval consumer or MCP registration.
 * Registry construction is trusted host code; execute accepts only Core JSON identities.
 * The lock fences cooperating adapters. Other writers must be excluded by the fixture host.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath, readFile, readlink, readdir, open, unlink, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bindActionAttempt, hashActionRequest, parseActionRequest,
  type ActionReceipt, type ActionRequest, type BoundActionAttempt,
} from "./typed-actions.js";

type GitRequest = Extract<ActionRequest, { kind: "GitIntegrateMain" }>;
type Commit = GitRequest["expected"]["head"];
type GitResult = NonNullable<ActionReceipt["gitResult"]>;
type Digests = Pick<GitResult, "stagedDeltaSha256" | "unstagedDeltaSha256" | "untrackedStateSha256" | "localChangePathsSha256">;
export type FileIdentity = Readonly<{ device: number; inode: number }>;
export type TrustedFixtureRepository = Readonly<{
  id: string;
  root: string;
  rootIdentity: FileIdentity;
  gitIdentity: FileIdentity;
  origin: string;
  originIdentity: FileIdentity;
  generation: number;
  policyIdentity: string;
  policySha256: string;
}>;

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const encode = (domain: string, value: unknown) => sha(`${domain}\n${JSON.stringify(value)}`);
export const gitIntegrateMainFixturePolicy = Object.freeze({
  identity: "git-integrate-main-fixture-v1",
  sha256: sha("git-integrate-main-fixture-v1\nmain\norigin\nfetch-no-tags/merge-no-edit/preserve-deltas/push/fetch/verify\n"),
});

// No dynamic executable, shell, argv, refs, strategies or messages at the API boundary.
const executable = process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const nullFile = "/dev/null";
const prefix = ["--no-pager", "-c", "core.fsmonitor=false",
  "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "credential.helper=",
  "-c", "core.askPass=", "-c", "commit.gpgSign=false", "-c", "merge.gpgSign=false",
  "-c", "merge.autoStash=false", "-c", "merge.ff=true", "-c", "merge.renames=false",
  "-c", "protocol.allow=never", "-c", "protocol.file.allow=always"] as const;
const commands = {
  config: ["config", "--local", "--null", "--list"],
  root: ["rev-parse", "--show-toplevel"],
  branch: ["symbolic-ref", "--quiet", "HEAD"],
  head: ["rev-parse", "--verify", "HEAD^{commit}"],
  remote: ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
  format: ["rev-parse", "--show-object-format"],
  refs: ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"],
  tree: ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
  index: ["ls-files", "--stage", "-z"],
  flags: ["ls-files", "-v", "-z"],
  untracked: ["ls-files", "--others", "-z"], // Include ignored files: they must not be overwritten either.
  fetch: ["fetch", "--no-tags", "origin"],
  divergence: ["rev-list", "--left-right", "--count", "HEAD...refs/remotes/origin/main"],
  remotePaths: ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD...refs/remotes/origin/main", "--"],
  merge: ["merge", "--no-edit", "origin/main"],
  abort: ["merge", "--abort"],
  parents: ["rev-list", "--parents", "-n", "1", "HEAD"],
  push: ["push", "origin", "main"],
} as const;
type Command = keyof typeof commands;
export type GitInvocation = Readonly<{ operation: Command; argv: readonly string[] }>;
export type GitAdapterOutcome =
  | { status: "VERIFIED"; requestHash: string; attemptHash: string; gitResult: GitResult; invocations: readonly GitInvocation[] }
  | { status: "BLOCKED"; reason: string; restoration: "not-needed" | "verified" | "unverified";
      invocations: readonly GitInvocation[] };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function noLinks(file: string, allowMissing = false): Promise<void> {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (allowMissing && !await exists(current)) return;
    check(!(await lstat(current)).isSymbolicLink(), "Symlink/reparse escape");
    check(path.resolve(await realpath(current)).toLowerCase() === path.resolve(current).toLowerCase(), "Realpath escape");
  }
}
async function identity(file: string, expected: FileIdentity): Promise<void> {
  await noLinks(file);
  const stat = await lstat(file);
  check(stat.isDirectory() && stat.dev === expected.device && stat.ino === expected.inode, "Repository identity mismatch");
}
async function metadataTree(root: string): Promise<void> {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    check(!item.isSymbolicLink(), "Git metadata symlink/reparse escape");
    if (item.isDirectory()) await metadataTree(file);
  }
}
function gitPath(value: string): string {
  check(value.length > 0 && !value.includes("\ufffd") && !value.includes("\\") && !value.includes(":"), "Unsupported Git path");
  check(!value.startsWith("/") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."
    && part.toLowerCase() !== ".git" && !/[. ]$/.test(part)), "Unsafe Git path");
  return value;
}
function records(buffer: Buffer): string[] {
  check(Buffer.from(buffer.toString("utf8")).equals(buffer), "Non-UTF8 Git data is unsupported");
  const text = buffer.toString("utf8");
  check(text === "" || text.endsWith("\0"), "Malformed NUL records");
  return text === "" ? [] : text.slice(0, -1).split("\0");
}
const ordered = (values: Iterable<string>) => [...values].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
type ObjectIdentity = readonly [mode: string, algorithm: "sha1" | "sha256", digest: string];
type WorkingIdentity = readonly [type: "file" | "symlink", mode: string, algorithm: "sha256", digest: string];
type LocalState = Digests & { paths: string[] };

class RepositorySession {
  deadline = Date.now() + 300_000;
  quarantined = false;
  readonly invocations: GitInvocation[] = [];
  fileMode = false;
  algorithm: "sha1" | "sha256" = "sha1";
  private isolation?: { directory: string; config: string; hooks: string; configIdentity: FileIdentity; hooksIdentity: FileIdentity; directoryIdentity: FileIdentity };
  constructor(readonly repository: TrustedFixtureRepository) {}

  private async gitIsolation() {
    if (process.platform !== "win32") return { config: nullFile, hooks: nullFile };
    if (!this.isolation) {
      const directory = await mkdtemp(path.join(await realpath(tmpdir()), "typed-git-isolation-"));
      const config = path.join(directory, "empty"), hooks = path.join(directory, "hooks");
      await writeFile(config, "", { flag: "wx", mode: 0o600 });
      await mkdir(hooks, { mode: 0o700 });
      const file = await lstat(config), dir = await lstat(hooks), guard = await lstat(directory);
      this.isolation = { directory, config, hooks,
        configIdentity: { device: file.dev, inode: file.ino }, hooksIdentity: { device: dir.dev, inode: dir.ino }, directoryIdentity: { device: guard.dev, inode: guard.ino } };
    }
    const isolation = this.isolation;
    await noLinks(isolation.config); await noLinks(isolation.hooks);
    const file = await lstat(isolation.config);
    check(file.isFile() && file.nlink === 1 && file.dev === isolation.configIdentity.device
      && file.ino === isolation.configIdentity.inode && (await readFile(isolation.config)).length === 0,
      "Git isolation config changed");
    await identity(isolation.hooks, isolation.hooksIdentity);
    check((await readdir(isolation.hooks)).length === 0, "Git isolation hooks changed");
    return isolation;
  }
  async dispose(): Promise<void> {
    if (this.isolation && !this.quarantined) {
      check(inside(await realpath(tmpdir()), path.resolve(this.isolation.directory)), "Unsafe isolation cleanup path");
      await identity(this.isolation.directory, this.isolation.directoryIdentity);
      await rm(this.isolation.directory, { recursive: true, force: true });
    }
  }

  async git(operation: Command): Promise<Buffer> {
    const timeout = Math.min(30_000, this.deadline - Date.now());
    check(timeout > 0, "Phase timeout: reconcile before retry");
    const isolation = await this.gitIsolation();
    const argv = [...prefix, "-c", `core.hooksPath=${isolation.hooks.replaceAll("\\", "/")}`,
      "-c", `core.attributesFile=${isolation.config.replaceAll("\\", "/")}`, ...commands[operation]];
    this.invocations.push(Object.freeze({ operation, argv: Object.freeze([...argv]) }));
    // Do not inherit GIT_*, editors, shell startup, loaders, SSH, or global config.
    const env: NodeJS.ProcessEnv = {
      SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
      PATH: process.platform === "win32" ? "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32" : "/usr/bin:/bin",
      HOME: this.repository.root, USERPROFILE: this.repository.root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: isolation.config, GIT_CONFIG_SYSTEM: isolation.config,
      GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_OPTIONAL_LOCKS: "0",
      GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_MERGE_AUTOEDIT: "no",
      LC_ALL: "C", LANG: "C",
    };
    return new Promise((resolve, reject) => {
      execFile(executable, argv, { cwd: this.repository.root, shell: false, windowsHide: true,
        timeout, maxBuffer: 8 * 1024 * 1024, encoding: "buffer", env }, (error, stdout) => {
        if (error) {
          if (error.killed || error.signal || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") this.quarantined = true;
          reject(new Error(`Git ${operation} failed or was indeterminate`));
        } else resolve(stdout);
      });
    });
  }
  async text(operation: Command): Promise<string> { return (await this.git(operation)).toString("utf8").trim(); }
  commit(value: string): Commit {
    check(new RegExp(`^[a-f0-9]{${this.algorithm === "sha1" ? 40 : 64}}$`).test(value), "Malformed object identity");
    return { algorithm: this.algorithm, digest: value };
  }
  async head(): Promise<Commit> { return this.commit(await this.text("head")); }
  async remote(): Promise<Commit> { return this.commit(await this.text("remote")); }
  async relation(): Promise<[number, number]> {
    const value = await this.text("divergence");
    check(/^\d+\s+\d+$/.test(value), "Malformed divergence");
    const counts = value.split(/\s+/).map(Number);
    check(counts.every(Number.isSafeInteger), "Invalid divergence");
    return [counts[0], counts[1]];
  }
  async trusted(): Promise<void> {
    const r = this.repository;
    check(path.isAbsolute(r.root) && path.isAbsolute(r.origin)
      && inside(await realpath(tmpdir()), path.resolve(r.root))
      && inside(await realpath(tmpdir()), path.resolve(r.origin)), "Fixture boundary: repositories must be temporary");
    await identity(r.root, r.rootIdentity);
    await identity(path.join(r.root, ".git"), r.gitIdentity);
    await identity(r.origin, r.originIdentity);
    check(r.policyIdentity === gitIntegrateMainFixturePolicy.identity
      && r.policySha256 === gitIntegrateMainFixturePolicy.sha256, "Policy identity/hash mismatch");
    await metadataTree(path.join(r.root, ".git"));
    for (const name of ["commondir", "objects/info/alternates", "info/grafts", "info/attributes", "refs/replace", "shallow"]) {
      check(!await exists(path.join(r.root, ".git", name)), "Unsupported Git metadata");
    }
    if (await exists(path.join(r.root, ".git/packed-refs"))) {
      check(!(await readFile(path.join(r.root, ".git/packed-refs"), "utf8")).includes("refs/replace/"), "Replacement refs forbidden");
    }
    const config = new Map<string, string>();
    for (const record of records(await this.git("config"))) {
      const separator = record.indexOf("\n");
      check(separator > 0, "Malformed config");
      const key = record.slice(0, separator), value = record.slice(separator + 1);
      check(!config.has(key), "Duplicate Git configuration");
      config.set(key, value);
      const allowed: Record<string, (v: string) => boolean> = {
        "core.repositoryformatversion": (v) => v === "0" || v === "1",
        "core.filemode": (v) => v === "true" || v === "false",
        "core.bare": (v) => v === "false",
        "core.logallrefupdates": (v) => v === "true",
        "core.ignorecase": (v) => v === "true" || v === "false",
        "core.symlinks": (v) => v === "true" || v === "false",
        "core.autocrlf": (v) => v === "false",
        "extensions.objectformat": (v) => v === "sha256",
        "remote.origin.url": (v) => v === r.origin,
        "remote.origin.fetch": (v) => v === "+refs/heads/main:refs/remotes/origin/main",
        "branch.main.remote": (v) => v === "origin",
        "branch.main.merge": (v) => v === "refs/heads/main",
        "user.name": (v) => /^[\w .-]{1,100}$/.test(v),
        "user.email": (v) => /^[\w.+-]+@[\w.-]+$/.test(v),
      };
      check(Object.hasOwn(allowed, key) && allowed[key](value), `Unsupported Git configuration: ${key}`);
    }
    check(config.get("remote.origin.url") === r.origin
      && config.get("remote.origin.fetch") === "+refs/heads/main:refs/remotes/origin/main", "Origin identity mismatch");
    this.fileMode = config.get("core.filemode") === "true";
    check(path.resolve(await this.text("root")) === path.resolve(r.root), "Git root mismatch");
    check(await this.text("branch") === "refs/heads/main", "Wrong branch");
    const algorithm = await this.text("format");
    check(algorithm === "sha1" || algorithm === "sha256", "Unsupported object format");
    this.algorithm = algorithm;
    // `merge origin/main` must resolve uniquely to the fixed remote-tracking ref.
    for (const line of (await this.text("refs")).split("\n")) {
      const [ref, object, symbolic = ""] = line.trimEnd().split(" ");
      this.commit(object);
      check((ref === "refs/heads/main" || ref === "refs/remotes/origin/main") && symbolic === ""
        || ref === "refs/remotes/origin/HEAD" && symbolic === "refs/remotes/origin/main", "Unexpected or ambiguous ref");
    }
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START", "MERGE_AUTOSTASH", "index.lock"]) {
      check(!await exists(path.join(r.root, ".git", name)), "Unfinished Git operation");
    }
  }
  async working(file: string, index?: ObjectIdentity): Promise<{ identity: WorkingIdentity; object: ObjectIdentity } | null> {
    const full = path.join(this.repository.root, gitPath(file));
    await noLinks(path.dirname(full), true);
    if (!await exists(full)) return null;
    const stat = await lstat(full);
    check(stat.size <= 8 * 1024 * 1024, "Working file exceeds bound");
    check(stat.nlink === 1, "Working hardlink escape");
    let content: Buffer, mode: string, type: "file" | "symlink";
    if (stat.isSymbolicLink()) {
      check(inside(this.repository.root, await realpath(full)), "Working symlink escape");
      content = Buffer.from(await readlink(full)); mode = "120000"; type = "symlink";
    } else {
      check(stat.isFile(), "Unsupported working file type");
      content = await readFile(full);
      mode = this.fileMode ? (stat.mode & 0o111 ? "100755" : "100644")
        : index?.[0] === "100755" ? "100755" : "100644";
      type = "file";
    }
    const blob = createHash(this.algorithm).update(`blob ${content.length}\0`).update(content).digest("hex");
    return { identity: [type, mode, "sha256", sha(content)], object: [mode, this.algorithm, blob] };
  }
  async local(): Promise<LocalState> {
    const head = new Map<string, ObjectIdentity>(), index = new Map<string, ObjectIdentity>();
    for (const entry of records(await this.git("tree"))) {
      const match = /^(\d{6}) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      check(match, "Unsupported HEAD entry (including submodule)");
      this.commit(match[2]); head.set(gitPath(match[3]), [match[1], this.algorithm, match[2]]);
    }
    for (const entry of records(await this.git("index"))) {
      const match = /^(100644|100755|120000) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
      check(match && match[3] === "0", "Unmerged or unsupported index stages");
      this.commit(match[2]); index.set(gitPath(match[4]), [match[1], this.algorithm, match[2]]);
    }
    for (const entry of records(await this.git("flags"))) check(entry.startsWith("H "), "Unsupported index flags");
    const untracked = ordered(new Set(records(await this.git("untracked")).map(gitPath)));
    const all = ordered(new Set([...head.keys(), ...index.keys(), ...untracked]));
    check(all.length <= 10_000, "Path count exceeds bound");
    const casePaths = new Set<string>();
    for (const file of all) {
      check(!casePaths.has(file.toLowerCase()), "Case-alias paths unsupported"); casePaths.add(file.toLowerCase());
      check(!file.split("/").some((part) => part.toLowerCase() === ".gitattributes"), "Attributes are unsupported");
    }
    const staged: unknown[] = [], unstaged: unknown[] = [], others: unknown[] = [];
    const changed = new Set<string>();
    for (const file of ordered(new Set([...head.keys(), ...index.keys()]))) {
      const h = head.get(file) ?? null, i = index.get(file) ?? null;
      if (JSON.stringify(h) !== JSON.stringify(i)) { staged.push([file, h, i]); changed.add(file); }
      if (i) {
        const w = await this.working(file, i);
        if (JSON.stringify(i) !== JSON.stringify(w?.object ?? null)) {
          unstaged.push([file, i, w?.identity ?? null]); changed.add(file);
        }
      }
    }
    for (const file of untracked) {
      const w = await this.working(file);
      check(w, "Untracked file disappeared");
      // An index-absent working file binds explicit absence in the index→WT
      // delta as well as its separate untracked identity.
      unstaged.push([file, null, w.identity]);
      others.push([file, w.identity[0], ["sha256", w.identity[3]]]); changed.add(file);
    }
    unstaged.sort((a, b) => Buffer.compare(Buffer.from((a as [string])[0]), Buffer.from((b as [string])[0])));
    const paths = ordered(changed);
    return {
      stagedDeltaSha256: encode("git-staged-delta-v1", staged),
      unstagedDeltaSha256: encode("git-unstaged-delta-v1", unstaged),
      untrackedStateSha256: encode("git-untracked-state-v1", others),
      localChangePathsSha256: encode("git-local-change-paths-v1", paths), paths,
    };
  }
}

const sameCommit = (a: Commit, b: Commit) => a.algorithm === b.algorithm && a.digest === b.digest;
function digests(state: LocalState): Digests {
  const { paths: _paths, ...result } = state; return result;
}
function preserved(state: LocalState, expected: Digests): void {
  for (const key of Object.keys(digests(state)) as (keyof Digests)[]) check(state[key] === expected[key], `${key} mismatch`);
}

/** This factory is deliberately restricted to temporary fixture repositories.
 * It provides Git evidence, never an approved/SUCCEEDED Core receipt. A future
 * production entry point needs an independent authority consumer and fencing host.
 */
export function createGitIntegrateMainFixtureAdapter(inventory: readonly TrustedFixtureRepository[]) {
  const registry = new Map<string, TrustedFixtureRepository>();
  for (const item of inventory) {
    check(!registry.has(item.id), "Duplicate repository ID");
    const copy = structuredClone(item);
    registry.set(item.id, Object.freeze({ ...copy, rootIdentity: Object.freeze(copy.rootIdentity),
      gitIdentity: Object.freeze(copy.gitIdentity), originIdentity: Object.freeze(copy.originIdentity) }));
  }
  const consumed = new Set<string>();
  async function locked<T>(id: string, operation: (session: RepositorySession) => Promise<T>): Promise<T> {
    const repository = registry.get(id);
    check(repository, "Unknown repository ID");
    // Establish the directory identity before creating the cooperative lock.
    check(inside(await realpath(tmpdir()), path.resolve(repository.root)), "Fixture boundary");
    await identity(repository.root, repository.rootIdentity);
    await identity(path.join(repository.root, ".git"), repository.gitIdentity);
    const lockPath = path.join(repository.root, ".git/typed-action-integrate.lock");
    const lock = await open(lockPath, "wx");
    const session = new RepositorySession(repository);
    try { return await operation(session); }
    finally {
      await lock.close();
      await session.dispose();
      // Timeout/output termination can leave descendant processes in flight.
      // Retain the fence until the trusted fixture host reconciles/disposes it.
      if (!session.quarantined) await unlink(lockPath);
    }
  }
  return Object.freeze({
    async observe(targetId: string): Promise<GitRequest["expected"]> {
      return locked(targetId, async (s) => {
        await s.trusted();
        const head = await s.head(), remoteHead = await s.remote(), local = await s.local();
        check(sameCommit(head, await s.head()), "HEAD changed during observation");
        preserved(await s.local(), local);
        return { generation: s.repository.generation, head, remoteHead, ...digests(local) };
      });
    },
    async execute(requestInput: unknown, attemptInput: BoundActionAttempt): Promise<GitAdapterOutcome> {
      let invocations: readonly GitInvocation[] = [];
      let restoration: "not-needed" | "verified" | "unverified" = "not-needed";
      try {
        const request = parseActionRequest(requestInput);
        check(request.kind === "GitIntegrateMain", "Wrong action kind");
        const bound = bindActionAttempt(attemptInput.attempt, request);
        check(bound.attemptHash === attemptInput.attemptHash, "Attempt binding mismatch");
        const requestHash = hashActionRequest(request);
        check(!consumed.has(bound.attemptHash), "Attempt already consumed");
        consumed.add(bound.attemptHash);
        return await locked(request.target.id, async (s): Promise<GitAdapterOutcome> => {
          invocations = s.invocations;
          const binding = () => {
            check(hashActionRequest(requestInput) === requestHash, "Request identity changed");
            check(bindActionAttempt(attemptInput.attempt, requestInput).attemptHash === bound.attemptHash
              && attemptInput.attemptHash === bound.attemptHash, "Attempt identity changed");
            check(s.repository.generation === request.expected.generation
              && s.repository.generation === request.preconditions.targetGeneration, "Target generation mismatch");
            check(s.repository.policySha256 === request.preconditions.policySha256, "Policy hash mismatch");
          };
          const state = async (head: Commit) => {
            binding(); await s.trusted();
            check(sameCommit(await s.head(), head), "Local HEAD mismatch");
            const local = await s.local(); preserved(local, request.expected);
            check(sameCommit(await s.head(), head), "HEAD changed during state check");
            return local;
          };
          s.deadline = Date.now() + request.timeout.preflightMs;
          const before = await state(request.expected.head);
          check(sameCommit(await s.remote(), request.expected.remoteHead), "Remote HEAD mismatch");
          s.deadline = Date.now() + request.timeout.executionMs;
          await s.git("fetch");
          check(sameCommit(await s.remote(), request.expected.remoteHead), "Fetched remote HEAD mismatch");
          const [ahead, behind] = await s.relation();
          const remotePaths = records(await s.git("remotePaths")).map(gitPath);
          check(!remotePaths.some((file) => file.split("/").some((part) => part.toLowerCase() === ".gitattributes")), "Remote attributes unsupported");
          // Prefix intersections protect file/directory transitions, and case aliases on Windows.
          check(!remotePaths.some((remote) => before.paths.some((local) => {
            const a = remote.toLowerCase(), b = local.toLowerCase();
            return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
          })), "Remote/local path overlap");
          await state(request.expected.head);
          check(sameCommit(await s.remote(), request.expected.remoteHead), "Remote changed before merge");
          try { await s.git("merge"); }
          catch {
            restoration = "unverified";
            check(!s.quarantined, "Indeterminate merge: fence retained for reconciliation");
            s.quarantined = true;
            if (await exists(path.join(s.repository.root, ".git/MERGE_HEAD"))) await s.git("abort");
            await state(request.expected.head);
            s.quarantined = false;
            restoration = "verified";
            throw new Error("Merge failed; pre-merge state restored; push forbidden");
          }
          const integrated = await s.head();
          const integration: GitResult["integration"] = behind === 0 ? "unchanged" : ahead === 0 ? "fast-forward" : "merge";
          const parents = async (): Promise<Commit[]> => {
            const result = (await s.text("parents")).split(" ").map((value) => s.commit(value));
            check(sameCommit(result[0], integrated), "Result HEAD mismatch");
            if (integration === "merge") {
              check(result.length === 3 && sameCommit(result[1], request.expected.head)
                && sameCommit(result[2], request.expected.remoteHead)
                && !sameCommit(integrated, request.expected.head) && !sameCommit(integrated, request.expected.remoteHead), "Merge parents mismatch");
              return result.slice(1);
            }
            check(sameCommit(integrated, integration === "unchanged" ? request.expected.head : request.expected.remoteHead), "Integration result mismatch");
            return [];
          };
          const mergeParents = await parents();
          await state(integrated);
          // Push gate: fresh binding, repo/origin/branch/conflict, HEAD, parents and all four deltas.
          await parents();
          await state(integrated);
          check(sameCommit(await s.remote(), request.expected.remoteHead), "Remote changed before push");
          binding();
          await s.git("push");
          s.deadline = Date.now() + request.timeout.verificationMs;
          await s.git("fetch");
          const originMainHead = await s.remote();
          check(sameCommit(await s.head(), integrated) && sameCommit(integrated, originMainHead), "Final remote HEAD mismatch");
          const [finalAhead, finalBehind] = await s.relation();
          check(finalAhead === 0 && finalBehind === 0, "Final divergence mismatch");
          await parents();
          const finalLocal = await state(integrated);
          return { status: "VERIFIED", requestHash, attemptHash: bound.attemptHash,
            gitResult: { integration, finalHead: integrated, originMainHead,
              mergeCommit: integration === "merge" ? integrated : null, mergeParents,
              ...digests(finalLocal), ahead: finalAhead, behind: finalBehind }, invocations: s.invocations };
        });
      } catch (error) {
        return { status: "BLOCKED", reason: error instanceof Error ? error.message : "Indeterminate failure",
          restoration, invocations };
      }
    },
  });
}
