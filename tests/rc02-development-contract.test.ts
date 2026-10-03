import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertFreshAttempt, consumeMaterialization, hashRecord, parseBinding, validateBinding,
  type DevelopmentBinding } from "../src/execution-orchestrator/development/contract.js";

const digest = "a".repeat(64);
const seal = <T extends { digest: string }>(value: T): T => ({ ...value, digest: hashRecord(value) });
function fixture(n = 1, previous?: DevelopmentBinding): DevelopmentBinding {
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION" as const, id: "dev2-delegation-human",
    policyId: "dev2-policy-fixed", policyDigest: digest, repositoryId: "dev2-repository-canonical",
    baselineHead: "b".repeat(40), scope: ["src/example.ts"], maxAttempts: 3, digest });
  const request = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST" as const, id: "dev2-request-one",
    delegationDigest: delegation.digest, goalDigest: digest, acceptanceCriteriaDigest: digest, digest });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT" as const, id: `dev2-attempt-${n}`,
    requestDigest: request.digest, sequence: n, candidateGeneration: n,
    predecessor: previous ? { id: previous.attempt.id, digest: previous.attempt.digest } : null,
    candidateId: `dev2-candidate-${n}`, sessionId: `dev2-session-${n}`, executionId: `dev2-execution-${n}`,
    manifestId: `dev2-manifest-${n}`, fastId: `dev2-fast-${n}`, advisoryReviewId: `dev2-review-${n}`,
    materializationId: `dev2-materialization-${n}`, reviewReceiptId: `dev2-receipt-${n}`, inputSnapshotDigest: digest, digest });
  const manifest = seal({ domain: "RC02_DEVELOPMENT_V2_MANIFEST" as const, id: attempt.manifestId,
    attemptDigest: attempt.digest, proposalDigest: digest, digest,
    files: [{ path: "src/example.ts", operation: "CREATED" as const, before: { state: "MISSING" as const },
      after: { state: "FILE" as const, byteLength: 0, sha256: createHash("sha256").update("").digest("hex") } }] });
  const fast = seal({ domain: "RC02_DEVELOPMENT_V2_FAST" as const, id: attempt.fastId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, requestedProfile: "FAST" as const,
    effectiveProfile: "FAST" as const, result: "PASS" as const, evidenceDigest: digest, digest });
  const review = seal({ domain: "RC02_DEVELOPMENT_V2_ADVISORY_REVIEW" as const, id: attempt.advisoryReviewId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, fastDigest: fast.digest,
    result: "PASS" as const, findingsDigest: digest, digest });
  const materialization = seal({ domain: "RC02_DEVELOPMENT_V2_MATERIALIZATION" as const, id: attempt.materializationId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, advisoryReviewDigest: review.digest, digest });
  const reviewReceipt = seal({ domain: "RC02_DEVELOPMENT_V2_REVIEW_RECEIPT" as const, id: attempt.reviewReceiptId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, materializationDigest: materialization.digest,
    requestedProfile: "REVIEW" as const, effectiveProfile: "REVIEW" as const, result: "PASS" as const,
    evidenceDigest: digest, digest });
  return { delegation, request, attempt, manifest, fast, review, materialization, reviewReceipt };
}
const bare = (b: DevelopmentBinding) => ({ delegation: b.delegation, request: b.request, attempt: b.attempt });

describe("Development V2 pure identities", () => {
  it("binds the entire immutable chain without granting authority", () => {
    const b = fixture();
    const result = validateBinding(b, structuredClone(b));
    expect(result.kind).toBe("BINDING_ONLY");
    expect(Object.isFrozen(result.binding.manifest?.files[0].after)).toBe(true);
    expect(() => validateBinding(b, { ...b, attempt: fixture(2, b).attempt })).toThrow();
    expect(() => parseBinding({ ...b, attempt: { ...b.attempt, id: "bounded-0123456789" } })).toThrow();
  });
  it("uses canonical key order and domain-separated hashes", () => {
    const b = fixture();
    expect(hashRecord(Object.fromEntries(Object.entries(b.attempt).reverse()))).toBe(b.attempt.digest);
    expect(() => hashRecord({ ...b.attempt, domain: "BOUNDED_V2" })).toThrow();
    for (const key of ["delegation", "request", "attempt", "manifest", "fast", "review", "materialization", "reviewReceipt"] as const) {
      const changed = structuredClone(b);
      changed[key]!.digest = "0".repeat(64);
      expect(() => parseBinding(changed)).toThrow("digest");
    }
  });
  it("rejects cross-attempt manifest, FAST, advisory review, materialization and receipt", () => {
    const first = fixture(), second = fixture(2, first);
    for (const key of ["manifest", "fast", "review", "materialization", "reviewReceipt"] as const)
      expect(() => parseBinding({ ...second, [key]: first[key] })).toThrow();
    for (const key of ["manifest", "fast", "review", "materialization", "reviewReceipt"] as const) {
      const b = fixture();
      b[key] = seal({ ...b[key]!, attemptDigest: "c".repeat(64) }) as never;
      expect(() => parseBinding(b)).toThrow();
    }
  });
  it("requires complete lineage and new reserved evidence identities before fresh execution", () => {
    const first = fixture(), next = bare(fixture(2, first));
    expect(() => assertFreshAttempt([first], next)).not.toThrow();
    expect(() => assertFreshAttempt([first], bare(first))).toThrow();
    expect(() => assertFreshAttempt([first], fixture(2, first))).toThrow();
    for (const key of ["id", "candidateId", "sessionId", "executionId", "manifestId", "fastId", "advisoryReviewId",
      "materializationId", "reviewReceiptId"] as const) {
      const changed = structuredClone(next);
      changed.attempt = seal({ ...changed.attempt, [key]: first.attempt[key] });
      expect(() => assertFreshAttempt([first], changed)).toThrow();
    }
    const third = bare(fixture(3, next));
    expect(() => assertFreshAttempt([first, next], third)).not.toThrow();
    expect(() => assertFreshAttempt([next], third)).toThrow();
    expect(() => assertFreshAttempt([first, next, third], bare(fixture(4, third)))).toThrow();
  });
  it("keeps MISSING distinct from an empty file and restricts operations", () => {
    const b = fixture();
    expect(parseBinding(b).manifest?.files[0].before).toEqual({ state: "MISSING" });
    for (const operation of ["DELETED", "RENAMED", "UNCHANGED", "MODIFIED"]) {
      const changed = structuredClone(b);
      (changed.manifest!.files[0] as { operation: string }).operation = operation;
      expect(() => parseBinding(changed)).toThrow();
    }
    const changed = structuredClone(b);
    changed.manifest!.files[0].after.sha256 = digest;
    changed.manifest = seal(changed.manifest!);
    expect(() => parseBinding(changed)).toThrow("Empty file");
    const row = { path: "src/example.ts", operation: "UNCHANGED" as const,
      before: { state: "FILE" as const, sha256: digest, byteLength: 1 },
      after: { state: "FILE" as const, sha256: digest, byteLength: 1 } };
    const minimal = { ...bare(b), manifest: seal({ ...b.manifest!, files: [row] }) };
    expect(() => parseBinding(minimal)).not.toThrow();
    expect(() => parseBinding({ ...minimal, manifest: seal({ ...minimal.manifest,
      files: [{ ...row, operation: "MODIFIED" }] }) })).toThrow("operation");
    expect(() => parseBinding({ ...minimal, manifest: seal({ ...minimal.manifest,
      files: [{ ...row, operation: "MODIFIED", after: { ...row.after, sha256: "c".repeat(64) } }] }) })).not.toThrow();
  });
  it("consumes materialization once in the supplied history, never issues a permit", () => {
    const b = fixture(), first = consumeMaterialization(b, b, []);
    expect(first.kind).toBe("CONSUMPTION_PROJECTION_ONLY");
    expect(() => consumeMaterialization(b, b, first.consumed)).toThrow("consumed");
    expect(() => consumeMaterialization(b, b, [...first.consumed, ...first.consumed])).toThrow();
    expect(() => consumeMaterialization(bare(b), bare(b), [])).toThrow();
  });
  it.each(["approved", "authorized", "current", "pass", "DoneApproved", "executable", "argv", "cwd", "model", "provider", "verificationProfile"])
    ("rejects caller field %s at every layer", key => {
      const b = fixture();
      expect(() => parseBinding({ ...b, [key]: true })).toThrow();
      for (const layer of Object.keys(b) as (keyof DevelopmentBinding)[])
        expect(() => parseBinding({ ...b, [layer]: { ...b[layer], [key]: true } })).toThrow();
    });
  it.each([["b.ts", "a.ts"], ["a.ts", "a.ts"], ["A.ts", "a.ts"], ["../a.ts"], ["/a.ts"],
    ["C:/a.ts"], ["src\\a.ts"], ["src/.git/a.ts"], ["src/NUL.ts"], ["src/a .ts"], ["src/é.ts"]])
    ("rejects unsafe or noncanonical scope %j", (...scope) => {
      const b = fixture();
      expect(() => parseBinding({ ...b, delegation: { ...b.delegation, scope } })).toThrow();
    });
  it("rejects prototypes, accessors, hidden properties and sparse arrays without invoking getters", () => {
    const b = fixture();
    let reads = 0;
    expect(() => parseBinding(Object.create(b))).toThrow();
    expect(() => parseBinding({ ...b, get attempt() { reads++; return b.attempt; } })).toThrow();
    expect(reads).toBe(0);
    expect(() => parseBinding(Object.defineProperty(b, "hidden", { value: true }))).toThrow();
    const sparse = fixture(); sparse.delegation.scope = new Array(2);
    expect(() => parseBinding(sparse)).toThrow();
    expect(() => parseBinding({ ...fixture(), attempt: new Date() })).toThrow();
  });
});
