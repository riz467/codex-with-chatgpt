import { z } from "zod";
import { freeze, parseStrict } from "../../task-contract/contract.js";
import { assertFreshAttempt, validateBinding } from "./contract.js";

export const states = ["REQUEST_FIXED", "ATTEMPT_FIXED", "CANDIDATE_PREPARING", "CANDIDATE_READY",
  "DISPATCH_RESERVED", "WORKER_DISPATCH_IN_PROGRESS", "PROPOSAL_FIXED", "CANDIDATE_MUTATION_IN_PROGRESS",
  "CANDIDATE_MUTATION_CONFIRMED", "FAST_IN_PROGRESS", "FAST_EVIDENCE_FIXED", "REVIEW_PENDING",
  "REVIEW_RECORD_PREPARED", "ATTEMPT_REJECTED", "PASS_RECORDED", "MATERIALIZATION_ELIGIBLE",
  "CANONICAL_MATERIALIZATION_RESERVED", "CANONICAL_MUTATION_IN_PROGRESS", "CANONICAL_MUTATION_CONFIRMED",
  "REVIEW_VERIFY_IN_PROGRESS", "REVIEW_VERIFIED", "HUMAN_COMMIT_CHECKPOINT", "FAILED_KNOWN",
  "CANDIDATE_MUTATION_UNKNOWN", "FAST_FAILED_KNOWN", "STALE_CANDIDATE", "REVIEW_VERIFY_FAILED_KNOWN",
  "RECONCILE_REQUIRED"] as const;
export type State = typeof states[number];
const main = states.slice(0, 13);
const accepted = ["PASS_RECORDED", "MATERIALIZATION_ELIGIBLE", "CANONICAL_MATERIALIZATION_RESERVED",
  "CANONICAL_MUTATION_IN_PROGRESS", "CANONICAL_MUTATION_CONFIRMED", "REVIEW_VERIFY_IN_PROGRESS",
  "REVIEW_VERIFIED", "HUMAN_COMMIT_CHECKPOINT"] as const;
const pairs: [State, State][] = [];
for (const chain of [main, accepted]) for (let i = 1; i < chain.length; i++) pairs.push([chain[i - 1], chain[i]]);
pairs.push(["REVIEW_RECORD_PREPARED", "ATTEMPT_REJECTED"], ["REVIEW_RECORD_PREPARED", "PASS_RECORDED"]);
for (const state of main.slice(0, 7)) pairs.push([state, "FAILED_KNOWN"]);
pairs.push(["CANDIDATE_MUTATION_IN_PROGRESS", "FAILED_KNOWN"],
  ["CANDIDATE_MUTATION_IN_PROGRESS", "CANDIDATE_MUTATION_UNKNOWN"], ["FAST_IN_PROGRESS", "FAST_FAILED_KNOWN"],
  ["REVIEW_VERIFY_IN_PROGRESS", "REVIEW_VERIFY_FAILED_KNOWN"]);
for (const state of [...main, ...accepted.slice(0, 3)])
  if (state !== "CANDIDATE_MUTATION_IN_PROGRESS") pairs.push([state, "STALE_CANDIDATE"]);
// Canonical integrity uncertainty can be discovered even after an otherwise terminal outcome.
for (const state of states) if (state !== "RECONCILE_REQUIRED") pairs.push([state, "RECONCILE_REQUIRED"]);
export const transitionGraph = freeze(pairs);

const transitionSchema = z.object({ from: z.enum(states), to: z.enum(states),
  candidateOutcome: z.enum(["NOT_STARTED", "CONFIRMED", "FAILED_WITHOUT_MUTATION", "UNKNOWN"]),
  canonicalOutcome: z.enum(["NOT_STARTED", "CONFIRMED", "FAILED_WITHOUT_MUTATION", "UNKNOWN"]),
}).strict();
export type Transition = z.infer<typeof transitionSchema>;

/** Checks ordering only. No call to this function reserves, dispatches, writes or authorizes. */
export function assertTransition(input: unknown): void {
  const t = parseStrict(transitionSchema, input);
  if (t.canonicalOutcome === "UNKNOWN") {
    if (t.to === "RECONCILE_REQUIRED") return;
    throw new Error("Canonical uncertainty requires reconciliation");
  }
  if (!transitionGraph.some(([from, to]) => from === t.from && to === t.to)) throw new Error("Forbidden transition");
  if (t.to === "RECONCILE_REQUIRED") return;
  if (t.candidateOutcome === "UNKNOWN") {
    if (t.from === "CANDIDATE_MUTATION_IN_PROGRESS" && t.to === "CANDIDATE_MUTATION_UNKNOWN" &&
      t.canonicalOutcome === "NOT_STARTED") return;
    throw new Error("Candidate uncertainty closes attempt");
  }
  if (t.to === "CANDIDATE_MUTATION_UNKNOWN") throw new Error("Unknown outcome required");
  if (main.slice(0, 7).includes(t.from) && t.to !== "CANDIDATE_MUTATION_CONFIRMED" && t.candidateOutcome !== "NOT_STARTED")
    throw new Error("Candidate mutation not yet started");
  const candidateConfirmed = ["CANDIDATE_MUTATION_CONFIRMED", "FAST_IN_PROGRESS", "FAST_EVIDENCE_FIXED",
    "REVIEW_PENDING", "REVIEW_RECORD_PREPARED", "ATTEMPT_REJECTED", ...accepted];
  if ((candidateConfirmed.includes(t.to) || candidateConfirmed.includes(t.from)) && t.candidateOutcome !== "CONFIRMED")
    throw new Error("Confirmed candidate required");
  if (t.from === "CANDIDATE_MUTATION_IN_PROGRESS" && t.to === "FAILED_KNOWN" && t.candidateOutcome !== "FAILED_WITHOUT_MUTATION")
    throw new Error("Known no-mutation failure required");
  if (t.to === "CANONICAL_MUTATION_CONFIRMED" || ["CANONICAL_MUTATION_CONFIRMED", "REVIEW_VERIFY_IN_PROGRESS",
    "REVIEW_VERIFIED"].includes(t.from)) {
    if (t.canonicalOutcome !== "CONFIRMED") throw new Error("Confirmed canonical mutation required");
  } else if (t.canonicalOutcome !== "NOT_STARTED") throw new Error("Canonical mutation not yet permitted");
}

/** Local preconditions only. A future host must authenticate delegation, currentness,
 * reservations and complete history independently. AI evidence never returns ALLOW. */
export function transitionPreconditions(transition: unknown, bindingInput: unknown, hostExpected: unknown) {
  assertTransition(transition);
  const t = parseStrict(transitionSchema, transition);
  const { binding: b } = validateBinding(bindingInput, hostExpected);
  if (["FAST_IN_PROGRESS", "FAST_EVIDENCE_FIXED", "REVIEW_PENDING", "REVIEW_RECORD_PREPARED", "ATTEMPT_REJECTED",
    ...accepted].includes(t.to) && !b.manifest) throw new Error("Manifest required");
  if (["FAST_EVIDENCE_FIXED", "REVIEW_PENDING", "REVIEW_RECORD_PREPARED", "ATTEMPT_REJECTED", ...accepted].includes(t.to) && !b.fast)
    throw new Error("FAST evidence required");
  if (["REVIEW_RECORD_PREPARED", "ATTEMPT_REJECTED", ...accepted].includes(t.to) && !b.review) throw new Error("Advisory review required");
  if (t.to === "ATTEMPT_REJECTED" && b.review?.result !== "NEEDS_WORK" ||
    accepted.includes(t.to as typeof accepted[number]) && b.review?.result !== "PASS") throw new Error("Advisory result mismatch");
  if (accepted.slice(2).includes(t.to as typeof accepted[number]) && !b.materialization) throw new Error("Materialization binding required");
  if (["REVIEW_VERIFIED", "HUMAN_COMMIT_CHECKPOINT"].includes(t.to) && !b.reviewReceipt) throw new Error("REVIEW receipt required");
  return freeze({ disposition: "REQUIRES_HOST_AUTHORIZATION" as const, kind: "LOCAL_PRECONDITIONS_ONLY" as const });
}

/** A fresh identity is a separate lifecycle, never a transition out of the old attempt. */
export function freshAttemptPreconditions(history: unknown, next: unknown, previousState: unknown) {
  parseStrict(z.enum(["ATTEMPT_REJECTED", "FAILED_KNOWN", "CANDIDATE_MUTATION_UNKNOWN", "FAST_FAILED_KNOWN", "STALE_CANDIDATE"]), previousState);
  assertFreshAttempt(history, next);
  return freeze({ disposition: "REQUIRES_HOST_AUTHORIZATION" as const, kind: "LOCAL_PRECONDITIONS_ONLY" as const });
}
