import { createHash } from "node:crypto";
import { z } from "zod";
import { actionKinds } from "../mcp/typed-actions.js";

// This is an independent wire contract. AI_WORKSPACE_DONE_APPROVAL is untouched.
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const idSchema = z.string().uuid().regex(/^[0-9a-f-]+$/);
export const timestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const keyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const bytes = (length: number) => z.string().length(Math.ceil(length * 4 / 3)).regex(/^[A-Za-z0-9_-]+$/).refine(value => {
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === length && decoded.toString("base64url") === value;
});
/** Issuers MUST allocate a fresh cryptographically random 32-byte jti. A parser
 * can validate its canonical encoding, not prove the issuer used a CSPRNG. */
export const jtiSchema = bytes(32);
export const signatureSchema = bytes(64);
export const actionBindingShape = {
  actionId: idSchema,
  actionKind: z.enum(actionKinds),
  targetId: idSchema,
  requestHash: sha256Schema,
  attemptId: idSchema,
  attemptHash: sha256Schema,
  attemptSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  independentReviewEvidenceHash: sha256Schema,
  policySha256: sha256Schema,
  targetGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maintenanceWindowId: idSchema,
};
export const actionBindingFields = Object.freeze([
  "actionId", "actionKind", "targetId", "requestHash", "attemptId", "attemptHash", "attemptSequence",
  "independentReviewEvidenceHash", "policySha256", "targetGeneration", "maintenanceWindowId",
] as const);

export const typedActionApprovalRequestSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal("AI_WORKSPACE_TYPED_ACTION_APPROVAL_REQUEST"),
  approvalRequestId: idSchema, ...actionBindingShape,
  issuedAt: timestampSchema, expiresAt: timestampSchema, jti: jtiSchema,
}).strict();
export const signedTypedActionApprovalSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal("AI_WORKSPACE_TYPED_ACTION_APPROVAL"),
  payload: typedActionApprovalRequestSchema,
  approverKeyId: keyIdSchema, signatureAlgorithm: z.literal("Ed25519"), signature: signatureSchema,
}).strict();

/** Host-owned independently verified snapshot. NEVER derive it from approval JSON.
 * Booleans describe trusted results; caller-supplied booleans confer no authority. */
export const trustedTypedActionApprovalContextSchema = z.object({
  ...actionBindingShape,
  independentReviewResult: z.literal("PASS"), reviewIsCurrent: z.literal(true),
  requestIsCurrent: z.literal(true), policyIsCurrent: z.literal(true),
  maintenanceWindowValid: z.literal(true),
  maintenanceWindowStartsAt: timestampSchema, maintenanceWindowExpiresAt: timestampSchema,
}).strict();

export type TypedActionApprovalRequest = z.infer<typeof typedActionApprovalRequestSchema>;
export type SignedTypedActionApproval = z.infer<typeof signedTypedActionApprovalSchema>;
export type TrustedTypedActionApprovalContext = z.infer<typeof trustedTypedActionApprovalContextSchema>;
export type ActionBinding = Pick<TypedActionApprovalRequest, typeof actionBindingFields[number]>;

/** Reject hidden fields, prototypes, accessors and non-JSON values before Zod can
 * strip anything or invoke a getter. Shared only within the new typed-action domain. */
export function assertPlainJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new Error("Expected plain JSON");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error("Expected plain JSON");
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw new Error("Invalid JSON array");
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)
      || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error("Invalid JSON property");
    assertPlainJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
export function parseStrict<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  assertPlainJson(input); return schema.parse(input);
}
export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export function immutable<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
export function canonicalJson(value: unknown): string {
  assertPlainJson(value);
  const encode = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    if (v !== null && typeof v === "object") return `{${Object.keys(v).sort()
      .map(key => `${JSON.stringify(key)}:${encode((v as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(v) as string;
  };
  return encode(value);
}
export function domainHash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonicalJson(value)}`, "utf8").digest("hex");
}
export function bindingsMatch(a: ActionBinding, b: ActionBinding): boolean {
  return actionBindingFields.every(field => a[field] === b[field]);
}

export const typedActionApprovalSigningDomain = "AI_WORKSPACE_TYPED_ACTION_APPROVAL_V1";
/** UTF-8 domain + LF + recursively key-sorted JSON of the strict envelope minus
 * signature. Envelope type, version, key ID and algorithm are all signed. */
export function typedActionApprovalSigningBytes(input: unknown): Buffer {
  const { signature: _signature, ...unsigned } = parseStrict(signedTypedActionApprovalSchema, input);
  return Buffer.from(`${typedActionApprovalSigningDomain}\n${canonicalJson(unsigned)}`, "utf8");
}
/** Evidence identity includes the entire signed envelope, including its signature. */
export function hashTypedActionApproval(input: unknown): string {
  return domainHash("AI_WORKSPACE_TYPED_ACTION_APPROVAL_EVIDENCE_V1", parseStrict(signedTypedActionApprovalSchema, input));
}
