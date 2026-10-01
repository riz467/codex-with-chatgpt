import { z } from "zod";
import { actionAttemptSchema, actionRequestSchema } from "../mcp/typed-actions.js";
import {
  actionBindingShape, canonicalJson, domainHash, idSchema, jtiSchema, keyIdSchema, parseStrict,
  sha256Schema, signatureSchema, signedTypedActionApprovalSchema, timestampSchema,
  trustedTypedActionApprovalContextSchema, type Immutable,
} from "../typed-action-approval/contract.js";

/** Trusted CT702 evidence is supplied independently by the host, never copied
 * from Human Approval. Its provenance/integrity must be verified upstream. */
export const trustedIndependentReviewSchema = z.object({
  ...actionBindingShape, result: z.literal("PASS"), isCurrent: z.literal(true),
  evidenceIntegrityValid: z.literal(true), issuedAt: timestampSchema, expiresAt: timestampSchema,
}).strict();
export const trustedPolicyContextSchema = z.object({
  actionKind: actionBindingShape.actionKind, targetId: idSchema, policySha256: sha256Schema,
  targetGeneration: actionBindingShape.targetGeneration, maintenanceWindowId: idSchema,
  maintenanceWindowStartsAt: timestampSchema, maintenanceWindowExpiresAt: timestampSchema,
  isCurrent: z.literal(true), requestIsCurrent: z.literal(true), actionAllowed: z.literal(true),
}).strict();

export const executionPermitPayloadSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal("AI_WORKSPACE_TYPED_ACTION_EXECUTION_PERMIT"),
  permitId: idSchema, ...actionBindingShape,
  humanApprovalEvidenceHash: sha256Schema, humanApprovalJti: jtiSchema,
  issuedAt: timestampSchema, expiresAt: timestampSchema, jti: jtiSchema,
}).strict();
export const signedExecutionPermitSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal("AI_WORKSPACE_TYPED_ACTION_SIGNED_EXECUTION_PERMIT"),
  payload: executionPermitPayloadSchema, finalizerKeyId: keyIdSchema,
  signatureAlgorithm: z.literal("Ed25519"), signature: signatureSchema,
}).strict();
export const trustedExecutionContextSchema = trustedTypedActionApprovalContextSchema.extend({
  humanApprovalEvidenceHash: sha256Schema, humanApprovalJti: jtiSchema,
  humanApprovalIssuedAt: timestampSchema, humanApprovalExpiresAt: timestampSchema,
  independentReviewIssuedAt: timestampSchema, independentReviewExpiresAt: timestampSchema,
}).strict();

/** Host-generated issuance metadata, not an untrusted selector. This Core only
 * constructs an unsigned draft; CT701 signing/issuance is deliberately absent. */
export const permitIssuanceSchema = z.object({
  permitId: idSchema, jti: jtiSchema, issuedAt: timestampSchema, expiresAt: timestampSchema,
}).strict();
export const finalizerInputSchema = z.object({
  boundRequest: z.object({ request: actionRequestSchema, requestHash: sha256Schema }).strict(),
  boundAttempt: z.object({ attempt: actionAttemptSchema, attemptHash: sha256Schema }).strict(),
  humanApproval: signedTypedActionApprovalSchema,
  humanContext: trustedTypedActionApprovalContextSchema,
  independentReview: trustedIndependentReviewSchema,
  policyContext: trustedPolicyContextSchema,
  issuance: permitIssuanceSchema,
}).strict();
export type FinalizerInput = z.infer<typeof finalizerInputSchema>;
export type ExecutionPermitPayload = z.infer<typeof executionPermitPayloadSchema>;
export type SignedExecutionPermit = z.infer<typeof signedExecutionPermitSchema>;
export type TrustedExecutionContext = z.infer<typeof trustedExecutionContextSchema>;

export const executionPermitSigningDomain = "AI_WORKSPACE_TYPED_ACTION_EXECUTION_PERMIT_V1";
export function executionPermitSigningBytes(input: unknown): Buffer {
  const { signature: _signature, ...unsigned } = parseStrict(signedExecutionPermitSchema, input);
  return Buffer.from(`${executionPermitSigningDomain}\n${canonicalJson(unsigned)}`, "utf8");
}
export function hashExecutionPermit(input: unknown): string {
  return domainHash("AI_WORKSPACE_TYPED_ACTION_EXECUTION_PERMIT_EVIDENCE_V1", parseStrict(signedExecutionPermitSchema, input));
}

export const consumptionNamespaces = Object.freeze({
  humanApproval: "typed-action/human-approval-jti/v1",
  executionPermit: "typed-action/execution-permit-jti/v1",
  attempt: "typed-action/attempt-hash/v1",
} as const);
export type ConsumptionKey = Readonly<{
  namespace: typeof consumptionNamespaces[keyof typeof consumptionNamespaces]; value: string;
}>;
/** Trusted durable store boundary; no implementation is supplied here.
 * - One linearizable transaction consumes ALL keys or NONE, never check-then-insert.
 * - Return true only after durable commit; any duplicate returns false without writes.
 * - Namespace/value uniqueness is global across processes, hosts and restarts.
 * - No release, rollback, expiry deletion, or resetting of consumed attempts.
 * - An exception/unknown commit outcome requires reconciliation, NEVER execution.
 * The execution gate calls this interface, never either signature verifier.
 */
export interface AtomicExecutionConsumptionStore {
  consumeOnce(keys: readonly ConsumptionKey[]): Promise<boolean>;
}
export const finalizationStates = Object.freeze([
  "VERIFIED_NOT_CONSUMED", "CONSUMED_FOR_EXECUTION", "REJECTED", "RECONCILE_REQUIRED",
] as const);
export type FinalizationState = typeof finalizationStates[number];
export type ExecutionGateDecision = Immutable<
  | { state: "CONSUMED_FOR_EXECUTION"; executionMayStart: true; permit: ExecutionPermitPayload }
  | { state: "REJECTED" | "RECONCILE_REQUIRED"; executionMayStart: false }
>;
export type ExecutionOutcome = "verified" | "blocked" | "failed" | "timeout" | "output-limit"
  | "post-push-verification-failed" | "mutation-indeterminate";

/** Structural lifecycle contract, not execution authority. There is no transition
 * back to verification/consumption, including from BLOCKED or after reconciliation. */
export function assertFinalizationTransition(from: FinalizationState, to: FinalizationState): void {
  if (!(from === "VERIFIED_NOT_CONSUMED" && ["CONSUMED_FOR_EXECUTION", "REJECTED", "RECONCILE_REQUIRED"].includes(to)
    || from === "CONSUMED_FOR_EXECUTION" && to === "RECONCILE_REQUIRED")) throw new Error("Invalid finalization transition");
}
export function stateAfterExecution(outcome: ExecutionOutcome): "CONSUMED_FOR_EXECUTION" | "RECONCILE_REQUIRED" {
  // A verified result also stays consumed. Unrecognized runtime values fail closed.
  return outcome === "verified" ? "CONSUMED_FOR_EXECUTION" : "RECONCILE_REQUIRED";
}
