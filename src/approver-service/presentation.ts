import { z } from 'zod';
import { canonicalJson, domainHash, idSchema, keyIdSchema, sha256Schema, typedActionApprovalRequestSchema, trustedTypedActionApprovalContextSchema, bindingsMatch, parseStrict } from '../typed-action-approval/contract.js';
import { validTimeRange, withinWindow } from '../typed-action-approval/verifier.js';

export const presentationBodySchema = z.object({
  schemaVersion: z.literal(1), presentationId: idSchema,
  request: typedActionApprovalRequestSchema,
  context: trustedTypedActionApprovalContextSchema,
  trustedSourceIdentity: keyIdSchema,
}).strict();
export const presentationSchema = presentationBodySchema.extend({ presentationHash: sha256Schema }).strict();
export type TrustedTypedActionPresentation = z.infer<typeof presentationSchema>;
export function presentationHash(body: z.infer<typeof presentationBodySchema>): string {
  return domainHash('CT700_TRUSTED_PRESENTATION_V1', parseStrict(presentationBodySchema, body));
}
export function parsePresentation(input: unknown): TrustedTypedActionPresentation {
  const p = parseStrict(presentationSchema, input);
  const { presentationHash: hash, ...body } = p;
  if (hash !== presentationHash(body) || !bindingsMatch(p.request, p.context)) throw Error('PRESENTATION_BINDING_MISMATCH');
  return p;
}
export function presentationCurrent(p: TrustedTypedActionPresentation, now: number): boolean {
  return validTimeRange(p.request.issuedAt, p.request.expiresAt, now) &&
    withinWindow(p.request.issuedAt, p.request.expiresAt, p.context.maintenanceWindowStartsAt, p.context.maintenanceWindowExpiresAt, now);
}
/** Host-owned authenticated channel seam. Never implement by accepting caller booleans/headers.
 * Returning a record attests source authentication AND independently verified current bindings.
 * IR-04/05 must serialize invalidation with this store before enabling this dependency. */
export interface TrustedTypedActionPresentationVerifier {
  verifyRegistration(candidate: unknown): TrustedTypedActionPresentation | null;
  authorizeLookup(lookup: { operation: 'status' | 'evidence'; approvalRequestId: string }): boolean;
}
export const denyAllPresentationVerifier: TrustedTypedActionPresentationVerifier = Object.freeze({
  verifyRegistration: () => null, authorizeLookup: () => false,
});
export const sameRequest = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
