import { z } from "zod";
import { id, sha, utc, uuid, strict, type Manifest, manifestHash } from "./contract.js";

export const authorizationSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("BootstrapLocalAuthorizationReceipt"),
  domain: z.literal("bootstrap-human-admin-local-v1"), campaignId: uuid, manifestSha256: sha, authorizationNonce: uuid,
  executorSha256: sha, trustDomainId: z.string(), authorizedAt: utc, expiresAt: utc, operatorIdentity: id, executionHostIdentity: id,
  sourceEvidenceRoot: sha, authorizationTextDigest: sha, messageReference: id.nullable(), localAttestationDigest: sha,
  verificationMethod: z.literal("INDEPENDENT_HUMAN_ADMIN_PC"), productionApproval: z.literal(false) }).strict();
export type Authorization = z.infer<typeof authorizationSchema>;
export function parseAuthorization(input: unknown, m: Manifest, now: string): Authorization {
  const a = strict(authorizationSchema, input);
  if (a.campaignId !== m.campaignId || a.manifestSha256 !== manifestHash(m) || a.authorizationNonce !== m.authorizationNonce
    || a.executorSha256 !== m.executor.executorSha256 || a.trustDomainId !== m.trustDomainId
    || a.operatorIdentity !== m.executor.operatorIdentity || a.executionHostIdentity !== m.executor.executionHostIdentity
    || a.sourceEvidenceRoot !== m.sources.evidenceRoot || a.expiresAt !== m.validity.expiresAt
    || a.authorizedAt < m.validity.notBefore || a.authorizedAt >= m.validity.authorizeBefore
    || a.authorizedAt > now || now >= a.expiresAt || now < m.validity.notBefore) throw new Error("Authorization binding or validity");
  return a;
}
export const cancellationSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("BootstrapHumanCancellationReceipt"),
  domain: z.literal("bootstrap-human-admin-cancellation-v1"), campaignId: uuid, manifestSha256: sha, authorizationNonce: uuid,
  operatorIdentity: id, executionHostIdentity: id, cancelledAt: utc, localAttestationDigest: sha }).strict();
export const ceremonyReceiptSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("BootstrapOfflineCeremonyReceipt"),
  domain: z.literal("bootstrap-offline-ceremony-v1"), campaignId: uuid, manifestSha256: sha, ceremonyId: id,
  operatorIdentity: id, executionHostIdentity: id, completedAt: utc, evidenceDigest: sha, localAttestationDigest: sha }).strict();
export const stepReceiptSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("OfflineTestStepReceipt"),
  campaignId: uuid, manifestSha256: sha, stepId: id, operationId: sha, inputDigest: sha,
  postconditionDigest: sha, evidenceRoot: sha, observedAt: utc, result: z.literal("OBSERVED") }).strict();
export const preconditionSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("OfflinePreconditionObservation"),
  campaignId: uuid, manifestSha256: sha, stepId: id, preconditionDigest: sha, evidenceRoot: sha, observedAt: utc }).strict();
export const verificationReceiptSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("OfflineVerificationReceipt"),
  campaignId: uuid, manifestSha256: sha, stepId: id, operationId: sha, observedReceiptSha256: sha,
  postconditionDigest: sha, evidenceRoot: sha, verifiedAt: utc }).strict();
export const cutoverReceiptSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("OfflineCutoverModelReceipt"),
  domain: z.literal("bootstrap-offline-cutover-model-v1"), campaignId: uuid, manifestSha256: sha, trustDomainId: z.string(),
  mode: z.enum(["BOOTSTRAP_DISABLED_PENDING", "PASSKEY_ONLY"]), evidenceRoot: sha, protocolSha256: sha,
  recordedAt: utc, productionPasskeyEvidence: z.literal(false) }).strict();
