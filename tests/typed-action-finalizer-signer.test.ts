import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { canonicalJson } from "../src/typed-action-approval/contract.js";
import { createTypedActionPermitSigningKernel } from "../src/typed-action-finalizer/signer.js";
import { verifyExecutionPermit } from "../src/typed-action-finalizer/verifier.js";
import { LedgerOutcomeUnknownError } from "../src/typed-action-finalizer/storage.js";
import { hash, jti, now, time } from "./typed-action-fixtures.js";
import { sqliteFixture, type SqliteFixture } from "./typed-action-sqlite-fixtures.js";

const active: SqliteFixture[] = [];
async function setup() { const f = await sqliteFixture(); active.push(f); return f; }
afterEach(async () => { vi.restoreAllMocks(); for (const f of active.splice(0)) await f.cleanup(); });

describe("CT701 fixed permit signing kernel with real SQLite", () => {
  it("finalizes, Ed25519 signs, self-verifies and durably stores canonical evidence without consuming", async () => {
    const f = await setup();
    const result = f.kernel.finalizeAndSignTypedAction(f.input);
    expect(result.state).toBe("VERIFIED_NOT_CONSUMED");
    if (result.state !== "VERIFIED_NOT_CONSUMED") throw new Error("No evidence");
    expect(verifyExecutionPermit(result.envelope, f.executionContext, f.finalizerKeys, now).valid).toBe(true);
    const stored = f.store.permit(f.identity.permitJti)!;
    expect(stored.canonicalEnvelope).toBe(canonicalJson(result.envelope));
    expect(stored.envelope).toEqual(result.envelope);
    expect(stored.state).toBe("VERIFIED_NOT_CONSUMED");
    expect(stored.createdAt).toBe(time(0)); expect(stored.updatedAt).toBe(time(0));
    expect(f.count("finalized_permits")).toBe(1); expect(f.count("consumed_execution_identities")).toBe(0);
    expect(f.store.audit(f.identity).map(row => row.event)).toEqual(["PERMIT_ISSUED"]);
    expect(Object.isFrozen(result.envelope.payload)).toBe(true);
  });

  it("case A: stored evidence survives restart and all repeated issuance is fail-closed", async () => {
    const f = await setup(); f.kernel.finalizeAndSignTypedAction(f.input);
    const canonical = f.store.permit(f.identity.permitJti)!.canonicalEnvelope;
    f.store.close();
    const restarted = f.connect();
    expect(restarted.store.permit(f.identity.permitJti)!.canonicalEnvelope).toBe(canonical);
    expect(verifyExecutionPermit(JSON.parse(canonical), f.executionContext, f.finalizerKeys, now).valid).toBe(true);
    expect(restarted.kernel.finalizeAndSignTypedAction(f.input)).toEqual({ state: "REJECTED" });
    const changed = structuredClone(f.input); changed.issuance.jti = jti(); changed.issuance.permitId = randomUUID();
    expect(restarted.kernel.finalizeAndSignTypedAction(changed)).toEqual({ state: "REJECTED" });
    expect(restarted.store.permit(changed.issuance.jti)).toBeNull();
  });

  it.each(["same", "different-permit", "different-human", "same-permit-id", "same-permit-jti"])("permanent issuance uniqueness: %s", async variant => {
    const f = await setup(); f.kernel.finalizeAndSignTypedAction(f.input);
    const second = structuredClone(f.input);
    if (variant !== "same") { second.issuance.jti = jti(); second.issuance.permitId = randomUUID(); }
    if (variant === "different-human") second.humanApproval = f.signApproval({ ...second.humanApproval,
      payload: { ...second.humanApproval.payload, jti: jti(), approvalRequestId: randomUUID() } });
    if (variant === "same-permit-id") second.issuance.permitId = f.input.issuance.permitId;
    if (variant === "same-permit-jti") second.issuance.jti = f.input.issuance.jti;
    expect(f.kernel.finalizeAndSignTypedAction(second)).toEqual({ state: "REJECTED" });
    expect(f.count("finalized_permits")).toBe(1); expect(f.count("consumed_execution_identities")).toBe(0);
  });

  it("a reused Human jti cannot issue for a different valid request/attempt", async () => {
    const f = await setup(), other = await setup();
    f.kernel.finalizeAndSignTypedAction(f.input);
    // CT700 signs a fully valid independent second request, reusing only its jti.
    other.input.humanApproval = f.signApproval({ ...other.approval, payload: { ...other.approval.payload, jti: f.approval.payload.jti } });
    const kernel = createTypedActionPermitSigningKernel({ store: f.store, privateKey: f.finalizer.privateKey,
      finalizerKeyId: "ct701-test", trustedHumanKeys: f.humanKeys, now: () => now });
    expect(kernel.finalizeAndSignTypedAction(other.input)).toEqual({ state: "REJECTED" });
    expect(f.count("finalized_permits")).toBe(1);
  });

  it.each(["permitId", "jti"])("%s independently prevents collisions across distinct valid requests", async field => {
    const f = await setup(), other = await setup();
    f.kernel.finalizeAndSignTypedAction(f.input);
    other.input.humanApproval = f.signApproval(other.approval);
    other.input.issuance[field] = f.input.issuance[field];
    expect(f.kernel.finalizeAndSignTypedAction(other.input)).toEqual({ state: "REJECTED" });
    expect(f.count("finalized_permits")).toBe(1);
    other.input.issuance[field] = field === "jti" ? jti() : randomUUID();
    expect(f.kernel.finalizeAndSignTypedAction(other.input).state).toBe("VERIFIED_NOT_CONSUMED");
    expect(f.count("finalized_permits")).toBe(2);
  });

  it("rejects public, RSA and EC signing keys", async () => {
    const f = await setup();
    for (const key of [f.finalizer.publicKey, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
      generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey]) {
      expect(() => createTypedActionPermitSigningKernel({ store: f.store, privateKey: key,
        finalizerKeyId: "ct701-test", trustedHumanKeys: f.humanKeys, now: () => now })).toThrow(/Ed25519 private key/);
    }
    expect(f.count("finalized_permits")).toBe(0);
  });

  it.each(["forged-human", "human-mismatch", "review-mismatch", "policy-mismatch", "expired", "request-rehash", "attempt-rehash", "unknown-field"])("%s never persists a permit", async fault => {
    const f = await setup();
    if (fault === "forged-human") f.input.humanApproval.signature = Buffer.alloc(64, 1).toString("base64url");
    if (fault === "human-mismatch") f.input.humanApproval = f.signApproval({ ...f.approval, payload: { ...f.approval.payload, requestHash: hash() } });
    if (fault === "review-mismatch") f.input.independentReview.independentReviewEvidenceHash = hash();
    if (fault === "policy-mismatch") f.input.policyContext.policySha256 = hash();
    if (fault === "expired") f.setClock(now + 120_000);
    if (fault === "request-rehash") f.input.boundRequest.request.timeout.executionMs++;
    if (fault === "attempt-rehash") f.input.boundAttempt.attempt.createdAt = time(-31_000);
    if (fault === "unknown-field") f.input.path = "caller-controlled";
    expect(f.kernel.finalizeAndSignTypedAction(f.input)).toEqual({ state: "REJECTED" });
    expect(f.count("finalized_permits")).toBe(0); expect(f.count("finalizer_audit")).toBe(0);
  });

  it("has no generic signing escape hatch or request-controlled filesystem selector", async () => {
    const f = await setup();
    expect(Object.keys(f.kernel)).toEqual(["finalizeAndSignTypedAction"]);
    for (const input of [f.permit.payload, f.permit, Buffer.from("arbitrary bytes"), { payload: f.permit.payload },
      ...["databasePath", "privateKeyPath", "command", "url", "sql"].map(key => ({ ...f.input, [key]: "arbitrary" }))]) {
      expect(f.kernel.finalizeAndSignTypedAction(input)).toEqual({ state: "REJECTED" });
    }
    expect(f.count("finalized_permits")).toBe(0);
  });

  it("a signer key outside the ledger trust inventory cannot persist evidence", async () => {
    const f = await setup();
    const kernel = createTypedActionPermitSigningKernel({ store: f.store, privateKey: generateKeyPairSync("ed25519").privateKey,
      finalizerKeyId: "ct701-test", trustedHumanKeys: f.humanKeys, now: () => now });
    expect(() => kernel.finalizeAndSignTypedAction(f.input)).toThrow(/Invalid signed permit/);
    expect(f.count("finalized_permits")).toBe(0);
  });

  it("never returns evidence if SQLite commit acknowledgement is lost", async () => {
    const f = await setup(), original = f.db.exec.bind(f.db); let injected = false;
    vi.spyOn(f.db, "exec").mockImplementation(sql => {
      original(sql);
      if (sql === "COMMIT" && !injected) { injected = true; throw new Error("lost commit acknowledgement"); }
    });
    expect(() => f.kernel.finalizeAndSignTypedAction(f.input)).toThrow(LedgerOutcomeUnknownError);
    expect(f.store.permit(f.identity.permitJti)!.state).toBe("RECONCILE_REQUIRED");
    expect(f.count("consumed_execution_identities")).toBe(0);
    expect(f.kernel.finalizeAndSignTypedAction(f.input)).toEqual({ state: "REJECTED" });
  });
});
