import type { KeyObject } from "node:crypto";
import { immutable, parseStrict, type Immutable } from "../typed-action-approval/contract.js";
import { verifyEd25519 } from "../typed-action-approval/verifier.js";
import { independentReviewMaxFutureSkewMs, independentReviewMaxLifetimeMs, independentReviewSigningBytes,
  reviewBindingFields, signedIndependentReviewSchema, trustedReviewContextSchema, type IndependentReviewPayload } from "./contract.js";

export type IndependentReviewVerification =
  | { valid: true; jti: string; payload: Immutable<IndependentReviewPayload> }
  | { valid: false };

/** Authentication only: FAIL/NEEDS_WORK are valid evidence, never permission.
 * The future Authority Ingestor must enforce PASS for Finalizer eligibility.
 * No replay consumption, trusted-record construction or authority mutation. */
export function verifyIndependentReview(input: unknown, trustedContext: unknown,
  trustedKeys: ReadonlyMap<string, KeyObject>, now: number): IndependentReviewVerification {
  try {
    const value = parseStrict(signedIndependentReviewSchema, input);
    const context = parseStrict(trustedReviewContextSchema, trustedContext), p = value.payload;
    const issued = Date.parse(p.issuedAt), expires = Date.parse(p.expiresAt);
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000
      || issued > now + independentReviewMaxFutureSkewMs || expires <= now || expires <= issued
      || expires - issued > independentReviewMaxLifetimeMs
      || !reviewBindingFields.every(field => p[field] === context[field])
      || p.reviewId !== context.currentReviewId || p.result !== context.expectedResult
      || p.reviewEvidenceHash !== context.expectedReviewEvidenceHash
      || p.bundleManifestSha256 !== context.expectedBundleManifestSha256
      || value.reviewerKeyId !== context.expectedReviewerKeyId
      || !verifyEd25519(independentReviewSigningBytes(value), value.signature, value.reviewerKeyId, trustedKeys)) return { valid: false };
    return immutable({ valid: true as const, jti: p.jti, payload: p });
  } catch { return { valid: false }; }
}
