import { describe, expect, it } from "vitest";
import { hashRecord, type DevelopmentBinding } from "../src/execution-orchestrator/development/contract.js";
import { assertTransition, freshAttemptPreconditions, states, transitionGraph, transitionPreconditions,
  type State, type Transition } from "../src/execution-orchestrator/development/state-machine.js";

const forward: State[] = ["REQUEST_FIXED", "ATTEMPT_FIXED", "CANDIDATE_PREPARING", "CANDIDATE_READY",
  "DISPATCH_RESERVED", "WORKER_DISPATCH_IN_PROGRESS", "PROPOSAL_FIXED", "CANDIDATE_MUTATION_IN_PROGRESS",
  "CANDIDATE_MUTATION_CONFIRMED", "FAST_IN_PROGRESS", "FAST_EVIDENCE_FIXED", "REVIEW_PENDING",
  "REVIEW_RECORD_PREPARED", "PASS_RECORDED", "MATERIALIZATION_ELIGIBLE", "CANONICAL_MATERIALIZATION_RESERVED",
  "CANONICAL_MUTATION_IN_PROGRESS", "CANONICAL_MUTATION_CONFIRMED", "REVIEW_VERIFY_IN_PROGRESS",
  "REVIEW_VERIFIED", "HUMAN_COMMIT_CHECKPOINT"];
const expectedEdges: [State, State][] = forward.slice(1).map((to, i) => [forward[i], to]);
expectedEdges.push(["REVIEW_RECORD_PREPARED", "ATTEMPT_REJECTED"],
  ...forward.slice(0, 8).map((from): [State, State] => [from, "FAILED_KNOWN"]),
  ["CANDIDATE_MUTATION_IN_PROGRESS", "CANDIDATE_MUTATION_UNKNOWN"],
  ["FAST_IN_PROGRESS", "FAST_FAILED_KNOWN"], ["REVIEW_VERIFY_IN_PROGRESS", "REVIEW_VERIFY_FAILED_KNOWN"],
  ...forward.slice(0, 16).filter(from => from !== "CANDIDATE_MUTATION_IN_PROGRESS")
    .map((from): [State, State] => [from, "STALE_CANDIDATE"]),
  ...states.filter(from => from !== "RECONCILE_REQUIRED").map((from): [State, State] => [from, "RECONCILE_REQUIRED"]));
const outcomes = ["NOT_STARTED", "CONFIRMED", "FAILED_WITHOUT_MUTATION", "UNKNOWN"] as const;
const digest = "a".repeat(64);
const seal = <T extends { digest: string }>(value: T): T => ({ ...value, digest: hashRecord(value) });
function binding(result: "PASS" | "NEEDS_WORK" = "PASS"): DevelopmentBinding {
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION" as const, id: "dev2-delegation-human",
    policyId: "dev2-policy-fixed", policyDigest: digest, repositoryId: "dev2-repository-canonical",
    baselineHead: "b".repeat(40), scope: ["src/example.ts"], maxAttempts: 2, digest });
  const request = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST" as const, id: "dev2-request-one",
    delegationDigest: delegation.digest, goalDigest: digest, acceptanceCriteriaDigest: digest, digest });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT" as const, id: "dev2-attempt-one",
    requestDigest: request.digest, sequence: 1, candidateGeneration: 1, predecessor: null,
    candidateId: "dev2-candidate-one", sessionId: "dev2-session-one", executionId: "dev2-execution-one",
    manifestId: "dev2-manifest-one", fastId: "dev2-fast-one", advisoryReviewId: "dev2-review-one",
    materializationId: "dev2-materialization-one", reviewReceiptId: "dev2-receipt-one", inputSnapshotDigest: digest, digest });
  const manifest = seal({ domain: "RC02_DEVELOPMENT_V2_MANIFEST" as const, id: attempt.manifestId,
    attemptDigest: attempt.digest, proposalDigest: digest, digest,
    files: [{ path: "src/example.ts", operation: "CREATED" as const, before: { state: "MISSING" as const },
      after: { state: "FILE" as const, byteLength: 1, sha256: digest } }] });
  const fast = seal({ domain: "RC02_DEVELOPMENT_V2_FAST" as const, id: attempt.fastId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, requestedProfile: "FAST" as const,
    effectiveProfile: "FAST" as const, result: "PASS" as const, evidenceDigest: digest, digest });
  const review = seal({ domain: "RC02_DEVELOPMENT_V2_ADVISORY_REVIEW" as const, id: attempt.advisoryReviewId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, fastDigest: fast.digest,
    result, findingsDigest: digest, digest });
  if (result === "NEEDS_WORK") return { delegation, request, attempt, manifest, fast, review };
  const materialization = seal({ domain: "RC02_DEVELOPMENT_V2_MATERIALIZATION" as const, id: attempt.materializationId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, advisoryReviewDigest: review.digest, digest });
  const reviewReceipt = seal({ domain: "RC02_DEVELOPMENT_V2_REVIEW_RECEIPT" as const, id: attempt.reviewReceiptId,
    attemptDigest: attempt.digest, manifestDigest: manifest.digest, materializationDigest: materialization.digest,
    requestedProfile: "REVIEW" as const, effectiveProfile: "REVIEW" as const, result: "PASS" as const, evidenceDigest: digest, digest });
  return { delegation, request, attempt, manifest, fast, review, materialization, reviewReceipt };
}
const transition = (from: State, to: State, candidateOutcome: Transition["candidateOutcome"] = "CONFIRMED",
  canonicalOutcome: Transition["canonicalOutcome"] = "NOT_STARTED"): Transition => ({ from, to, candidateOutcome, canonicalOutcome });

describe("Development V2 exact pure transition graph", () => {
  it("matches the independent specification and rejects every absent edge for every outcome", () => {
    const key = ([from, to]: readonly [State, State]) => `${from}>${to}`;
    expect(transitionGraph.map(key).sort()).toEqual(expectedEdges.map(key).sort());
    expect(new Set(transitionGraph.map(key)).size).toBe(transitionGraph.length);
    for (const from of states) for (const to of states) {
      let permitted = false;
      for (const candidateOutcome of outcomes) for (const canonicalOutcome of outcomes) {
        try { assertTransition({ from, to, candidateOutcome, canonicalOutcome }); permitted = true; }
        catch { /* exhaustive negative space */ }
      }
      // Re-observing canonical UNKNOWN in RECONCILE_REQUIRED is an idempotent fence, not a resume.
      expect(permitted, `${from}>${to}`).toBe(expectedEdges.some(edge => edge[0] === from && edge[1] === to) ||
        from === "RECONCILE_REQUIRED" && to === "RECONCILE_REQUIRED");
    }
  });
  it("permits the complete forward chain with correct outcomes", () => {
    const b = binding();
    for (let i = 1; i < forward.length; i++) {
      const candidate = i >= 8 ? "CONFIRMED" : "NOT_STARTED";
      const canonical = i >= 17 ? "CONFIRMED" : "NOT_STARTED";
      expect(transitionPreconditions(transition(forward[i - 1], forward[i], candidate, canonical), b, b))
        .toEqual({ disposition: "REQUIRES_HOST_AUTHORIZATION", kind: "LOCAL_PRECONDITIONS_ONLY" });
    }
  });
  it("has exactly one dispatch and materialization entry and no reverse or retry edges", () => {
    for (const target of ["WORKER_DISPATCH_IN_PROGRESS", "CANONICAL_MUTATION_IN_PROGRESS"])
      expect(transitionGraph.filter(([, to]) => to === target)).toHaveLength(1);
    for (let i = 1; i < forward.length; i++) for (let j = 0; j < i; j++)
      expect(() => assertTransition(transition(forward[i], forward[j]))).toThrow();
    for (const value of ["RUNNING", "APPROVED", "DONE", "FULL", "COMMIT", "PUSH", "DEPLOY", "ACTIVATE", "RETRY", "REDISPATCH"])
      expect(() => assertTransition({ ...transition("REQUEST_FIXED", "ATTEMPT_FIXED"), to: value })).toThrow();
  });
  it("NEEDS_WORK closes the attempt and cannot record PASS or materialize", () => {
    const b = binding("NEEDS_WORK");
    expect(() => transitionPreconditions(transition("REVIEW_RECORD_PREPARED", "ATTEMPT_REJECTED"), b, b)).not.toThrow();
    expect(() => transitionPreconditions(transition("REVIEW_RECORD_PREPARED", "PASS_RECORDED"), b, b)).toThrow();
    expect(() => transitionPreconditions(transition("PASS_RECORDED", "MATERIALIZATION_ELIGIBLE"), b, b)).toThrow();
    expect(transitionGraph.filter(([from]) => from === "ATTEMPT_REJECTED")).toEqual([["ATTEMPT_REJECTED", "RECONCILE_REQUIRED"]]);
    expect(() => freshAttemptPreconditions([b], b, "ATTEMPT_REJECTED")).toThrow();
  });
  it("fresh attempt is a separate identity and requires host authorization even after candidate uncertainty", () => {
    const b = binding("NEEDS_WORK");
    const next = { delegation: b.delegation, request: b.request, attempt: seal({ ...b.attempt,
      id: "dev2-attempt-two", sequence: 2, candidateGeneration: 2, predecessor: { id: b.attempt.id, digest: b.attempt.digest },
      candidateId: "dev2-candidate-two", sessionId: "dev2-session-two", executionId: "dev2-execution-two",
      manifestId: "dev2-manifest-two", fastId: "dev2-fast-two", advisoryReviewId: "dev2-review-two",
      materializationId: "dev2-materialization-two", reviewReceiptId: "dev2-receipt-two" }) };
    expect(freshAttemptPreconditions([b], next, "ATTEMPT_REJECTED").disposition).toBe("REQUIRES_HOST_AUTHORIZATION");
    expect(freshAttemptPreconditions([b], next, "CANDIDATE_MUTATION_UNKNOWN").disposition).toBe("REQUIRES_HOST_AUTHORIZATION");
    for (const state of ["RECONCILE_REQUIRED", "CANONICAL_MUTATION_IN_PROGRESS", "HUMAN_COMMIT_CHECKPOINT", "PASS_RECORDED"])
      expect(() => freshAttemptPreconditions([b], next, state)).toThrow();
  });
  it("canonical unknown outcomes are fenced from every state, including terminal states", () => {
    for (const from of states) for (const to of states) {
      const check = () => assertTransition(transition(from, to, "UNKNOWN", "UNKNOWN"));
      if (to === "RECONCILE_REQUIRED") expect(check).not.toThrow(); else expect(check).toThrow();
    }
    for (const to of states.filter(state => state !== "RECONCILE_REQUIRED"))
      expect(() => assertTransition(transition("RECONCILE_REQUIRED", to, "CONFIRMED", "CONFIRMED"))).toThrow();
  });
  it("candidate uncertainty cannot resume, confirm or become stale/retry", () => {
    expect(() => assertTransition(transition("CANDIDATE_MUTATION_IN_PROGRESS", "CANDIDATE_MUTATION_UNKNOWN", "UNKNOWN"))).not.toThrow();
    for (const to of states.filter(state => !["CANDIDATE_MUTATION_UNKNOWN", "RECONCILE_REQUIRED"].includes(state)))
      expect(() => assertTransition(transition("CANDIDATE_MUTATION_IN_PROGRESS", to, "UNKNOWN"))).toThrow();
    expect(() => assertTransition(transition("CANDIDATE_MUTATION_IN_PROGRESS", "FAILED_KNOWN", "NOT_STARTED"))).toThrow();
    expect(() => assertTransition(transition("CANDIDATE_MUTATION_IN_PROGRESS", "FAILED_KNOWN", "FAILED_WITHOUT_MUTATION"))).not.toThrow();
  });
  it("AI PASS, FAST PASS, and REVIEW receipts never grant authority or bypass ordering", () => {
    const b = binding();
    expect(() => transitionPreconditions(transition("FAST_EVIDENCE_FIXED", "MATERIALIZATION_ELIGIBLE"), b, b)).toThrow();
    expect(() => transitionPreconditions(transition("REVIEW_PENDING", "MATERIALIZATION_ELIGIBLE"), b, b)).toThrow();
    const { review: _review, materialization: _material, reviewReceipt: _receipt, ...fastOnly } = b;
    expect(() => transitionPreconditions(transition("PASS_RECORDED", "MATERIALIZATION_ELIGIBLE"), fastOnly, fastOnly)).toThrow();
    expect(() => transitionPreconditions(transition("PASS_RECORDED", "MATERIALIZATION_ELIGIBLE"), b, undefined)).toThrow();
    expect(transitionPreconditions(transition("PASS_RECORDED", "MATERIALIZATION_ELIGIBLE"), b, b).disposition).toBe("REQUIRES_HOST_AUTHORIZATION");
    expect(transitionPreconditions(transition("REVIEW_VERIFIED", "HUMAN_COMMIT_CHECKPOINT", "CONFIRMED", "CONFIRMED"), b, b).disposition)
      .toBe("REQUIRES_HOST_AUTHORIZATION");
  });
  it("requires bound evidence and rejects caller authority/outcome inventions", () => {
    const b = binding();
    for (const key of ["authorized", "approved", "executable", "argv", "cwd", "model", "provider", "verificationProfile"])
      expect(() => assertTransition({ ...transition("REQUEST_FIXED", "ATTEMPT_FIXED", "NOT_STARTED"), [key]: true })).toThrow();
    for (const key of ["manifest", "fast", "review", "materialization", "reviewReceipt"] as const) {
      const changed = structuredClone(b); delete changed[key];
      expect(() => transitionPreconditions(transition("REVIEW_VERIFIED", "HUMAN_COMMIT_CHECKPOINT", "CONFIRMED", "CONFIRMED"), changed, changed)).toThrow();
    }
    expect(() => assertTransition({ ...transition("REQUEST_FIXED", "ATTEMPT_FIXED"), canonicalOutcome: "PASS" })).toThrow();
    expect(() => assertTransition(transition("CANONICAL_MUTATION_IN_PROGRESS", "CANONICAL_MUTATION_CONFIRMED"))).toThrow();
  });
});
