import { describe, expect, it } from "vitest";
import { hashAttempt, hashRequest, hashScope, type GateDecision, type TaskBinding } from "../src/task-contract/contract.js";
import { assertExecutionTransition, classifyAuthorityObservation, executionStates, operationEligibility,
  operations, stateForMutationOutcome, type ExecutionState, type LifecycleSnapshot } from "../src/task-contract/lifecycle.js";

const digest = "a".repeat(64);
function binding(): TaskBinding {
  const request = { version: 2 as const, taskId: "task-one", requestHash: digest, repoId: "repo-one",
    goalDigest: digest, acceptanceCriteriaDigest: digest, executionProfileId: "profile-text",
    profileDigest: digest, policyDigest: digest, targetGeneration: 1, exactEditScope: ["README.md"],
    scopeDigest: hashScope(["README.md"]), editContractKind: "v03_exact_text" as const };
  request.requestHash = hashRequest(request);
  const attempt = { version: 2 as const, taskId: request.taskId, requestHash: request.requestHash,
    attemptId: "attempt-one", attemptHash: digest, attemptSequence: 1,
    baselineIdentity: digest, inputSnapshotDigest: digest };
  attempt.attemptHash = hashAttempt(attempt);
  const gate: GateDecision = { gateVersion: 2, taskId: request.taskId, requestHash: request.requestHash,
    repoId: request.repoId, executionProfileId: request.executionProfileId,
    profileDigest: digest, policyDigest: digest, targetGeneration: 1, exactEditScope: ["README.md"],
    scopeDigest: request.scopeDigest, editContractKind: request.editContractKind,
    attemptId: attempt.attemptId, attemptHash: attempt.attemptHash, attemptSequence: 1,
    baselineIdentity: digest, decision: "ALLOW_BOUNDED_EDIT", reasonCode: "BOUNDED_EDIT", reason: "Fixed contract.",
    allowedOperations: ["tracked_utf8_exact_text_edit", "fixed_verify", "review_artifact"], evidenceRefs: ["evidence-one"] };
  return { request, attempt, gate };
}
function snapshot(state: ExecutionState = "EXECUTION_RESERVED"): LifecycleSnapshot {
  return { state, mutationOutcome: "NOT_STARTED", identityStatus: "RESERVED", evidenceStatus: "CURRENT", binding: binding() };
}
const eligible = (value: unknown, operation: typeof operations[number]) => operationEligibility(value, operation, binding());

describe("RC02 lifecycle contains no execution or authority capability", () => {
  it.each(["READ", "DISPLAY", "VERIFY_HISTORICAL"] as const)("legacy permits inspection %s", operation => {
    const legacy = snapshot("LOCAL_DONE"); delete legacy.binding; legacy.evidenceStatus = "LEGACY";
    expect(eligible(legacy, operation).disposition).toBe("INSPECTION_ALLOWED");
  });
  it.each(["MUTATE", "VERIFY", "REQUEST_REVIEW", "APPROVE", "FINALIZE", "RETRY_VERIFY", "REDISPATCH"] as const)(
    "legacy cannot gain %s", operation => {
      const legacy = snapshot(); delete legacy.binding;
      expect(["DENIED", "REQUIRES_FRESH_REQUEST"]).toContain(eligible(legacy, operation).disposition);
    });
  it("null or missing gate cannot mutate even when local state claims validation", () => {
    for (const gate of [null, undefined]) {
      const value = snapshot(); value.binding = { ...binding(), gate };
      expect(eligible(value, "MUTATE").disposition).toBe("DENIED");
    }
  });
  it.each(["BLOCKED", "FAILED_KNOWN", "VERIFY_FAILED_KNOWN", "LOCAL_DONE"] as const)("%s cannot resume", state => {
    expect(eligible(snapshot(state), "MUTATE").disposition).toBe("DENIED");
    expect(eligible(snapshot(state), "RETRY_VERIFY").disposition).toBe("DENIED");
    expect(eligible(snapshot(state), "REDISPATCH").disposition).toBe("DENIED");
    expect(() => assertExecutionTransition(state, "EXECUTION_RESERVED", "NOT_STARTED")).toThrow();
  });
  it.each(["MUTATE", "VERIFY", "REQUEST_REVIEW", "APPROVE", "FINALIZE", "RETRY_VERIFY", "REDISPATCH"] as const)(
    "reconciliation denies %s", operation => {
      expect(eligible(snapshot("RECONCILE_REQUIRED"), operation).disposition).toBe("DENIED");
      const unknown = snapshot(); unknown.mutationOutcome = "UNKNOWN";
      expect(eligible(unknown, operation).disposition).toBe("DENIED");
    });
  it.each(["UNKNOWN", "timeout", null, undefined, "verified", { current: true }])("unknown outcome %j fails closed", outcome => {
    expect(stateForMutationOutcome(outcome)).toBe("RECONCILE_REQUIRED");
  });
  it("maps only known outcome values; NOT_STARTED does not imply a reservation", () => {
    expect(stateForMutationOutcome("NOT_STARTED")).toBe("REQUEST_FIXED");
    expect(stateForMutationOutcome("CONFIRMED")).toBe("MUTATION_CONFIRMED");
    expect(stateForMutationOutcome("FAILED_WITHOUT_MUTATION")).toBe("FAILED_KNOWN");
  });
  it("no state or unknown outcome has an executable/DONE escape from reconciliation", () => {
    for (const target of executionStates.filter(state => state !== "RECONCILE_REQUIRED")) {
      expect(() => assertExecutionTransition("RECONCILE_REQUIRED", target, "NOT_STARTED")).toThrow();
      expect(() => assertExecutionTransition("MUTATION_IN_PROGRESS", target, "UNKNOWN")).toThrow();
    }
    expect(() => assertExecutionTransition("MUTATION_IN_PROGRESS", "RECONCILE_REQUIRED", "UNKNOWN")).not.toThrow();
    expect(() => assertExecutionTransition("RECONCILE_REQUIRED", "DONE" as ExecutionState, "UNKNOWN")).toThrow();
  });
  it("every state denies implicit retry, including a model retry judgment", () => {
    for (const state of executionStates) {
      expect(eligible(snapshot(state), "RETRY_VERIFY").disposition).toBe("DENIED");
      expect(eligible(snapshot(state), "REDISPATCH").disposition).toBe("DENIED");
    }
    expect(eligible({ ...snapshot(), modelDecision: "RETRY_VERIFY" }, "RETRY_VERIFY").disposition).toBe("DENIED");
  });
  it("matching local execution preconditions still require independent host authorization", () => {
    expect(eligible(snapshot(), "MUTATE").disposition).toBe("REQUIRES_HOST_AUTHORIZATION");
    expect(operationEligibility(snapshot(), "MUTATE").disposition).toBe("DENIED");
    expect(eligible({ ...snapshot(), policyAllowed: true }, "MUTATE").disposition).toBe("DENIED");
  });
  it("known verification/review/finalization preconditions never establish authority", () => {
    for (const [state, operation] of [["MUTATION_CONFIRMED", "VERIFY"], ["VERIFICATION_PASSED", "REQUEST_REVIEW"],
      ["REVIEW_PENDING", "APPROVE"], ["REVIEW_PENDING", "FINALIZE"]] as const) {
      const value = snapshot(state); value.mutationOutcome = "CONFIRMED";
      expect(eligible(value, operation).disposition).toBe("REQUIRES_HOST_AUTHORIZATION");
    }
  });
  it.each(["CONSUMED", "QUARANTINED"] as const)("%s identity never becomes eligible again", identityStatus => {
    for (const state of executionStates) {
      const value = { ...snapshot(state), identityStatus, mutationOutcome: "CONFIRMED" };
      expect(eligible(value, "MUTATE").disposition).toBe("DENIED");
      expect(eligible(value, "FINALIZE").disposition).toBe("DENIED");
    }
  });
  it("superseded evidence requires a fresh request/attempt and fresh authority", () => {
    expect(eligible({ ...snapshot(), evidenceStatus: "SUPERSEDED" }, "MUTATE").disposition).toBe("REQUIRES_FRESH_REQUEST");
    const value = snapshot(); const changed = binding(); changed.gate.targetGeneration++;
    value.binding = changed;
    expect(eligible(value, "MUTATE").disposition).toBe("DENIED");
  });
  it.each([{ kind: "PERMIT_ISSUED" }, { kind: "APPROVAL_SIGNED" }, { kind: "REVIEW", result: "PASS" },
    { kind: "LOCAL_DONE" }, { kind: "COMPLETION_RECORD_CANDIDATE" }])("%j cannot establish approval or authoritative DONE", observation => {
    expect(classifyAuthorityObservation(observation)).toEqual({ authoritativeState: "UNVERIFIED",
      isApproval: false, requiresAuthorityVerification: true });
  });
  it("caller authority/currentness claims cannot enter the observation domain", () => {
    expect(() => classifyAuthorityObservation({ kind: "COMPLETION_RECORD_CANDIDATE", current: true })).toThrow();
    expect(() => classifyAuthorityObservation({ kind: "DONE" })).toThrow();
  });
  it("validates the forward structural path but rejects skipped stages and inconsistent outcomes", () => {
    const path = executionStates.slice(0, 8);
    for (let index = 0; index < path.length - 1; index++) {
      const outcome = index >= 4 ? "CONFIRMED" : "NOT_STARTED";
      expect(() => assertExecutionTransition(path[index], path[index + 1], outcome)).not.toThrow();
    }
    expect(() => assertExecutionTransition("REQUEST_FIXED", "MUTATION_IN_PROGRESS", "NOT_STARTED")).toThrow();
    expect(() => assertExecutionTransition("MUTATION_IN_PROGRESS", "MUTATION_CONFIRMED", "NOT_STARTED")).toThrow();
    expect(() => assertExecutionTransition("MUTATION_IN_PROGRESS", "BLOCKED", "CONFIRMED")).toThrow();
  });
});
