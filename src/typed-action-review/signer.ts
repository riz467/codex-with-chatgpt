import { createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { immutable, keyIdSchema, parseStrict, type Immutable } from "../typed-action-approval/contract.js";
import { hashReviewedEvidence, independentlyVerifiedReviewSchema, independentReviewMaxLifetimeMs,
  independentReviewSigningBytes, reviewBindingFields, reviewInputSchema, signedIndependentReviewSchema,
  type ReviewInput, type SignedIndependentReview } from "./contract.js";
import { verifyIndependentReview } from "./verifier.js";

export type ReviewIssuanceResult =
  | { state: "SIGNED"; envelope: Immutable<SignedIndependentReview> }
  | { state: "REJECTED" };

/** Trusted CT702 host bootstrap, with an in-memory key only. The host dependency
 * must independently verify sources and supply a current, consistent snapshot
 * under its review fence. Caller input is just a lookup/binding constraint.
 * This core cannot establish the provenance of a malicious host's snapshot. */
export function createIndependentReviewSigningKernel(host: Readonly<{
  privateKey: KeyObject;
  reviewerKeyId: string;
  now: () => number;
  independentlyVerifyReview: (input: Immutable<ReviewInput>) => unknown;
}>) {
  const { privateKey, now, independentlyVerifyReview } = host;
  const keyId = parseStrict(keyIdSchema, host.reviewerKeyId);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 private key required");
  const keys = new Map([[keyId, createPublicKey(privateKey)]]);
  return Object.freeze({
    reviewAndSign(input: unknown): ReviewIssuanceResult {
      try {
        const request = immutable(parseStrict(reviewInputSchema, input));
        const { context, evidence } = parseStrict(independentlyVerifiedReviewSchema, independentlyVerifyReview(request));
        if (!reviewBindingFields.every(field => request[field] === evidence[field] && request[field] === context[field])) return { state: "REJECTED" };
        const clock = now();
        const envelope = parseStrict(signedIndependentReviewSchema, {
          schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_SIGNED_INDEPENDENT_REVIEW",
          reviewerKeyId: keyId, signatureAlgorithm: "Ed25519", signature: Buffer.alloc(64).toString("base64url"),
          payload: { schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_INDEPENDENT_REVIEW", ...request,
            reviewEvidenceHash: hashReviewedEvidence(evidence), bundleManifestSha256: evidence.manifest.sha256,
            result: evidence.review.result, issuedAt: new Date(clock).toISOString(),
            expiresAt: new Date(clock + independentReviewMaxLifetimeMs).toISOString(), jti: randomBytes(32).toString("base64url") },
        });
        envelope.signature = sign(null, independentReviewSigningBytes(envelope), privateKey).toString("base64url");
        if (!verifyIndependentReview(envelope, context, keys, clock).valid) return { state: "REJECTED" };
        return immutable({ state: "SIGNED" as const, envelope });
      } catch { return { state: "REJECTED" }; }
    },
  });
}
