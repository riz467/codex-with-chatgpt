import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/task-contract/contract.js";
import { hashRecord, type DevelopmentBinding } from "../src/execution-orchestrator/development/contract.js";
import { assertDevelopmentStoreInstance, DevelopmentStore, type StoreCommand } from "../src/execution-orchestrator/development/store.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const h = "a".repeat(64);
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const seal = <T extends { digest: string }>(value: T): T => ({ ...value, digest: hashRecord(value) });
const findings = (b: Pick<DevelopmentBinding, "attempt" | "manifest" | "fast">, result: "PASS" | "NEEDS_WORK") => canonicalJson({
  domain: "RC02_DEVELOPMENT_V2_ADVISORY_FINDINGS_V1", attemptDigest: b.attempt.digest,
  manifestDigest: b.manifest!.digest, fastDigest: b.fast!.digest, reviewContextDigest: h, result, findings: [] });
const verification = (b: Pick<DevelopmentBinding, "attempt" | "delegation" | "manifest" | "review" | "materialization">) => canonicalJson({
  domain: "RC02_DEVELOPMENT_V2_REVIEW_VERIFICATION_V1", attemptDigest: b.attempt.digest, manifestDigest: b.manifest!.digest,
  advisoryReviewDigest: b.review!.digest, materializationDigest: b.materialization!.digest, findingsDigest: b.review!.findingsDigest,
  reviewContextDigest: h, baselineHead: b.delegation.baselineHead, canonicalScopeDigest: h, candidateScopeDigest: h,
  requestedProfile: "REVIEW", effectiveProfile: "REVIEW", result: "PASS" });
function binding(result: "PASS" | "NEEDS_WORK" = "PASS"): DevelopmentBinding {
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION" as const, id: "dev2-delegation-human",
    policyId: "dev2-policy-fixed", policyDigest: h, repositoryId: "dev2-repository-canonical",
    baselineHead: "b".repeat(40), scope: ["src/example.ts"], maxAttempts: 2, digest: h });
  const request = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST" as const, id: "dev2-request-one",
    delegationDigest: delegation.digest, goalDigest: h, acceptanceCriteriaDigest: h, digest: h });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT" as const, id: "dev2-attempt-one",
    requestDigest: request.digest, sequence: 1, candidateGeneration: 1, predecessor: null,
    candidateId: "dev2-candidate-one", sessionId: "dev2-session-one", executionId: "dev2-execution-one",
    manifestId: "dev2-manifest-one", fastId: "dev2-fast-one", advisoryReviewId: "dev2-review-one",
    materializationId: "dev2-materialization-one", reviewReceiptId: "dev2-receipt-one", inputSnapshotDigest: h, digest: h });
  const manifest = seal({ domain: "RC02_DEVELOPMENT_V2_MANIFEST" as const, id: attempt.manifestId,
    attemptDigest: attempt.digest, proposalDigest: h, digest: h,
    files: [{ path: "src/example.ts", operation: "CREATED" as const, before: { state: "MISSING" as const },
      after: { state: "FILE" as const, byteLength: 1, sha256: h } }] });
  const fast = seal({ domain: "RC02_DEVELOPMENT_V2_FAST" as const, id: attempt.fastId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, requestedProfile: "FAST" as const,
    effectiveProfile: "FAST" as const, result: "PASS" as const, evidenceDigest: h, digest: h });
  const review = seal({ domain: "RC02_DEVELOPMENT_V2_ADVISORY_REVIEW" as const, id: attempt.advisoryReviewId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, fastDigest: fast.digest,
    result, findingsDigest: sha(findings({ attempt, manifest, fast }, result)), digest: h });
  const materialization = seal({ domain: "RC02_DEVELOPMENT_V2_MATERIALIZATION" as const, id: attempt.materializationId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, advisoryReviewDigest: review.digest, digest: h });
  const reviewReceipt = seal({ domain: "RC02_DEVELOPMENT_V2_REVIEW_RECEIPT" as const, id: attempt.reviewReceiptId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, materializationDigest: materialization.digest,
    requestedProfile: "REVIEW" as const, effectiveProfile: "REVIEW" as const, result: "PASS" as const,
    evidenceDigest: sha(verification({ attempt, delegation, manifest, review, materialization })), digest: h });
  return result === "PASS" ? { delegation, request, attempt, manifest, fast, review, materialization, reviewReceipt }
    : { delegation, request, attempt, manifest, fast, review };
}
const bare = (b: DevelopmentBinding) => ({ delegation: b.delegation, request: b.request, attempt: b.attempt });
function fixture(result: "PASS" | "NEEDS_WORK" = "PASS") {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dl2-store-"))); roots.push(root);
  const full = binding(result), initial = bare(full);
  const create: StoreCommand = { operation: "CREATE", transactionId: "dev2-store-tx-create", expectedVersion: 0, binding: initial };
  const { store, receipt } = DevelopmentStore.create(root, create, initial);
  let serial = 0;
  const command = (fields: Record<string, unknown>, b: DevelopmentBinding = store.recover().state.binding as DevelopmentBinding) =>
    ({ transactionId: `dev2-store-tx-${++serial}`, expectedVersion: store.recover().state.version, binding: b, ...fields });
  const send = (fields: Record<string, unknown>, b?: DevelopmentBinding) => {
    const c = command(fields, b); return store.transact(c, c.binding);
  };
  const advance = (to: string, b?: DevelopmentBinding, candidateOutcome = "NOT_STARTED", canonicalOutcome = "NOT_STARTED") =>
    send({ operation: "ADVANCE", to, candidateOutcome, canonicalOutcome }, b);
  const pendingReview = () => {
    advance("ATTEMPT_FIXED"); advance("CANDIDATE_PREPARING"); advance("CANDIDATE_READY");
    send({ operation: "RESERVE", kind: "DISPATCH" }); advance("WORKER_DISPATCH_IN_PROGRESS"); advance("PROPOSAL_FIXED");
    send({ operation: "RESERVE", kind: "CANDIDATE" });
    advance("CANDIDATE_MUTATION_CONFIRMED", { ...initial, manifest: full.manifest! }, "CONFIRMED");
    send({ operation: "RESERVE", kind: "FAST" });
    advance("FAST_EVIDENCE_FIXED", { ...initial, manifest: full.manifest!, fast: full.fast! }, "CONFIRMED");
    advance("REVIEW_PENDING", undefined, "CONFIRMED");
    send({ operation: "ARTIFACT", artifactId: "dev2-artifact-findings", contentBase64: Buffer.from(findings(full, result)).toString("base64") });
  };
  const reviewed = () => {
    pendingReview();
    const b = { ...initial, manifest: full.manifest!, fast: full.fast!, review: full.review! };
    send({ operation: "REVIEW_ARTIFACT" }, b); send({ operation: "COMMIT_REVIEW" }, b);
  };
  const materializationReserved = () => {
    reviewed(); advance("MATERIALIZATION_ELIGIBLE", undefined, "CONFIRMED");
    const { reviewReceipt: _receipt, ...b } = full;
    send({ operation: "RESERVE", kind: "CANONICAL" }, b);
  };
  return { root, full, initial, store, receipt, create, command, send, advance, pendingReview, reviewed, materializationReserved,
    journal: path.join(root, "development-v2.journal"), anchor: store.anchorOf(receipt) };
}

describe("DL2-B committed storage, not authority", () => {
  it("brands only token-gated factory instances and guards borrowed public methods", () => {
    const f = fixture();
    expect(() => assertDevelopmentStoreInstance(f.store)).not.toThrow();
    expect(() => assertDevelopmentStoreInstance(DevelopmentStore.open(f.root, f.anchor))).not.toThrow();
    const copied = Object.create(DevelopmentStore.prototype, Object.getOwnPropertyDescriptors(f.store));
    const fakes = [Object.create(DevelopmentStore.prototype), copied, structuredClone(f.store),
      { recover: () => f.store.recover() }, Object.setPrototypeOf({}, DevelopmentStore.prototype),
      new Proxy(f.store, {}), null, undefined];
    for (const fake of fakes) {
      expect(() => assertDevelopmentStoreInstance(fake)).toThrow("UNRECOGNIZED_INSTANCE");
      expect(() => DevelopmentStore.prototype.recover.call(fake)).toThrow("UNRECOGNIZED_INSTANCE");
      expect(() => DevelopmentStore.prototype.transact.call(fake, {}, {})).toThrow("UNRECOGNIZED_INSTANCE");
      expect(() => DevelopmentStore.prototype.anchorOf.call(fake, f.receipt)).toThrow("UNRECOGNIZED_INSTANCE");
      expect(() => DevelopmentStore.prototype.completeRelease.call(fake, "FAST")).toThrow("UNRECOGNIZED_INSTANCE");
    }
    const Constructor = DevelopmentStore as unknown as new (...args: unknown[]) => DevelopmentStore;
    expect(() => new Constructor(undefined, f.root, f.anchor)).toThrow("FACTORY_REQUIRED");
    expect(() => new Constructor(Symbol("DevelopmentStore factory only"), f.root, f.anchor)).toThrow("FACTORY_REQUIRED");
    expect(() => Reflect.construct(DevelopmentStore, [Symbol(), f.root, f.anchor])).toThrow("FACTORY_REQUIRED");
    expect(f.store.recover().state.version).toBe(0);
  });
  it("creates, reopens and reconstructs exactly; missing bootstrap never silently recreates", () => {
    const f = fixture(), reopened = DevelopmentStore.open(f.root, f.anchor);
    expect(reopened.recover()).toEqual(f.store.recover());
    expect(reopened.recover().state).toMatchObject({ version: 0, state: "REQUEST_FIXED", committedReview: null });
    expect(f.receipt.kind).toBe("COMMITTED_STORAGE_ONLY");
    expect(() => DevelopmentStore.create(f.root, f.create, f.initial)).toThrow();
    fs.unlinkSync(f.journal);
    expect(() => DevelopmentStore.open(f.root, f.anchor)).toThrow();
    expect(fs.existsSync(f.journal)).toBe(false);
  });
  it("enforces expected-version CAS between independently opened writers", () => {
    const f = fixture(), second = DevelopmentStore.open(f.root, f.anchor);
    const c = f.command({ operation: "ADVANCE", to: "ATTEMPT_FIXED", candidateOutcome: "NOT_STARTED", canonicalOutcome: "NOT_STARTED" });
    const r = f.store.transact(c, c.binding);
    expect(r.version).toBe(1);
    expect(() => second.transact({ ...c, transactionId: "dev2-store-tx-stale" }, c.binding)).toThrow("STALE_VERSION");
    expect(second.transact(c, c.binding)).toEqual(r);
    expect(() => second.transact({ ...c, to: "CANDIDATE_PREPARING" }, c.binding)).toThrow("TRANSACTION_CONFLICT");
    expect(f.advance("CANDIDATE_PREPARING").version).toBe(2);
  });
  it("retains explicit host-bound predecessor/generation identity without creating attempts during recovery", () => {
    const f = fixture(), next = { ...f.initial, attempt: seal({ ...f.initial.attempt,
      id: "dev2-attempt-two", sequence: 2, candidateGeneration: 2,
      predecessor: { id: f.initial.attempt.id, digest: f.initial.attempt.digest },
      candidateId: "dev2-candidate-two", sessionId: "dev2-session-two", executionId: "dev2-execution-two",
      manifestId: "dev2-manifest-two", fastId: "dev2-fast-two", advisoryReviewId: "dev2-review-two",
      materializationId: "dev2-materialization-two", reviewReceiptId: "dev2-receipt-two" }) };
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dl2-successor-"))); roots.push(root);
    const created = DevelopmentStore.create(root, { ...f.create, binding: next }, next);
    const before = fs.readFileSync(path.join(root, "development-v2.journal"));
    const recovered = DevelopmentStore.open(root, created.store.anchorOf(created.receipt)).recover();
    expect(recovered.state.binding.attempt).toEqual(next.attempt);
    expect(recovered.receipts[0].candidateGeneration).toBe(2);
    expect(fs.readFileSync(path.join(root, "development-v2.journal"))).toEqual(before);
  });
  it("stores content-addressed immutable bytes; exact duplicates do not advance version", () => {
    const f = fixture(), c = f.command({ operation: "ARTIFACT", artifactId: "dev2-artifact-one", contentBase64: Buffer.from("bytes\0").toString("base64") });
    const r = f.store.transact(c, c.binding), before = fs.readFileSync(f.journal);
    expect(f.store.transact({ ...c, transactionId: "dev2-store-tx-duplicate", expectedVersion: 999 }, c.binding)).toEqual(r);
    expect(fs.readFileSync(f.journal)).toEqual(before);
    expect(f.store.recover().state.blobs[sha("bytes\0")]).toBe(c.contentBase64);
    expect(() => f.store.transact({ ...c, transactionId: "dev2-store-tx-conflict", contentBase64: "eA==" }, c.binding)).toThrow("IMMUTABLE_CONFLICT");
    expect(() => f.send({ operation: "ARTIFACT", artifactId: "dev2-artifact-two", contentBase64: "invalid=" })).toThrow("INVALID_BLOB");
  });
  it.each(["PASS", "NEEDS_WORK"] as const)("orphan %s review artifact has no committed verdict", result => {
    const f = fixture(result); f.pendingReview();
    const b = { ...f.initial, manifest: f.full.manifest!, fast: f.full.fast!, review: f.full.review! };
    f.send({ operation: "REVIEW_ARTIFACT" }, b);
    const opened = DevelopmentStore.open(f.root, f.store.recover().anchor), state = opened.recover().state;
    expect(state.state).toBe("REVIEW_PENDING");
    expect(state.binding.review).toBeUndefined(); expect(state.committedReview).toBeNull();
    expect(state.artifacts.map(a => a.id)).toContain(b.review.id);
    const c = f.command({ operation: "COMMIT_REVIEW" }, b), r = opened.transact(c, b);
    expect(opened.recover().state.state).toBe(result === "PASS" ? "PASS_RECORDED" : "ATTEMPT_REJECTED");
    expect(DevelopmentStore.open(f.root, opened.anchorOf(r)).transact(c, b)).toEqual(r);
    expect(opened.transact({ ...c, transactionId: "dev2-store-tx-review-duplicate" }, b)).toEqual(r);
    const changed = { ...b, review: seal({ ...b.review, findingsDigest: "f".repeat(64) }) };
    expect(() => opened.transact({ ...c, transactionId: "dev2-store-tx-review-conflict", binding: changed }, changed)).toThrow("IMMUTABLE_CONFLICT");
  });
  it("rejects review without artifact, future evidence promotion and cross-attempt data", () => {
    const f = fixture(); f.pendingReview();
    const b = { ...f.initial, manifest: f.full.manifest!, fast: f.full.fast!, review: f.full.review! };
    expect(() => f.send({ operation: "COMMIT_REVIEW" }, b)).toThrow("REVIEW_ARTIFACT");
    expect(() => f.advance("PASS_RECORDED", b, "CONFIRMED")).toThrow();
    const fresh = fixture();
    expect(() => fresh.advance("ATTEMPT_FIXED", fresh.full)).toThrow("FUTURE_EVIDENCE");
    expect(() => fresh.send({ operation: "ARTIFACT", artifactId: "dev2-artifact-one", contentBase64: "" },
      { ...fresh.initial, attempt: seal({ ...fresh.initial.attempt, sessionId: "dev2-session-other" }) })).toThrow("BINDING_REPLACED");
  });
  it("commits materialization consumption once, and returns only the original receipt for exact duplicates", () => {
    const f = fixture(); f.materializationReserved();
    const c = f.command({ operation: "CONSUME_MATERIALIZATION" }), r = f.store.transact(c, c.binding);
    expect(r.operation).toBe("CONSUME_MATERIALIZATION"); expect(r.kind).toBe("COMMITTED_STORAGE_ONLY");
    expect(f.store.recover().state).toMatchObject({ state: "CANONICAL_MUTATION_IN_PROGRESS", consumedMaterialization: f.full.attempt.materializationId });
    const opened = DevelopmentStore.open(f.root, f.store.anchorOf(r));
    expect(opened.recover().disposition).toBe("RECONCILE_REQUIRED");
    expect(opened.transact(c, c.binding)).toEqual(r);
    expect(opened.transact({ ...c, transactionId: "dev2-store-tx-consume-duplicate" }, c.binding)).toEqual(r);
    expect(() => opened.transact({ ...c, operation: "ADVANCE", to: "CANONICAL_MUTATION_CONFIRMED",
      candidateOutcome: "CONFIRMED", canonicalOutcome: "CONFIRMED", transactionId: "dev2-store-tx-replay" }, c.binding)).toThrow("RECONCILE_REQUIRED");
    expect(() => f.send({ operation: "RESERVE", kind: "CANONICAL" })).toThrow("RESERVATION_REPLAY");
  });
  it("never infers consumed status from a future materialization artifact", () => {
    const f = fixture(); f.materializationReserved();
    expect(f.store.recover().state.consumedMaterialization).toBeNull();
    expect(() => f.advance("CANONICAL_MUTATION_IN_PROGRESS", undefined, "CONFIRMED")).toThrow("SPECIAL_TRANSACTION");
  });
  it.each(["DISPATCH", "CANDIDATE", "FAST", "CANONICAL"] as const)("recovery fences held %s reservations without replay", kind => {
    const f = fixture();
    if (kind === "CANONICAL") f.materializationReserved();
    else {
      f.advance("ATTEMPT_FIXED"); f.advance("CANDIDATE_PREPARING"); f.advance("CANDIDATE_READY");
      f.send({ operation: "RESERVE", kind: "DISPATCH" });
      if (kind !== "DISPATCH") {
        f.advance("WORKER_DISPATCH_IN_PROGRESS"); f.advance("PROPOSAL_FIXED");
        f.send({ operation: "RESERVE", kind: "CANDIDATE" });
        if (kind === "FAST") {
          f.advance("CANDIDATE_MUTATION_CONFIRMED", { ...f.initial, manifest: f.full.manifest! }, "CONFIRMED");
          f.send({ operation: "RESERVE", kind: "FAST" });
        }
      }
    }
    const before = fs.readFileSync(f.journal), reopened = DevelopmentStore.open(f.root, f.store.recover().anchor);
    expect(reopened.recover().disposition).toBe("RECONCILE_REQUIRED");
    expect(reopened.recover()).toEqual(reopened.recover());
    expect(fs.readFileSync(f.journal)).toEqual(before);
    expect(() => reopened.transact(f.command({ operation: "ARTIFACT", artifactId: "dev2-artifact-retry", contentBase64: "" }),
      f.store.recover().state.binding)).toThrow("RECONCILE_REQUIRED");
  });
  it("recovers committed terminal state and completes only pending release bookkeeping idempotently", () => {
    const f = fixture("NEEDS_WORK"); f.reviewed();
    const recovered = DevelopmentStore.open(f.root, f.store.recover().anchor);
    expect(recovered.recover().state.state).toBe("ATTEMPT_REJECTED");
    expect(recovered.recover().releasedReservations).toEqual(["DISPATCH", "CANDIDATE", "FAST"]);
    const result = recovered.completeRelease("FAST"), bytes = fs.readFileSync(f.journal);
    expect(recovered.completeRelease("FAST")).toEqual(result);
    expect(fs.readFileSync(f.journal)).toEqual(bytes);
    expect(recovered.recover().state.state).toBe("ATTEMPT_REJECTED");
    expect(recovered.recover().state.binding.review?.result).toBe("NEEDS_WORK");
    expect(() => recovered.completeRelease("CANONICAL")).toThrow("NOT_RELEASABLE");
  });
  it("canonical unknown outcome remains fenced with reservation retained", () => {
    const f = fixture(); f.materializationReserved(); f.send({ operation: "CONSUME_MATERIALIZATION" });
    f.advance("RECONCILE_REQUIRED", undefined, "UNKNOWN", "UNKNOWN");
    const reopened = DevelopmentStore.open(f.root, f.store.recover().anchor);
    expect(reopened.recover().state.state).toBe("RECONCILE_REQUIRED");
    expect(reopened.recover().state.reservations.find(r => r.kind === "CANONICAL")?.status).toBe("HELD");
    expect(() => reopened.completeRelease("CANONICAL")).toThrow("RECONCILE_REQUIRED");
  });
  it("reaches REVIEW evidence and human checkpoint only through committed bound records", () => {
    const f = fixture(); f.materializationReserved(); f.send({ operation: "CONSUME_MATERIALIZATION" });
    f.advance("CANONICAL_MUTATION_CONFIRMED", undefined, "CONFIRMED", "CONFIRMED");
    f.send({ operation: "RESERVE", kind: "REVIEW_VERIFY" });
    expect(() => f.advance("REVIEW_VERIFIED", f.full, "CONFIRMED", "CONFIRMED")).toThrow("VERIFY_ARTIFACT_REQUIRED");
    f.send({ operation: "ARTIFACT", artifactId: "dev2-artifact-verify", contentBase64: Buffer.from(verification(f.full)).toString("base64") });
    f.advance("REVIEW_VERIFIED", f.full, "CONFIRMED", "CONFIRMED");
    f.advance("HUMAN_COMMIT_CHECKPOINT", undefined, "CONFIRMED", "CONFIRMED");
    const reopened = DevelopmentStore.open(f.root, f.store.recover().anchor);
    expect(reopened.recover().disposition).toBe("RECORDED_ONLY");
    expect(reopened.completeRelease("CANONICAL").kind).toBe("COMMITTED_STORAGE_ONLY");
    expect(reopened.recover().state.consumedMaterialization).toBe(f.full.attempt.materializationId);
  });
  it.each(["authorized", "approved", "path", "command", "executable", "argv", "cwd", "provider", "model", "verificationProfile"])
    ("rejects injected %s", key => {
      const f = fixture(), before = fs.readFileSync(f.journal);
      expect(() => f.store.transact({ ...f.create, [key]: true }, f.initial)).toThrow();
      expect(fs.readFileSync(f.journal)).toEqual(before);
    });
  it.each(["../escape", "dev2-artifact-../escape", "dev2-artifact-A", "C:/escape"])("rejects artifact path/alias %s", artifactId => {
    const f = fixture(); expect(() => f.send({ operation: "ARTIFACT", artifactId, contentBase64: "" })).toThrow();
  });
  it("rejects getters without evaluating them and independently mismatched host binding", () => {
    const f = fixture(); let reads = 0;
    expect(() => f.store.transact({ ...f.create, get binding() { reads++; return f.initial; } }, f.initial)).toThrow();
    expect(reads).toBe(0);
    expect(() => f.store.transact(f.create, binding())).toThrow("Host binding");
  });
  it("does not steal a stale lock, while committed receipts remain recoverable", () => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, "development-v2.writer"), "old owner");
    const reopened = DevelopmentStore.open(f.root, f.anchor);
    expect(reopened.recover().writerFenced).toBe(true);
    expect(reopened.transact(f.create, f.initial)).toEqual(f.receipt);
    expect(() => reopened.transact(f.command({ operation: "ARTIFACT", artifactId: "dev2-artifact-one", contentBase64: "" }), f.initial)).toThrow();
    expect(fs.readFileSync(path.join(f.root, "development-v2.writer"), "utf8")).toBe("old owner");
  });
  it("rejects a linked journal instead of modifying another file", () => {
    const f = fixture(), outside = path.join(f.root, "outside"); fs.renameSync(f.journal, outside); fs.linkSync(outside, f.journal);
    expect(() => DevelopmentStore.open(f.root, f.anchor)).toThrow("UNSAFE_FILE");
  });
});

describe("DL2-B crash and corruption windows using real journal I/O", () => {
  it("flushes PREPARE before COMMIT and COMMIT before returning the reservation receipt", () => {
    const f = fixture(); f.advance("ATTEMPT_FIXED"); f.advance("CANDIDATE_PREPARING"); f.advance("CANDIDATE_READY");
    const c = f.command({ operation: "RESERVE", kind: "DISPATCH" });
    const events: string[] = [], write = fs.writeSync.bind(fs), flush = fs.fsyncSync;
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) => {
      events.push(JSON.parse(JSON.parse(buffer.toString()).body).type);
      return write(fd, buffer, offset, length);
    }) as typeof fs.writeSync);
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { flush(fd); events.push("FLUSH"); });
    const receipt = f.store.transact(c, c.binding); events.push("RETURNED"); vi.restoreAllMocks();
    expect(events.slice(events.indexOf("PREPARE"))).toEqual(["PREPARE", "FLUSH", "COMMIT", "FLUSH", "RETURNED"]);
    expect(receipt.operation).toBe("RESERVE");
  });
  it.each(["PREPARE", "COMMIT"])("partial %s write is never repaired or mistaken for a commit", target => {
    const f = fixture(), c = f.command({ operation: "ARTIFACT", artifactId: "dev2-artifact-torn", contentBase64: "eA==" });
    const write = fs.writeSync.bind(fs);
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) => {
      if (JSON.parse(JSON.parse(buffer.toString()).body).type === target) {
        write(fd, buffer, offset, Math.floor(length / 2)); throw new Error("torn write");
      }
      return write(fd, buffer, offset, length);
    }) as typeof fs.writeSync);
    expect(() => f.store.transact(c, c.binding)).toThrow("torn write"); vi.restoreAllMocks();
    const before = fs.readFileSync(f.journal);
    expect(() => DevelopmentStore.open(f.root, f.anchor)).toThrow("TRUNCATED_JOURNAL");
    expect(fs.readFileSync(f.journal)).toEqual(before);
  });
  it.each(["PREPARE", "COMMIT"])("consumption interruption after %s preserves the exact consumption boundary", target => {
    const f = fixture(); f.materializationReserved();
    const c = f.command({ operation: "CONSUME_MATERIALIZATION" }), anchor = f.store.recover().anchor;
    const write = fs.writeSync.bind(fs), flush = fs.fsyncSync; let last = "";
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) => {
      last = JSON.parse(JSON.parse(buffer.toString()).body).type;
      return write(fd, buffer, offset, length);
    }) as typeof fs.writeSync);
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { flush(fd); if (last === target) throw new Error("response lost"); });
    expect(() => f.store.transact(c, c.binding)).toThrow("response lost"); vi.restoreAllMocks();
    const reopened = DevelopmentStore.open(f.root, anchor), recovered = reopened.recover();
    expect(recovered.disposition).toBe("RECONCILE_REQUIRED");
    if (target === "PREPARE") {
      expect(recovered.state.consumedMaterialization).toBeNull();
      expect(() => reopened.transact(c, c.binding)).toThrow("RECONCILE_REQUIRED");
    } else {
      expect(recovered.state.consumedMaterialization).toBe(f.full.attempt.materializationId);
      expect(reopened.transact(c, c.binding)).toEqual(recovered.receipts.at(-1));
    }
  });
  it.each(["before-prepare", "after-prepare", "before-commit", "after-commit"])("survives abrupt process exit %s without choosing a verdict", point => {
    const f = fixture("NEEDS_WORK"); f.pendingReview();
    const b = { ...f.initial, manifest: f.full.manifest!, fast: f.full.fast!, review: f.full.review! };
    f.send({ operation: "REVIEW_ARTIFACT" }, b);
    const c = f.command({ operation: "COMMIT_REVIEW" }, b), anchor = f.store.recover().anchor;
    // The child executes only the store. Injection wraps real Node I/O; there is no production bypass.
    const script = `
      import fs from 'node:fs';
      import { DevelopmentStore } from './src/execution-orchestrator/development/store.ts';
      const input = JSON.parse(fs.readFileSync(0, 'utf8'));
      const store = DevelopmentStore.open(input.root, input.anchor);
      const write = fs.writeSync, flush = fs.fsyncSync; let last = '';
      fs.writeSync = function(fd, bytes, ...args) {
        const type = JSON.parse(JSON.parse(bytes.toString()).body).type;
        if ((input.point === 'before-prepare' && type === 'PREPARE') || (input.point === 'before-commit' && type === 'COMMIT')) process.exit(91);
        const n = write.call(fs, fd, bytes, ...args); last = type; return n;
      };
      fs.fsyncSync = function(fd) {
        flush(fd);
        if ((input.point === 'after-prepare' && last === 'PREPARE') || (input.point === 'after-commit' && last === 'COMMIT')) process.exit(91);
      };
      store.transact(input.command, input.command.binding);
      process.exit(92);
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."), input: JSON.stringify({ root: f.root, anchor, command: c, point }), encoding: "utf8", timeout: 30000,
    });
    expect(child.status, child.stderr).toBe(91);
    const reopened = DevelopmentStore.open(f.root, anchor), recovered = reopened.recover();
    const bytes = fs.readFileSync(f.journal);
    expect(recovered.writerFenced).toBe(true);
    if (point === "after-commit") {
      expect(recovered.state.state).toBe("ATTEMPT_REJECTED");
      expect(recovered.state.binding.review?.result).toBe("NEEDS_WORK");
      expect(reopened.transact(c, b)).toEqual(recovered.receipts.at(-1));
    } else {
      expect(recovered.state.state).toBe("REVIEW_PENDING"); expect(recovered.state.committedReview).toBeNull();
      expect(recovered.orphanTransaction).toBe(point !== "before-prepare");
    }
    expect(reopened.recover()).toEqual(recovered);
    expect(fs.readFileSync(f.journal)).toEqual(bytes);
  }, 30000);
  it("flush failure never returns success and fences the live writer", () => {
    const f = fixture(), c = f.command({ operation: "ARTIFACT", artifactId: "dev2-artifact-one", contentBase64: "" });
    const original = fs.fsyncSync; let n = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { if (++n === 3) throw new Error("flush failed"); original(fd); });
    expect(() => f.store.transact(c, c.binding)).toThrow("flush failed");
    vi.restoreAllMocks();
    expect(f.store.recover().state.version).toBe(0);
    expect(f.store.recover().orphanTransaction).toBe(true);
    expect(f.store.recover().disposition).toBe("RECONCILE_REQUIRED");
    expect(() => f.store.transact(c, c.binding)).toThrow("RECONCILE_REQUIRED");
  });
  it("handles short writes without dropping bytes", () => {
    const f = fixture(), write = fs.writeSync.bind(fs);
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) =>
      write(fd, buffer, offset, Math.min(length, 17))) as typeof fs.writeSync);
    f.send({ operation: "ARTIFACT", artifactId: "dev2-artifact-short", contentBase64: "eA==" });
    vi.restoreAllMocks();
    expect(DevelopmentStore.open(f.root, f.store.recover().anchor).recover().state.version).toBe(1);
  });
  it.each(["truncate", "digest", "version-gap", "receipt", "impossible-state", "immutable-conflict"])("fails closed on %s without silent repair", corruption => {
    const f = fixture(); f.send({ operation: "ARTIFACT", artifactId: "dev2-artifact-one", contentBase64: "eA==" });
    f.send({ operation: "ARTIFACT", artifactId: "dev2-artifact-two", contentBase64: "eQ==" });
    const lines = fs.readFileSync(f.journal, "utf8").trimEnd().split("\n");
    if (corruption === "truncate") fs.writeFileSync(f.journal, lines.join("\n").slice(0, -12));
    else {
      const i = corruption === "receipt" ? 3 : 4, envelope = JSON.parse(lines[i]), body = JSON.parse(envelope.body);
      if (corruption === "digest") envelope.sha256 = "0".repeat(64);
      else {
        if (corruption === "version-gap") body.command.expectedVersion = 99;
        if (corruption === "receipt") body.receipt.version = 99;
        if (corruption === "impossible-state") body.command = { ...body.command, operation: "ADVANCE", to: "DONE", candidateOutcome: "CONFIRMED", canonicalOutcome: "CONFIRMED" };
        if (corruption === "immutable-conflict") body.command.artifactId = "dev2-artifact-one";
        envelope.body = canonicalJson(body); envelope.sha256 = sha(envelope.body);
      }
      lines[i] = canonicalJson(envelope); fs.writeFileSync(f.journal, lines.join("\n") + "\n");
    }
    const before = fs.readFileSync(f.journal);
    expect(() => DevelopmentStore.open(f.root, f.anchor)).toThrow();
    expect(fs.readFileSync(f.journal)).toEqual(before);
  });
  it("detects lost committed tail using the independently retained receipt anchor", () => {
    const f = fixture(), before = fs.readFileSync(f.journal);
    const r = f.advance("ATTEMPT_FIXED"); fs.writeFileSync(f.journal, before);
    expect(() => DevelopmentStore.open(f.root, f.store.anchorOf(r))).toThrow("ANCHOR_MISSING");
  });
});
