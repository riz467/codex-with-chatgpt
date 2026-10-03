import { z } from "zod";
import { canonicalJson, digestSchema, freeze, parseStrict } from "../../task-contract/contract.js";
import { fastSchema, hashRecord } from "./contract.js";
import { sha256, type FixedBinding } from "./candidate-mutation.js";

export const MAX_FAST_OUTPUT_BYTES = 1024 * 1024;
export const MAX_FAST_EVIDENCE_BYTES = 16 * 1024;
export const FAST_SANDBOX_PROFILE = "RC02_E0_BWRAP_RO_V1";
const names = z.array(z.string().max(4096)).max(10000);
const summarySchema = z.object({ requested_profile: z.literal("FAST"), effective_profile: z.literal("FAST"),
  result: z.literal("PASS"), pass: z.literal(true), escalation_required: z.literal(false),
  escalation_reasons: names.length(0), changed_paths: names, declared_paths: names.nullable(), observed_git_paths: names,
  out_of_scope_paths: names.length(0), related_tests: names, mandatory_tests: names, direct_tests: names,
  related_sources: names, docs_only: z.boolean(), commands: z.array(z.object({ executable: z.string(), argv: names, status: z.literal(0) }).strict()).max(100),
}).strict();

/** Only the final complete line of the trusted verifier is a summary. No scanning
 * backwards for an earlier PASS, no prose inference and no duplicate JSON keys. */
export function parseFastSummary(stdout: Buffer, stderr: Buffer, status: number | null) {
  if (status !== 0 || stdout.length > MAX_FAST_OUTPUT_BYTES || stderr.length > MAX_FAST_OUTPUT_BYTES) throw new Error("FAST_NOT_PASS");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  if (!text.endsWith("\n")) throw new Error("FAST_INCOMPLETE_SUMMARY");
  const line = text.slice(0, -1).split("\n").at(-1)!;
  const value = JSON.parse(line);
  // Trusted verifier emits JSON.stringify, so this also detects duplicate keys.
  if (JSON.stringify(value) !== line) throw new Error("FAST_NONCANONICAL_SUMMARY");
  return parseStrict(summarySchema, value);
}

export const fastEvidenceSchema = z.object({ domain: z.literal("RC02_DEVELOPMENT_V2_FAST_EVIDENCE_V1"),
  attemptDigest: digestSchema, manifestDigest: digestSchema, runtimeCapsuleDigest: digestSchema,
  nodeExecutableDigest: digestSchema, gitExecutableDigest: digestSchema, nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
  requestedProfile: z.literal("FAST"), effectiveProfile: z.literal("FAST"), result: z.literal("PASS"),
  summaryDigest: digestSchema, stdoutSha256: digestSchema, stderrSha256: digestSchema,
  candidatePostSnapshotDigest: digestSchema, networkIsolation: z.literal("OS_NETWORK_NAMESPACE"),
  sandboxProfile: z.literal(FAST_SANDBOX_PROFILE), sandboxProfileDigest: digestSchema,
  osResourceCgroupLimit: z.literal("NOT_ESTABLISHED"),
}).strict();
export type FastEvidence = z.infer<typeof fastEvidenceSchema>;
export function sealFastEvidence(binding: FixedBinding, input: unknown) {
  const evidence = parseStrict(fastEvidenceSchema, input);
  if (!binding.manifest || evidence.attemptDigest !== binding.attempt.digest || evidence.manifestDigest !== binding.manifest.digest)
    throw new Error("FAST_EVIDENCE_BINDING");
  const bytes = Buffer.from(canonicalJson(evidence));
  if (bytes.length > MAX_FAST_EVIDENCE_BYTES) throw new Error("FAST_EVIDENCE_LIMIT");
  const evidenceDigest = sha256(bytes);
  const record = fastSchema.parse({ domain: "RC02_DEVELOPMENT_V2_FAST", id: binding.attempt.fastId,
    attemptDigest: binding.attempt.digest, manifestDigest: binding.manifest.digest, requestedProfile: "FAST",
    effectiveProfile: "FAST", result: "PASS", evidenceDigest, digest: "0".repeat(64) });
  return freeze({ evidence, contentBase64: bytes.toString("base64"),
    artifactId: `dev2-artifact-fast-${binding.attempt.digest}`, fast: { ...record, digest: hashRecord(record) } });
}
