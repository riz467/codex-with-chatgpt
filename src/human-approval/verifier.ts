import { verify, type KeyObject } from "node:crypto";
import { approvalSigningBytes, signedApprovalSchema, trustedApprovalContextSchema,
  type ApprovalRequest, type TrustedApprovalContext } from "./contract.js";

export type Verification = { valid: true; jti: string; payload: ApprovalRequest } | { valid: false };
const invalid = (): Verification => ({ valid: false });
const binding = ["task_id", "run_id", "authoritative_review_id", "review_evidence_hash",
  "bundle_manifest_sha256", "canonical_goal_sha256"] as const;
const maxLifetime = 5 * 60_000;
const maxFutureSkew = 30_000;

/** Pure verifier: no HTTP, disk, WebAuthn, issuance, mutable replay state, or Complete call.
 * trustedContext MUST be obtained independently of the untrusted evidence and must be rechecked
 * at the future consumption gate; caller controls neither trustedKeys nor the verified context.
 */
export function verifySignedApproval(input: unknown, trustedContext: TrustedApprovalContext,
  trustedKeys: ReadonlyMap<string, KeyObject>, now: number): Verification {
  const parsed = signedApprovalSchema.safeParse(input);
  const context = trustedApprovalContextSchema.safeParse(trustedContext);
  if (!parsed.success || !context.success || !Number.isSafeInteger(now)) return invalid();
  const value = parsed.data, payload = value.payload, current = context.data;
  const issued = Date.parse(payload.issued_at), expires = Date.parse(payload.expires_at);
  if (issued > now + maxFutureSkew || expires <= now || expires <= issued || expires - issued > maxLifetime ||
      current.current_review_id !== current.authoritative_review_id ||
      current.current_review_evidence_hash !== current.review_evidence_hash ||
      binding.some(field => payload[field] !== current[field])) return invalid();
  const key = trustedKeys.get(value.approver_key_id);
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519") return invalid();
  const signature = Buffer.from(value.signature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value.signature) return invalid();
  try {
    if (!verify(null, approvalSigningBytes(value), key, signature)) return invalid();
  } catch { return invalid(); }
  // The nonce is the v1 jti. Do not mark it used here; atomic consume is a separate boundary.
  return { valid: true, jti: payload.nonce, payload };
}
