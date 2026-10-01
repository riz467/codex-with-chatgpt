import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { actionBindingFields, bindingsMatch, domainHash, idSchema, immutable, parseStrict, sha256Schema,
  signedTypedActionApprovalSchema, trustedTypedActionApprovalContextSchema } from "../typed-action-approval/contract.js";
import { validTimeRange, verifyTypedActionApproval, withinWindow } from "../typed-action-approval/verifier.js";
import { reviewBindingFields, signedIndependentReviewSchema, trustedReviewContextSchema } from "../typed-action-review/contract.js";
import { verifyIndependentReview } from "../typed-action-review/verifier.js";
import { policyAuthoritySchema, requestAuthoritySchema, reviewAuthoritySchema } from "./authority-records.js";

const lookupSchema = z.object({ actionId: idSchema, targetId: idSchema, requestHash: sha256Schema,
  attemptId: idSchema, attemptHash: sha256Schema }).strict();
export type AuthorityLookup = z.infer<typeof lookupSchema>;
const adoptionSchema = z.object({ identity: lookupSchema, evidence: signedIndependentReviewSchema }).strict();
const registrationSchema = z.object({ identity: lookupSchema, evidence: signedTypedActionApprovalSchema }).strict();
export function parseReviewAdoption(input: unknown) { return parseStrict(adoptionSchema, input); }
const hostSnapshotSchema = z.object({
  request: z.object({ current: z.literal(true), body: requestAuthoritySchema }).strict(),
  policy: z.object({ current: z.literal(true), body: policyAuthoritySchema }).strict(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reviewContext: trustedReviewContextSchema,
}).strict();

/** Host installation dependency, never a per-call input. Synchronous reads run
 * under the authority DB writer lock. Host writers MUST share that lock/store;
 * an independently mutable remote authority is not a supported adapter.
 * The request hash commits to the host's policy/generation/window binding:
 * CT702 v1 does not sign separate policy/generation/window fields. */
export interface AuthorityIngestorHost {
  currentAuthority(identity: Readonly<AuthorityLookup>): unknown;
  trustedReviewKeys: ReadonlyMap<string, KeyObject>;
  trustedHumanKeys: ReadonlyMap<string, KeyObject>;
  now(): number;
}

function requireAuthority(value: unknown): asserts value {
  if (!value) throw new Error("Authority ingestion rejected");
}
function binding(request: z.infer<typeof requestAuthoritySchema>) {
  return Object.fromEntries(actionBindingFields.map(field => [field, request[field]]));
}
function constrain(identity: AuthorityLookup, request: z.infer<typeof requestAuthoritySchema>) {
  requireAuthority(Object.entries(identity).every(([key, value]) => request[key as keyof typeof request] === value));
}
type Authorities = { request: z.infer<typeof requestAuthoritySchema>; review: z.infer<typeof reviewAuthoritySchema>;
  policy: z.infer<typeof policyAuthoritySchema>; generation: number };
function eligible({ request, review, policy, generation }: Authorities, now: number) {
  requireAuthority(bindingsMatch(request, review) && review.result === "PASS" && review.evidenceIntegrityValid
    && policy.actionAllowed && policy.policySha256 === request.policySha256 && policy.actionKind === request.actionKind
    && policy.targetId === request.targetId && generation === request.targetGeneration && generation === policy.targetGeneration
    && policy.maintenanceWindowId === request.maintenanceWindowId
    && validTimeRange(review.issuedAt, review.expiresAt, now) && Date.parse(review.issuedAt) <= now
    && Date.parse(request.attemptCreatedAt) <= Date.parse(review.issuedAt)
    && withinWindow(review.issuedAt, review.expiresAt, policy.maintenanceWindowStartsAt, policy.maintenanceWindowExpiresAt, now));
}

/** Pure preparation, not a mutation capability. Called only while the store owns
 * the authority writer lock; the store never accepts prepared caller records. */
export function prepareReviewAdoption(input: unknown, host: AuthorityIngestorHost) {
  const value = parseStrict(adoptionSchema, input);
  const expected = parseStrict(hostSnapshotSchema, host.currentAuthority(immutable(value.identity)));
  const request = expected.request.body, policy = expected.policy.body, context = expected.reviewContext;
  constrain(value.identity, request);
  requireAuthority(reviewBindingFields.filter(field => field !== "reviewId").every(field => request[field] === context[field])
    && request.independentReviewEvidenceHash === context.expectedReviewEvidenceHash);
  const now = host.now();
  const verified = verifyIndependentReview(value.evidence, context, host.trustedReviewKeys, now);
  requireAuthority(verified.valid && verified.payload.result === "PASS");
  const p = verified.payload;
  const review = parseStrict(reviewAuthoritySchema, { ...binding(request), result: p.result,
    evidenceIntegrityValid: true, issuedAt: p.issuedAt, expiresAt: p.expiresAt });
  const authorities = { request, review, policy, generation: expected.generation };
  eligible(authorities, now);
  return { ...authorities, reviewId: p.reviewId, jti: p.jti, reviewEvidenceHash: p.reviewEvidenceHash,
    envelopeHash: domainHash("AI_WORKSPACE_CT701_REVIEW_ADOPTION_ENVELOPE_V1", value.evidence) };
}

export function parseHumanRegistration(input: unknown) { return parseStrict(registrationSchema, input); }
export function verifyHumanRegistration(input: ReturnType<typeof parseHumanRegistration>, authorities: Authorities,
  host: AuthorityIngestorHost) {
  const now = host.now();
  constrain(input.identity, authorities.request);
  eligible(authorities, now);
  const { request, review, policy } = authorities;
  const context = parseStrict(trustedTypedActionApprovalContextSchema, { ...binding(request), independentReviewResult: "PASS",
    reviewIsCurrent: true, requestIsCurrent: true, policyIsCurrent: true, maintenanceWindowValid: true,
    maintenanceWindowStartsAt: policy.maintenanceWindowStartsAt, maintenanceWindowExpiresAt: policy.maintenanceWindowExpiresAt });
  requireAuthority(Date.parse(review.issuedAt) <= Date.parse(input.evidence.payload.issuedAt)
    && Date.parse(input.evidence.payload.issuedAt) <= now
    && verifyTypedActionApproval(input.evidence, context, host.trustedHumanKeys, now).valid);
}
