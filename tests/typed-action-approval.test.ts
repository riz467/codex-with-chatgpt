import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { approvalSigningBytes, type TrustedApprovalContext } from "../src/human-approval/contract.js";
import { verifySignedApproval } from "../src/human-approval/verifier.js";
import { actionBindingFields, hashTypedActionApproval, typedActionApprovalSigningBytes } from "../src/typed-action-approval/contract.js";
import { verifyTypedActionApproval } from "../src/typed-action-approval/verifier.js";
import { fixture, hash, jti, now, time } from "./typed-action-fixtures.js";

function changed(field: string): unknown {
  if (field.endsWith("Id")) return randomUUID();
  if (field === "actionKind") return "AppUpgrade";
  if (field === "attemptSequence" || field === "targetGeneration") return 99;
  return hash();
}
describe("independent Typed Action Human Approval", () => {
  it("verifies exact Ed25519 binding without consuming or granting execution", () => {
    const f = fixture();
    const first = verifyTypedActionApproval(f.approval, f.humanContext, f.humanKeys, now);
    expect(first).toEqual({ valid: true, jti: f.approval.payload.jti, payload: f.approval.payload });
    expect(verifyTypedActionApproval(f.approval, f.humanContext, f.humanKeys, now)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toHaveProperty("executionMayStart");
    expect(typedActionApprovalSigningBytes(f.approval).toString()).toMatch(/^AI_WORKSPACE_TYPED_ACTION_APPROVAL_V1\n/);
  });

  it.each(actionBindingFields)("rejects signed wrong %s and mismatched trusted context", field => {
    const f = fixture(), value = changed(field);
    const altered = f.signApproval({ ...f.approval, payload: { ...f.approval.payload, [field]: value } });
    expect(verifyTypedActionApproval(altered, f.humanContext, f.humanKeys, now).valid).toBe(false);
    expect(verifyTypedActionApproval(f.approval, { ...f.humanContext, [field]: value }, f.humanKeys, now).valid).toBe(false);
  });

  it.each([
    ["expired", -100_000, 0], ["future-issued", 30_001, 60_000], ["excessive lifetime", -10_000, 290_001],
    ["zero lifetime", 0, 0], ["inverted lifetime", 10_000, 1],
  ])("rejects %s", (_name, issued, expires) => {
    const f = fixture();
    const value = f.signApproval({ ...f.approval, payload: { ...f.approval.payload, issuedAt: time(Number(issued)), expiresAt: time(Number(expires)) } });
    expect(verifyTypedActionApproval(value, f.humanContext, f.humanKeys, now).valid).toBe(false);
  });

  it("checks exact lifetime/skew boundaries and a valid trusted clock", () => {
    const f = fixture();
    const value = f.signApproval({ ...f.approval, payload: { ...f.approval.payload, issuedAt: time(30_000), expiresAt: time(330_000) } });
    expect(verifyTypedActionApproval(value, f.humanContext, f.humanKeys, now).valid).toBe(true);
    for (const clock of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(verifyTypedActionApproval(f.approval, f.humanContext, f.humanKeys, clock).valid).toBe(false);
    }
  });

  it.each(["reviewIsCurrent", "requestIsCurrent", "policyIsCurrent", "maintenanceWindowValid"])("rejects false trusted %s", field => {
    const f = fixture();
    expect(verifyTypedActionApproval(f.approval, { ...f.humanContext, [field]: false }, f.humanKeys, now).valid).toBe(false);
  });

  it("requires PASS and a currently valid maintenance window covering the approval", () => {
    const f = fixture();
    for (const delta of [
      { independentReviewResult: "NEEDS_WORK" }, { maintenanceWindowStartsAt: time(1) },
      { maintenanceWindowExpiresAt: time(0) }, { maintenanceWindowExpiresAt: time(60_000) },
      { maintenanceWindowStartsAt: time(-1) },
    ]) expect(verifyTypedActionApproval(f.approval, { ...f.humanContext, ...delta }, f.humanKeys, now).valid).toBe(false);
  });

  it("rejects unknown keys, private/RSA keys, wrong algorithm and forged signatures", () => {
    const f = fixture();
    const unknown = f.signApproval({ ...f.approval, approverKeyId: "unknown" });
    for (const input of [unknown, f.signApproval(f.approval, generateKeyPairSync("ed25519").privateKey),
      { ...f.approval, signature: Buffer.alloc(64, 1).toString("base64url") },
      { ...f.approval, signatureAlgorithm: "RSA" },
    ]) expect(verifyTypedActionApproval(input, f.humanContext, f.humanKeys, now).valid).toBe(false);
    for (const keys of [new Map(), new Map([["ct700-test", f.human.privateKey]]),
      new Map([["ct700-test", generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey]])]) {
      expect(verifyTypedActionApproval(f.approval, f.humanContext, keys, now).valid).toBe(false);
    }
  });

  it("rejects unknown fields, malformed encoding, non-JSON values and accessors without invoking them", () => {
    const f = fixture(); let accessed = false;
    const accessor = { ...f.approval };
    Object.defineProperty(accessor, "payload", { enumerable: true, get: () => { accessed = true; return f.approval.payload; } });
    const hidden = { ...f.approval }; Object.defineProperty(hidden, "command", { value: "run", enumerable: false });
    const symbol = { ...f.approval, [Symbol("command")]: "run" };
    const proto = Object.assign(Object.create({}), f.approval);
    for (const value of [null, [], true, "PASS", accessor, hidden, symbol, proto,
      { ...f.approval, extra: true }, { ...f.approval, schemaVersion: 2 },
      { ...f.approval, payload: { ...f.approval.payload, independentReview: true } },
      { ...f.approval, payload: { ...f.approval.payload, issuedAt: "2026-02-30T12:00:00.000Z" } },
      { ...f.approval, payload: { ...f.approval.payload, jti: "A".repeat(42) + "B" } },
      { ...f.approval, signature: "A".repeat(85) + "B" },
      ...["path", "command", "executable", "remote", "ref", "url"].map(field => ({ ...f.approval, payload: { ...f.approval.payload, [field]: "arbitrary" } })),
    ]) expect(verifyTypedActionApproval(value, f.humanContext, f.humanKeys, now).valid).toBe(false);
    expect(accessed).toBe(false);
  });

  it("canonicalizes key ordering and binds key ID, nonce, request ID, timestamps and all envelope bytes", () => {
    const f = fixture();
    const reversed = { ...Object.fromEntries(Object.entries(f.approval).reverse()),
      payload: Object.fromEntries(Object.entries(f.approval.payload).reverse()) };
    expect(typedActionApprovalSigningBytes(reversed)).toEqual(typedActionApprovalSigningBytes(f.approval));
    expect(hashTypedActionApproval(reversed)).toBe(hashTypedActionApproval(f.approval));
    for (const change of [{ approvalRequestId: randomUUID() }, { jti: jti() }, { issuedAt: time(-9000) }, { expiresAt: time(100_000) }]) {
      expect(verifyTypedActionApproval({ ...f.approval, payload: { ...f.approval.payload, ...change } }, f.humanContext, f.humanKeys, now).valid).toBe(false);
    }
    const unsignedBytes = typedActionApprovalSigningBytes(f.approval).toString().split("\n").slice(1).join("\n");
    const wrongDomain = sign(null, Buffer.from(`AI_WORKSPACE_DONE_APPROVAL_V1\n${unsignedBytes}`), f.human.privateKey).toString("base64url");
    expect(verifyTypedActionApproval({ ...f.approval, signature: wrongDomain }, f.humanContext, f.humanKeys, now).valid).toBe(false);
    const aliasKeys = new Map([...f.humanKeys, ["alias", f.human.publicKey] as const]);
    expect(verifyTypedActionApproval({ ...f.approval, approverKeyId: "alias" }, f.humanContext, aliasKeys, now).valid).toBe(false);
  });

  it("DONE and Typed Action approvals mutually reject while DONE retains its original wire format", () => {
    const f = fixture();
    const review = "review-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const context: TrustedApprovalContext = {
      task_id: "rpc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", run_id: "auto-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      authoritative_review_id: review, review_evidence_hash: hash(), bundle_manifest_sha256: hash(), canonical_goal_sha256: hash(),
      current_review_id: review, current_review_evidence_hash: "", review_result: "PASS", review_is_current: true, bundle_integrity_valid: true,
    };
    context.current_review_evidence_hash = context.review_evidence_hash;
    const done: any = { schema_version: 1, type: "AI_WORKSPACE_DONE_APPROVAL", approver_key_id: "ct700-test",
      signature_algorithm: "Ed25519", signature: "A".repeat(86), payload: {
        schema_version: 1, type: "AI_WORKSPACE_DONE_APPROVAL_REQUEST", request_id: "req-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        task_id: context.task_id, run_id: context.run_id, authoritative_review_id: review,
        review_evidence_hash: context.review_evidence_hash, bundle_manifest_sha256: context.bundle_manifest_sha256,
        canonical_goal_sha256: context.canonical_goal_sha256, issued_at: time(-10_000), expires_at: time(120_000), nonce: jti(),
      } };
    done.signature = sign(null, approvalSigningBytes(done), f.human.privateKey).toString("base64url");
    expect(verifySignedApproval(done, context, f.humanKeys, now).valid).toBe(true);
    expect(verifyTypedActionApproval(done, f.humanContext, f.humanKeys, now).valid).toBe(false);
    expect(verifySignedApproval(f.approval, context, f.humanKeys, now).valid).toBe(false);
  });
});
