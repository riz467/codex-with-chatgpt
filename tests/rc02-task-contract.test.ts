import { describe, expect, it } from "vitest";
import { canonicalJson, hashAttempt, hashRequest, hashScope, validateTaskBinding,
  type GateDecision, type TaskBinding } from "../src/task-contract/contract.js";

const digest = (character: string) => character.repeat(64);
function fixture(): TaskBinding {
  const request = { version: 2 as const, taskId: "task-one", repoId: "repo-one", requestHash: digest("0"),
    goalDigest: digest("1"), acceptanceCriteriaDigest: digest("2"), executionProfileId: "profile-text",
    profileDigest: digest("3"), policyDigest: digest("4"), targetGeneration: 7,
    exactEditScope: ["README.md", "docs/change.md"], scopeDigest: hashScope(["README.md", "docs/change.md"]),
    editContractKind: "v03_exact_text" as const };
  request.requestHash = hashRequest(request);
  const attempt = { version: 2 as const, taskId: request.taskId, requestHash: request.requestHash,
    attemptId: "attempt-one", attemptHash: digest("0"), attemptSequence: 1,
    baselineIdentity: digest("5"), inputSnapshotDigest: digest("6") };
  attempt.attemptHash = hashAttempt(attempt);
  const gate: GateDecision = { gateVersion: 2, taskId: request.taskId, requestHash: request.requestHash,
    repoId: request.repoId, executionProfileId: request.executionProfileId, profileDigest: request.profileDigest,
    policyDigest: request.policyDigest, targetGeneration: request.targetGeneration,
    exactEditScope: [...request.exactEditScope], scopeDigest: request.scopeDigest, editContractKind: request.editContractKind,
    attemptId: attempt.attemptId, attemptHash: attempt.attemptHash, attemptSequence: attempt.attemptSequence,
    baselineIdentity: attempt.baselineIdentity, decision: "ALLOW_BOUNDED_EDIT", reasonCode: "BOUNDED_EDIT",
    reason: "Host assessed the fixed local edit contract.",
    allowedOperations: ["tracked_utf8_exact_text_edit", "fixed_verify", "review_artifact"], evidenceRefs: ["evidence-one"] };
  return { request, attempt, gate };
}

describe("RC02 task binding is consistency, not authorization", () => {
  it("accepts exact independently supplied expectations and freezes a copy", () => {
    const candidate = fixture();
    const result = validateTaskBinding(candidate, fixture());
    expect(result.kind).toBe("BINDING_ONLY");
    expect(result).not.toHaveProperty("authorized");
    expect(result).not.toHaveProperty("executionMayStart");
    expect(Object.isFrozen(result.binding.gate.exactEditScope)).toBe(true);
    candidate.gate.reason = "Changed after validation";
    expect(result.binding.gate.reason).not.toBe(candidate.gate.reason);
  });

  it.each([undefined, null])("rejects missing/null gate: %s", gate => {
    const input: Record<string, unknown> = fixture();
    if (gate === undefined) delete input.gate;
    else input.gate = gate;
    expect(() => validateTaskBinding(input, fixture())).toThrow();
  });

  it.each(["request", "attempt", "gate"] as const)("rejects unsupported %s version", part => {
    const input = fixture();
    if (part === "gate") input.gate.gateVersion = 1 as 2;
    else input[part].version = 1 as 2;
    expect(() => validateTaskBinding(input, fixture())).toThrow();
  });

  it.each([
    ["taskId", "task-other"], ["requestHash", digest("a")], ["attemptId", "attempt-other"],
    ["attemptHash", digest("a")], ["attemptSequence", 2], ["repoId", "repo-other"],
    ["baselineIdentity", digest("a")], ["executionProfileId", "profile-other"],
    ["profileDigest", digest("a")], ["policyDigest", digest("a")], ["targetGeneration", 8],
    ["exactEditScope", ["OTHER.md"]], ["scopeDigest", digest("a")],
    ["editContractKind", "bounded_v2_range_edit"], ["decision", "PASS"],
    ["reasonCode", "CALLER_ALLOWED"], ["allowedOperations", ["fixed_verify"]],
    ["evidenceRefs", ["caller-evidence"]], ["reason", "caller rewrote the rationale"],
  ])("rejects gate mismatch: %s", (field, value) => {
    const input = fixture();
    (input.gate as unknown as Record<string, unknown>)[field as string] = value;
    expect(() => validateTaskBinding(input, fixture())).toThrow();
  });

  it("rejects a self-consistent caller ALLOW against the independent host contract", () => {
    const forged = fixture();
    forged.request.goalDigest = digest("a");
    forged.request.requestHash = hashRequest(forged.request);
    forged.attempt.requestHash = forged.request.requestHash;
    forged.attempt.attemptHash = hashAttempt(forged.attempt);
    forged.gate.requestHash = forged.request.requestHash;
    forged.gate.attemptHash = forged.attempt.attemptHash;
    expect(() => validateTaskBinding(forged, fixture())).toThrow("Host contract mismatch");
    // An exact match checks consistency only, even when the decision says ALLOW.
    expect(validateTaskBinding(forged, forged).kind).toBe("BINDING_ONLY");
    expect(() => validateTaskBinding(forged, undefined)).toThrow();
  });

  it("cannot turn a host refusal into caller ALLOW", () => {
    const host = fixture();
    host.gate.decision = "STOP_OPERATION";
    host.gate.reasonCode = "LIVE_OPERATION_REQUESTED";
    host.gate.allowedOperations = [];
    expect(validateTaskBinding(host, host).binding.gate.decision).toBe("STOP_OPERATION");
    expect(() => validateTaskBinding(fixture(), host)).toThrow();
  });

  it.each(["request", "attempt"] as const)("recomputes %s identity rather than accepting a claimed digest", part => {
    const input = fixture();
    if (part === "request") input.request.acceptanceCriteriaDigest = digest("a");
    else input.attempt.inputSnapshotDigest = digest("a");
    expect(() => validateTaskBinding(input, input)).toThrow("Identity digest mismatch");
  });

  it.each([
    ["docs/change.md", "README.md"], ["README.md", "README.md"], ["README.md", "readme.md"],
    ["../outside.md"], ["/absolute.md"], ["docs//change.md"], ["docs/./change.md"],
    ["C:/file.md"], ["docs\\change.md"], ["docs/file.md:stream"], ["docs/file.md."],
    ["docs/file.md "], [".git/config"], [".ai/status.json"], ["CON.txt"], ["a\u0000.md"],
  ])("rejects reordered/duplicate/nonportable scope %j", (...scope) => {
    expect(() => hashScope(scope)).toThrow();
    const input = fixture();
    input.request.exactEditScope = scope;
    input.gate.exactEditScope = scope;
    expect(() => validateTaskBinding(input, fixture())).toThrow();
  });

  it.each(["a".repeat(63), "A".repeat(64), "g".repeat(64)])("rejects malformed digest %s", malformed => {
    const input = fixture(); input.request.policyDigest = malformed;
    expect(() => validateTaskBinding(input, fixture())).toThrow();
  });

  it.each(["PASS", "current", "policyAllowed", "authorized", "doneApproved"])("rejects extra authority field %s", key => {
    for (const part of ["root", "request", "attempt", "gate"] as const) {
      const input = fixture();
      const object = part === "root" ? input : input[part];
      Object.assign(object, { [key]: true });
      expect(() => validateTaskBinding(input, fixture())).toThrow();
    }
  });

  it("rejects hidden fields, accessors, prototypes, sparse arrays and non-JSON without invoking getters", () => {
    const input = fixture(); let called = false;
    Object.defineProperty(input.gate, "current", { get() { called = true; return true; }, enumerable: true });
    expect(() => validateTaskBinding(input, fixture())).toThrow(); expect(called).toBe(false);
    const hidden = fixture(); Object.defineProperty(hidden.gate, "PASS", { value: true });
    expect(() => validateTaskBinding(hidden, fixture())).toThrow();
    const inherited = fixture(); Object.setPrototypeOf(inherited.gate, { current: true });
    expect(() => validateTaskBinding(inherited, fixture())).toThrow();
    const sparse = fixture(); sparse.gate.evidenceRefs = new Array(1);
    expect(() => validateTaskBinding(sparse, fixture())).toThrow();
    expect(() => canonicalJson({ unsafe: undefined })).toThrow();
    expect(() => canonicalJson({ unsafe: -0 })).toThrow();
  });

  it("accepts the separate range-edit contract without silently converting formats", () => {
    const input = fixture(); input.request.editContractKind = "bounded_v2_range_edit";
    input.request.requestHash = hashRequest(input.request);
    input.attempt.requestHash = input.request.requestHash;
    input.attempt.attemptHash = hashAttempt(input.attempt);
    input.gate.editContractKind = input.request.editContractKind;
    input.gate.requestHash = input.request.requestHash;
    input.gate.attemptHash = input.attempt.attemptHash;
    input.gate.allowedOperations[0] = "tracked_utf8_range_edit";
    expect(validateTaskBinding(input, input).kind).toBe("BINDING_ONLY");
  });
});
