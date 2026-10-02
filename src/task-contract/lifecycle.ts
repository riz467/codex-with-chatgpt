import { z } from "zod";
import { freeze, parseStrict, validateTaskBinding } from "./contract.js";

export const executionStates = ["REQUEST_FIXED", "ATTEMPT_FIXED", "GATE_VALIDATED", "EXECUTION_RESERVED",
  "MUTATION_IN_PROGRESS", "MUTATION_CONFIRMED", "VERIFICATION_PASSED", "REVIEW_PENDING", "BLOCKED",
  "FAILED_KNOWN", "VERIFY_FAILED_KNOWN", "RECONCILE_REQUIRED", "LOCAL_DONE"] as const;
export type ExecutionState = typeof executionStates[number];
export const operations = ["READ", "DISPLAY", "VERIFY_HISTORICAL", "MUTATE", "VERIFY", "REQUEST_REVIEW",
  "APPROVE", "FINALIZE", "RETRY_VERIFY", "REDISPATCH"] as const;
export type Operation = typeof operations[number];
const outcomeSchema = z.enum(["NOT_STARTED", "CONFIRMED", "FAILED_WITHOUT_MUTATION", "UNKNOWN"]);
export type MutationOutcome = z.infer<typeof outcomeSchema>;
const snapshotSchema = z.object({
  state: z.enum(executionStates), mutationOutcome: outcomeSchema,
  identityStatus: z.enum(["FRESH", "RESERVED", "CONSUMED", "QUARANTINED"]),
  evidenceStatus: z.enum(["CURRENT", "SUPERSEDED", "LEGACY"]),
  binding: z.unknown().optional(),
}).strict();
export type LifecycleSnapshot = z.infer<typeof snapshotSchema>;
export type Eligibility = Readonly<{
  disposition: "INSPECTION_ALLOWED" | "DENIED" | "REQUIRES_FRESH_REQUEST" | "REQUIRES_HOST_AUTHORIZATION";
  reason: string;
}>;
const result = (disposition: Eligibility["disposition"], reason: string): Eligibility => freeze({ disposition, reason });

/** Pure preconditions, NEVER authorization. hostExpected must not be caller-derived.
 * Even the positive sensitive result requires independently enforced host authority. */
export function operationEligibility(input: unknown, operation: Operation, hostExpected?: unknown): Eligibility {
  let snapshot: LifecycleSnapshot;
  try { snapshot = parseStrict(snapshotSchema, input); }
  catch { return result("DENIED", "INVALID_SNAPSHOT"); }
  if (!(operations as readonly string[]).includes(operation)) return result("DENIED", "UNKNOWN_OPERATION");
  if (["READ", "DISPLAY", "VERIFY_HISTORICAL"].includes(operation))
    return result("INSPECTION_ALLOWED", "READ_ONLY_EVIDENCE");
  if (snapshot.mutationOutcome === "UNKNOWN" || snapshot.state === "RECONCILE_REQUIRED" ||
    snapshot.identityStatus === "QUARANTINED") return result("DENIED", "RECONCILE_REQUIRED");
  if (operation === "RETRY_VERIFY" || operation === "REDISPATCH") return result("DENIED", "NO_RETRY_CAPABILITY");
  if (snapshot.evidenceStatus === "LEGACY" || snapshot.binding == null)
    return result("REQUIRES_FRESH_REQUEST", "LEGACY_INSPECTION_ONLY");
  if (snapshot.evidenceStatus === "SUPERSEDED") return result("REQUIRES_FRESH_REQUEST", "SUPERSEDED_AUTHORITY");
  if (snapshot.identityStatus === "CONSUMED") return result("DENIED", "IDENTITY_ALREADY_CONSUMED");
  if (["BLOCKED", "FAILED_KNOWN", "VERIFY_FAILED_KNOWN", "LOCAL_DONE"].includes(snapshot.state))
    return result("DENIED", "STOPPED_LOCAL_STATE");
  try {
    if (validateTaskBinding(snapshot.binding, hostExpected).binding.gate.decision !== "ALLOW_BOUNDED_EDIT")
      return result("DENIED", "GATE_REFUSED");
  } catch { return result("DENIED", "UNVERIFIED_BINDING"); }
  const matches = operation === "MUTATE" ? snapshot.state === "EXECUTION_RESERVED" &&
      snapshot.identityStatus === "RESERVED" && snapshot.mutationOutcome === "NOT_STARTED"
    : operation === "VERIFY" ? snapshot.state === "MUTATION_CONFIRMED" && snapshot.mutationOutcome === "CONFIRMED"
    : operation === "REQUEST_REVIEW" ? snapshot.state === "VERIFICATION_PASSED" && snapshot.mutationOutcome === "CONFIRMED"
    : (operation === "APPROVE" || operation === "FINALIZE") &&
      snapshot.state === "REVIEW_PENDING" && snapshot.mutationOutcome === "CONFIRMED";
  return matches ? result("REQUIRES_HOST_AUTHORIZATION", "LOCAL_PRECONDITIONS_ONLY")
    : result("DENIED", "OPERATION_STATE_MISMATCH");
}

/** Unknown or unsupported outcomes fail closed. No rollback/dispatch happens here. */
export function stateForMutationOutcome(outcome: unknown): ExecutionState {
  if (outcome === "CONFIRMED") return "MUTATION_CONFIRMED";
  if (outcome === "FAILED_WITHOUT_MUTATION") return "FAILED_KNOWN";
  if (outcome === "NOT_STARTED") return "REQUEST_FIXED";
  return "RECONCILE_REQUIRED";
}

const forward: Partial<Record<ExecutionState, ExecutionState>> = {
  REQUEST_FIXED: "ATTEMPT_FIXED", ATTEMPT_FIXED: "GATE_VALIDATED", GATE_VALIDATED: "EXECUTION_RESERVED",
  EXECUTION_RESERVED: "MUTATION_IN_PROGRESS", MUTATION_IN_PROGRESS: "MUTATION_CONFIRMED",
  MUTATION_CONFIRMED: "VERIFICATION_PASSED", VERIFICATION_PASSED: "REVIEW_PENDING",
};
/** Structural transition check only; successful validation cannot reserve or execute. */
export function assertExecutionTransition(from: ExecutionState, to: ExecutionState, outcome: MutationOutcome): void {
  if (!executionStates.includes(from) || !executionStates.includes(to) || !outcomeSchema.safeParse(outcome).success)
    throw new Error("Invalid lifecycle input");
  if (outcome === "UNKNOWN") {
    if (to === "RECONCILE_REQUIRED") return;
    throw new Error("Unknown outcome requires reconciliation");
  }
  if (["RECONCILE_REQUIRED", "BLOCKED", "FAILED_KNOWN", "VERIFY_FAILED_KNOWN", "LOCAL_DONE"].includes(from))
    throw new Error("Terminal local state cannot resume");
  if (to === "RECONCILE_REQUIRED") return;
  if (to === "BLOCKED" && !["MUTATION_IN_PROGRESS", "MUTATION_CONFIRMED"].includes(from)) return;
  if (to === "FAILED_KNOWN" && outcome === "FAILED_WITHOUT_MUTATION" &&
    ["EXECUTION_RESERVED", "MUTATION_IN_PROGRESS"].includes(from)) return;
  if (to === "VERIFY_FAILED_KNOWN" && from === "MUTATION_CONFIRMED" && outcome === "CONFIRMED") return;
  if (forward[from] === to && (to === "MUTATION_CONFIRMED" || to === "VERIFICATION_PASSED" || to === "REVIEW_PENDING"
    ? outcome === "CONFIRMED" : outcome === "NOT_STARTED")) return;
  throw new Error("Forbidden execution transition");
}

// These observations describe separate records. They are not authenticity proofs.
const authorityObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("LOCAL_DONE") }).strict(),
  z.object({ kind: z.literal("REVIEW"), result: z.enum(["PASS", "FAIL", "NEEDS_WORK"]) }).strict(),
  z.object({ kind: z.literal("APPROVAL_SIGNED") }).strict(),
  z.object({ kind: z.literal("PERMIT_ISSUED") }).strict(),
  z.object({ kind: z.literal("COMPLETION_RECORD_CANDIDATE") }).strict(),
]);
export const authoritativeStates = ["UNVERIFIED", "DONE"] as const;
/** No observation accepted by this foundation can establish authoritative DONE.
 * A future authenticated CT701 receipt verifier owns that decision, outside this API. */
export function classifyAuthorityObservation(input: unknown): Readonly<{
  authoritativeState: "UNVERIFIED"; isApproval: false; requiresAuthorityVerification: true;
}> {
  parseStrict(authorityObservationSchema, input);
  return freeze({ authoritativeState: "UNVERIFIED", isApproval: false, requiresAuthorityVerification: true });
}
