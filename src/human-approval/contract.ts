import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const taskID = z.string().regex(/^rpc-[0-9a-f]{32}$/);
const runID = z.string().regex(/^auto-[0-9a-f]{32}$/);
const reviewID = z.string().regex(/^review-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const keyID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

/** No paths, commands, repo keys, free-form claims, or unknown fields. */
export const approvalRequestSchema = z.object({
  schema_version: z.literal(1),
  type: z.literal("AI_WORKSPACE_DONE_APPROVAL_REQUEST"),
  request_id: z.string().regex(/^req-[0-9a-f]{32}$/),
  task_id: taskID,
  run_id: runID,
  authoritative_review_id: reviewID,
  review_evidence_hash: sha256,
  bundle_manifest_sha256: sha256,
  canonical_goal_sha256: sha256,
  issued_at: timestamp,
  expires_at: timestamp,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(value => {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value;
  }), // 32 random bytes, canonical base64url
}).strict().refine(v => v.run_id.slice(5) === v.task_id.slice(4));

export const signedApprovalSchema = z.object({
  schema_version: z.literal(1),
  type: z.literal("AI_WORKSPACE_DONE_APPROVAL"),
  payload: approvalRequestSchema,
  approver_key_id: keyID,
  signature_algorithm: z.literal("Ed25519"),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/), // Ed25519 64-byte signature
}).strict();

/** Independently verified, trusted Review snapshot; NEVER construct this from the approval JSON. */
export const trustedApprovalContextSchema = z.object({
  task_id: taskID,
  run_id: runID,
  authoritative_review_id: reviewID,
  review_evidence_hash: sha256,
  bundle_manifest_sha256: sha256,
  canonical_goal_sha256: sha256,
  current_review_id: reviewID,
  current_review_evidence_hash: sha256,
  review_result: z.literal("PASS"),
  review_is_current: z.literal(true),
  bundle_integrity_valid: z.literal(true),
}).strict().refine(v => v.run_id.slice(5) === v.task_id.slice(4));

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type SignedApproval = z.infer<typeof signedApprovalSchema>;
export type TrustedApprovalContext = z.infer<typeof trustedApprovalContextSchema>;

/** v1 wire format: UTF-8 of this exact prefix followed by JSON.stringify in the listed key order.
 * The domain and algorithm/key ID are signed too. No JSON supplied by the caller is signed verbatim.
 */
export function approvalSigningBytes(value: SignedApproval): Buffer {
  const { payload: p } = value;
  return Buffer.from("AI_WORKSPACE_DONE_APPROVAL_V1\n" + JSON.stringify({
    schema_version: value.schema_version,
    type: value.type,
    payload: {
      schema_version: p.schema_version, type: p.type, request_id: p.request_id,
      task_id: p.task_id, run_id: p.run_id, authoritative_review_id: p.authoritative_review_id,
      review_evidence_hash: p.review_evidence_hash, bundle_manifest_sha256: p.bundle_manifest_sha256,
      canonical_goal_sha256: p.canonical_goal_sha256, issued_at: p.issued_at,
      expires_at: p.expires_at, nonce: p.nonce,
    },
    approver_key_id: value.approver_key_id,
    signature_algorithm: value.signature_algorithm,
  }), "utf8");
}
