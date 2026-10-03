import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson, digestSchema, parseStrict } from "../../task-contract/contract.js";
import type { parseBinding } from "./contract.js";

export const findingsSchema = z.object({ domain: z.literal("RC02_DEVELOPMENT_V2_ADVISORY_FINDINGS_V1"),
  attemptDigest: digestSchema, manifestDigest: digestSchema, fastDigest: digestSchema, reviewContextDigest: digestSchema,
  result: z.enum(["PASS", "NEEDS_WORK"]), findings: z.array(z.string().min(1).max(2048)).max(16),
}).strict();
export const evidenceHash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function parseFindings(text: string, binding: ReturnType<typeof parseBinding>, contextDigest?: string) {
  if (Buffer.byteLength(text) > 49152) throw new Error("REVIEW_FINDINGS_LIMIT");
  const value = parseStrict(findingsSchema, JSON.parse(text));
  if (canonicalJson(value) !== text || value.attemptDigest !== binding.attempt.digest ||
    value.manifestDigest !== binding.manifest?.digest || value.fastDigest !== binding.fast?.digest ||
    contextDigest !== undefined && value.reviewContextDigest !== contextDigest) throw new Error("REVIEW_FINDINGS_BINDING");
  return value;
}

export const verificationSchema = z.object({ domain: z.literal("RC02_DEVELOPMENT_V2_REVIEW_VERIFICATION_V1"),
  attemptDigest: digestSchema, manifestDigest: digestSchema, advisoryReviewDigest: digestSchema,
  materializationDigest: digestSchema, findingsDigest: digestSchema, reviewContextDigest: digestSchema,
  canonicalScopeDigest: digestSchema, candidateScopeDigest: digestSchema,
  baselineHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  requestedProfile: z.literal("REVIEW"), effectiveProfile: z.literal("REVIEW"), result: z.literal("PASS"),
}).strict();
