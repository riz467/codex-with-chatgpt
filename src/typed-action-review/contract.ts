import { z } from "zod";
import { actionBindingShape, canonicalJson, domainHash, idSchema, jtiSchema, keyIdSchema,
  parseStrict, sha256Schema, signatureSchema, timestampSchema } from "../typed-action-approval/contract.js";

export const independentReviewSigningDomain = "AI_WORKSPACE_TYPED_ACTION_INDEPENDENT_REVIEW_V1";
export const independentReviewMaxLifetimeMs = 5 * 60_000;
export const independentReviewMaxFutureSkewMs = 30_000;
export const reviewResultSchema = z.enum(["PASS", "FAIL", "NEEDS_WORK"]);
const reviewIdSchema = z.union([idSchema, z.string().regex(/^review-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)]);
const reviewBindingShape = {
  actionId: actionBindingShape.actionId, actionKind: actionBindingShape.actionKind,
  targetId: actionBindingShape.targetId, requestHash: actionBindingShape.requestHash,
  attemptId: actionBindingShape.attemptId, attemptHash: actionBindingShape.attemptHash,
  attemptSequence: actionBindingShape.attemptSequence, reviewId: reviewIdSchema,
};
export const reviewBindingFields = Object.freeze([
  "actionId", "actionKind", "targetId", "requestHash", "attemptId", "attemptHash", "attemptSequence", "reviewId",
] as const);
export const reviewInputSchema = z.object(reviewBindingShape).strict();

/** In-memory adapter contract for independently checked AI Orchestration Review
 * sources. The CT702 host must compute source digests from the reviewed bundle,
 * manifest and reports, check their consistency and bind them to this attempt.
 * No parser or filesystem access is implied. Report digests commit to the full
 * reports, not merely a caller's PASS flag. */
export const reviewedEvidenceSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal("AI_WORKSPACE_TYPED_ACTION_REVIEWED_EVIDENCE"),
  ...reviewBindingShape,
  reviewBundle: z.object({ sha256: sha256Schema }).strict(),
  manifest: z.object({ sha256: sha256Schema }).strict(),
  integrity: z.object({ result: z.literal("VERIFIED"), reportSha256: sha256Schema }).strict(),
  review: z.object({ result: reviewResultSchema, reportSha256: sha256Schema }).strict(),
}).strict();

/** reviewEvidenceHash is SHA-256(domain + LF + recursively key-sorted JSON of
 * reviewedEvidenceSchema). It is NOT a hash of the signed envelope and cannot
 * be supplied to the signer by its caller. Hashing alone establishes no trust:
 * the host independently verifies the sources before supplying this snapshot. */
export function hashReviewedEvidence(input: unknown): string {
  return domainHash("AI_WORKSPACE_TYPED_ACTION_REVIEWED_EVIDENCE_DIGEST_V1", parseStrict(reviewedEvidenceSchema, input));
}
export const independentReviewPayloadSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal("AI_WORKSPACE_TYPED_ACTION_INDEPENDENT_REVIEW"),
  ...reviewBindingShape, reviewEvidenceHash: sha256Schema, bundleManifestSha256: sha256Schema,
  result: reviewResultSchema, issuedAt: timestampSchema, expiresAt: timestampSchema, jti: jtiSchema,
}).strict();
export const signedIndependentReviewSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal("AI_WORKSPACE_TYPED_ACTION_SIGNED_INDEPENDENT_REVIEW"),
  payload: independentReviewPayloadSchema, reviewerKeyId: keyIdSchema,
  signatureAlgorithm: z.literal("Ed25519"), signature: signatureSchema,
}).strict();

/** Host-owned expectations; NEVER derive these from signed evidence. Key ID is
 * pinned here in addition to resolving its public key in a host-owned key map. */
export const trustedReviewContextSchema = z.object({
  ...reviewBindingShape, expectedReviewEvidenceHash: sha256Schema, expectedBundleManifestSha256: sha256Schema,
  expectedReviewerKeyId: keyIdSchema, expectedResult: reviewResultSchema,
  currentReviewId: reviewIdSchema, reviewIsCurrent: z.literal(true), bundleIntegrityVerified: z.literal(true),
}).strict();
export const independentlyVerifiedReviewSchema = z.object({
  context: trustedReviewContextSchema, evidence: reviewedEvidenceSchema,
}).strict();
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export type ReviewedEvidence = z.infer<typeof reviewedEvidenceSchema>;
export type TrustedReviewContext = z.infer<typeof trustedReviewContextSchema>;
export type IndependentReviewPayload = z.infer<typeof independentReviewPayloadSchema>;
export type SignedIndependentReview = z.infer<typeof signedIndependentReviewSchema>;

/** Only this strict CT702 envelope has signing bytes; all metadata is covered. */
export function independentReviewSigningBytes(input: unknown): Buffer {
  const { signature: _signature, ...unsigned } = parseStrict(signedIndependentReviewSchema, input);
  return Buffer.from(`${independentReviewSigningDomain}\n${canonicalJson(unsigned)}`, "utf8");
}
