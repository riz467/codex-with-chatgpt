import { z } from "zod";
import { assertJson, canonicalJson, digest, parseJson } from "./hash.js";
import { phases } from "./state-machine.js";

export const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const utc = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const integer = z.number().int().safe().nonnegative();
export function strict<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = typeof input === "string" ? parseJson(input) : input;
  assertJson(value); return schema.parse(value);
}
export const operationKinds = ["TEST_READ_ONLY", "TEST_MUTATION", "TEST_HUMAN_CEREMONY"] as const;
export const catalog = Object.freeze({ schemaVersion: 1, kind: "OfflineTestOperationCatalog",
  operations: operationKinds });
export const catalogSha256 = digest("bootstrap-offline-catalog-v1", catalog);
const placeholder = <T extends string>(kind: T) => z.object({ schemaVersion: z.literal(1), kind: z.literal(kind),
  status: z.literal("NOT_IMPLEMENTED"), contractSha256: sha }).strict();
export const validitySchema = z.object({ notBefore: utc, authorizeBefore: utc, expiresAt: utc,
  maxClockSkewMs: integer.max(5000), observationMaxAgeMs: integer.positive().max(300_000) }).strict()
  .refine(v => Date.parse(v.notBefore) < Date.parse(v.authorizeBefore) && Date.parse(v.authorizeBefore) < Date.parse(v.expiresAt)
    && Date.parse(v.expiresAt) - Date.parse(v.notBefore) <= 8 * 3600_000);
export const stepSchema = z.object({ stepId: id, operationKind: z.enum(operationKinds), targetRef: z.literal("OFFLINE_FIXTURE"),
  phase: z.enum(phases), dependencies: z.array(id).max(256), inputDigest: sha, preconditionDigest: sha,
  postconditionDigest: sha, timeoutMs: integer.positive().max(1_800_000), maxMutationAttempts: z.literal(1),
  expectedReceipt: z.object({ schemaVersion: z.literal(1), kind: z.literal("OfflineTestStepReceipt") }).strict(),
  ceremonyId: id.nullable() }).strict();
export type Step = z.infer<typeof stepSchema>;
export const checkpointSchema = z.object({ sequence: integer, eventHash: sha }).strict();
export type Checkpoint = z.infer<typeof checkpointSchema>;
export const continuationSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("BootstrapBoundedContinuation"),
  originalCampaignId: uuid, originalManifestSha256: sha, previousCampaignId: uuid, previousManifestSha256: sha,
  previousCheckpoint: checkpointSchema, lastVerifiedCheckpoint: checkpointSchema,
  verifiedReceipts: z.array(z.object({ stepId: id, receiptSha256: sha, evidenceRoot: sha }).strict()).max(256),
  freshObservationRoot: sha, observedAt: utc, remainingStepIds: z.array(id).min(1).max(256) }).strict();
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("SecurityTrustBootstrapCampaign"), campaignId: uuid, authorizationNonce: uuid,
  trustDomainId: z.string().regex(/^tp-bootstrap-fixture-[a-z0-9-]{1,64}$/), validity: validitySchema,
  sources: z.object({ schemaVersion: z.literal(1), kind: z.literal("OfflineSourceBinding"), buildCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceTreeSha256: sha, evidenceRoot: sha, cleanBuild: z.literal(true) }).strict(),
  executor: z.object({ schemaVersion: z.literal(1), kind: z.literal("OfflineFixedExecutor"), artifactId: id, executorSha256: sha,
    payloadSha256: sha, runtimeIdentity: id, osIdentity: id, executionHostIdentity: id, operatorIdentity: id,
    catalogVersion: z.literal(1), catalogSha256: z.literal(catalogSha256) }).strict(),
  policyAdoptions: placeholder("PolicyAdoptionsPlaceholder"), ctManifests: placeholder("CtManifestsPlaceholder"),
  artifacts: placeholder("ArtifactsPlaceholder"), network: placeholder("NetworkPlaceholder"), keyTopology: placeholder("KeyTopologyPlaceholder"),
  authority: placeholder("AuthorityPlaceholder"), steps: z.array(stepSchema).min(1).max(256),
  allowedMutations: z.array(z.object({ stepId: id, targetRef: z.literal("OFFLINE_FIXTURE"),
    operationKind: z.literal("TEST_MUTATION"), inputDigest: sha, phase: z.enum(phases) }).strict()).max(256),
  forbiddenMutations: z.tuple([z.literal("PRODUCTION"), z.literal("ARBITRARY_EXECUTION"), z.literal("ROLLBACK"),
    z.literal("RETRY"), z.literal("REKEY"), z.literal("SCOPE_CHANGE"), z.literal("MANIFEST_PATCH")]),
  expectedPostCreateState: placeholder("PostCreateStatePlaceholder"),
  humanCeremonies: z.array(z.object({ schemaVersion: z.literal(1), ceremonyId: id,
    kind: z.enum(["TEST_TAILNET_ENROLLMENT", "TEST_PASSKEY_ENROLLMENT", "TEST_EXTERNAL_E2E"]),
    operatorIdentity: id, expiresAt: utc, expectedEvidenceDigest: sha }).strict()).max(256),
  verification: placeholder("VerificationPlaceholder"),
  stopConditions: z.tuple([z.literal("UNKNOWN"), z.literal("MISMATCH"), z.literal("EXPIRED"), z.literal("CANCELLED"), z.literal("CLOCK_ROLLBACK")]),
  reconciliationPolicy: z.object({ schemaVersion: z.literal(1), kind: z.literal("NewBoundedAuthorizationOnly"), automaticRetry: z.literal(false) }).strict(),
  cutover: z.object({ schemaVersion: z.literal(1), kind: z.literal("OfflineCutoverModel"), requiredEvidenceRoot: sha,
    irreversibleProtocolSha256: sha, productionMode: z.literal("PASSKEY_ONLY") }).strict(),
  audit: z.object({ schemaVersion: z.literal(1), kind: z.literal("LocalJournalContract"), journalId: id, ownerIdentity: id,
    externalAnchor: z.literal("IR_08_NOT_IMPLEMENTED"), hashChain: z.literal("SHA256_BOOTSTRAP_JOURNAL_V1"),
    redaction: z.literal("HASHES_AND_ENUMS_ONLY"), maxEvents: integer.min(100).max(100_000), retention: z.literal("PERMANENT") }).strict(),
  continuation: continuationSchema.nullable(),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export function parseManifest(input: unknown): Manifest {
  const m = strict(manifestSchema, input), map = new Map(m.steps.map(s => [s.stepId, s]));
  if (map.size !== m.steps.length) throw new Error("Duplicate step");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (s: Step): void => {
    if (visiting.has(s.stepId)) throw new Error("DAG cycle");
    if (visited.has(s.stepId)) return;
    visiting.add(s.stepId);
    if (new Set(s.dependencies).size !== s.dependencies.length) throw new Error("Duplicate dependency");
    for (const dep of s.dependencies) {
      const d = map.get(dep); if (!d) throw new Error("Missing dependency");
      if (phases.indexOf(d.phase) > phases.indexOf(s.phase)) throw new Error("Backward phase dependency");
      visit(d);
    }
    visiting.delete(s.stepId); visited.add(s.stepId);
  };
  m.steps.forEach(visit);
  const ceremonies = new Map(m.humanCeremonies.map(c => [c.ceremonyId, c]));
  if (ceremonies.size !== m.humanCeremonies.length) throw new Error("Duplicate ceremony");
  for (const s of m.steps) {
    if ((s.operationKind === "TEST_HUMAN_CEREMONY") !== (s.ceremonyId !== null)
      || (s.ceremonyId !== null && !ceremonies.has(s.ceremonyId))) throw new Error("Ceremony binding");
  }
  const ceremonyIds = m.steps.flatMap(s => s.ceremonyId ? [s.ceremonyId] : []);
  if (new Set(ceremonyIds).size !== m.humanCeremonies.length || ceremonyIds.length !== m.humanCeremonies.length) throw new Error("Unused/reused ceremony");
  if (m.humanCeremonies.some(c => c.operatorIdentity !== m.executor.operatorIdentity || c.expiresAt > m.validity.expiresAt)) throw new Error("Ceremony authority");
  const mutations = m.steps.filter(s => s.operationKind === "TEST_MUTATION").map(s => ({ stepId: s.stepId, targetRef: s.targetRef,
    operationKind: s.operationKind, inputDigest: s.inputDigest, phase: s.phase }));
  if (canonicalJson(mutations) !== canonicalJson(m.allowedMutations)) throw new Error("Exact mutation allowlist required");
  // Mutation concurrency is one; the timeout budget must fit even without ceremony wait.
  if (m.steps.reduce((sum, s) => sum + s.timeoutMs, 0) > Date.parse(m.validity.expiresAt) - Date.parse(m.validity.notBefore)) throw new Error("Campaign timeout budget");
  return m;
}
export function manifestHash(input: unknown): string { return digest("security-trust-bootstrap-campaign-v1", parseManifest(input)); }
