import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, freeze } from "../../task-contract/contract.js";
import { hashRecord, manifestSchema, validateBinding, type DevelopmentBinding } from "./contract.js";
import { assertCandidateAttempt, inspectCandidateRepository, type CandidateRepository } from "./candidate-repo.js";
import { MAX_PROPOSAL_BYTES, parseProposal } from "./proposal.js";
import { assertDevelopmentStoreInstance, DevelopmentStore, type StoreCommand } from "./store.js";

export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const limitBytes = 1024 * 1024 * 1024;
type FileState = { state: "FILE"; sha256: string; byteLength: number };
type ScopeState = FileState | { state: "MISSING" };
type Entry = { kind: "FILE" | "DIRECTORY" | "LINK"; identity: string; sha256?: string; byteLength?: number };
export type TreeSnapshot = Readonly<Record<string, Entry>>;
function fail(reason: string): never { throw new Error(`DL2_E0_${reason}`); }
export type FixedBinding = ReturnType<typeof validateBinding>["binding"];

/** Exclusive host custody of candidate and its ancestors is required, as in DL2-C.
 * No candidate code runs during this operation. Checks do not constitute an OS lock. */
export function snapshotTree(root: string, candidate = true): TreeSnapshot {
  if (candidate && process.platform === "linux") {
    const mounts = fs.readFileSync("/proc/self/mountinfo", "utf8");
    if (Buffer.byteLength(mounts) > 1024 * 1024) fail("MOUNTINFO_LIMIT");
    for (const line of mounts.trim().split("\n")) {
      const mountpoint = line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
      if (!mountpoint || !line.includes(" - ")) fail("MOUNTINFO_INVALID");
      if (mountpoint === root || mountpoint.startsWith(root + "/")) fail("MOUNT_ALIAS");
    }
  }
  const rows: Record<string, Entry> = Object.create(null);
  let remaining = limitBytes, count = 0;
  const walk = (full: string, name: string) => {
    if (++count > 100_000) fail("SNAPSHOT_LIMIT");
    const s = fs.lstatSync(full);
    const identity = `${s.dev}:${s.ino}:${s.mode}:${s.isDirectory() ? "directory" : s.nlink}`;
    if (s.isSymbolicLink() && !candidate) {
      rows[name] = { kind: "LINK", identity, sha256: sha256(fs.readlinkSync(full)) }; return;
    }
    if (s.isSymbolicLink() || path.relative(fs.realpathSync.native(full), full) !== "") fail("UNSAFE_RELATIONSHIP");
    if (s.isDirectory()) {
      rows[name] = { kind: "DIRECTORY", identity };
      const names = fs.readdirSync(full).sort(), aliases = new Set<string>();
      for (const child of names) {
        if (candidate && aliases.has(child.toLowerCase())) fail("CASE_ALIAS");
        aliases.add(child.toLowerCase());
        walk(path.join(full, child), name ? `${name}/${child}` : child);
      }
    } else {
      if (!s.isFile() || candidate && s.nlink !== 1 || s.size > remaining) fail("UNSAFE_FILE_OR_LIMIT");
      remaining -= s.size;
      const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fs.fstatSync(fd), hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
        let length = 0;
        while (length <= s.size) {
          const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, s.size + 1 - length), null);
          if (!n) break;
          length += n; hash.update(buffer.subarray(0, n));
        }
        const after = fs.fstatSync(fd), current = fs.lstatSync(full);
        if (opened.dev !== s.dev || opened.ino !== s.ino || current.dev !== s.dev || current.ino !== s.ino ||
          after.size !== length || length !== s.size || opened.mtimeMs !== s.mtimeMs || opened.ctimeMs !== s.ctimeMs ||
          opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) fail("SNAPSHOT_RACE");
        rows[name] = { kind: "FILE", identity, sha256: hash.digest("hex"), byteLength: length };
      } finally { fs.closeSync(fd); }
    }
  };
  walk(root, "");
  return freeze({ ...rows });
}

export function safeComponents(root: string, relative: string): string {
  const parts = relative.split("/");
  let full = root, missing = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!/^[A-Za-z0-9_.@+-]+$/.test(part) || [".", "..", ".git", "node_modules"].includes(part.toLowerCase()) ||
      /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) fail("UNSAFE_SCOPE_PATH");
    if (!missing) {
      const names = fs.readdirSync(full);
      if (names.some(n => n.toLowerCase() === part.toLowerCase() && n !== part)) fail("CASE_ALIAS");
    }
    full = path.join(full, part);
    if (missing) continue;
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || path.relative(fs.realpathSync.native(full), full) !== "" ||
        (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail("UNSAFE_SCOPE_PATH");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = true;
    }
  }
  return full;
}

export function scopeSnapshot(scope: readonly string[], tree: TreeSnapshot): readonly { path: string; value: ScopeState }[] {
  return freeze(scope.map(name => {
    const row = Object.hasOwn(tree, name) ? tree[name] : undefined;
    if (row && row.kind !== "FILE") fail("SCOPE_NOT_FILE");
    return { path: name, value: row ? { state: "FILE" as const, sha256: row.sha256!, byteLength: row.byteLength! }
      : { state: "MISSING" as const } };
  }));
}

/** Uses genuine methods, never caller-overridden instance methods. */
export function currentStore(store: unknown) {
  assertDevelopmentStoreInstance(store);
  return DevelopmentStore.prototype.recover.call(store);
}
export function commitStore(store: DevelopmentStore, binding: FixedBinding, fields: Record<string, unknown>) {
  const recovered = currentStore(store);
  if (recovered.orphanTransaction || recovered.writerFenced) fail("RECONCILE_REQUIRED");
  const command = { transactionId: `dev2-store-tx-e0-${recovered.state.version + 1}`, expectedVersion: recovered.state.version,
    binding, ...fields } as StoreCommand;
  return DevelopmentStore.prototype.transact.call(store, command, binding);
}
export function assertIdleStore(store: unknown, binding: unknown, expected: unknown, state: string) {
  const b = validateBinding(binding, expected).binding;
  const r = currentStore(store);
  if (r.disposition === "RECONCILE_REQUIRED" || r.writerFenced || r.state.reservations.some(x => x.status !== "RELEASED"))
    fail("RECONCILE_REQUIRED");
  if (r.state.state !== state || !same(r.state.binding, b)) fail("ENTRY_STATE_OR_BINDING");
  return b;
}
export function advanceStore(store: DevelopmentStore, binding: FixedBinding, to: string,
  candidateOutcome: "CONFIRMED" | "UNKNOWN" | "FAILED_WITHOUT_MUTATION") {
  return commitStore(store, binding, { operation: "ADVANCE", to, candidateOutcome, canonicalOutcome: "NOT_STARTED" });
}

export interface MutatedCandidate { readonly kind: "MANIFEST_COMMITTED_EVIDENCE_ONLY" }
interface MutationData { store: DevelopmentStore; candidate: CandidateRepository; binding: FixedBinding;
  candidateTree: TreeSnapshot; canonicalTree: TreeSnapshot; canonicalRoot: string }
const mutations = new WeakMap<MutatedCandidate, MutationData>();
export function inspectMutatedCandidate(handle: MutatedCandidate): Readonly<MutationData> {
  const data = mutations.get(handle);
  if (!data) fail("UNRECOGNIZED_MUTATION_HANDLE");
  return Object.freeze({ ...data });
}
export function assertMutationCurrent(data: Readonly<MutationData>): void {
  inspectCandidateRepository(data.candidate);
  if (!same(snapshotTree(data.candidate.root), data.candidateTree) ||
    !same(snapshotTree(data.canonicalRoot, false), data.canonicalTree)) fail("CANDIDATE_OR_CANONICAL_DRIFT");
}

/** Sole mutation surface. Proposal is data; reservation is durable bookkeeping, not authority. */
export function mutateCandidate(input: { store: DevelopmentStore; binding: unknown; candidate: CandidateRepository; proposal: unknown },
  hostExpected: unknown): MutatedCandidate {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) fail("INVALID_INPUT");
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 4 || keys.some(k => typeof k !== "string" || !["store", "binding", "candidate", "proposal"].includes(k)))
    fail("INVALID_INPUT_FIELDS");
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(input, k)!;
    if (!d.enumerable || !("value" in d)) fail("INVALID_INPUT_PROPERTY");
  }
  input = { ...input };
  const b = assertIdleStore(input.store, input.binding, hostExpected, "PROPOSAL_FIXED");
  const proposal = parseProposal(input.proposal, b, hostExpected);
  assertCandidateAttempt(input.candidate, b, hostExpected);
  const info = inspectCandidateRepository(input.candidate);
  if (info.head !== b.delegation.baselineHead) fail("CANDIDATE_BASELINE");
  for (const name of b.delegation.scope) safeComponents(input.candidate.root, name);
  const beforeTree = snapshotTree(input.candidate.root), canonicalTree = snapshotTree(info.canonicalRoot, false);
  const before = scopeSnapshot(b.delegation.scope, beforeTree);
  const replacements = proposal.files.map(row => {
    const target = safeComponents(input.candidate.root, row.path), bytes = Buffer.from(row.content, "utf8");
    if (bytes.length > MAX_PROPOSAL_BYTES) fail("REPLACEMENT_LIMIT");
    if (Object.hasOwn(beforeTree, row.path)) {
      if (beforeTree[row.path].byteLength! > MAX_PROPOSAL_BYTES) fail("EXISTING_TEXT_LIMIT");
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const bytes = Buffer.alloc(beforeTree[row.path].byteLength! + 1);
        let length = 0;
        while (length < bytes.length) {
          const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (!n) break;
          length += n;
        }
        if (length !== beforeTree[row.path].byteLength || sha256(bytes.subarray(0, length)) !== beforeTree[row.path].sha256)
          fail("TEXT_SNAPSHOT_RACE");
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
      } finally { fs.closeSync(fd); }
    }
    return { ...row, target, bytes };
  });
  // Missing untouched scope rows cannot be represented by the existing Manifest contract.
  for (const row of before) if (row.value.state === "MISSING" && !replacements.some(r => r.path === row.path))
    fail("MANIFEST_MISSING_UNCHANGED_UNREPRESENTABLE");
  commitStore(input.store, b, { operation: "RESERVE", kind: "CANDIDATE" });
  let started = false;
  let manifest: DevelopmentBinding["manifest"];
  let afterTree: TreeSnapshot;
  try {
    inspectCandidateRepository(input.candidate);
    if (!same(snapshotTree(input.candidate.root), beforeTree) || !same(snapshotTree(info.canonicalRoot, false), canonicalTree))
      fail("PRE_MUTATION_DRIFT");
    for (const row of replacements) {
      safeComponents(input.candidate.root, row.path);
      const parts = row.path.split("/");
      let parent = input.candidate.root;
      for (const component of parts.slice(0, -1)) {
        parent = path.join(parent, component);
        if (!fs.existsSync(parent)) { started = true; fs.mkdirSync(parent, { mode: 0o700 }); }
      }
      const prior = Object.hasOwn(beforeTree, row.path) ? beforeTree[row.path] : undefined;
      // O_EXCL for creation; no truncation until descriptor identity has been verified.
      if (!prior) started = true;
      const fd = fs.openSync(row.target, prior ? fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0)
        : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const stat = fs.fstatSync(fd);
        safeComponents(input.candidate.root, row.path);
        if (!stat.isFile() || stat.nlink !== 1 || prior && prior.identity !== `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}`)
          fail("WRITE_IDENTITY_CHANGED");
        started = true;
        fs.ftruncateSync(fd, 0);
        let offset = 0;
        while (offset < row.bytes.length) {
          const n = fs.writeSync(fd, row.bytes, offset, row.bytes.length - offset, offset);
          if (n <= 0) fail("SHORT_WRITE");
          offset += n;
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
    inspectCandidateRepository(input.candidate);
    afterTree = snapshotTree(input.candidate.root);
    if (!same(snapshotTree(info.canonicalRoot, false), canonicalTree)) fail("CANONICAL_DRIFT");
    const changed = new Set(replacements.map(r => r.path));
    const newParents = new Set(replacements.flatMap(r => r.path.split("/").slice(0, -1).map((_, i) => r.path.split("/").slice(0, i + 1).join("/"))));
    for (const name of new Set([...Object.keys(beforeTree), ...Object.keys(afterTree)])) {
      if (changed.has(name)) continue;
      if (!Object.hasOwn(beforeTree, name) && newParents.has(name) && afterTree[name]?.kind === "DIRECTORY") continue;
      if (!same(Object.hasOwn(beforeTree, name) ? beforeTree[name] : null, Object.hasOwn(afterTree, name) ? afterTree[name] : null)) fail("UNEXPECTED_MUTATION");
    }
    for (const row of replacements) if (afterTree[row.path]?.sha256 !== sha256(row.bytes) || afterTree[row.path]?.byteLength !== row.bytes.length)
      fail("REPLACEMENT_MISMATCH");
    const after = scopeSnapshot(b.delegation.scope, afterTree);
    const files = before.map((row, i) => {
      const next = after[i].value;
      if (next.state !== "FILE") fail("MANIFEST_POST_MISSING");
      return { path: row.path, before: row.value, after: next,
        operation: row.value.state === "MISSING" ? "CREATED" : same(row.value, next) ? "UNCHANGED" : "MODIFIED" };
    });
    const parsed = manifestSchema.parse({ domain: "RC02_DEVELOPMENT_V2_MANIFEST", id: b.attempt.manifestId,
      attemptDigest: b.attempt.digest, proposalDigest: proposal.proposalDigest, files, digest: "0".repeat(64) });
    manifest = { ...parsed, digest: hashRecord(parsed) };
  } catch (error) {
    // No retry or rollback. Even mkdir/open-create is a filesystem mutation.
    let reconcile = false;
    try {
      if (!same(snapshotTree(info.canonicalRoot, false), canonicalTree) ||
        !started && !same(snapshotTree(input.candidate.root), beforeTree)) reconcile = true;
    } catch { reconcile = true; }
    if (reconcile) {
      try { advanceStore(input.store, b, "RECONCILE_REQUIRED", "UNKNOWN"); } catch { /* held reservation fences recovery */ }
      fail("RECONCILE_REQUIRED");
    }
    try { advanceStore(input.store, b, started ? "CANDIDATE_MUTATION_UNKNOWN" : "FAILED_KNOWN",
      started ? "UNKNOWN" : "FAILED_WITHOUT_MUTATION"); } catch { fail("RECONCILE_REQUIRED"); }
    throw new Error(started ? "CANDIDATE_MUTATION_UNKNOWN" : "FAILED_WITHOUT_MUTATION", { cause: error });
  }
  const binding = validateBinding({ ...b, manifest }, { ...b, manifest }).binding;
  try {
    advanceStore(input.store, binding, "CANDIDATE_MUTATION_CONFIRMED", "CONFIRMED");
    DevelopmentStore.prototype.completeRelease.call(input.store, "CANDIDATE");
  } catch { fail("RECONCILE_REQUIRED"); }
  const handle = Object.freeze({ kind: "MANIFEST_COMMITTED_EVIDENCE_ONLY" as const });
  mutations.set(handle, { store: input.store, candidate: input.candidate, binding, candidateTree: afterTree!, canonicalTree,
    canonicalRoot: info.canonicalRoot });
  return handle;
}
