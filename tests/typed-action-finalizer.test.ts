import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { bindActionAttempt, bindActionRequest } from "../src/mcp/typed-actions.js";
import { actionBindingFields, hashTypedActionApproval } from "../src/typed-action-approval/contract.js";
import { assertFinalizationTransition, consumptionNamespaces, executionPermitSigningBytes, hashExecutionPermit,
  stateAfterExecution, type AtomicExecutionConsumptionStore, type ConsumptionKey, type ExecutionOutcome,
} from "../src/typed-action-finalizer/contract.js";
import { consumeExecutionPermit, finalizeTypedAction, verifyExecutionPermit } from "../src/typed-action-finalizer/verifier.js";
import { fixture, hash, jti, now, time } from "./typed-action-fixtures.js";

/** Test fake ONLY. Separate handles share a backing Set to model a restart.
 * The synchronous transaction models all-or-none uniqueness, not real durability. */
class TestStore implements AtomicExecutionConsumptionStore {
  calls = 0;
  constructor(readonly backing = new Set<string>()) {}
  async consumeOnce(keys: readonly ConsumptionKey[]): Promise<boolean> {
    this.calls++;
    const encoded = keys.map(key => JSON.stringify([key.namespace, key.value]));
    if (new Set(encoded).size !== encoded.length || encoded.some(key => this.backing.has(key))) return false;
    for (const key of encoded) this.backing.add(key);
    return true;
  }
}
function gate(f: ReturnType<typeof fixture>, store: AtomicExecutionConsumptionStore, input: unknown = f.permit, context = f.executionContext) {
  return consumeExecutionPermit(input, f.finalizerKeys, { store, freshContext: () => context, now: () => now });
}

describe("CT701 pure Finalizer", () => {
  it("recomputes Core identities and produces an unsigned, not-consumed permit draft", () => {
    const f = fixture(), before = structuredClone(f.input);
    const result = finalizeTypedAction(f.input, f.humanKeys, now);
    expect(result.state).toBe("VERIFIED_NOT_CONSUMED");
    if (result.state !== "VERIFIED_NOT_CONSUMED") throw new Error("No draft");
    for (const key of actionBindingFields) expect(result.permit[key]).toBe(f.approval.payload[key]);
    expect(result.permit.humanApprovalEvidenceHash).toBe(hashTypedActionApproval(f.approval));
    expect(result.permit.humanApprovalJti).toBe(f.approval.payload.jti);
    expect(Object.isFrozen(result.permit)).toBe(true);
    expect(result).not.toHaveProperty("signature"); expect(result).not.toHaveProperty("executionMayStart");
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual(result);
    expect(f.input).toEqual(before);
  });

  it.each(actionBindingFields)("Human approval %s mismatch produces no permit", field => {
    const f = fixture(), value = typeof f.approval.payload[field] === "number" ? 99
      : field.endsWith("Id") ? randomUUID() : field === "actionKind" ? "AppUpgrade" : hash();
    f.input.humanApproval = f.signApproval({ ...f.approval, payload: { ...f.approval.payload, [field]: value } });
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });

  it.each(["missing", "stale", "not-PASS", "integrity", "expired", "future", "wrong-attempt", "wrong-hash", "reviewed-after-approval"])("independent review %s produces no permit", fault => {
    const f = fixture();
    if (fault === "missing") delete f.input.independentReview;
    if (fault === "stale") f.input.independentReview.isCurrent = false;
    if (fault === "not-PASS") f.input.independentReview.result = "NEEDS_WORK";
    if (fault === "integrity") f.input.independentReview.evidenceIntegrityValid = false;
    if (fault === "expired") f.input.independentReview.expiresAt = time(0);
    if (fault === "future") f.input.independentReview.issuedAt = time(1000);
    if (fault === "wrong-attempt") f.input.independentReview.attemptHash = hash();
    if (fault === "wrong-hash") f.input.independentReview.independentReviewEvidenceHash = hash();
    if (fault === "reviewed-after-approval") f.input.independentReview.issuedAt = time(-5000);
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });

  it.each(["missing", "stale", "denied", "superseded-request", "wrong-hash", "wrong-target", "wrong-generation", "wrong-window"])("trusted policy %s produces no permit", fault => {
    const f = fixture();
    if (fault === "missing") delete f.input.policyContext;
    if (fault === "stale") f.input.policyContext.isCurrent = false;
    if (fault === "denied") f.input.policyContext.actionAllowed = false;
    if (fault === "superseded-request") f.input.policyContext.requestIsCurrent = false;
    if (fault === "wrong-hash") f.input.policyContext.policySha256 = hash();
    if (fault === "wrong-target") f.input.policyContext.targetId = randomUUID();
    if (fault === "wrong-generation") f.input.policyContext.targetGeneration++;
    if (fault === "wrong-window") f.input.policyContext.maintenanceWindowExpiresAt = time(-1);
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });

  it("rehashes the actual request instead of comparing supplied matching hash claims", () => {
    const f = fixture(); f.input.boundRequest.request.timeout.executionMs++;
    // Supplied requestHash, attempt and approval still all match each other.
    expect(f.input.boundRequest.requestHash).toBe(f.approval.payload.requestHash);
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });

  it("rehashes the actual attempt instead of comparing supplied matching hash claims", () => {
    const f = fixture(); f.input.boundAttempt.attempt.createdAt = time(-31_000);
    expect(f.input.boundAttempt.attemptHash).toBe(f.approval.payload.attemptHash);
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });

  it("the same request with a different bound attempt requires fresh Human Approval and review", () => {
    const f = fixture();
    f.input.boundAttempt = bindActionAttempt({ ...f.input.boundAttempt.attempt, attemptId: randomUUID() }, f.input.boundRequest.request);
    expect(f.input.boundRequest.requestHash).toBe(f.approval.payload.requestHash);
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });

  it.each(["request-hash", "attempt-hash", "generation", "attempt-time", "unknown-field", "forged-human", "self-asserted-review"])("rejects %s", fault => {
    const f = fixture();
    if (fault === "request-hash") f.input.boundRequest.requestHash = hash();
    if (fault === "attempt-hash") f.input.boundAttempt.attemptHash = hash();
    if (fault === "generation") {
      f.input.boundRequest.request.preconditions.targetGeneration++;
      f.input.boundRequest = bindActionRequest(f.input.boundRequest.request);
    }
    if (fault === "attempt-time") f.input.boundAttempt.attempt.createdAt = time(1);
    if (fault === "unknown-field") f.input.command = "run";
    if (fault === "forged-human") f.input.humanApproval.signature = Buffer.alloc(64, 1).toString("base64url");
    if (fault === "self-asserted-review") { delete f.input.independentReview; f.input.humanApproval.payload.independentReview = true; }
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });

  it.each([
    ["expired", time(-1000), time(0)], ["future", time(30_001), time(60_000)],
    ["outlives-human", time(0), time(120_001)], ["before-human", time(-11_000), time(60_000)],
    ["excessive", time(0), time(300_001)],
  ])("permit draft %s is rejected", (_fault, issuedAt, expiresAt) => {
    const f = fixture(); Object.assign(f.input.issuance, { issuedAt, expiresAt });
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });

  it("permit cannot outlive the independent review", () => {
    const f = fixture(); f.input.independentReview.expiresAt = time(30_000);
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });

  it("does not treat an unsigned draft as a signed execution permit", () => {
    const f = fixture(), result = finalizeTypedAction(f.input, f.humanKeys, now);
    expect(verifyExecutionPermit(result, f.executionContext, f.finalizerKeys, now).valid).toBe(false);
    expect(verifyExecutionPermit(f.permit.payload, f.executionContext, f.finalizerKeys, now).valid).toBe(false);
  });

  it("does not bypass Core's separate destructive/reboot approval requirements", () => {
    const f = fixture();
    const request = f.input.boundRequest.request;
    Object.assign(request, { kind: "RebootNode", target: { ...request.target, kind: "node" }, risk: "destructive", reboot: "required",
      expected: { generation: 4, bootId: randomUUID(), backup: { snapshotId: randomUUID(), sha256: hash(), generation: 4 } },
      desired: { boot: "new-boot-id", health: "healthy" },
      approval: { ...request.approval, destructive: "separate-required", reboot: "separate-required" },
    });
    f.input.boundRequest = bindActionRequest(request);
    f.input.boundAttempt = bindActionAttempt({ ...f.input.boundAttempt.attempt, requestHash: f.input.boundRequest.requestHash }, request);
    const changes = { actionKind: "RebootNode", requestHash: f.input.boundRequest.requestHash, attemptHash: f.input.boundAttempt.attemptHash };
    Object.assign(f.input.humanContext, changes); Object.assign(f.input.independentReview, changes);
    f.input.policyContext.actionKind = "RebootNode";
    f.input.humanApproval = f.signApproval({ ...f.approval, payload: { ...f.approval.payload, ...changes } });
    expect(finalizeTypedAction(f.input, f.humanKeys, now)).toEqual({ state: "REJECTED" });
  });
});

describe("Execution Permit verifier", () => {
  it("verifies the CT701 signature with a distinct domain and independently held context", () => {
    const f = fixture();
    expect(verifyExecutionPermit(f.permit, f.executionContext, f.finalizerKeys, now)).toEqual({
      valid: true, state: "VERIFIED_NOT_CONSUMED", jti: f.permit.payload.jti, payload: f.permit.payload,
    });
    expect(executionPermitSigningBytes(f.permit).toString()).toMatch(/^AI_WORKSPACE_TYPED_ACTION_EXECUTION_PERMIT_V1\n/);
    expect(hashExecutionPermit(f.permit)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([...actionBindingFields, "humanApprovalEvidenceHash", "humanApprovalJti"])("rejects wrong trusted %s, even with a valid signature", field => {
    const f = fixture();
    const wrong = typeof f.executionContext[field] === "number" ? 99 : field.endsWith("Id") ? randomUUID()
      : field === "actionKind" ? "AppUpgrade" : field === "humanApprovalJti" ? jti() : hash();
    expect(verifyExecutionPermit(f.permit, { ...f.executionContext, [field]: wrong }, f.finalizerKeys, now).valid).toBe(false);
    const signedWrong = f.signPermit({ ...f.permit, payload: { ...f.permit.payload, [field]: wrong } });
    expect(verifyExecutionPermit(signedWrong, f.executionContext, f.finalizerKeys, now).valid).toBe(false);
  });

  it("rejects forged/unknown/wrong-type keys and cross-domain signatures", () => {
    const f = fixture();
    const body = executionPermitSigningBytes(f.permit).toString().split("\n").slice(1).join("\n");
    for (const value of [
      f.signPermit(f.permit, f.human.privateKey), f.signPermit(f.permit, generateKeyPairSync("ed25519").privateKey),
      f.signPermit({ ...f.permit, finalizerKeyId: "unknown" }),
      { ...f.permit, signature: sign(null, Buffer.from(`AI_WORKSPACE_TYPED_ACTION_APPROVAL_V1\n${body}`), f.finalizer.privateKey).toString("base64url") },
      { ...f.permit, signatureAlgorithm: "RSA" }, f.approval,
    ]) expect(verifyExecutionPermit(value, f.executionContext, f.finalizerKeys, now).valid).toBe(false);
    expect(verifyExecutionPermit(f.permit, f.executionContext, new Map(), now).valid).toBe(false);
    expect(verifyExecutionPermit(f.permit, f.executionContext, new Map([["ct701-test", f.finalizer.privateKey]]), now).valid).toBe(false);
  });

  it.each([
    ["expired", time(-10_000), time(0)], ["future", time(30_001), time(60_000)],
    ["too long", time(0), time(300_001)], ["before-human", time(-11_000), time(60_000)],
    ["outlives-human", time(0), time(120_001)],
  ])("rejects signed %s permit", (_fault, issuedAt, expiresAt) => {
    const f = fixture();
    const evidence = f.signPermit({ ...f.permit, payload: { ...f.permit.payload, issuedAt, expiresAt } });
    expect(verifyExecutionPermit(evidence, f.executionContext, f.finalizerKeys, now).valid).toBe(false);
  });

  it.each([
    { reviewIsCurrent: false }, { independentReviewResult: "NEEDS_WORK" }, { requestIsCurrent: false },
    { policyIsCurrent: false }, { maintenanceWindowValid: false }, { maintenanceWindowExpiresAt: time(0) },
    { humanApprovalExpiresAt: time(0) }, { independentReviewExpiresAt: time(30_000) },
    { independentReviewIssuedAt: time(-5000) },
  ])("rejects stale/invalid execution context %j", delta => {
    const f = fixture();
    expect(verifyExecutionPermit(f.permit, { ...f.executionContext, ...delta }, f.finalizerKeys, now).valid).toBe(false);
  });

  it("strictly rejects unknown fields and signs the permit identifiers and envelope metadata", () => {
    const f = fixture();
    for (const value of [null, [], { ...f.permit, command: "exec" }, { ...f.permit, schemaVersion: 2 },
      { ...f.permit, payload: { ...f.permit.payload, path: "/arbitrary" } },
      { ...f.permit, payload: { ...f.permit.payload, permitId: randomUUID() } },
      { ...f.permit, payload: { ...f.permit.payload, jti: jti() } },
      { ...f.permit, signature: "A".repeat(85) + "B" },
    ]) expect(verifyExecutionPermit(value, f.executionContext, f.finalizerKeys, now).valid).toBe(false);
    const aliasKeys = new Map([...f.finalizerKeys, ["alias", f.finalizer.publicKey] as const]);
    expect(verifyExecutionPermit({ ...f.permit, finalizerKeyId: "alias" }, f.executionContext, aliasKeys, now).valid).toBe(false);
    const reversed = { ...Object.fromEntries(Object.entries(f.permit).reverse()), payload: Object.fromEntries(Object.entries(f.permit.payload).reverse()) };
    expect(executionPermitSigningBytes(reversed)).toEqual(executionPermitSigningBytes(f.permit));
    expect(hashExecutionPermit(reversed)).toBe(hashExecutionPermit(f.permit));
    expect(verifyExecutionPermit(reversed, f.executionContext, f.finalizerKeys, now).valid).toBe(true);
  });
});

describe("atomic execution consumption and terminal lifecycle contract", () => {
  it("verifiers do not consume; only the execution gate atomically consumes all three namespaces", async () => {
    const f = fixture(), store = new TestStore();
    expect(verifyExecutionPermit(f.permit, f.executionContext, f.finalizerKeys, now).valid).toBe(true);
    expect(verifyExecutionPermit(f.permit, f.executionContext, f.finalizerKeys, now).valid).toBe(true);
    expect(store.calls).toBe(0);
    expect(await gate(f, store)).toMatchObject({ state: "CONSUMED_FOR_EXECUTION", executionMayStart: true });
    expect(store.calls).toBe(1); expect(store.backing.size).toBe(3);
    expect([...store.backing].map(key => JSON.parse(key)[0]).sort()).toEqual(Object.values(consumptionNamespaces).sort());
    expect(await gate(f, store)).toEqual({ state: "REJECTED", executionMayStart: false });
  });

  it.each(["human", "permit", "attempt"])("same %s identity twice is rejected independently across simulated process restart", async duplicate => {
    const f = fixture(), store = new TestStore();
    expect((await gate(f, store)).executionMayStart).toBe(true);
    const evidence = structuredClone(f.permit), context = structuredClone(f.executionContext);
    // Change the other two replay identities, isolating the duplicate namespace.
    if (duplicate !== "human") context.humanApprovalJti = evidence.payload.humanApprovalJti = jti();
    if (duplicate !== "permit") evidence.payload.jti = jti();
    if (duplicate !== "attempt") context.attemptHash = evidence.payload.attemptHash = hash();
    const restarted = new TestStore(store.backing);
    expect(await gate(f, restarted, f.signPermit(evidence), context)).toEqual({ state: "REJECTED", executionMayStart: false });
    expect(store.backing.size).toBe(3); // No partial insert of the fresh keys.
  });

  it("concurrent gates have exactly one winner under atomic store semantics", async () => {
    const f = fixture(), backing = new Set<string>();
    const results = await Promise.all(Array.from({ length: 10 }, () => gate(f, new TestStore(backing))));
    expect(results.filter(value => value.executionMayStart)).toHaveLength(1);
    expect(results.filter(value => value.state === "REJECTED")).toHaveLength(9);
    expect(backing.size).toBe(3);
  });

  it.each(["blocked", "failed", "timeout", "output-limit", "post-push-verification-failed", "mutation-indeterminate"] as ExecutionOutcome[])("%s requires reconciliation, never re-enables the permit or attempt", async outcome => {
    const f = fixture(), store = new TestStore();
    expect((await gate(f, store)).executionMayStart).toBe(true);
    expect(stateAfterExecution(outcome)).toBe("RECONCILE_REQUIRED");
    expect(() => assertFinalizationTransition("CONSUMED_FOR_EXECUTION", "RECONCILE_REQUIRED")).not.toThrow();
    expect(() => assertFinalizationTransition("RECONCILE_REQUIRED", "VERIFIED_NOT_CONSUMED")).toThrow();
    expect(() => assertFinalizationTransition("RECONCILE_REQUIRED", "CONSUMED_FOR_EXECUTION")).toThrow();
    expect(await gate(f, new TestStore(store.backing))).toEqual({ state: "REJECTED", executionMayStart: false });
    const nextPermit = structuredClone(f.permit), nextContext = structuredClone(f.executionContext);
    nextPermit.payload.jti = jti(); nextPermit.payload.permitId = randomUUID();
    nextContext.humanApprovalJti = nextPermit.payload.humanApprovalJti = jti();
    // A fresh permit and Human jti still cannot resurrect the consumed attempt.
    expect(await gate(f, new TestStore(store.backing), f.signPermit(nextPermit), nextContext)).toEqual({ state: "REJECTED", executionMayStart: false });
  });

  it("verified execution remains consumed and terminal states cannot transition back", () => {
    expect(stateAfterExecution("verified")).toBe("CONSUMED_FOR_EXECUTION");
    for (const from of ["CONSUMED_FOR_EXECUTION", "REJECTED", "RECONCILE_REQUIRED"] as const) {
      expect(() => assertFinalizationTransition(from, "VERIFIED_NOT_CONSUMED")).toThrow();
      expect(() => assertFinalizationTransition(from, "CONSUMED_FOR_EXECUTION")).toThrow();
    }
    expect(() => assertFinalizationTransition("VERIFIED_NOT_CONSUMED", "CONSUMED_FOR_EXECUTION")).not.toThrow();
  });

  it("invalid evidence never calls the store", async () => {
    const f = fixture(), store = new TestStore();
    expect(await gate(f, store, { ...f.permit, signature: "forged" })).toEqual({ state: "REJECTED", executionMayStart: false });
    expect(store.calls).toBe(0);
  });

  it("a non-boolean store acknowledgement never authorizes execution", async () => {
    const f = fixture();
    const broken: AtomicExecutionConsumptionStore = { consumeOnce: async () => undefined as unknown as boolean };
    expect(await gate(f, broken)).toEqual({ state: "RECONCILE_REQUIRED", executionMayStart: false });
  });

  it.each([false, true])("unknown store commit outcome (committed=%s) requires reconciliation", async committed => {
    const f = fixture(), backing = new TestStore();
    const store: AtomicExecutionConsumptionStore = { async consumeOnce(keys) {
      if (committed) await backing.consumeOnce(keys);
      throw new Error("Store connection lost");
    } };
    expect(await gate(f, store)).toEqual({ state: "RECONCILE_REQUIRED", executionMayStart: false });
    if (committed) expect(await gate(f, new TestStore(backing.backing))).toEqual({ state: "REJECTED", executionMayStart: false });
  });

  it.each(["context", "expiry", "evidence", "key-revocation"])("%s changes during consumption require reconciliation without releasing any keys", async fault => {
    const f = fixture(), backing = new TestStore(); let clock = now;
    const store: AtomicExecutionConsumptionStore = { async consumeOnce(keys) {
      const result = await backing.consumeOnce(keys);
      if (fault === "context") f.executionContext.reviewIsCurrent = false;
      if (fault === "expiry") clock = now + 60_000;
      if (fault === "evidence") f.permit.payload.permitId = randomUUID();
      if (fault === "key-revocation") f.finalizerKeys.clear();
      return result;
    } };
    const result = await consumeExecutionPermit(f.permit, f.finalizerKeys, { store, freshContext: () => f.executionContext, now: () => clock });
    expect(result).toEqual({ state: "RECONCILE_REQUIRED", executionMayStart: false });
    expect(backing.backing.size).toBe(3);
  });
});
