import { verify, type KeyObject } from "node:crypto";
import {
  bindingsMatch, immutable, parseStrict, signedTypedActionApprovalSchema, typedActionApprovalSigningBytes,
  trustedTypedActionApprovalContextSchema, type Immutable, type TypedActionApprovalRequest,
} from "./contract.js";

export const typedActionMaxLifetimeMs = 5 * 60_000;
export const typedActionMaxFutureSkewMs = 30_000;
export type TypedActionApprovalVerification =
  | { valid: true; jti: string; payload: Immutable<TypedActionApprovalRequest> }
  | { valid: false };

export function validTimeRange(issuedAt: string, expiresAt: string, now: number): boolean {
  const issued = Date.parse(issuedAt), expires = Date.parse(expiresAt);
  return Number.isSafeInteger(now) && now >= 0 && now <= 8_640_000_000_000_000
    && issued <= now + typedActionMaxFutureSkewMs && expires > now && expires > issued
    && expires - issued <= typedActionMaxLifetimeMs;
}
export function withinWindow(issuedAt: string, expiresAt: string, startsAt: string, endsAt: string, now: number): boolean {
  const starts = Date.parse(startsAt), ends = Date.parse(endsAt);
  return starts <= now && now < ends && starts <= Date.parse(issuedAt) && Date.parse(expiresAt) <= ends;
}
export function verifyEd25519(bytes: Buffer, signature: string, keyId: string, keys: ReadonlyMap<string, KeyObject>): boolean {
  const key = keys.get(keyId);
  return !!key && key.type === "public" && key.asymmetricKeyType === "ed25519"
    && verify(null, bytes, key, Buffer.from(signature, "base64url"));
}

/** Pure authentication/binding check. Does NOT consume jti, authorize execution,
 * load keys, fetch review/policy context, or grant Human Approval. */
export function verifyTypedActionApproval(input: unknown, trustedContext: unknown,
  trustedKeys: ReadonlyMap<string, KeyObject>, now: number): TypedActionApprovalVerification {
  try {
    const value = parseStrict(signedTypedActionApprovalSchema, input);
    const context = parseStrict(trustedTypedActionApprovalContextSchema, trustedContext);
    const p = value.payload;
    if (!bindingsMatch(p, context) || !validTimeRange(p.issuedAt, p.expiresAt, now)
      || !withinWindow(p.issuedAt, p.expiresAt, context.maintenanceWindowStartsAt, context.maintenanceWindowExpiresAt, now)
      || !verifyEd25519(typedActionApprovalSigningBytes(value), value.signature, value.approverKeyId, trustedKeys)) return { valid: false };
    return immutable({ valid: true as const, jti: p.jti, payload: p });
  } catch { return { valid: false }; }
}
