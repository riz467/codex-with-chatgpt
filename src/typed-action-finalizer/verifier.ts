import type { KeyObject } from "node:crypto";
import { bindActionAttempt, hashActionRequest, parseActionRequest } from "../mcp/typed-actions.js";
import {
  actionBindingFields, bindingsMatch, canonicalJson, hashTypedActionApproval, immutable, parseStrict,
  type ActionBinding, type Immutable,
} from "../typed-action-approval/contract.js";
import { validTimeRange, verifyEd25519, verifyTypedActionApproval, withinWindow } from "../typed-action-approval/verifier.js";
import {
  consumptionNamespaces, executionPermitPayloadSchema, executionPermitSigningBytes, finalizerInputSchema,
  signedExecutionPermitSchema, trustedExecutionContextSchema,
  type AtomicExecutionConsumptionStore, type ExecutionGateDecision, type ExecutionPermitPayload,
} from "./contract.js";

export type Finalization =
  | { state: "VERIFIED_NOT_CONSUMED"; permit: Immutable<ExecutionPermitPayload> }
  | { state: "REJECTED" };
function require(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid finalization binding"); }

/** Pure CT701 verification and unsigned draft construction. No key loading,
 * signing, consumption, approval issuance, network, or adapter invocation.
 * The trusted host must independently obtain all three trusted contexts. */
export function finalizeTypedAction(input: unknown, trustedHumanKeys: ReadonlyMap<string, KeyObject>, now: number): Finalization {
  try {
    const value = parseStrict(finalizerInputSchema, input);
    const { humanContext: context, independentReview: review, policyContext: policy, issuance } = value;
    const request = parseActionRequest(value.boundRequest.request);
    const requestHash = hashActionRequest(request);
    const bound = bindActionAttempt(value.boundAttempt.attempt, request);
    require(requestHash === value.boundRequest.requestHash && bound.attemptHash === value.boundAttempt.attemptHash);
    // This phase has no separate destructive/reboot approval evidence contract.
    require(request.approval.destructive === "not-applicable" && request.approval.reboot === "not-applicable");
    const binding: ActionBinding = {
      actionId: request.actionId, actionKind: request.kind, targetId: request.target.id,
      requestHash, attemptId: bound.attempt.attemptId, attemptHash: bound.attemptHash,
      attemptSequence: bound.attempt.sequence, independentReviewEvidenceHash: review.independentReviewEvidenceHash,
      policySha256: request.preconditions.policySha256, targetGeneration: request.expected.generation,
      maintenanceWindowId: request.preconditions.maintenanceWindowId,
    };
    require(request.preconditions.targetGeneration === binding.targetGeneration
      && bindingsMatch(binding, context) && bindingsMatch(binding, review));
    require(policy.actionKind === binding.actionKind && policy.targetId === binding.targetId
      && policy.policySha256 === binding.policySha256 && policy.targetGeneration === binding.targetGeneration
      && policy.maintenanceWindowId === binding.maintenanceWindowId
      && policy.maintenanceWindowStartsAt === context.maintenanceWindowStartsAt
      && policy.maintenanceWindowExpiresAt === context.maintenanceWindowExpiresAt);
    const human = verifyTypedActionApproval(value.humanApproval, context, trustedHumanKeys, now);
    require(human.valid);
    require(bindingsMatch(binding, human.payload));
    const created = Date.parse(bound.attempt.createdAt), reviewed = Date.parse(review.issuedAt), approved = Date.parse(human.payload.issuedAt);
    require(Number.isFinite(created) && created <= reviewed && reviewed <= approved && reviewed <= now
      && Date.parse(review.expiresAt) > now && Date.parse(review.expiresAt) > reviewed);
    require(validTimeRange(issuance.issuedAt, issuance.expiresAt, now)
      && Date.parse(issuance.issuedAt) >= approved
      && Date.parse(issuance.expiresAt) <= Date.parse(human.payload.expiresAt)
      && Date.parse(issuance.expiresAt) <= Date.parse(review.expiresAt)
      && withinWindow(issuance.issuedAt, issuance.expiresAt, policy.maintenanceWindowStartsAt, policy.maintenanceWindowExpiresAt, now));
    const permit = parseStrict(executionPermitPayloadSchema, {
      schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_EXECUTION_PERMIT", ...issuance, ...binding,
      humanApprovalEvidenceHash: hashTypedActionApproval(value.humanApproval), humanApprovalJti: human.jti,
    });
    return immutable({ state: "VERIFIED_NOT_CONSUMED" as const, permit });
  } catch { return { state: "REJECTED" }; }
}

export type ExecutionPermitVerification =
  | { valid: true; state: "VERIFIED_NOT_CONSUMED"; jti: string; payload: Immutable<ExecutionPermitPayload> }
  | { valid: false; state: "REJECTED" };

/** Bridge-side pure verifier: neither signed JSON nor a valid signature creates
 * the trusted execution context. No replay state is read/written here. */
export function verifyExecutionPermit(input: unknown, trustedContext: unknown,
  trustedFinalizerKeys: ReadonlyMap<string, KeyObject>, now: number): ExecutionPermitVerification {
  try {
    const value = parseStrict(signedExecutionPermitSchema, input), p = value.payload;
    const context = parseStrict(trustedExecutionContextSchema, trustedContext);
    require(actionBindingFields.every(field => p[field] === context[field])
      && p.humanApprovalEvidenceHash === context.humanApprovalEvidenceHash && p.humanApprovalJti === context.humanApprovalJti);
    require(validTimeRange(p.issuedAt, p.expiresAt, now)
      && validTimeRange(context.humanApprovalIssuedAt, context.humanApprovalExpiresAt, now)
      && withinWindow(p.issuedAt, p.expiresAt, context.maintenanceWindowStartsAt, context.maintenanceWindowExpiresAt, now)
      && Date.parse(context.independentReviewIssuedAt) <= Date.parse(context.humanApprovalIssuedAt)
      && Date.parse(context.independentReviewIssuedAt) <= now
      && Date.parse(context.humanApprovalIssuedAt) <= Date.parse(p.issuedAt)
      && Date.parse(p.expiresAt) <= Date.parse(context.humanApprovalExpiresAt)
      && Date.parse(p.expiresAt) <= Date.parse(context.independentReviewExpiresAt));
    require(verifyEd25519(executionPermitSigningBytes(value), value.signature, value.finalizerKeyId, trustedFinalizerKeys));
    return immutable({ valid: true as const, state: "VERIFIED_NOT_CONSUMED" as const, jti: p.jti, payload: p });
  } catch { return { valid: false, state: "REJECTED" }; }
}

/** Host seam only; does not execute anything. The host must hold its exclusive
 * target/policy/review fence from freshContext through consume and execution.
 * Store consumption is permanent even if post-consumption freshness fails.
 * Only executionMayStart:true from this call can cross the future execution gate.
 * The return is a one-shot handoff, not a serializable/reusable token: every
 * execution entry (including after restart) must pass this gate again.
 * JSON states/unsigned drafts/verified payloads are NOT capabilities. */
export async function consumeExecutionPermit(input: unknown, trustedFinalizerKeys: ReadonlyMap<string, KeyObject>,
  host: Readonly<{
    freshContext: () => unknown;
    now: () => number;
    store: AtomicExecutionConsumptionStore;
  }>): Promise<ExecutionGateDecision> {
  let consumptionStarted = false;
  try {
    // Snapshot evidence before awaiting the external atomic store.
    const evidence = immutable(parseStrict(signedExecutionPermitSchema, input));
    const context = parseStrict(trustedExecutionContextSchema, host.freshContext());
    const verified = verifyExecutionPermit(evidence, context, trustedFinalizerKeys, host.now());
    if (!verified.valid) return { state: "REJECTED", executionMayStart: false };
    const p = verified.payload;
    consumptionStarted = true;
    const consumed = await host.store.consumeOnce(immutable([
      { namespace: consumptionNamespaces.humanApproval, value: p.humanApprovalJti },
      { namespace: consumptionNamespaces.executionPermit, value: p.jti },
      { namespace: consumptionNamespaces.attempt, value: p.attemptHash },
    ]));
    if (consumed === false) return { state: "REJECTED", executionMayStart: false };
    require(consumed === true);
    // Expiry, revocation and context changes during the durable write must not
    // authorize mutation, nor may they release the already consumed keys.
    const fresh = parseStrict(trustedExecutionContextSchema, host.freshContext());
    require(canonicalJson(context) === canonicalJson(fresh)
      && canonicalJson(evidence) === canonicalJson(parseStrict(signedExecutionPermitSchema, input))
      && verifyExecutionPermit(evidence, fresh, trustedFinalizerKeys, host.now()).valid);
    return immutable({ state: "CONSUMED_FOR_EXECUTION" as const, executionMayStart: true as const, permit: p });
  } catch {
    return { state: consumptionStarted ? "RECONCILE_REQUIRED" : "REJECTED", executionMayStart: false };
  }
}
