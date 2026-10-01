import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvalSigningBytes } from "../src/human-approval/contract.js";
import { verifySignedApproval } from "../src/human-approval/verifier.js";
import { canonicalJson, typedActionApprovalSigningDomain } from "../src/typed-action-approval/contract.js";
import { verifyTypedActionApproval } from "../src/typed-action-approval/verifier.js";
import { executionPermitSigningBytes } from "../src/typed-action-finalizer/contract.js";
import { finalizeTypedAction, verifyExecutionPermit } from "../src/typed-action-finalizer/verifier.js";
import { hashReviewedEvidence, independentReviewSigningBytes, independentReviewSigningDomain,
  reviewBindingFields, type ReviewedEvidence, type TrustedReviewContext } from "../src/typed-action-review/contract.js";
import * as signerModule from "../src/typed-action-review/signer.js";
import { verifyIndependentReview } from "../src/typed-action-review/verifier.js";
import { fixture, hash, jti, now, time } from "./typed-action-fixtures.js";

function reviewFixture(result: "PASS" | "FAIL" | "NEEDS_WORK" = "PASS") {
  const key = generateKeyPairSync("ed25519"), keys = new Map([["ct702-test", key.publicKey]]);
  const input = { actionId: randomUUID(), actionKind: "RestartService" as const, targetId: randomUUID(),
    requestHash: hash(), attemptId: randomUUID(), attemptHash: hash(), attemptSequence: 1, reviewId: randomUUID() };
  const evidence: ReviewedEvidence = { schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_REVIEWED_EVIDENCE", ...input,
    reviewBundle: { sha256: hash() }, manifest: { sha256: hash() },
    integrity: { result: "VERIFIED", reportSha256: hash() }, review: { result, reportSha256: hash() } };
  const context: TrustedReviewContext = { ...input, expectedReviewEvidenceHash: hashReviewedEvidence(evidence),
    expectedBundleManifestSha256: evidence.manifest.sha256, expectedReviewerKeyId: "ct702-test", expectedResult: result,
    currentReviewId: input.reviewId, reviewIsCurrent: true, bundleIntegrityVerified: true };
  const host = { privateKey: key.privateKey, reviewerKeyId: "ct702-test", now: () => now,
    independentlyVerifyReview: () => ({ context, evidence }) };
  const kernel = signerModule.createIndependentReviewSigningKernel(host);
  const issued = kernel.reviewAndSign(input);
  if (issued.state !== "SIGNED") throw new Error("Invalid fixture");
  const envelope = structuredClone(issued.envelope);
  // Raw crypto is deliberately confined to adversarial tests, not the kernel API.
  const resign = (value: any) => ({ ...value, signature: sign(null, independentReviewSigningBytes(value), key.privateKey).toString("base64url") });
  const check = (value: unknown = envelope, ctx: unknown = context, clock = now) => verifyIndependentReview(value, ctx, keys, clock);
  return { input, evidence, context, host, key, keys, kernel, envelope, resign, check };
}
const changed = (field: string): unknown => field.endsWith("Id") ? randomUUID()
  : field === "actionKind" ? "AppUpgrade" : field === "attemptSequence" ? 2 : hash();

describe("CT702 signed independent review evidence core", () => {
  it.each(["PASS", "FAIL", "NEEDS_WORK"] as const)("authenticates %s evidence without granting authority", result => {
    const f = reviewFixture(result), verified = f.check();
    expect(verified).toEqual({ valid: true, jti: f.envelope.payload.jti, payload: f.envelope.payload });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(f.kernel)).toBe(true);
    expect(f.check()).toEqual(verified); // verification is non-consuming
    expect(verified).not.toHaveProperty("executionMayStart");
    const next = f.kernel.reviewAndSign(f.input);
    expect(next.state).toBe("SIGNED");
    if (next.state === "SIGNED") {
      expect(Object.isFrozen(next.envelope.payload)).toBe(true);
      expect(next.envelope.payload.jti).not.toBe(f.envelope.payload.jti);
    }
  });

  it.each([...reviewBindingFields, "reviewEvidenceHash", "bundleManifestSha256"])("rejects signed wrong %s", field => {
    const f = reviewFixture();
    const altered = f.resign({ ...f.envelope, payload: { ...f.envelope.payload, [field]: changed(field) } });
    expect(f.check(altered).valid).toBe(false);
    const contextField = field === "reviewEvidenceHash" ? "expectedReviewEvidenceHash"
      : field === "bundleManifestSha256" ? "expectedBundleManifestSha256" : field;
    expect(f.check(f.envelope, { ...f.context, [contextField]: changed(field) }).valid).toBe(false);
  });

  it.each([{ reviewIsCurrent: false }, { bundleIntegrityVerified: false }, { currentReviewId: randomUUID() },
    { expectedReviewerKeyId: "other" }, { expectedResult: "FAIL" }])("rejects stale/invalid host context %j", delta => {
    const f = reviewFixture();
    expect(f.check(f.envelope, { ...f.context, ...delta }).valid).toBe(false);
    Object.assign(f.context, delta);
    expect(f.kernel.reviewAndSign(f.input)).toEqual({ state: "REJECTED" });
  });

  it.each([
    ["expired", -100_000, 0], ["future-issued", 30_001, 60_000], ["excessive lifetime", 0, 300_001],
    ["zero lifetime", 1000, 1000], ["inverted lifetime", 2000, 1000],
  ])("rejects %s", (_name, issued, expires) => {
    const f = reviewFixture();
    expect(f.check(f.resign({ ...f.envelope, payload: { ...f.envelope.payload,
      issuedAt: time(Number(issued)), expiresAt: time(Number(expires)) } })).valid).toBe(false);
  });

  it("enforces exact skew/lifetime boundaries and valid host clocks", () => {
    const f = reviewFixture();
    const value = f.resign({ ...f.envelope, payload: { ...f.envelope.payload, issuedAt: time(30_000), expiresAt: time(330_000) } });
    expect(f.check(value).valid).toBe(true);
    for (const clock of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(f.check(f.envelope, f.context, clock).valid).toBe(false);
      expect(signerModule.createIndependentReviewSigningKernel({ ...f.host, now: () => clock }).reviewAndSign(f.input).state).toBe("REJECTED");
    }
  });

  it("rejects unknown, wrong, private and non-Ed25519 keys and forged signatures", () => {
    const f = reviewFixture(), rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const keys of [new Map(), new Map([["ct702-test", generateKeyPairSync("ed25519").publicKey]]),
      new Map([["ct702-test", f.key.privateKey]]), new Map([["ct702-test", rsa.publicKey]])]) {
      expect(verifyIndependentReview(f.envelope, f.context, keys, now).valid).toBe(false);
    }
    expect(f.check(f.resign({ ...f.envelope, reviewerKeyId: "unknown" })).valid).toBe(false);
    expect(f.check({ ...f.envelope, signature: Buffer.alloc(64, 1).toString("base64url") }).valid).toBe(false);
    for (const key of [rsa.privateKey, f.key.publicKey]) {
      expect(() => signerModule.createIndependentReviewSigningKernel({ ...f.host, privateKey: key })).toThrow();
    }
  });

  it("rejects unknown fields and hostile non-JSON without calling accessors", () => {
    const f = reviewFixture(); let accessed = false;
    const accessor = { ...f.envelope };
    Object.defineProperty(accessor, "payload", { enumerable: true, get: () => { accessed = true; return f.envelope.payload; } });
    const hidden = { ...f.envelope }; Object.defineProperty(hidden, "hidden", { value: true });
    for (const value of [null, [], "PASS", accessor, hidden, { ...f.envelope, [Symbol()]: true },
      Object.assign(Object.create({}), f.envelope), { ...f.envelope, extra: true },
      { ...f.envelope, payload: { ...f.envelope.payload, extra: true } },
      { ...f.envelope, payload: { ...f.envelope.payload, issuedAt: "2026-02-30T12:00:00.000Z" } },
      { ...f.envelope, payload: { ...f.envelope.payload, jti: "A".repeat(42) + "B" } },
      { ...f.envelope, signature: "A".repeat(85) + "B" }]) expect(f.check(value).valid).toBe(false);
    expect(accessed).toBe(false);
    expect(f.check(f.envelope, { ...f.context, extra: true }).valid).toBe(false);
  });

  it("canonicalizes recursive key ordering and commits to every reviewed source", () => {
    const f = reviewFixture();
    const reverse = (value: any): any => value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value;
    expect(independentReviewSigningBytes(reverse(f.envelope))).toEqual(independentReviewSigningBytes(f.envelope));
    expect(f.check(reverse(f.envelope)).valid).toBe(true);
    expect(hashReviewedEvidence(reverse(f.evidence))).toBe(f.envelope.payload.reviewEvidenceHash);
    for (const source of ["reviewBundle", "manifest", "integrity", "review"] as const) {
      const value = structuredClone(f.evidence);
      if (source === "reviewBundle" || source === "manifest") value[source].sha256 = hash();
      else value[source].reportSha256 = hash();
      expect(hashReviewedEvidence(value)).not.toBe(f.context.expectedReviewEvidenceHash);
      const kernel = signerModule.createIndependentReviewSigningKernel({ ...f.host,
        independentlyVerifyReview: () => ({ context: f.context, evidence: value }) });
      expect(kernel.reviewAndSign(f.input).state).toBe("REJECTED");
    }
    expect(hashReviewedEvidence({ ...f.evidence, review: { ...f.evidence.review, result: "FAIL" } })).not.toBe(hashReviewedEvidence(f.evidence));
    expect(() => hashReviewedEvidence({ ...f.evidence, extra: true })).toThrow();
  });

  it("signature covers every payload and envelope binding even with adjusted expectations", () => {
    const f = reviewFixture();
    for (const [field, original] of Object.entries(f.envelope.payload)) {
      const replacement = field === "issuedAt" ? time(1) : field === "expiresAt" ? time(200_000)
        : field === "jti" ? jti() : field === "result" ? "FAIL" : field === "schemaVersion" ? 2
        : field === "type" ? "OTHER" : changed(field);
      expect(replacement).not.toBe(original);
      const payload = { ...f.envelope.payload, [field]: replacement };
      const { signature, ...unsigned } = f.envelope;
      // Crypto check bypasses schema/binding rejection, proving byte coverage.
      expect(verify(null, Buffer.from(`${independentReviewSigningDomain}\n${canonicalJson({ ...unsigned, payload })}`),
        f.key.publicKey, Buffer.from(signature, "base64url"))).toBe(false);
      expect(f.check({ ...f.envelope, payload }).valid).toBe(false);
    }
    for (const delta of [{ schemaVersion: 2 }, { type: "OTHER" }, { signatureAlgorithm: "RSA" }, { reviewerKeyId: "alias" }]) {
      const { signature, ...unsigned } = f.envelope;
      expect(verify(null, Buffer.from(`${independentReviewSigningDomain}\n${canonicalJson({ ...unsigned, ...delta })}`),
        f.key.publicKey, Buffer.from(signature, "base64url"))).toBe(false);
      expect(f.check({ ...f.envelope, ...delta }).valid).toBe(false);
    }
    expect(verifyIndependentReview({ ...f.envelope, reviewerKeyId: "alias" }, { ...f.context, expectedReviewerKeyId: "alias" },
      new Map([["alias", f.key.publicKey]]), now).valid).toBe(false);
  });

  it("exposes only a narrow signer and rejects caller authority and malformed host results", () => {
    const f = reviewFixture();
    expect(Object.keys(signerModule)).toEqual(["createIndependentReviewSigningKernel"]);
    expect(Object.keys(f.kernel)).toEqual(["reviewAndSign"]);
    for (const input of [Buffer.from("bytes"), "{}", true, f.envelope,
      ...["domain", "reviewerKeyId", "result", "PASS", "reviewEvidenceHash", "issuedAt", "expiresAt", "jti"].map(field => ({ ...f.input, [field]: "PASS" }))]) {
      expect(f.kernel.reviewAndSign(input)).toEqual({ state: "REJECTED" });
    }
    for (const snapshot of [true, { result: "PASS" }, { context: f.context },
      { context: f.context, evidence: { ...f.evidence, attemptHash: hash() } },
      { context: f.context, evidence: { ...f.evidence, integrity: { ...f.evidence.integrity, result: "INVALID" } } },
      { context: f.context, evidence: { ...f.evidence, review: { ...f.evidence.review, result: "FAIL" } } }]) {
      expect(signerModule.createIndependentReviewSigningKernel({ ...f.host, independentlyVerifyReview: () => snapshot })
        .reviewAndSign(f.input).state).toBe("REJECTED");
    }
    expect(signerModule.createIndependentReviewSigningKernel({ ...f.host, independentlyVerifyReview: () => { throw new Error("unavailable"); } })
      .reviewAndSign(f.input).state).toBe("REJECTED");
  });

  it("isolates Human, Permit and DONE domains even with the identical Ed25519 key", () => {
    const f = reviewFixture(), other = fixture();
    const keys = new Map([["ct702-test", f.key.publicKey], ["ct700-test", f.key.publicKey], ["ct701-test", f.key.publicKey]]);
    const human = other.signApproval(other.approval, f.key.privateKey);
    const permit = other.signPermit(other.permit, f.key.privateKey);
    expect(verifyTypedActionApproval(human, other.humanContext, keys, now).valid).toBe(true);
    expect(verifyExecutionPermit(permit, other.executionContext, keys, now).valid).toBe(true);
    const reviewId = `review-${randomUUID()}`;
    const doneContext = { task_id: "rpc-" + "a".repeat(32), run_id: "auto-" + "a".repeat(32),
      authoritative_review_id: reviewId, review_evidence_hash: hash(), bundle_manifest_sha256: hash(), canonical_goal_sha256: hash(),
      current_review_id: reviewId, current_review_evidence_hash: "", review_result: "PASS" as const,
      review_is_current: true as const, bundle_integrity_valid: true as const };
    doneContext.current_review_evidence_hash = doneContext.review_evidence_hash;
    const done: any = { schema_version: 1, type: "AI_WORKSPACE_DONE_APPROVAL", approver_key_id: "ct700-test",
      signature_algorithm: "Ed25519", signature: "A".repeat(86), payload: {
        schema_version: 1, type: "AI_WORKSPACE_DONE_APPROVAL_REQUEST", request_id: "req-" + "a".repeat(32),
        task_id: doneContext.task_id, run_id: doneContext.run_id, authoritative_review_id: reviewId,
        review_evidence_hash: doneContext.review_evidence_hash, bundle_manifest_sha256: doneContext.bundle_manifest_sha256,
        canonical_goal_sha256: doneContext.canonical_goal_sha256, issued_at: time(0), expires_at: time(120_000), nonce: jti(),
      } };
    done.signature = sign(null, approvalSigningBytes(done), f.key.privateKey).toString("base64url");
    expect(verifySignedApproval(done, doneContext, keys, now).valid).toBe(true);
    for (const value of [human, permit, done]) expect(verifyIndependentReview(value, f.context, keys, now).valid).toBe(false);
    expect(verifyTypedActionApproval(f.envelope, other.humanContext, keys, now).valid).toBe(false);
    expect(verifySignedApproval(f.envelope, doneContext, keys, now).valid).toBe(false);
    expect(verifyExecutionPermit(f.envelope, other.executionContext, keys, now).valid).toBe(false);
    const body = independentReviewSigningBytes(f.envelope).toString().split("\n").slice(1).join("\n");
    const permitDomain = executionPermitSigningBytes(permit).toString().split("\n")[0];
    for (const domain of [typedActionApprovalSigningDomain, permitDomain, "AI_WORKSPACE_DONE_APPROVAL_V1"]) {
      const signature = sign(null, Buffer.from(`${domain}\n${body}`), f.key.privateKey).toString("base64url");
      expect(f.check({ ...f.envelope, signature }).valid).toBe(false);
    }
  });

  it.each(["FAIL", "NEEDS_WORK"])("preserves Finalizer PASS-only semantics for %s", result => {
    const f = fixture();
    expect(finalizeTypedAction({ ...f.input, independentReview: { ...f.input.independentReview, result } }, f.humanKeys, now).state)
      .not.toBe("VERIFIED_NOT_CONSUMED");
  });
});
