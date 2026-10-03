import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "../../task-contract/contract.js";
import { hashRecord, materializationSchema, parseBinding, reviewReceiptSchema } from "./contract.js";
import { assertCandidateAttempt, assertCanonicalBaseline, inspectCandidateRepository } from "./candidate-repo.js";
import { assertCanonicalFixture, type CanonicalFixture } from "./canonical-fixture.js";
import { assertIdleStore, commitStore, currentStore, inspectMutatedCandidate, safeComponents, scopeSnapshot,
  sha256, snapshotTree, type FixedBinding, type MutatedCandidate, type TreeSnapshot } from "./candidate-mutation.js";
import { readBoundArtifact, reviewBase } from "./review-context.js";
import { parseFindings, verificationSchema } from "./review-evidence.js";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function reviewArtifacts(mutation: MutatedCandidate, b: FixedBinding) {
  const { store } = inspectMutatedCandidate(mutation);
  const s = currentStore(store).state;
  if (!b.review || b.review.result !== "PASS" || s.committedReview !== b.review.digest) throw new Error("ADVISORY_PASS_REQUIRED");
  const base = reviewBase(b);
  const findings = parseFindings(readBoundArtifact(store, b.review.findingsDigest, base).toString("utf8"), b);
  if (findings.result !== "PASS") throw new Error("ADVISORY_PASS_REQUIRED");
  readBoundArtifact(store, findings.reviewContextDigest, base);
  const recordBinding = { ...base, review: b.review };
  if (readBoundArtifact(store, sha256(canonicalJson(b.review)), recordBinding).toString("utf8") !== canonicalJson(b.review))
    throw new Error("REVIEW_RECORD_MISMATCH");
  return findings;
}
function candidateCurrent(mutation: MutatedCandidate, b: FixedBinding) {
  const data = inspectMutatedCandidate(mutation);
  assertCandidateAttempt(data.candidate, b, b);
  inspectCandidateRepository(data.candidate);
  if (!same(data.binding.manifest, b.manifest) || !same(snapshotTree(data.candidate.root), data.candidateTree))
    throw new Error("CANDIDATE_IDENTITY_OR_DRIFT");
  return data;
}
function checkScope(b: FixedBinding, tree: TreeSnapshot, side: "before" | "after") {
  if (!b.manifest || !same(scopeSnapshot(b.delegation.scope, tree), b.manifest.files.map(row => ({ path: row.path, value: row[side] }))))
    throw new Error("CANONICAL_SCOPE_DRIFT");
}
function onlyTargets(before: TreeSnapshot, after: TreeSnapshot, b: FixedBinding) {
  const changed = b.manifest!.files.filter(r => r.operation !== "UNCHANGED");
  const targets = new Set(changed.map(r => r.path));
  const parents = new Set(changed.flatMap(r => r.path.split("/").slice(0, -1).map((_, i) => r.path.split("/").slice(0, i + 1).join("/"))));
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (targets.has(name)) continue;
    if (!Object.hasOwn(before, name) && parents.has(name) && after[name]?.kind === "DIRECTORY") continue;
    if (!same(before[name] ?? null, after[name] ?? null)) throw new Error("UNEXPECTED_CANONICAL_MUTATION");
  }
}
function move(mutation: MutatedCandidate, b: FixedBinding, to: string, unknown = false) {
  return commitStore(inspectMutatedCandidate(mutation).store, b, { operation: "ADVANCE", to,
    candidateOutcome: "CONFIRMED", canonicalOutcome: unknown ? "UNKNOWN" : "CONFIRMED" });
}
function reconcile(mutation: MutatedCandidate): never {
  const { store } = inspectMutatedCandidate(mutation);
  try { move(mutation, currentStore(store).state.binding, "RECONCILE_REQUIRED", true); } catch { /* consumed identity / held reservation fences recovery */ }
  throw new Error("DL2_F_RECONCILE_REQUIRED");
}

/** No real canonical entrypoint. Exclusive host custody of fixture, candidate,
 * store and ancestors is required throughout, as in E0. Not an OS locking API. */
export function materializeCanonicalFixture(fixture: CanonicalFixture, mutation: MutatedCandidate) {
  const { store } = inspectMutatedCandidate(mutation);
  let b = currentStore(store).state.binding;
  assertIdleStore(store, b, b, "MATERIALIZATION_ELIGIBLE");
  const data = candidateCurrent(mutation, b);
  assertCanonicalFixture(fixture, data.candidate);
  reviewArtifacts(mutation, b);
  assertCanonicalBaseline(data.candidate);
  for (const name of b.delegation.scope) safeComponents(fixture.root, name);
  const before = snapshotTree(fixture.root, false);
  checkScope(b, before, "before");
  const replacements = b.manifest!.files.filter(r => r.operation !== "UNCHANGED").map(row => {
    const bytes = fs.readFileSync(safeComponents(data.candidate.root, row.path));
    if (sha256(bytes) !== row.after.sha256 || bytes.length !== row.after.byteLength) throw new Error("CANDIDATE_POST_STATE");
    return { ...row, bytes, target: safeComponents(fixture.root, row.path) };
  });
  const record = materializationSchema.parse({ domain: "RC02_DEVELOPMENT_V2_MATERIALIZATION", id: b.attempt.materializationId,
    attemptDigest: b.attempt.digest, manifestDigest: b.manifest!.digest, advisoryReviewDigest: b.review!.digest, digest: "0".repeat(64) });
  b = parseBinding({ ...b, materialization: { ...record, digest: hashRecord(record) } });
  commitStore(store, b, { operation: "RESERVE", kind: "CANONICAL" });
  try {
    commitStore(store, b, { operation: "CONSUME_MATERIALIZATION" });
    // No canonical writes before both durable transactions. Recheck immediately.
    const consumed = currentStore(store).state;
    if (consumed.state !== "CANONICAL_MUTATION_IN_PROGRESS" || consumed.consumedMaterialization !== b.materialization!.id)
      throw new Error("CONSUMPTION_REQUIRED");
    candidateCurrent(mutation, b); assertCanonicalFixture(fixture, data.candidate); assertCanonicalBaseline(data.candidate);
    for (const name of b.delegation.scope) safeComponents(fixture.root, name);
    if (!same(snapshotTree(fixture.root, false), before)) throw new Error("PRE_WRITE_DRIFT");
    for (const row of replacements) {
      safeComponents(fixture.root, row.path);
      let parent = fixture.root;
      for (const part of row.path.split("/").slice(0, -1)) {
        parent = path.join(parent, part);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
      }
      const prior = before[row.path];
      const fd = fs.openSync(row.target, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0) |
        (prior ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL), 0o600);
      try {
        const s = fs.fstatSync(fd);
        safeComponents(fixture.root, row.path);
        if (!s.isFile() || s.nlink !== 1 || prior && prior.identity !== `${s.dev}:${s.ino}:${s.mode}:${s.nlink}`)
          throw new Error("WRITE_IDENTITY_CHANGED");
        fs.ftruncateSync(fd, 0);
        let offset = 0;
        while (offset < row.bytes.length) {
          const n = fs.writeSync(fd, row.bytes, offset, row.bytes.length - offset, offset);
          if (n <= 0) throw new Error("SHORT_WRITE");
          offset += n;
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      // Flush new directory entries on platforms with supported directory fsync.
      // On Windows the fixture proof is observed file-flush + exact reread only;
      // production directory durability remains a live activation gate.
      if (process.platform !== "win32") {
        for (let dir = path.dirname(row.target); ; dir = path.dirname(dir)) {
          const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          if (dir === fixture.root) break;
        }
      }
    }
    candidateCurrent(mutation, b); assertCanonicalBaseline(data.candidate);
    const after = snapshotTree(fixture.root, false);
    checkScope(b, after, "after"); onlyTargets(before, after, b);
    move(mutation, b, "CANONICAL_MUTATION_CONFIRMED");
    const handle = Object.freeze({ kind: "FIXTURE_MATERIALIZATION_CONFIRMED_ONLY" as const });
    confirmed.set(handle, { fixture, mutation, tree: after, binding: b });
    return handle;
  } catch { return reconcile(mutation); }
}

export interface ConfirmedMaterialization { readonly kind: "FIXTURE_MATERIALIZATION_CONFIRMED_ONLY" }
const confirmed = new WeakMap<ConfirmedMaterialization, { fixture: CanonicalFixture; mutation: MutatedCandidate; tree: TreeSnapshot; binding: FixedBinding }>();

/** REVIEW verifies exact materialized content, not human approval. */
export function verifyMaterializedReview(handle: ConfirmedMaterialization) {
  const proof = confirmed.get(handle);
  if (!proof) throw new Error("UNRECOGNIZED_MATERIALIZATION");
  const { mutation, fixture } = proof, { store } = inspectMutatedCandidate(mutation);
  let b = currentStore(store).state.binding;
  if (currentStore(store).state.state !== "CANONICAL_MUTATION_CONFIRMED" || !same(b, proof.binding)) throw new Error("REVIEW_VERIFY_ENTRY");
  commitStore(store, b, { operation: "RESERVE", kind: "REVIEW_VERIFY" });
  try {
    const data = candidateCurrent(mutation, b);
    assertCanonicalFixture(fixture, data.candidate); assertCanonicalBaseline(data.candidate);
    const findings = reviewArtifacts(mutation, b);
    const tree = snapshotTree(fixture.root, false);
    if (!same(tree, proof.tree)) throw new Error("STALE_REVIEW");
    checkScope(b, tree, "after");
    const canonicalScope = scopeSnapshot(b.delegation.scope, tree), candidateScope = scopeSnapshot(b.delegation.scope, data.candidateTree);
    if (!same(canonicalScope, candidateScope)) throw new Error("REVIEW_CONTENT_MISMATCH");
    const evidence = verificationSchema.parse({ domain: "RC02_DEVELOPMENT_V2_REVIEW_VERIFICATION_V1", attemptDigest: b.attempt.digest,
      manifestDigest: b.manifest!.digest, advisoryReviewDigest: b.review!.digest, materializationDigest: b.materialization!.digest,
      findingsDigest: b.review!.findingsDigest, reviewContextDigest: findings.reviewContextDigest,
      canonicalScopeDigest: sha256(canonicalJson(canonicalScope)), candidateScopeDigest: sha256(canonicalJson(candidateScope)),
      baselineHead: b.delegation.baselineHead, requestedProfile: "REVIEW", effectiveProfile: "REVIEW", result: "PASS" });
    const bytes = Buffer.from(canonicalJson(evidence));
    commitStore(store, b, { operation: "ARTIFACT", artifactId: `dev2-artifact-verify-${b.attempt.digest}`, contentBase64: bytes.toString("base64") });
    readBoundArtifact(store, sha256(bytes), b);
    const record = reviewReceiptSchema.parse({ domain: "RC02_DEVELOPMENT_V2_REVIEW_RECEIPT", id: b.attempt.reviewReceiptId,
      attemptDigest: b.attempt.digest, manifestDigest: b.manifest!.digest, materializationDigest: b.materialization!.digest,
      requestedProfile: "REVIEW", effectiveProfile: "REVIEW", result: "PASS", evidenceDigest: sha256(bytes), digest: "0".repeat(64) });
    b = parseBinding({ ...b, reviewReceipt: { ...record, digest: hashRecord(record) } });
    candidateCurrent(mutation, b); assertCanonicalBaseline(data.candidate);
    if (!same(snapshotTree(fixture.root, false), proof.tree)) throw new Error("VERIFY_RACE");
    move(mutation, b, "REVIEW_VERIFIED");
    return Object.freeze({ state: "REVIEW_VERIFIED" as const, receipt: b.reviewReceipt! });
  } catch { return reconcile(mutation); }
}

export function reachHumanCommitCheckpoint(handle: ConfirmedMaterialization) {
  const proof = confirmed.get(handle);
  if (!proof) throw new Error("UNRECOGNIZED_MATERIALIZATION");
  const { mutation, fixture } = proof, { store } = inspectMutatedCandidate(mutation), b = currentStore(store).state.binding;
  if (currentStore(store).state.state !== "REVIEW_VERIFIED") throw new Error("HUMAN_CHECKPOINT_ENTRY");
  try {
    const data = candidateCurrent(mutation, b);
    assertCanonicalFixture(fixture, data.candidate); assertCanonicalBaseline(data.candidate); reviewArtifacts(mutation, b);
    if (!same(snapshotTree(fixture.root, false), proof.tree)) throw new Error("CHECKPOINT_DRIFT");
    move(mutation, b, "HUMAN_COMMIT_CHECKPOINT");
    return Object.freeze({ state: "HUMAN_COMMIT_CHECKPOINT" as const, kind: "LOCAL_LIFECYCLE_ONLY" as const });
  } catch { return reconcile(mutation); }
}
