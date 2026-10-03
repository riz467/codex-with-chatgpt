import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/task-contract/contract.js";
import { hashRecord, type DevelopmentBinding } from "../src/execution-orchestrator/development/contract.js";
import { hashDevelopmentGoal, hashDevelopmentAcceptanceCriteria, validateRequestInputs,
  prepareRequestInputHandle, inspectRequestInputHandle } from "../src/execution-orchestrator/development/request-input.js";

const raw = () => ({ goal: { version: 1, text: "Human goal\r\n" },
  acceptanceCriteria: { version: 1, items: ["First", "Second"] } });
const digest = "a".repeat(64);
const seal = <T extends { digest: string }>(value: T): T => ({ ...value, digest: hashRecord(value) });
function fixture(requestId = "one", attemptId = "one", snapshot = digest): DevelopmentBinding {
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION" as const, id: "dev2-delegation-human",
    policyId: "dev2-policy-fixed", policyDigest: digest, repositoryId: "dev2-repository-canonical",
    baselineHead: "b".repeat(40), scope: ["src/example.ts"], maxAttempts: 3, digest });
  const request = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST" as const, id: `dev2-request-${requestId}`,
    delegationDigest: delegation.digest, goalDigest: hashDevelopmentGoal(raw().goal),
    acceptanceCriteriaDigest: hashDevelopmentAcceptanceCriteria(raw().acceptanceCriteria), digest });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT" as const, id: `dev2-attempt-${attemptId}`,
    requestDigest: request.digest, sequence: 1, candidateGeneration: 1, predecessor: null,
    candidateId: `dev2-candidate-${attemptId}`, sessionId: `dev2-session-${attemptId}`, executionId: `dev2-execution-${attemptId}`,
    manifestId: `dev2-manifest-${attemptId}`, fastId: `dev2-fast-${attemptId}`, advisoryReviewId: `dev2-review-${attemptId}`,
    materializationId: `dev2-materialization-${attemptId}`, reviewReceiptId: `dev2-receipt-${attemptId}`,
    inputSnapshotDigest: snapshot, digest });
  return { delegation, request, attempt };
}

describe("Development V2 trusted request inputs", () => {
  it("uses the exact formal domains and existing canonical JSON deterministically", () => {
    const input = raw();
    const expected = (domain: string, value: unknown) => createHash("sha256")
      .update(`${domain}\n${canonicalJson(value)}`, "utf8").digest("hex");
    expect(hashDevelopmentGoal(input.goal)).toBe(expected("RC02_DEVELOPMENT_V2_GOAL_INPUT_V1", input.goal));
    expect(hashDevelopmentAcceptanceCriteria(input.acceptanceCriteria))
      .toBe(expected("RC02_DEVELOPMENT_V2_ACCEPTANCE_INPUT_V1", input.acceptanceCriteria));
    expect(hashDevelopmentGoal(input.goal)).not.toBe(expected("RC02_DEVELOPMENT_V2_ACCEPTANCE_INPUT_V1", input.goal));
    expect(hashDevelopmentGoal({ text: input.goal.text, version: 1 })).toBe(hashDevelopmentGoal(input.goal));
    expect(hashDevelopmentAcceptanceCriteria(structuredClone(input.acceptanceCriteria)))
      .toBe(hashDevelopmentAcceptanceCriteria(input.acceptanceCriteria));
  });
  it.each(["Human Goal\r\n", "Human goal\n", "Human goal\r\n ", " Human goal\r\n"])
    ("preserves goal bytes for %j", text => {
      expect(hashDevelopmentGoal({ version: 1, text })).not.toBe(hashDevelopmentGoal(raw().goal));
    });
  it("preserves Unicode, criteria contents, whitespace and order", () => {
    expect(hashDevelopmentGoal({ version: 1, text: "é" })).not.toBe(hashDevelopmentGoal({ version: 1, text: "e\u0301" }));
    const original = hashDevelopmentAcceptanceCriteria(raw().acceptanceCriteria);
    for (const items of [["first", "Second"], ["Second", "First"], ["First ", "Second"]])
      expect(hashDevelopmentAcceptanceCriteria({ version: 1, items })).not.toBe(original);
  });
  it.each(["goalDigest", "acceptanceCriteriaDigest", "expectedGoalDigest", "expectedCriteriaDigest", "authorized"])
    ("rejects caller expected/authority field %s", key => {
      const b = fixture();
      expect(() => validateRequestInputs({ ...raw(), [key]: digest }, b, b)).toThrow();
    });
  it("rejects unknown fields and invalid versions in nested inputs", () => {
    expect(() => hashDevelopmentGoal({ ...raw().goal, extra: true })).toThrow();
    expect(() => hashDevelopmentAcceptanceCriteria({ ...raw().acceptanceCriteria, extra: true })).toThrow();
    expect(() => hashDevelopmentGoal({ ...raw().goal, version: 2 })).toThrow();
    expect(() => hashDevelopmentAcceptanceCriteria({ ...raw().acceptanceCriteria, version: 2 })).toThrow();
  });
  it("enforces all size boundaries without trimming", () => {
    for (const text of ["", "x".repeat(32769)]) expect(() => hashDevelopmentGoal({ version: 1, text })).toThrow();
    expect(() => hashDevelopmentGoal({ version: 1, text: "x".repeat(32768) })).not.toThrow();
    expect(() => hashDevelopmentGoal({ version: 1, text: " " })).not.toThrow();
    for (const items of [[], [""], ["x".repeat(4097)], Array(65).fill("x")])
      expect(() => hashDevelopmentAcceptanceCriteria({ version: 1, items })).toThrow();
    expect(() => hashDevelopmentAcceptanceCriteria({ version: 1, items: Array(64).fill("x".repeat(4096)) })).not.toThrow();
  });
  it("rejects accessors, prototypes, hidden fields and sparse arrays without invoking getters", () => {
    let reads = 0;
    const b = fixture();
    expect(() => validateRequestInputs({ get goal() { reads++; return raw().goal; }, acceptanceCriteria: raw().acceptanceCriteria }, b, b)).toThrow();
    expect(() => hashDevelopmentGoal({ version: 1, get text() { reads++; return "goal"; } })).toThrow();
    expect(reads).toBe(0);
    expect(() => hashDevelopmentGoal(Object.create(raw().goal))).toThrow();
    expect(() => hashDevelopmentGoal(Object.defineProperty(raw().goal, "hidden", { value: 1 }))).toThrow();
    expect(() => hashDevelopmentAcceptanceCriteria({ version: 1, items: new Array(2) })).toThrow();
  });
  it("rejects host mismatch before parsing raw inputs", () => {
    expect(() => validateRequestInputs(undefined, fixture(), fixture("other"))).toThrow("Host binding mismatch");
  });
  it.each(["goalDigest", "acceptanceCriteriaDigest"] as const)("rejects %s mismatch against a valid host-bound request", key => {
    const b = fixture();
    b.request = seal({ ...b.request, [key]: digest });
    b.attempt = seal({ ...b.attempt, requestDigest: b.request.digest });
    expect(() => validateRequestInputs(raw(), b, structuredClone(b))).toThrow("digest mismatch");
  });
  it("issues a frozen non-authoritative handle and isolates stored inputs from caller mutation", () => {
    const input = raw(), b = fixture(), expected = structuredClone(b);
    const handle = prepareRequestInputHandle(input, b, expected);
    input.goal.text = "changed";
    input.acceptanceCriteria.items.reverse();
    b.request.id = "dev2-request-changed";
    const result = inspectRequestInputHandle(handle, expected, structuredClone(expected));
    expect(result.inputs).toEqual(raw());
    expect(result.binding.request.digest).toBe(expected.request.digest);
    expect(Object.isFrozen(result.inputs.acceptanceCriteria.items)).toBe(true);
    expect(Object.isFrozen(result.binding.attempt)).toBe(true);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle).toEqual({ kind: "REQUEST_INPUT_HANDLE_ONLY" });
    expect(result.kind).toBe("REQUEST_INPUT_BINDING_ONLY");
    for (const key of ["authorized", "approval", "permit", "DoneApproved"])
      expect(handle).not.toHaveProperty(key);
    expect(() => validateRequestInputs(handle, expected, expected)).toThrow();
  });
  it("rejects serialized, cloned, forged and missing handles without reconstruction", () => {
    const b = fixture(), handle = prepareRequestInputHandle(raw(), b, b);
    for (const fake of [JSON.parse(JSON.stringify(handle)), structuredClone(handle), { ...handle },
      Object.create(handle), null, true, raw()])
      expect(() => inspectRequestInputHandle(fake, b, b)).toThrow("Unrecognized request input handle");
  });
  it("rejects cross-request, cross-attempt and host mismatch on handle inspection", () => {
    const b = fixture(), handle = prepareRequestInputHandle(raw(), b, b);
    for (const other of [fixture("other"), fixture("one", "other")])
      expect(() => inspectRequestInputHandle(handle, other, other)).toThrow("handle binding mismatch");
    expect(() => inspectRequestInputHandle(handle, b, fixture("other"))).toThrow("Host binding mismatch");
  });
  it("does not reinterpret or modify inputSnapshotDigest", () => {
    for (const snapshot of ["0".repeat(64), "f".repeat(64)]) {
      const b = fixture("one", "one", snapshot), before = structuredClone(b);
      const result = validateRequestInputs(raw(), b, structuredClone(b));
      expect(result.binding.attempt.inputSnapshotDigest).toBe(snapshot);
      expect(b).toEqual(before);
      expect(result.inputs).toEqual(raw());
    }
  });
});
