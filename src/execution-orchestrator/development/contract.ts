import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, digestSchema, exactScopeSchema, freeze, parseStrict } from "../../task-contract/contract.js";

// A separate wire/hash domain. IDs are host-allocated, not bounded-v2 revisions.
const id = (kind: string) => z.string().regex(new RegExp(`^dev2-${kind}-[A-Za-z0-9_-]{1,80}$`));
const sequence = z.number().int().positive().safe();
const seal = z.object({ digest: digestSchema });
export const delegationSchema = z.object({
  domain: z.literal("RC02_DEVELOPMENT_V2_DELEGATION"), id: id("delegation"),
  policyId: id("policy"), policyDigest: digestSchema, repositoryId: id("repository"),
  baselineHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), scope: exactScopeSchema,
  maxAttempts: sequence,
}).merge(seal).strict();
export const requestSchema = z.object({
  domain: z.literal("RC02_DEVELOPMENT_V2_REQUEST"), id: id("request"), delegationDigest: digestSchema,
  goalDigest: digestSchema, acceptanceCriteriaDigest: digestSchema,
}).merge(seal).strict();
export const attemptSchema = z.object({
  domain: z.literal("RC02_DEVELOPMENT_V2_ATTEMPT"), id: id("attempt"), requestDigest: digestSchema,
  sequence, predecessor: z.object({ id: id("attempt"), digest: digestSchema }).strict().nullable(),
  candidateId: id("candidate"), candidateGeneration: sequence,
  sessionId: id("session"), executionId: id("execution"), inputSnapshotDigest: digestSchema,
  manifestId: id("manifest"), fastId: id("fast"), advisoryReviewId: id("review"),
  materializationId: id("materialization"), reviewReceiptId: id("receipt"),
}).merge(seal).strict();
const file = z.object({ state: z.literal("FILE"), sha256: digestSchema,
  byteLength: z.number().int().nonnegative().safe() }).strict();
const missing = z.object({ state: z.literal("MISSING") }).strict();
const fileOperation = z.discriminatedUnion("operation", [
  z.object({ path: z.string(), operation: z.literal("UNCHANGED"), before: file, after: file }).strict(),
  z.object({ path: z.string(), operation: z.literal("MODIFIED"), before: file, after: file }).strict(),
  z.object({ path: z.string(), operation: z.literal("CREATED"), before: missing, after: file }).strict(),
]);
export const manifestSchema = z.object({
  domain: z.literal("RC02_DEVELOPMENT_V2_MANIFEST"), id: id("manifest"), attemptDigest: digestSchema,
  files: z.array(fileOperation).min(1).max(20), proposalDigest: digestSchema,
}).merge(seal).strict();
export const fastSchema = z.object({
  domain: z.literal("RC02_DEVELOPMENT_V2_FAST"), id: id("fast"), attemptDigest: digestSchema,
  manifestDigest: digestSchema, requestedProfile: z.literal("FAST"), effectiveProfile: z.literal("FAST"),
  result: z.literal("PASS"), evidenceDigest: digestSchema,
}).merge(seal).strict();
export const reviewSchema = z.object({
  domain: z.literal("RC02_DEVELOPMENT_V2_ADVISORY_REVIEW"), id: id("review"), attemptDigest: digestSchema,
  manifestDigest: digestSchema, fastDigest: digestSchema, result: z.enum(["PASS", "NEEDS_WORK"]),
  findingsDigest: digestSchema,
}).merge(seal).strict();
export const materializationSchema = z.object({
  domain: z.literal("RC02_DEVELOPMENT_V2_MATERIALIZATION"), id: id("materialization"),
  attemptDigest: digestSchema, manifestDigest: digestSchema, advisoryReviewDigest: digestSchema,
}).merge(seal).strict();
export const reviewReceiptSchema = z.object({
  domain: z.literal("RC02_DEVELOPMENT_V2_REVIEW_RECEIPT"), id: id("receipt"), attemptDigest: digestSchema,
  manifestDigest: digestSchema, materializationDigest: digestSchema,
  requestedProfile: z.literal("REVIEW"), effectiveProfile: z.literal("REVIEW"), result: z.literal("PASS"),
  evidenceDigest: digestSchema,
}).merge(seal).strict();
export const bindingSchema = z.object({ delegation: delegationSchema, request: requestSchema,
  attempt: attemptSchema, manifest: manifestSchema.optional(), fast: fastSchema.optional(),
  review: reviewSchema.optional(), materialization: materializationSchema.optional(),
  reviewReceipt: reviewReceiptSchema.optional() }).strict();
export type DevelopmentBinding = z.infer<typeof bindingSchema>;

// Same strict alternatives; dispatch by the unique literal domain instead of
// allocating failed parses for every preceding record kind on each journal scan.
const recordSchema = z.discriminatedUnion("domain", [delegationSchema, requestSchema, attemptSchema, manifestSchema,
  fastSchema, reviewSchema, materializationSchema, reviewReceiptSchema]);

/** Canonical content identity only; a digest is not a signature or authority proof. */
export function hashRecord(input: unknown): string {
  const value = parseStrict(recordSchema, input);
  const { digest: _digest, ...body } = value;
  return createHash("sha256").update(`${value.domain}\n${canonicalJson(body)}`, "utf8").digest("hex");
}

export function parseBinding(input: unknown) {
  const b = parseStrict(bindingSchema, input);
  for (const value of Object.values(b)) {
    if (value && hashRecord(value) !== value.digest) throw new Error("Record digest mismatch");
  }
  const { delegation: d, request: r, attempt: a, manifest: m, fast: f, review: v,
    materialization: material, reviewReceipt: receipt } = b;
  if (r.delegationDigest !== d.digest || a.requestDigest !== r.digest || a.sequence > d.maxAttempts ||
    (a.sequence === 1) !== (a.predecessor === null) || a.predecessor?.id === a.id ||
    a.candidateGeneration !== a.sequence) throw new Error("Request/attempt binding mismatch");
  for (const evidence of [m, f, v, material, receipt]) {
    if (evidence && evidence.attemptDigest !== a.digest) throw new Error("Cross-attempt evidence");
  }
  if (m && m.id !== a.manifestId || f && f.id !== a.fastId || v && v.id !== a.advisoryReviewId ||
    material && material.id !== a.materializationId || receipt && receipt.id !== a.reviewReceiptId)
    throw new Error("Evidence identity mismatch");
  if (m) {
    if (canonicalJson(m.files.map(row => row.path)) !== canonicalJson(d.scope)) throw new Error("Manifest scope mismatch");
    const emptyHash = createHash("sha256").update("").digest("hex");
    for (const row of m.files) {
      for (const state of [row.before, row.after]) {
        if (state.state === "FILE" && (state.byteLength === 0) !== (state.sha256 === emptyHash))
          throw new Error("Empty file identity mismatch");
      }
      if (row.operation !== "CREATED" &&
        (row.operation === "UNCHANGED") !== (canonicalJson(row.before) === canonicalJson(row.after)))
        throw new Error("File operation mismatch");
    }
  }
  if (f && (!m || f.manifestDigest !== m.digest) ||
    v && (!m || !f || v.manifestDigest !== m.digest || v.fastDigest !== f.digest) ||
    material && (!m || !v || v.result !== "PASS" || material.manifestDigest !== m.digest || material.advisoryReviewDigest !== v.digest) ||
    receipt && (!m || !material || receipt.manifestDigest !== m.digest || receipt.materializationDigest !== material.digest))
    throw new Error("Evidence chain mismatch");
  return freeze(b);
}

/** hostExpected must originate independently. This API authenticates nothing. */
export function validateBinding(input: unknown, hostExpected: unknown) {
  const binding = parseBinding(input), expected = parseBinding(hostExpected);
  if (canonicalJson(binding) !== canonicalJson(expected)) throw new Error("Host binding mismatch");
  return freeze({ kind: "BINDING_ONLY" as const, binding });
}

/** Structural history check only. The host must supply complete, protected history. */
export function assertFreshAttempt(historyInput: unknown, nextInput: unknown): void {
  const history = parseStrict(z.array(bindingSchema).min(1), historyInput).map(parseBinding);
  const next = parseBinding(nextInput);
  const all = [...history, next];
  const identities = new Set<string>();
  for (let i = 0; i < all.length; i++) {
    const b = all[i], previous = all[i - 1];
    if (b.attempt.sequence !== i + 1 || b.request.digest !== next.request.digest ||
      b.delegation.digest !== next.delegation.digest || (previous &&
        (b.attempt.predecessor?.id !== previous.attempt.id || b.attempt.predecessor.digest !== previous.attempt.digest)))
      throw new Error("Incomplete attempt lineage");
    const ids = [b.attempt.id, b.attempt.candidateId, b.attempt.sessionId, b.attempt.executionId,
      b.attempt.manifestId, b.attempt.fastId, b.attempt.advisoryReviewId, b.attempt.materializationId, b.attempt.reviewReceiptId];
    for (const identity of ids) {
      if (identities.has(identity)) throw new Error("Reused attempt identity");
      identities.add(identity);
    }
  }
  if (next.manifest || next.fast || next.review || next.materialization || next.reviewReceipt)
    throw new Error("Fresh attempt must start without evidence");
}

/** Pure one-shot projection; not a durable replay store or a materialization permit. */
export function consumeMaterialization(input: unknown, hostExpected: unknown, consumedInput: unknown) {
  const { binding } = validateBinding(input, hostExpected);
  const consumed = parseStrict(z.array(id("materialization")), consumedInput);
  if (new Set(consumed).size !== consumed.length || !binding.materialization ||
    consumed.includes(binding.materialization.id)) throw new Error("Materialization already consumed or absent");
  return freeze({ kind: "CONSUMPTION_PROJECTION_ONLY" as const, consumed: [...consumed, binding.materialization.id] });
}
