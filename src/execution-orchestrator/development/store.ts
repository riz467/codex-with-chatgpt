import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson, freeze, parseStrict } from "../../task-contract/contract.js";
import { bindingSchema, consumeMaterialization, parseBinding, validateBinding, type DevelopmentBinding } from "./contract.js";
import { transitionPreconditions, type State, type Transition } from "./state-machine.js";
import { parseFindings, verificationSchema } from "./review-evidence.js";

/** DL2-B persistence only. No method returns an execution permit.
 * Each root holds one immutable attempt lineage identity. The trusted host owns
 * root-to-attempt uniqueness, complete predecessor history and delegation checks;
 * validateBinding alone does not authenticate any of these facts. Recovery never
 * allocates a root or an attempt. Explicit creation may store a host-bound successor.
 *
 * Durability: a single append-only, host-protected journal contains both blob bytes
 * and transaction receipts. PREPARE is fully written and fsync'd before COMMIT is
 * written and fsync'd. No rename, directory entry, index or separate blob file is
 * needed for transaction publication. On Windows Node/libuv fsync maps to the
 * OS file flush primitive (FlushFileBuffers); this is not directory fsync and is
 * not a promise about hardware that lies about flush completion.
 *
 * Bootstrap creates a new journal exclusively in an existing trusted directory.
 * Node cannot portably guarantee Windows directory-entry durability. The host must
 * retain the returned anchor outside this directory. Reopen NEVER creates a missing
 * journal, and requires that anchor; missing/rolled-back data fails closed. There
 * is no automatic bootstrap retry. This is not rollback-resistant protected storage.
 *
 * Complete PREPARE without COMMIT is not committed. Partial/invalid frames, gaps,
 * conflicting identities, or an interrupted transaction fence further writes.
 * Recovery validates and flushes the observed journal before reporting receipts.
 * Advisory artifacts alone never change lifecycle state. Recovery only projects
 * committed facts and may complete reservation-release bookkeeping.
 *
 * Exclusive writer lock: wx file, never stolen or expired. A process crash may
 * strand it. Readers can recover committed receipts but writes stay fenced; an
 * independent host must establish exclusive custody outside this API. PID/age
 * is deliberately not used to infer safe ownership. All participants must use
 * this protocol; root/ancestors must be protected from concurrent hostile writers.
 */
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().nonnegative().safe();
const txId = z.string().regex(/^dev2-store-tx-[a-z0-9-]{1,64}$/);
const outcome = z.enum(["NOT_STARTED", "CONFIRMED", "FAILED_WITHOUT_MUTATION", "UNKNOWN"]);
const kindSchema = z.enum(["DISPATCH", "CANDIDATE", "FAST", "CANONICAL", "REVIEW_VERIFY"]);
type Kind = z.infer<typeof kindSchema>;
const common = { transactionId: txId, expectedVersion: version, binding: bindingSchema };
const commandSchema = z.discriminatedUnion("operation", [
  z.object({ ...common, operation: z.literal("CREATE") }).strict(),
  z.object({ ...common, operation: z.literal("ADVANCE"), to: z.string(), candidateOutcome: outcome, canonicalOutcome: outcome }).strict(),
  z.object({ ...common, operation: z.literal("RESERVE"), kind: kindSchema }).strict(),
  z.object({ ...common, operation: z.literal("REVIEW_ARTIFACT") }).strict(),
  z.object({ ...common, operation: z.literal("COMMIT_REVIEW") }).strict(),
  z.object({ ...common, operation: z.literal("CONSUME_MATERIALIZATION") }).strict(),
  z.object({ ...common, operation: z.literal("RELEASE"), kind: kindSchema }).strict(),
  z.object({ ...common, operation: z.literal("ARTIFACT"), artifactId: z.string().regex(/^dev2-artifact-[a-z0-9-]{1,80}$/),
    contentBase64: z.string().max(131072) }).strict(),
]);
export type StoreCommand = z.infer<typeof commandSchema>;
type Artifact = { id: string; sha256: string; bindingDigest: string };
type Reservation = { kind: Kind; reservedAt: number; bindingDigest: string; status: "HELD" | "RELEASE_PENDING" | "RELEASED" };
type Snapshot = { version: number; state: State; binding: DevelopmentBinding;
  artifacts: Artifact[]; blobs: Record<string, string>; reservations: Reservation[];
  committedReview: string | null; consumedMaterialization: string | null };
const anchorSchema = z.object({ format: z.literal("DL2_STORE_V1"), storeId: z.string().uuid(),
  version, receiptDigest: hash }).strict();
export type StoreAnchor = z.infer<typeof anchorSchema>;
export type StoreReceipt = StoreAnchor & { kind: "COMMITTED_STORAGE_ONLY"; operation: StoreCommand["operation"];
  transactionId: string; commandDigest: string; stateDigest: string; previousReceiptDigest: string | null;
  requestDigest: string; attemptDigest: string; candidateGeneration: number;
  manifestDigest: string | null; reviewDigest: string | null; materializationDigest: string | null };
type Prepared = { type: "PREPARE"; format: "DL2_STORE_V1"; storeId: string;
  previousReceiptDigest: string | null; command: StoreCommand; stateDigest: string };
type Commit = { type: "COMMIT"; prepareDigest: string; receipt: StoreReceipt };
type Scan = { state: Snapshot; receipts: StoreReceipt[]; commands: StoreCommand[]; pending: boolean; storeId: string };
const journalName = "development-v2.journal";
const lockName = "development-v2.writer";
const maxJournalBytes = 32 * 1024 * 1024;
const maxFrameBytes = 1024 * 1024;
function stop(reason: string): never { throw new Error(`DL2_STORE_${reason}`); }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const copyBinding = (input: unknown): DevelopmentBinding => structuredClone(parseBinding(input)) as DevelopmentBinding;

function extend(previous: DevelopmentBinding, next: DevelopmentBinding): void {
  for (const key of Object.keys(previous) as (keyof DevelopmentBinding)[])
    if (!same(previous[key], next[key] ?? null)) stop("BINDING_REPLACED");
}
const reservationTarget: Record<Kind, State> = { DISPATCH: "DISPATCH_RESERVED", CANDIDATE: "CANDIDATE_MUTATION_IN_PROGRESS",
  FAST: "FAST_IN_PROGRESS", CANONICAL: "CANONICAL_MATERIALIZATION_RESERVED", REVIEW_VERIFY: "REVIEW_VERIFY_IN_PROGRESS" };
const releaseTargets: Record<Kind, readonly State[]> = {
  DISPATCH: ["PROPOSAL_FIXED", "FAILED_KNOWN"], CANDIDATE: ["CANDIDATE_MUTATION_CONFIRMED", "FAILED_KNOWN"],
  FAST: ["FAST_EVIDENCE_FIXED", "FAST_FAILED_KNOWN"], CANONICAL: ["HUMAN_COMMIT_CHECKPOINT"],
  REVIEW_VERIFY: ["REVIEW_VERIFIED", "REVIEW_VERIFY_FAILED_KNOWN"],
};

function addArtifact(s: Snapshot, id: string, bytes: Buffer, binding: DevelopmentBinding): void {
  const sha256 = digest(bytes), bindingDigest = digest(canonicalJson(binding));
  const existing = s.artifacts.find(a => a.id === id);
  if (existing && (existing.sha256 !== sha256 || existing.bindingDigest !== bindingDigest)) stop("IMMUTABLE_CONFLICT");
  const encoded = bytes.toString("base64");
  if (s.blobs[sha256] !== undefined && s.blobs[sha256] !== encoded) stop("BLOB_CONFLICT");
  if (!existing) s.artifacts.push({ id, sha256, bindingDigest });
  s.blobs[sha256] = encoded;
}

function requireFindings(s: Snapshot, b: DevelopmentBinding): void {
  if (!b.review) stop("REVIEW_ABSENT");
  const encoded = s.blobs[b.review.findingsDigest];
  const base = { delegation: b.delegation, request: b.request, attempt: b.attempt, manifest: b.manifest, fast: b.fast };
  if (!encoded || !s.artifacts.some(a => a.sha256 === b.review!.findingsDigest &&
    a.bindingDigest === digest(canonicalJson(base)))) stop("FINDINGS_ARTIFACT_MISSING");
  const bytes = Buffer.from(encoded, "base64");
  if (digest(bytes) !== b.review.findingsDigest) stop("FINDINGS_HASH");
  const findings = parseFindings(new TextDecoder("utf-8", { fatal: true }).decode(bytes), b);
  if (findings.result !== b.review.result) stop("FINDINGS_RESULT");
}

/** Deterministic reducer is used both before writing and during the entire recovery scan. */
function apply(previous: Snapshot | undefined, c: StoreCommand): Snapshot {
  const b = copyBinding(c.binding);
  if (!previous) {
    if (c.operation !== "CREATE" || c.expectedVersion !== 0 ||
      b.manifest || b.fast || b.review || b.materialization || b.reviewReceipt) stop("INVALID_CREATE");
    return { version: 0, state: "REQUEST_FIXED", binding: b, artifacts: [], blobs: {}, reservations: [],
      committedReview: null, consumedMaterialization: null };
  }
  if (c.operation === "CREATE" || c.expectedVersion !== previous.version) stop("STALE_VERSION");
  extend(previous.binding, b);
  const s = structuredClone(previous);
  s.version++;
  if (!Number.isSafeInteger(s.version)) stop("VERSION_EXHAUSTED");
  if (c.operation === "ARTIFACT" || c.operation === "REVIEW_ARTIFACT") {
    if (c.operation === "REVIEW_ARTIFACT") {
      if (!b.review) stop("REVIEW_ABSENT");
      if (s.state !== "REVIEW_PENDING") stop("REVIEW_NOT_PENDING");
      requireFindings(s, b);
      addArtifact(s, b.review.id, Buffer.from(canonicalJson(b.review)), b);
    } else {
      const bytes = Buffer.from(c.contentBase64, "base64");
      if (bytes.toString("base64") !== c.contentBase64 || bytes.length > 65536) stop("INVALID_BLOB");
      addArtifact(s, c.artifactId, bytes, b);
    }
    return s; // Does NOT promote future evidence to the lifecycle binding.
  }
  if (c.operation === "RELEASE") {
    if (!same(b, s.binding)) stop("RELEASE_BINDING_CHANGED");
    const r = s.reservations.find(row => row.kind === c.kind);
    if (!r || r.status !== "RELEASE_PENDING") stop("RESERVATION_NOT_RELEASABLE");
    r.status = "RELEASED";
    return s;
  }
  const introduced = (Object.keys(b) as (keyof DevelopmentBinding)[]).filter(key => !previous.binding[key]);
  const allowed = c.operation === "COMMIT_REVIEW" ? ["review"] : c.operation === "RESERVE" && c.kind === "CANONICAL" ? ["materialization"]
    : c.operation === "ADVANCE" && c.to === "CANDIDATE_MUTATION_CONFIRMED" ? ["manifest"]
      : c.operation === "ADVANCE" && c.to === "FAST_EVIDENCE_FIXED" ? ["fast"]
        : c.operation === "ADVANCE" && c.to === "REVIEW_VERIFIED" ? ["reviewReceipt"] : [];
  if (introduced.some(key => !allowed.includes(key))) stop("FUTURE_EVIDENCE");
  const move = (to: State, candidateOutcome: Transition["candidateOutcome"], canonicalOutcome: Transition["canonicalOutcome"]) => {
    transitionPreconditions({ from: s.state, to, candidateOutcome, canonicalOutcome }, b, b);
    s.state = to;
  };
  if (c.operation === "RESERVE") {
    if (s.reservations.some(r => r.kind === c.kind)) stop("RESERVATION_REPLAY");
    move(reservationTarget[c.kind], ["FAST", "CANONICAL", "REVIEW_VERIFY"].includes(c.kind) ? "CONFIRMED" : "NOT_STARTED",
      c.kind === "REVIEW_VERIFY" ? "CONFIRMED" : "NOT_STARTED");
    s.reservations.push({ kind: c.kind, status: "HELD", reservedAt: s.version, bindingDigest: digest(canonicalJson(b)) });
  } else if (c.operation === "COMMIT_REVIEW") {
    if (s.state !== "REVIEW_PENDING" || !b.review || s.committedReview) stop("REVIEW_NOT_PENDING");
    requireFindings(s, b);
    const artifact = s.artifacts.find(a => a.id === b.review!.id);
    if (!artifact || artifact.sha256 !== digest(canonicalJson(b.review)) || artifact.bindingDigest !== digest(canonicalJson(b)))
      stop("REVIEW_ARTIFACT_MISMATCH");
    move("REVIEW_RECORD_PREPARED", "CONFIRMED", "NOT_STARTED");
    move(b.review.result === "PASS" ? "PASS_RECORDED" : "ATTEMPT_REJECTED", "CONFIRMED", "NOT_STARTED");
    s.committedReview = b.review.digest;
  } else if (c.operation === "CONSUME_MATERIALIZATION") {
    if (s.state !== "CANONICAL_MATERIALIZATION_RESERVED" || !b.materialization || s.consumedMaterialization ||
      !s.reservations.some(r => r.kind === "CANONICAL" && r.status === "HELD")) stop("MATERIALIZATION_REPLAY");
    consumeMaterialization(b, b, []); // protected journal history, never caller-supplied consumption history
    move("CANONICAL_MUTATION_IN_PROGRESS", "CONFIRMED", "NOT_STARTED");
    s.consumedMaterialization = b.materialization.id;
  } else if (c.operation === "ADVANCE") {
    if ([...Object.values(reservationTarget), "REVIEW_RECORD_PREPARED", "PASS_RECORDED", "ATTEMPT_REJECTED",
      "CANONICAL_MUTATION_IN_PROGRESS"].includes(c.to as State)) stop("SPECIAL_TRANSACTION_REQUIRED");
    if (c.to === "WORKER_DISPATCH_IN_PROGRESS" && !s.reservations.some(r => r.kind === "DISPATCH" && r.status === "HELD"))
      stop("DISPATCH_RESERVATION_REQUIRED");
    if (c.to === "REVIEW_VERIFIED") {
      const receipt = b.reviewReceipt;
      if (!receipt || !b.materialization || !b.review || !b.manifest ||
        !s.reservations.some(r => r.kind === "REVIEW_VERIFY" && r.status === "HELD")) stop("VERIFY_EVIDENCE_REQUIRED");
      const encoded = s.blobs[receipt.evidenceDigest];
      if (!encoded || !s.artifacts.some(a => a.sha256 === receipt.evidenceDigest &&
        a.bindingDigest === digest(canonicalJson(previous.binding)))) stop("VERIFY_ARTIFACT_REQUIRED");
      const text = Buffer.from(encoded, "base64").toString("utf8");
      const evidence = parseStrict(verificationSchema, JSON.parse(text));
      const findings = parseFindings(Buffer.from(s.blobs[b.review.findingsDigest], "base64").toString("utf8"), b);
      if (canonicalJson(evidence) !== text || digest(text) !== receipt.evidenceDigest ||
        evidence.attemptDigest !== b.attempt.digest || evidence.manifestDigest !== b.manifest.digest ||
        evidence.advisoryReviewDigest !== b.review.digest || evidence.materializationDigest !== b.materialization.digest ||
        evidence.findingsDigest !== b.review.findingsDigest || evidence.reviewContextDigest !== findings.reviewContextDigest ||
        evidence.baselineHead !== b.delegation.baselineHead || evidence.canonicalScopeDigest !== evidence.candidateScopeDigest)
        stop("VERIFY_EVIDENCE_BINDING");
    }
    move(c.to as State, c.candidateOutcome, c.canonicalOutcome);
  }
  s.binding = b;
  for (const r of s.reservations) if (r.status === "HELD" && releaseTargets[r.kind].includes(s.state)) r.status = "RELEASE_PENDING";
  return s;
}

function receiptFor(p: Prepared, state: Snapshot): StoreReceipt {
  const b = state.binding;
  const body = { format: "DL2_STORE_V1" as const, storeId: p.storeId, version: state.version,
    kind: "COMMITTED_STORAGE_ONLY" as const, operation: p.command.operation, transactionId: p.command.transactionId,
    commandDigest: digest(canonicalJson(p.command)), stateDigest: p.stateDigest, previousReceiptDigest: p.previousReceiptDigest,
    requestDigest: b.request.digest, attemptDigest: b.attempt.digest, candidateGeneration: b.attempt.candidateGeneration,
    manifestDigest: b.manifest?.digest ?? null, reviewDigest: b.review?.digest ?? null, materializationDigest: b.materialization?.digest ?? null };
  return { ...body, receiptDigest: digest(canonicalJson(body)) };
}
function frame(value: Prepared | Commit): Buffer {
  const body = canonicalJson(value);
  const bytes = Buffer.from(canonicalJson({ body, sha256: digest(body) }) + "\n");
  if (bytes.length > maxFrameBytes) stop("FRAME_LIMIT");
  return bytes;
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const n = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (n <= 0) stop("SHORT_WRITE");
    offset += n;
  }
}

function safeRoot(root: string): string {
  if (!path.isAbsolute(root)) stop("INVALID_HOST_ROOT");
  const resolved = path.resolve(root);
  let current = path.parse(resolved).root;
  for (const component of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase())
      stop("UNSAFE_HOST_ROOT");
  }
  return resolved;
}
function regular(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase())
    stop("UNSAFE_FILE");
}

const storeConstructorToken = Symbol("DevelopmentStore factory only");
const genuineStores = new WeakSet<DevelopmentStore>();

/** Runtime identity only. Not authority, approval or an execution permit. */
export function assertDevelopmentStoreInstance(input: unknown): asserts input is DevelopmentStore {
  if (typeof input !== "object" || input === null || !genuineStores.has(input as DevelopmentStore))
    stop("UNRECOGNIZED_INSTANCE");
}

export class DevelopmentStore {
  private readonly file: string;
  private readonly lock: string;
  private interrupted = false;
  private constructor(token: symbol, private readonly root: string, private anchor: StoreAnchor) {
    if (token !== storeConstructorToken) stop("FACTORY_REQUIRED");
    this.file = path.join(root, journalName); this.lock = path.join(root, lockName);
    genuineStores.add(this);
  }
  static create(root: string, input: unknown, hostExpected: unknown): { store: DevelopmentStore; receipt: StoreReceipt } {
    const c = parseStrict(commandSchema, input);
    validateBinding(c.binding, hostExpected);
    const state = apply(undefined, c), storeId = randomUUID();
    const store = new DevelopmentStore(storeConstructorToken, safeRoot(root), { format: "DL2_STORE_V1", storeId, version: 0, receiptDigest: "0".repeat(64) });
    const receipt = store.exclusive(() => {
      const fd = fs.openSync(store.file, "wx", 0o600);
      try { return store.append(fd, c, state, storeId, null); } finally { fs.closeSync(fd); }
    });
    store.anchor = store.anchorOf(receipt);
    return { store, receipt };
  }
  static open(root: string, anchorInput: unknown): DevelopmentStore {
    const anchor = parseStrict(anchorSchema, anchorInput);
    const store = new DevelopmentStore(storeConstructorToken, safeRoot(root), anchor);
    const scan = store.scan();
    store.interrupted = scan.pending || scan.state.reservations.some(r => r.status === "HELD") ||
      ["RECONCILE_REQUIRED", "CANDIDATE_MUTATION_UNKNOWN"].includes(scan.state.state);
    return store;
  }
  anchorOf(receipt: StoreReceipt): StoreAnchor {
    assertDevelopmentStoreInstance(this);
    return { format: receipt.format, storeId: receipt.storeId, version: receipt.version, receiptDigest: receipt.receiptDigest };
  }
  private exclusive<T>(action: () => T): T {
    assertDevelopmentStoreInstance(this);
    safeRoot(this.root);
    const fd = fs.openSync(this.lock, "wx", 0o600);
    try { return action(); } finally { fs.closeSync(fd); fs.unlinkSync(this.lock); }
  }
  private append(fd: number, c: StoreCommand, state: Snapshot, storeId: string, previousReceiptDigest: string | null): StoreReceipt {
    assertDevelopmentStoreInstance(this);
    const p: Prepared = { type: "PREPARE", format: "DL2_STORE_V1", storeId, previousReceiptDigest,
      command: c, stateDigest: digest(canonicalJson(state)) };
    const receipt = receiptFor(p, state);
    const prepare = frame(p), commit = frame({ type: "COMMIT", prepareDigest: digest(canonicalJson(p)), receipt });
    if (fs.fstatSync(fd).size + prepare.length + commit.length > maxJournalBytes) stop("JOURNAL_LIMIT");
    writeAll(fd, prepare); fs.fsyncSync(fd);
    writeAll(fd, commit); fs.fsyncSync(fd);
    return receipt;
  }
  private scan(): Scan {
    assertDevelopmentStoreInstance(this);
    safeRoot(this.root); regular(this.file);
    const fd = fs.openSync(this.file, "r+");
    let bytes: Buffer;
    try {
      const size = fs.fstatSync(fd).size;
      if (!size || size > maxJournalBytes) stop("JOURNAL_SIZE");
      bytes = fs.readFileSync(fd);
      fs.fsyncSync(fd); // establish file-flush acknowledgement for observed complete receipts
      if (fs.fstatSync(fd).size !== size || bytes.length !== size) stop("CONCURRENT_READ");
    } finally { fs.closeSync(fd); }
    if (bytes[bytes.length - 1] !== 10) stop("TRUNCATED_JOURNAL");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let pending: Prepared | undefined, pendingState: Snapshot | undefined, state: Snapshot | undefined;
    const receipts: StoreReceipt[] = [], commands: StoreCommand[] = [];
    for (const line of text.slice(0, -1).split("\n")) {
      if (Buffer.byteLength(line) > maxFrameBytes) stop("FRAME_LIMIT");
      const envelope = parseStrict(z.object({ body: z.string(), sha256: hash }).strict(), JSON.parse(line));
      if (digest(envelope.body) !== envelope.sha256 || canonicalJson(envelope) !== line) stop("FRAME_DIGEST");
      const value = JSON.parse(envelope.body) as Prepared | Commit;
      if (canonicalJson(value) !== envelope.body) stop("NONCANONICAL_FRAME");
      if (value.type === "PREPARE") {
        if (pending) stop("PREPARE_CONFLICT");
        const p = parseStrict(z.object({ type: z.literal("PREPARE"), format: z.literal("DL2_STORE_V1"),
          storeId: z.string().uuid(), previousReceiptDigest: hash.nullable(), command: commandSchema, stateDigest: hash }).strict(), value);
        if (p.storeId !== this.anchor.storeId || p.previousReceiptDigest !== (receipts.at(-1)?.receiptDigest ?? null) ||
          commands.some(c => c.transactionId === p.command.transactionId)) stop("HISTORY_CONFLICT");
        const next = apply(state, p.command);
        if (digest(canonicalJson(next)) !== p.stateDigest) stop("STATE_DIGEST");
        // Reducer input is this scan's private parsed bytes. Retain its validated
        // projection until COMMIT instead of applying the identical command twice.
        // Nothing is cached across scans or published before the receipt check.
        pending = p; pendingState = next;
      } else if (value.type === "COMMIT") {
        if (!pending || !pendingState) stop("ORPHAN_RECEIPT");
        const next = pendingState, expected = receiptFor(pending, next);
        if (!same(value, { type: "COMMIT", prepareDigest: digest(canonicalJson(pending)), receipt: expected })) stop("RECEIPT_CORRUPTION");
        state = next; receipts.push(expected); commands.push(pending.command); pending = undefined; pendingState = undefined;
      } else stop("UNKNOWN_FRAME");
    }
    if (!state || !receipts.some(r => r.version === this.anchor.version && r.receiptDigest === this.anchor.receiptDigest)) stop("ANCHOR_MISSING");
    return { state, receipts, commands, pending: !!pending, storeId: this.anchor.storeId };
  }
  /** Strict commands contain data/identities only; hostExpected is independently host-composed. */
  transact(input: unknown, hostExpected: unknown): StoreReceipt {
    assertDevelopmentStoreInstance(this);
    const c = parseStrict(commandSchema, input);
    validateBinding(c.binding, hostExpected);
    // Exact committed duplicates remain readable even with a stranded writer lock.
    const observed = this.scan();
    const duplicate = this.duplicate(observed, c);
    if (duplicate) return freeze(duplicate);
    if (this.interrupted || observed.pending) stop("RECONCILE_REQUIRED");
    return this.exclusive(() => {
      const scan = this.scan(), again = this.duplicate(scan, c);
      if (again) return freeze(again);
      if (scan.pending) stop("RECONCILE_REQUIRED");
      const next = apply(scan.state, c);
      regular(this.file);
      const fd = fs.openSync(this.file, "a");
      try {
        const receipt = this.append(fd, c, next, scan.storeId, scan.receipts.at(-1)!.receiptDigest);
        this.anchor = this.anchorOf(receipt);
        return freeze(receipt);
      } catch (error) { this.interrupted = true; throw error; }
      finally { fs.closeSync(fd); }
    });
  }
  private duplicate(scan: Scan, c: StoreCommand): StoreReceipt | undefined {
    assertDevelopmentStoreInstance(this);
    for (let i = 0; i < scan.commands.length; i++) {
      const old = scan.commands[i];
      if (old.transactionId === c.transactionId) {
        if (!same(old, c)) stop("TRANSACTION_CONFLICT");
        return scan.receipts[i];
      }
      const semanticDuplicate = old.operation === c.operation && (
        c.operation === "COMMIT_REVIEW" && old.binding.review?.id === c.binding.review?.id ||
        c.operation === "CONSUME_MATERIALIZATION" && old.binding.materialization?.id === c.binding.materialization?.id ||
        c.operation === "REVIEW_ARTIFACT" && old.binding.review?.id === c.binding.review?.id ||
        c.operation === "ARTIFACT" && old.operation === "ARTIFACT" && old.artifactId === c.artifactId);
      if (semanticDuplicate) {
        const { transactionId: _oldId, expectedVersion: _oldVersion, ...oldPayload } = old;
        const { transactionId: _newId, expectedVersion: _newVersion, ...newPayload } = c;
        if (!same(oldPayload, newPayload)) stop("IMMUTABLE_CONFLICT");
        return scan.receipts[i];
      }
    }
    return undefined;
  }
  recover() {
    assertDevelopmentStoreInstance(this);
    const scan = this.scan();
    const uncertain = this.interrupted || scan.pending || scan.state.reservations.some(r => r.status === "HELD") ||
      ["RECONCILE_REQUIRED", "CANDIDATE_MUTATION_UNKNOWN"].includes(scan.state.state);
    return freeze({ kind: "RECOVERED_STORAGE_ONLY" as const, state: scan.state, receipts: scan.receipts,
      disposition: uncertain ? "RECONCILE_REQUIRED" as const : "RECORDED_ONLY" as const,
      orphanTransaction: scan.pending, writerFenced: fs.existsSync(this.lock),
      // Pure bookkeeping projection. RELEASE_PENDING is already justified by a committed state receipt.
      releasedReservations: scan.state.reservations.filter(r => r.status !== "HELD").map(r => r.kind),
      anchor: this.anchorOf(scan.receipts.at(-1)!) });
  }
  /** Completing this projection is optional. No new verdict, attempt or side effect is selected. */
  completeRelease(kindInput: unknown): StoreReceipt {
    assertDevelopmentStoreInstance(this);
    const kind = parseStrict(kindSchema, kindInput), scan = this.scan();
    const prior = scan.commands.findIndex(c => c.operation === "RELEASE" && c.kind === kind);
    if (prior >= 0) return freeze(scan.receipts[prior]);
    if (scan.pending || scan.state.reservations.some(r => r.status === "HELD")) stop("RECONCILE_REQUIRED");
    const command: StoreCommand = { operation: "RELEASE", kind, binding: scan.state.binding,
      expectedVersion: scan.state.version, transactionId: `dev2-store-tx-release-${kind.toLowerCase()}` };
    return this.transact(command, scan.state.binding);
  }
}
