import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { approvalSigningBytes, approvalRequestSchema, signedApprovalSchema,
  type SignedApproval, type TrustedApprovalContext } from "../src/human-approval/contract.js";
import { verifySignedApproval } from "../src/human-approval/verifier.js";

const now = Date.parse("2026-09-26T12:00:00.000Z");
const review = "review-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const hash = (char: string) => char.repeat(64);
const context: TrustedApprovalContext = {
  task_id: "rpc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", run_id: "auto-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  authoritative_review_id: review, review_evidence_hash: hash("a"),
  bundle_manifest_sha256: hash("b"), canonical_goal_sha256: hash("c"),
  current_review_id: review, current_review_evidence_hash: hash("a"),
  review_result: "PASS", review_is_current: true, bundle_integrity_valid: true,
};

function fixture() {
  // Ephemeral test-only signing keys. No private key is checked in or bundled into runtime.
  const pair = generateKeyPairSync("ed25519");
  const keys = new Map<string, KeyObject>([["test-approver-1", pair.publicKey]]);
  const payload = {
    schema_version: 1 as const, type: "AI_WORKSPACE_DONE_APPROVAL_REQUEST" as const,
    request_id: "req-1234567890abcdef1234567890abcdef",
    task_id: context.task_id, run_id: context.run_id,
    authoritative_review_id: context.authoritative_review_id,
    review_evidence_hash: context.review_evidence_hash,
    bundle_manifest_sha256: context.bundle_manifest_sha256,
    canonical_goal_sha256: context.canonical_goal_sha256,
    issued_at: "2026-09-26T11:59:00.000Z", expires_at: "2026-09-26T12:04:00.000Z",
    nonce: randomBytes(32).toString("base64url"),
  };
  const unsigned: SignedApproval = { schema_version: 1, type: "AI_WORKSPACE_DONE_APPROVAL",
    payload, approver_key_id: "test-approver-1", signature_algorithm: "Ed25519", signature: "A".repeat(86) };
  const signed = (value: SignedApproval = unsigned, privateKey = pair.privateKey): SignedApproval =>
    ({ ...value, signature: sign(null, approvalSigningBytes(value), privateKey).toString("base64url") });
  return { keys, payload, evidence: signed(), signed };
}

const valid = (evidence: unknown, keys: ReadonlyMap<string, KeyObject>, snapshot: TrustedApprovalContext = context, time = now) =>
  verifySignedApproval(evidence, snapshot, keys, time).valid;

/** Bounded single-process fixture only; production requires a transactional store in the isolated domain. */
class FixtureConsumptionGate {
  private readonly used = new Map<string, number>();
  constructor(private readonly limit: number) {}
  tryConsume(evidence: unknown, keys: ReadonlyMap<string, KeyObject>, current: () => TrustedApprovalContext, time: number): boolean {
    const verified = verifySignedApproval(evidence, current(), keys, time);
    if (!verified.valid) return false;
    for (const [jti, expires] of this.used) if (expires <= time) this.used.delete(jti);
    // Recheck the trusted Review snapshot immediately before atomic reservation.
    if (!verifySignedApproval(evidence, current(), keys, time).valid || this.used.has(verified.jti) || this.used.size >= this.limit) return false;
    this.used.set(verified.jti, Date.parse(verified.payload.expires_at));
    return true;
  }
}

describe("signed Human Approval contract (not connected to Complete)", () => {
  it("valid signed approval PASS, with canonical signature bytes and strict request schema", () => {
    const f = fixture();
    expect(approvalRequestSchema.safeParse(f.payload).success).toBe(true);
    expect(signedApprovalSchema.safeParse(f.evidence).success).toBe(true);
    expect(approvalSigningBytes(f.evidence).toString("utf8")).toContain("AI_WORKSPACE_DONE_APPROVAL_V1\n");
    expect(verifySignedApproval(f.evidence, context, f.keys, now)).toMatchObject({ valid: true, jti: f.payload.nonce });
  });
  it("rejects boolean-only and PASS-only claims, missing signature, random signature and another private key", () => {
    const f = fixture();
    for (const claim of [{ done_approved: true }, { task_id: context.task_id, review_result: "PASS" },
      { ...f.evidence, signature: undefined }, { ...f.evidence, signature: randomBytes(64).toString("base64url") },
      f.signed(f.evidence, generateKeyPairSync("ed25519").privateKey)]) expect(valid(claim, f.keys)).toBe(false);
  });
  it("rejects payload tampering, task/run reuse and all Review/manifest/goal binding changes", () => {
    const f = fixture();
    for (const field of ["task_id", "run_id", "authoritative_review_id", "review_evidence_hash",
      "bundle_manifest_sha256", "canonical_goal_sha256", "nonce", "request_id", "expires_at"] as const) {
      const altered = { ...f.evidence, payload: { ...f.payload, [field]:
        field === "task_id" ? "rpc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" :
        field === "run_id" ? "auto-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" :
        field === "authoritative_review_id" ? "review-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" :
        field === "nonce" ? randomBytes(32).toString("base64url") :
        field === "request_id" ? "req-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" :
        field === "expires_at" ? "2026-09-26T12:03:00.000Z" : hash("d") } };
      expect(valid(altered, f.keys), field).toBe(false);
    }
    for (const field of ["task_id", "run_id", "review_evidence_hash", "bundle_manifest_sha256", "canonical_goal_sha256"] as const)
      expect(valid(f.evidence, f.keys, { ...context, [field]: field.endsWith("sha256") || field.endsWith("hash") ? hash("d") :
        field === "task_id" ? "rpc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" : "auto-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), field).toBe(false);
  });
  it("rejects old authoritative Review and any Review rerun superseding the signed evidence", () => {
    const f = fixture();
    const newer = "review-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(valid(f.evidence, f.keys, { ...context, current_review_id: newer })).toBe(false);
    expect(valid(f.evidence, f.keys, { ...context, current_review_evidence_hash: hash("d") })).toBe(false);
    expect(valid(f.evidence, f.keys, { ...context, authoritative_review_id: newer, current_review_id: newer })).toBe(false);
    expect(valid(f.evidence, f.keys, { ...context, review_result: "NEEDS_WORK" as "PASS" })).toBe(false);
    expect(valid(f.evidence, f.keys, { ...context, review_is_current: false as true })).toBe(false);
  });
  it("rejects expiry, invalid time ranges and anomalous future issued_at", () => {
    const f = fixture();
    expect(valid(f.evidence, f.keys, context, Date.parse(f.payload.expires_at))).toBe(false);
    expect(valid(f.signed({ ...f.evidence, payload: { ...f.payload, issued_at: "2026-09-26T12:01:00.000Z" } }), f.keys)).toBe(false);
    expect(valid(f.signed({ ...f.evidence, payload: { ...f.payload, expires_at: "2026-09-26T12:10:00.000Z" } }), f.keys)).toBe(false);
    expect(valid(f.evidence, f.keys, context, Number.NaN)).toBe(false);
  });
  it("rejects wrong key ID, wrong algorithm, wrong key type and absent trust anchor", () => {
    const f = fixture();
    expect(valid(f.evidence, new Map())).toBe(false);
    expect(valid({ ...f.evidence, approver_key_id: "other" }, f.keys)).toBe(false);
    expect(valid(f.signed({ ...f.evidence, approver_key_id: "other" }), f.keys)).toBe(false);
    expect(valid({ ...f.evidence, signature_algorithm: "RSA" }, f.keys)).toBe(false);
    const wrong = new Map([["test-approver-1", generateKeyPairSync("ed25519").privateKey]]);
    expect(valid(f.evidence, wrong)).toBe(false);
  });
  it("fails closed for malformed envelopes, unknown fields, schema versions and non-canonical encodings", () => {
    const f = fixture();
    for (const value of [null, [], "approved", { ...f.evidence, extra: true }, { ...f.evidence, schema_version: 2 },
      { ...f.evidence, payload: { ...f.payload, command: "whoami" } },
      { ...f.evidence, payload: { ...f.payload, schema_version: 2 } },
      { ...f.evidence, signature: "!!!" },
      { ...f.evidence, payload: { ...f.payload, issued_at: "2026-09-26T11:59:00Z" } },
      f.signed({ ...f.evidence, payload: { ...f.payload, nonce: "A".repeat(42) + "B" } }),
    ]) expect(valid(value, f.keys)).toBe(false);
    expect(valid(f.evidence, f.keys, { ...context, bundle_integrity_valid: false as true })).toBe(false);
  });
  it("keeps verification pure; fixture gate consumes a jti once and fails closed when full", () => {
    const f = fixture(), gate = new FixtureConsumptionGate(1);
    expect(valid(f.evidence, f.keys)).toBe(true);
    expect(valid(f.evidence, f.keys)).toBe(true); // verifier does not consume
    expect(gate.tryConsume(f.evidence, f.keys, () => context, now)).toBe(true);
    expect(gate.tryConsume(f.evidence, f.keys, () => context, now)).toBe(false);
    const next = f.signed({ ...f.evidence, payload: { ...f.payload, nonce: randomBytes(32).toString("base64url") } });
    expect(gate.tryConsume(next, f.keys, () => context, now)).toBe(false);
    let calls = 0;
    const changed = () => (++calls === 1 ? context : { ...context, current_review_id: "review-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(new FixtureConsumptionGate(1).tryConsume(f.evidence, f.keys, changed, now)).toBe(false);
  });
});
