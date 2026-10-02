import { createHash } from "node:crypto";
import { z } from "zod";

// Independent, trust-neutral wire domain. No signer, host adapter or authority imports.
export const contractVersion = 2 as const;
export const identifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

/** Reject accessors/hidden fields/prototypes before a parser can invoke or strip them. */
export function assertPlainJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new Error("Expected plain JSON");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error("Invalid prototype");
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw new Error("Invalid array shape");
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) ||
      (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error("Invalid JSON property");
    assertPlainJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

export function parseStrict<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  assertPlainJson(input);
  return schema.parse(input);
}

export function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

export function canonicalJson(value: unknown): string {
  assertPlainJson(value);
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (item !== null && typeof item === "object") return `{${Object.keys(item).sort()
      .map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(item) as string;
  };
  return encode(value);
}

const hash = (domain: string, input: unknown): string => createHash("sha256")
  .update(`${domain}\n${canonicalJson(input)}`, "utf8").digest("hex");

// Portable ASCII relative paths; no silent normalization or Windows aliases.
export const scopePathSchema = z.string().min(1).max(240).refine(value => {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  return value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== ".." &&
    !segment.endsWith(".") && ![".git", ".ai"].includes(segment.toLowerCase()) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment));
}, "Expected a normalized portable scope path");
export const exactScopeSchema = z.array(scopePathSchema).min(1).max(20).superRefine((paths, ctx) => {
  if (new Set(paths.map(value => value.toLowerCase())).size !== paths.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate or case-aliased scope" });
  if (paths.some((value, index) => index > 0 && paths[index - 1] >= value))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Scope must be strictly ordinal-sorted" });
});
export const editContractKindSchema = z.enum(["v03_exact_text", "bounded_v2_range_edit"]);
const generation = z.number().int().nonnegative().safe();
const sequence = z.number().int().positive().safe();
const contentBinding = {
  taskId: identifierSchema, requestHash: digestSchema, repoId: identifierSchema,
  executionProfileId: identifierSchema, profileDigest: digestSchema, policyDigest: digestSchema,
  targetGeneration: generation, exactEditScope: exactScopeSchema, scopeDigest: digestSchema,
  editContractKind: editContractKindSchema,
};
export const requestSchema = z.object({
  version: z.literal(contractVersion), ...contentBinding,
  goalDigest: digestSchema, acceptanceCriteriaDigest: digestSchema,
}).strict();
export const attemptSchema = z.object({
  version: z.literal(contractVersion), taskId: identifierSchema, requestHash: digestSchema,
  attemptId: identifierSchema, attemptHash: digestSchema, attemptSequence: sequence,
  baselineIdentity: digestSchema, inputSnapshotDigest: digestSchema,
}).strict();
export const gateDecisions = ["ALLOW_BOUNDED_EDIT", "STOP_SCOPE", "STOP_UNRESOLVED_INTENT",
  "STOP_OPERATION", "STOP_INVALID_PROPOSAL"] as const;
export const gateSchema = z.object({
  gateVersion: z.literal(contractVersion), ...contentBinding,
  attemptId: identifierSchema, attemptHash: digestSchema, attemptSequence: sequence,
  baselineIdentity: digestSchema, decision: z.enum(gateDecisions),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
  reason: z.string().min(1).max(2000).refine(value => value === value.trim(), "Reason must not need normalization"),
  allowedOperations: z.array(z.enum(["tracked_utf8_exact_text_edit", "tracked_utf8_range_edit",
    "fixed_verify", "review_artifact"])).max(3),
  evidenceRefs: z.array(identifierSchema).min(1).max(40),
}).strict().superRefine((gate, ctx) => {
  if (new Set(gate.allowedOperations).size !== gate.allowedOperations.length ||
    new Set(gate.evidenceRefs).size !== gate.evidenceRefs.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate gate entries" });
  const expected = gate.editContractKind === "v03_exact_text" ? "tracked_utf8_exact_text_edit" : "tracked_utf8_range_edit";
  if (gate.decision === "ALLOW_BOUNDED_EDIT" && (gate.reasonCode !== "BOUNDED_EDIT" ||
    canonicalJson(gate.allowedOperations) !== canonicalJson([expected, "fixed_verify", "review_artifact"])))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid bounded allow contract" });
  if (gate.decision !== "ALLOW_BOUNDED_EDIT" && gate.allowedOperations.length !== 0)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Stopped gate cannot list permitted operations" });
});
export const taskBindingSchema = z.object({ request: requestSchema, attempt: attemptSchema, gate: gateSchema }).strict();
export type RequestIdentity = z.infer<typeof requestSchema>;
export type AttemptIdentity = z.infer<typeof attemptSchema>;
export type GateDecision = z.infer<typeof gateSchema>;
export type TaskBinding = z.infer<typeof taskBindingSchema>;

export function hashScope(input: unknown): string {
  return hash("RC02_EDIT_SCOPE_V2", parseStrict(exactScopeSchema, input));
}
export function hashRequest(input: unknown): string {
  const { requestHash: _hash, ...body } = parseStrict(requestSchema, input);
  return hash("RC02_REQUEST_V2", body);
}
export function hashAttempt(input: unknown): string {
  const { attemptHash: _hash, ...body } = parseStrict(attemptSchema, input);
  return hash("RC02_ATTEMPT_V2", body);
}

function parseConsistentBinding(input: unknown): TaskBinding {
  const binding = parseStrict(taskBindingSchema, input);
  const { request, attempt, gate } = binding;
  if (hashScope(request.exactEditScope) !== request.scopeDigest || hashRequest(request) !== request.requestHash ||
    hashAttempt(attempt) !== attempt.attemptHash) throw new Error("Identity digest mismatch");
  for (const field of Object.keys(contentBinding) as (keyof typeof contentBinding)[]) {
    if (canonicalJson(request[field]) !== canonicalJson(gate[field])) throw new Error(`Gate ${field} mismatch`);
  }
  if (attempt.taskId !== request.taskId || attempt.requestHash !== request.requestHash)
    throw new Error("Attempt request mismatch");
  for (const field of ["attemptId", "attemptHash", "attemptSequence", "baselineIdentity"] as const) {
    if (attempt[field] !== gate[field]) throw new Error(`Gate ${field} mismatch`);
  }
  return binding;
}

/** The expected contract MUST come from independent host composition, not the caller.
 * Exact equality also pins host decision, reason, operations and evidence. This function
 * checks consistency only: neither its result nor a matching ALLOW grants authority. */
export function validateTaskBinding(input: unknown, hostExpected: unknown): Immutable<{
  kind: "BINDING_ONLY"; binding: TaskBinding;
}> {
  const binding = parseConsistentBinding(input);
  const expected = parseConsistentBinding(hostExpected);
  if (canonicalJson(binding) !== canonicalJson(expected)) throw new Error("Host contract mismatch");
  return freeze({ kind: "BINDING_ONLY" as const, binding });
}
