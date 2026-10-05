import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { validateBinding } from "./contract.js";
import { canonicalJson } from "../../task-contract/contract.js";

// Installation-owned primitives, never resolved through PATH or supplied by a request.
// Bind isolation to the same host platform as the executable for the module lifetime.
const hostPlatform = process.platform;
const gitExecutable = hostPlatform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const nullFile = "/dev/null";
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const requestSchema = z.object({ binding: z.unknown(), candidateRoot: z.string().min(1) }).strict();
const hostSchema = z.object({ expectedBinding: z.unknown(), canonicalRoot: z.string().min(1),
  candidateParent: z.string().min(1) }).strict();

export interface CandidateRepository {
  readonly kind: "INDEPENDENT_CANDIDATE_ONLY";
  readonly root: string;
  readonly head: string;
  readonly tree: string;
}
interface PrivateCandidate { canonical: string; gitDir: string; files: readonly string[]; attemptBinding: string; baselineIndex: Buffer }
const prepared = new WeakMap<CandidateRepository, PrivateCandidate>();

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Host-owned parent directories must remain exclusive to the controller during preparation.
 * This is filesystem validation, NOT the candidate execution security boundary. */
function plainPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Unsafe non-canonical path");
  for (let part = path; ; part = dirname(part)) {
    const stat = lstatSync(part);
    if (stat.isSymbolicLink() || relative(realpathSync.native(part), part) !== "")
      throw new Error("Symlink/junction path rejected");
    if (dirname(part) === part) break;
  }
}

function plainTree(path: string): void {
  plainPath(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name), stat = lstatSync(child);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("Unsafe repository entry");
    if (stat.isFile() && stat.nlink !== 1) throw new Error("Hardlinked repository entry");
    if (stat.isDirectory()) plainTree(child);
  }
}

function gitIsolationPaths(root: string): { configFile: string; hooksDir: string } {
  if (hostPlatform !== "win32") {
    return { configFile: nullFile, hooksDir: nullFile };
  }

  const guard = root + ".git-isolation";
  return {
    configFile: join(guard, "empty"),
    hooksDir: join(guard, "hooks"),
  };
}

function prepareGitIsolation(root: string): void {
  if (hostPlatform !== "win32") return;

  const { configFile, hooksDir } = gitIsolationPaths(root);
  const guard = dirname(configFile);

  if (existsSync(guard)) throw new Error("Git isolation path already exists");

  mkdirSync(guard, { mode: 0o700 });
  writeFileSync(configFile, "", { flag: "wx", mode: 0o600 });
  mkdirSync(hooksDir, { mode: 0o700 });
}

function validatedGitIsolation(root: string): { configFile: string; hooksDir: string } {
  const isolation = gitIsolationPaths(root);
  if (hostPlatform !== "win32") return isolation;

  plainPath(dirname(isolation.configFile));
  plainPath(isolation.configFile);
  plainPath(isolation.hooksDir);

  const config = lstatSync(isolation.configFile);
  const hooks = lstatSync(isolation.hooksDir);

  if (
    !config.isFile() ||
    config.nlink !== 1 ||
    readFileSync(isolation.configFile).length !== 0 ||
    !hooks.isDirectory() ||
    readdirSync(isolation.hooksDir).length !== 0
  ) {
    throw new Error("Git isolation path changed");
  }

  return isolation;
}

function gitConfigPath(value: string): string {
  return hostPlatform === "win32" ? value.replaceAll("\\", "/") : value;
}

function git(root: string, args: readonly string[], input?: Buffer | string, sourceObjects?: string): Buffer {
  const isolation = validatedGitIsolation(root);
  // No inherited environment. The canonical config is never opened by Git: even pack-objects
  // runs with the NEW repository's config and reads only the explicit source object directory.
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: isolation.configFile,
    GIT_CONFIG_GLOBAL: isolation.configFile,
    GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C",
    ...(hostPlatform === "win32" ? { SystemRoot: "C:\\Windows" } : {}),
    ...(sourceObjects ? { GIT_OBJECT_DIRECTORY: sourceObjects } : {}),
  };
  const result = spawnSync(gitExecutable, ["-c", "core.hooksPath=" + gitConfigPath(isolation.hooksDir),
    "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "submodule.recurse=false",
    "-c", "core.attributesFile=" + gitConfigPath(isolation.configFile), "-c", "core.fsmonitor=false", "-C", root, ...args],
  { env, input, shell: false, timeout: 60_000, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("Candidate Git primitive failed", { cause: result.error });
  return result.stdout;
}

function sourceHead(gitDir: string): string {
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (oid.test(head)) return head;
  const ref = head.match(/^ref: (refs\/heads\/[A-Za-z0-9_./-]+)$/)?.[1];
  if (!ref || ref.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe source HEAD");
  const path = join(gitDir, ...ref.split("/"));
  if (existsSync(path)) {
    plainPath(path);
    const value = readFileSync(path, "utf8").trim();
    if (oid.test(value)) return value;
  } else if (existsSync(join(gitDir, "packed-refs"))) {
    plainPath(join(gitDir, "packed-refs"));
    const line = readFileSync(join(gitDir, "packed-refs"), "utf8").split("\n").find(l => l.endsWith(` ${ref}`));
    if (line && oid.test(line.split(" ")[0])) return line.split(" ")[0];
  }
  throw new Error("Source HEAD unavailable");
}

function rejectRelationships(gitDir: string): void {
  for (const name of ["commondir", "gitdir", "worktrees", "shallow", "objects/info/alternates", "objects/info/http-alternates"])
    if (existsSync(join(gitDir, name))) throw new Error("Shared/partial Git storage rejected");
}

/** Preparation only. hostInput must come from protected host policy, independently of requestInput.
 * Phase A binding is checked, but neither a binding nor a store receipt grants execution authority.
 * No checkout/filter/diff/merge/submodule command ever runs; files are written from raw blobs.
 * On failure the private partial directory is retained for host cleanup, never issued as a handle. */
export function prepareCandidateRepository(requestInput: unknown, hostInput: unknown): CandidateRepository {
  const request = requestSchema.parse(requestInput), host = hostSchema.parse(hostInput);
  const { binding } = validateBinding(request.binding, host.expectedBinding);
  const baseline = binding.delegation.baselineHead;
  const canonical = host.canonicalRoot, root = request.candidateRoot, parent = host.candidateParent;
  plainPath(canonical); plainPath(parent);
  if (!isAbsolute(root) || resolve(root) !== root || dirname(root) !== parent || existsSync(root) ||
    within(canonical, root) || within(root, canonical) || within(canonical, parent)) throw new Error("Unsafe candidate root");
  const sourceGit = join(canonical, ".git"), objects = join(sourceGit, "objects");
  plainPath(sourceGit);
  if (!lstatSync(sourceGit).isDirectory()) throw new Error("Git worktree rejected");
  plainPath(join(sourceGit, "HEAD"));
  rejectRelationships(sourceGit); plainTree(objects);
  if (sourceHead(sourceGit) !== baseline) throw new Error("Trusted committed baseline mismatch");
  mkdirSync(root, { mode: 0o700 });
  prepareGitIsolation(root);
  git(root, ["init", "--template=", `--object-format=${baseline.length === 64 ? "sha256" : "sha1"}`]);
  const gitDir = join(root, ".git");
  const isolation = validatedGitIsolation(root);
  // Replace init's configuration with a closed, host-owned configuration. There are no includes,
  // remotes, helpers, filters, merge drivers, templates, or hooks copied from the canonical repo.
  writeFileSync(join(gitDir, "config"), `[core]\nrepositoryformatversion = ${baseline.length === 64 ? 1 : 0}\nbare = false\nfilemode = false\nhooksPath = ${gitConfigPath(isolation.hooksDir)}\nlogAllRefUpdates = false\n${baseline.length === 64 ? "[extensions]\nobjectFormat = sha256\n" : ""}[protocol]\nallow = never\n[submodule]\nrecurse = false\n`);
  const pack = git(root, ["pack-objects", "--stdout", "--revs"], `${baseline}\n`, objects);
  git(root, ["index-pack", "--stdin", "--strict"], pack);
  git(root, ["update-ref", "--no-deref", "HEAD", baseline]);
  const tree = git(root, ["rev-parse", `${baseline}^{tree}`]).toString().trim();
  const listing = git(root, ["ls-tree", "-rz", "--full-tree", baseline]).toString("utf8");
  const files: string[] = [];
  for (const record of listing.split("\0").filter(Boolean)) {
    const match = record.match(/^(100644|100755|160000) (blob|commit) ([a-f0-9]+)\t(.+)$/s);
    if (!match) throw new Error("Unsupported tree entry (including symlink)");
    const [, mode, type, hash, path] = match;
    // Conservative portable names also exclude NTFS streams, short-name aliases, .git aliases,
    // reserved devices, and Windows normalization collisions. Fail closed on unsupported names.
    if (!oid.test(hash) || path.split("/").some(p => !/^[A-Za-z0-9_.@+-]+$/.test(p) ||
      p === "." || p === ".." || p.toLowerCase() === ".git" || /[. ]$/.test(p) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error("Unsafe tracked path");
    if (mode === "160000" && type === "commit") continue; // Never initialize submodules.
    if (type !== "blob") throw new Error("Invalid blob mode");
    const destination = join(root, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, git(root, ["cat-file", "blob", hash]), { flag: "wx", mode: mode === "100755" ? 0o700 : 0o600 });
    files.push(path);
  }
  git(root, ["read-tree", baseline]); // Index only; no working-tree filter execution.
  // Empty host-prepared mount destination for E0's read-only dependency capsule.
  // This happens during preparation, never during reserved proposal mutation.
  if (!existsSync(join(root, "node_modules"))) mkdirSync(join(root, "node_modules"), { mode: 0o700 });
  if (sourceHead(sourceGit) !== baseline) throw new Error("Source HEAD changed during preparation");
  const candidate = Object.freeze({ kind: "INDEPENDENT_CANDIDATE_ONLY" as const, root, head: baseline, tree });
  prepared.set(candidate, { canonical, gitDir, files: Object.freeze(files), attemptBinding: canonicalJson({
    delegation: binding.delegation, request: binding.request, attempt: binding.attempt }), baselineIndex: readFileSync(join(gitDir, "index")) });
  inspectCandidateRepository(candidate);
  return candidate;
}

/** Revalidates an in-process, non-serializable preparation handle; never an execution permit. */
export function inspectCandidateRepository(candidate: CandidateRepository) {
  const privateData = prepared.get(candidate);
  if (!privateData) throw new Error("Unrecognized candidate handle");
  const { canonical, gitDir, files } = privateData;
  plainTree(candidate.root); rejectRelationships(gitDir);
  if (within(canonical, candidate.root) || !lstatSync(gitDir).isDirectory()) throw new Error("Unsafe candidate storage");
  // Config must stay exactly host-generated: do not run Git after candidate mutation of config.
  const config = readFileSync(join(gitDir, "config"), "utf8");
  const isolation = validatedGitIsolation(candidate.root);
  const expected = `[core]\nrepositoryformatversion = ${candidate.head.length === 64 ? 1 : 0}\nbare = false\nfilemode = false\nhooksPath = ${gitConfigPath(isolation.hooksDir)}\nlogAllRefUpdates = false\n${candidate.head.length === 64 ? "[extensions]\nobjectFormat = sha256\n" : ""}[protocol]\nallow = never\n[submodule]\nrecurse = false\n`;
  if (config !== expected || readdirSync(gitDir).some(n => ["hooks", "config.worktree"].includes(n))) throw new Error("Candidate config changed");
  const text = (args: string[]) => git(candidate.root, args).toString().trim();
  // One fixed read-only invocation observes the same five identities. No cache:
  // every inspection still re-reads Git state under the closed environment.
  const identities = text(["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir",
    "--git-path", "objects", "HEAD", "HEAD^{tree}"]).split("\n");
  if (identities.length !== 5) throw new Error("Invalid Git identity observation");
  for (const directory of identities.slice(0, 2)) {
    const actual = resolve(directory);
    if (relative(actual, gitDir) !== "") throw new Error(`Git storage identity mismatch: ${actual} != ${gitDir}`);
  }
  if (relative(resolve(identities[2]), join(gitDir, "objects")) !== "" ||
    identities[3] !== candidate.head || identities[4] !== candidate.tree ||
    text(["remote"]) !== "" || text(["worktree", "list", "--porcelain"]).split("\n").filter(l => l.startsWith("worktree ")).length !== 1)
    throw new Error("Candidate identity mismatch");
  for (const path of files) {
    const target = lstatSync(join(candidate.root, path));
    if (!target.isFile() || target.nlink !== 1) throw new Error("Unsafe tracked file");
    const source = join(canonical, path);
    if (existsSync(source)) {
      const original = lstatSync(source);
      if (original.dev === target.dev && original.ino === target.ino) throw new Error("Canonical hardlink shared");
    }
  }
  return Object.freeze({ canonicalRoot: canonical, gitDir, commonDir: gitDir, objectDir: join(gitDir, "objects"),
    head: candidate.head, tree: candidate.tree, remotes: 0, alternates: false, sharedStorage: false });
}

/** Original factory binding, ignoring later evidence extensions. Identity only. */
export function assertCandidateAttempt(candidate: CandidateRepository, bindingInput: unknown, hostExpected: unknown): void {
  const { binding: b } = validateBinding(bindingInput, hostExpected);
  const privateData = prepared.get(candidate);
  if (!privateData || privateData.attemptBinding !== canonicalJson({ delegation: b.delegation, request: b.request, attempt: b.attempt }))
    throw new Error("Candidate attempt binding mismatch");
}

/** Fixed read-only primitives. No caller Git argv, revisions or paths outside exact scope. */
export function readExactBaseline(candidate: CandidateRepository, bindingInput: unknown) {
  const { binding } = validateBinding(bindingInput, bindingInput);
  assertCandidateAttempt(candidate, binding, binding);
  inspectCandidateRepository(candidate);
  const data = prepared.get(candidate)!;
  return binding.delegation.scope.map(name => ({ path: name, bytes: data.files.includes(name)
    ? git(candidate.root, ["cat-file", "blob", `${binding.delegation.baselineHead}:${name}`]) : null }));
}

/** Canonical config is never executed. Conservative exact baseline index check. */
export function assertCanonicalBaseline(candidate: CandidateRepository): void {
  const data = prepared.get(candidate);
  if (!data) throw new Error("Unrecognized candidate handle");
  plainPath(data.canonical);
  const directory = join(data.canonical, ".git");
  plainTree(directory); rejectRelationships(directory);
  if (sourceHead(directory) !== candidate.head) throw new Error("Canonical HEAD drift");
  if (existsSync(join(directory, "index.lock")) ||
    !readFileSync(join(directory, "index")).equals(data.baselineIndex)) throw new Error("Unexpected canonical index");
}
