import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { hashTypedActionApproval, immutable, keyIdSchema, parseStrict, type Immutable } from "../typed-action-approval/contract.js";
import { executionPermitSigningBytes, finalizerInputSchema, signedExecutionPermitSchema, trustedExecutionContextSchema,
  type SignedExecutionPermit } from "./contract.js";
import { TypedActionFinalizerStore } from "./storage.js";
import { finalizeTypedAction, verifyExecutionPermit } from "./verifier.js";

export type PermitIssuanceResult =
  | { state: "VERIFIED_NOT_CONSUMED"; envelope: Immutable<SignedExecutionPermit> }
  | { state: "REJECTED" };

/** Trusted CT701 bootstrap dependencies only. No key files, paths, byte signing,
 * draft signing or arbitrary payload API. Signatures never escape before durable
 * evidence commit. Database errors propagate as reconciliation candidates.
 * The host holds its target/policy/review fence through verification and commit. */
export function createTypedActionPermitSigningKernel(host: Readonly<{
  store: TypedActionFinalizerStore;
  privateKey: KeyObject;
  finalizerKeyId: string;
  trustedHumanKeys: ReadonlyMap<string, KeyObject>;
  now: () => number;
}>) {
  const { store, privateKey, trustedHumanKeys, now } = host;
  const keyId = parseStrict(keyIdSchema, host.finalizerKeyId);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 private key required");
  const publicKeys = new Map([[keyId, createPublicKey(privateKey)]]);
  return Object.freeze({
    finalizeAndSignTypedAction(input: unknown): PermitIssuanceResult {
      let parsed: ReturnType<typeof finalizerInputSchema.parse>;
      try { parsed = parseStrict(finalizerInputSchema, input); } catch { return { state: "REJECTED" }; }
      const result = finalizeTypedAction(parsed, trustedHumanKeys, now());
      if (result.state !== "VERIFIED_NOT_CONSUMED") return { state: "REJECTED" };
      // Context comes from the independently verified host snapshots in Finalizer
      // input, not from a caller-supplied arbitrary permit or its signed claims.
      const context = parseStrict(trustedExecutionContextSchema, {
        ...parsed.humanContext,
        humanApprovalEvidenceHash: hashTypedActionApproval(parsed.humanApproval), humanApprovalJti: parsed.humanApproval.payload.jti,
        humanApprovalIssuedAt: parsed.humanApproval.payload.issuedAt, humanApprovalExpiresAt: parsed.humanApproval.payload.expiresAt,
        independentReviewIssuedAt: parsed.independentReview.issuedAt, independentReviewExpiresAt: parsed.independentReview.expiresAt,
      });
      const envelope = parseStrict(signedExecutionPermitSchema, {
        schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_SIGNED_EXECUTION_PERMIT", payload: result.permit,
        finalizerKeyId: keyId, signatureAlgorithm: "Ed25519", signature: Buffer.alloc(64).toString("base64url"),
      });
      envelope.signature = sign(null, executionPermitSigningBytes(envelope), privateKey).toString("base64url");
      if (!verifyExecutionPermit(envelope, context, publicKeys, now()).valid) return { state: "REJECTED" };
      if (!store.recordFinalizedPermit(envelope, context)) return { state: "REJECTED" };
      return immutable({ state: "VERIFIED_NOT_CONSUMED" as const, envelope });
    },
  });
}
