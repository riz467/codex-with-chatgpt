import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { bindActionAttempt, bindActionRequest } from "../src/mcp/typed-actions.js";
import { hashTypedActionApproval, typedActionApprovalSigningBytes } from "../src/typed-action-approval/contract.js";
import { executionPermitSigningBytes } from "../src/typed-action-finalizer/contract.js";
import { finalizeTypedAction } from "../src/typed-action-finalizer/verifier.js";

// Ephemeral keys and values shared only by the two pure Core test suites.
export const now = Date.parse("2026-10-01T12:00:00.000Z");
export const time = (delta: number) => new Date(now + delta).toISOString();
export const hash = () => randomBytes(32).toString("hex");
export const jti = () => randomBytes(32).toString("base64url");
export function fixture() {
  const human = generateKeyPairSync("ed25519"), finalizer = generateKeyPairSync("ed25519");
  const humanKeys = new Map([["ct700-test", human.publicKey]]), finalizerKeys = new Map([["ct701-test", finalizer.publicKey]]);
  const request: any = {
    schemaVersion: 1, actionId: randomUUID(), kind: "RestartService", target: { kind: "service", id: randomUUID() },
    preconditions: { targetGeneration: 4, policySha256: hash(), maintenanceWindowId: randomUUID(),
      recheck: "immediately-before-mutation-under-exclusive-fence" },
    timeout: { preflightMs: 1000, executionMs: 60_000, verificationMs: 1000, onExpiry: "stop-and-reconcile" },
    rollback: { mode: "none", onFailure: "block-and-reconcile" },
    retry: { automaticMutationRetries: 0, recovery: "new-request-fresh-preflight-and-new-approval" }, retryOf: null,
    risk: "elevated", approval: { human: "required", independentReview: "required", binding: "request-hash-and-attempt",
      destructive: "not-applicable", reboot: "not-applicable" }, reboot: "forbidden",
    expected: { generation: 4, serviceState: "running", configurationSha256: hash() }, desired: { serviceState: "running" },
  };
  const boundRequest = bindActionRequest(request);
  const boundAttempt = bindActionAttempt({ schemaVersion: 1, attemptId: randomUUID(), actionId: request.actionId,
    requestHash: boundRequest.requestHash, sequence: 1, createdAt: time(-30_000),
    approvalIdentity: "typed-action-attempt-sha256-v1" }, request);
  const binding = {
    actionId: request.actionId, actionKind: request.kind, targetId: request.target.id,
    requestHash: boundRequest.requestHash, attemptId: boundAttempt.attempt.attemptId, attemptHash: boundAttempt.attemptHash,
    attemptSequence: 1, independentReviewEvidenceHash: hash(), policySha256: request.preconditions.policySha256,
    targetGeneration: 4, maintenanceWindowId: request.preconditions.maintenanceWindowId,
  };
  const humanContext: any = {
    ...binding, independentReviewResult: "PASS", reviewIsCurrent: true, requestIsCurrent: true, policyIsCurrent: true,
    maintenanceWindowValid: true, maintenanceWindowStartsAt: time(-600_000), maintenanceWindowExpiresAt: time(600_000),
  };
  const approval: any = {
    schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_APPROVAL",
    payload: { schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_APPROVAL_REQUEST", approvalRequestId: randomUUID(),
      ...binding, issuedAt: time(-10_000), expiresAt: time(120_000), jti: jti() },
    approverKeyId: "ct700-test", signatureAlgorithm: "Ed25519", signature: Buffer.alloc(64).toString("base64url"),
  };
  const signApproval = (value: any = approval, key = human.privateKey): any => ({ ...value,
    signature: sign(null, typedActionApprovalSigningBytes(value), key).toString("base64url") });
  const input: any = {
    boundRequest: structuredClone(boundRequest), boundAttempt: structuredClone(boundAttempt),
    humanApproval: signApproval(), humanContext,
    independentReview: { ...binding, result: "PASS", isCurrent: true, evidenceIntegrityValid: true,
      issuedAt: time(-20_000), expiresAt: time(180_000) },
    policyContext: { actionKind: binding.actionKind, targetId: binding.targetId, policySha256: binding.policySha256,
      targetGeneration: 4, maintenanceWindowId: binding.maintenanceWindowId,
      maintenanceWindowStartsAt: humanContext.maintenanceWindowStartsAt, maintenanceWindowExpiresAt: humanContext.maintenanceWindowExpiresAt,
      isCurrent: true, requestIsCurrent: true, actionAllowed: true },
    issuance: { permitId: randomUUID(), jti: jti(), issuedAt: time(0), expiresAt: time(60_000) },
  };
  const result = finalizeTypedAction(input, humanKeys, now);
  if (result.state !== "VERIFIED_NOT_CONSUMED") throw new Error("Invalid test fixture");
  const unsigned: any = { schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_SIGNED_EXECUTION_PERMIT",
    payload: structuredClone(result.permit), finalizerKeyId: "ct701-test", signatureAlgorithm: "Ed25519",
    signature: Buffer.alloc(64).toString("base64url") };
  const signPermit = (value: any = unsigned, key = finalizer.privateKey): any => ({ ...value,
    signature: sign(null, executionPermitSigningBytes(value), key).toString("base64url") });
  const executionContext: any = {
    ...humanContext, humanApprovalEvidenceHash: hashTypedActionApproval(input.humanApproval),
    humanApprovalJti: input.humanApproval.payload.jti, humanApprovalIssuedAt: input.humanApproval.payload.issuedAt,
    humanApprovalExpiresAt: input.humanApproval.payload.expiresAt,
    independentReviewIssuedAt: input.independentReview.issuedAt, independentReviewExpiresAt: input.independentReview.expiresAt,
  };
  return { input, human, finalizer, humanKeys, finalizerKeys, signApproval, signPermit,
    approval: input.humanApproval, permit: signPermit(), humanContext, executionContext };
}
