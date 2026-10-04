/**
 * Bounded typed-action implementation seam.
 *
 * Bootstrap intentionally contains no executable action. Future bounded
 * control-plane tasks may edit this file, src/mcp/server.ts, and the matching
 * test file only. The profile gate itself remains outside that edit scope.
 */
export const typedActionBootstrap = Object.freeze({ version: 1 as const });

import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().uuid().regex(/^[0-9a-f-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.union([
  z.object({ algorithm: z.literal("sha1"), digest: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  z.object({ algorithm: z.literal("sha256"), digest: sha256 }).strict(),
]);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ precision: 3 });
const backup = z.object({ snapshotId: id, sha256, generation }).strict();
const serviceState = z.enum(["running", "stopped", "failed"]);

export const actionKinds = Object.freeze([
  "GitIntegrateMain", "AptUpgradeNode", "AptUpgradeGuest", "AppUpgrade", "RestartService", "RebootNode",
] as const);
export type ActionKind = typeof actionKinds[number];
export type ActionRisk = "low" | "elevated" | "destructive";

// These are requirements, never evidence that approval has been granted.
const approval = {
  human: z.literal("required"),
  independentReview: z.literal("required"),
  binding: z.literal("request-hash-and-attempt"),
};
const common = {
  schemaVersion: z.literal(1),
  actionId: id,
  preconditions: z.object({
    targetGeneration: generation,
    policySha256: sha256,
    maintenanceWindowId: id,
    recheck: z.literal("immediately-before-mutation-under-exclusive-fence"),
  }).strict(),
  timeout: z.object({
    preflightMs: z.number().int().min(1).max(300_000),
    executionMs: z.number().int().min(1).max(3_600_000),
    verificationMs: z.number().int().min(1).max(300_000),
    onExpiry: z.literal("stop-and-reconcile"),
  }).strict(),
  rollback: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("none"), onFailure: z.literal("block-and-reconcile") }).strict(),
    z.object({ mode: z.literal("separate-approved-action"), backup }).strict(),
  ]),
  retry: z.object({
    automaticMutationRetries: z.literal(0),
    recovery: z.literal("new-request-fresh-preflight-and-new-approval"),
  }).strict(),
  retryOf: z.object({ actionId: id, requestHash: sha256, receiptHash: sha256,
    attemptId: id, attemptHash: sha256, attemptSequence: sequence }).strict().nullable(),
};
const elevated = {
  risk: z.literal("elevated"),
  approval: z.object({ ...approval, destructive: z.literal("not-applicable"), reboot: z.literal("not-applicable") }).strict(),
};
const target = <T extends string>(kind: T) => z.object({ kind: z.literal(kind), id }).strict();
const packageExpected = z.object({ generation, inventorySha256: sha256, backup }).strict();
const packageDesired = z.object({ approvedManifestSha256: sha256 }).strict();

/** Canonical local-state digests, shared by preflight and final observations.
 * Encode exact paths and identities unambiguously in deterministic path order;
 * never hash diff display text, locale-dependent output or rename inference.
 * stagedDelta: only HEAD/index differences, binding path and each side's mode
 * and blob/object identity (including object algorithm), or explicit absence.
 * Covers add/delete/modify/mode/type changes; renames may be delete + add.
 * This is NOT the whole index or HEAD identity: clean paths are excluded.
 * unstagedDelta: only index/working-tree differences, binding path, index-side
 * mode/object identity or absence, and working-tree content/type/mode identity
 * or absence. untrackedState binds path, file type and content identity.
 * localChangePaths binds the deduplicated union of staged/unstaged/untracked
 * paths. A future adapter must BLOCK unmerged index stages and remote-only
 * changed paths overlapping this union before mutation (fail closed).
 * Disjoint remote changes may advance HEAD and clean index entries while all
 * four local-state digests remain equal. Computing observations is adapter work.
 */
const gitLocalState = {
  stagedDeltaSha256: sha256,
  unstagedDeltaSha256: sha256,
  untrackedStateSha256: sha256,
  localChangePathsSha256: sha256,
};

/** IDs resolve only through a future trusted inventory; they are not paths or selectors.
 * Manifests/policies are content-addressed, independently approved inventory records.
 * A digest alone never authorizes executing a manifest or accessing a resource.
 */
export const actionRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common, ...elevated, kind: z.literal("GitIntegrateMain"), target: target("repository"),
    // HEAD is local main, remoteHead is origin/main. Inventory fixes repository
    // and origin identity; both observations use the local-state contract above.
    expected: z.object({ generation, head: commit, remoteHead: commit, ...gitLocalState }).strict(),
    desired: z.object({
      branch: z.literal("main"), remote: z.literal("origin"),
      operation: z.literal("merge-origin-main-no-edit-and-push"),
      fetch: z.literal("no-tags"), remoteHeadCheck: z.literal("match-expected-after-fetch"),
      divergenceCheck: z.literal("recheck-before-merge"),
      overlapCheck: z.literal("remote-only-paths-disjoint-from-local-change-paths"),
      onConflict: z.literal("merge-abort-and-block"),
      parentCheck: z.literal("verify-against-premerge-heads"),
      localState: z.literal("preserve-staged-unstaged-and-untracked-deltas"),
      finalRelation: z.literal("origin-main-equals-head"),
      finalVerification: z.literal("fetch-and-check-zero-ahead-zero-behind-and-local-state"),
    }).strict(),
    reboot: z.literal("forbidden"),
  }).strict(),
  z.object({
    ...common, ...elevated, kind: z.literal("AptUpgradeNode"), target: target("node"),
    expected: packageExpected, desired: packageDesired, reboot: z.literal("separate-approved-action-if-needed"),
  }).strict(),
  z.object({
    ...common, ...elevated, kind: z.literal("AptUpgradeGuest"), target: target("guest"),
    expected: packageExpected, desired: packageDesired, reboot: z.literal("separate-approved-action-if-needed"),
  }).strict(),
  z.object({
    ...common, ...elevated, kind: z.literal("AppUpgrade"), target: target("application"),
    expected: z.object({ generation, artifactSha256: sha256, serviceState, backup }).strict(),
    desired: z.object({ artifactSha256: sha256, releaseGeneration: generation }).strict(),
    reboot: z.literal("forbidden"),
  }).strict(),
  z.object({
    ...common, ...elevated, kind: z.literal("RestartService"), target: target("service"),
    expected: z.object({ generation, serviceState, configurationSha256: sha256 }).strict(),
    desired: z.object({ serviceState: z.literal("running") }).strict(), reboot: z.literal("forbidden"),
  }).strict(),
  z.object({
    ...common, kind: z.literal("RebootNode"), target: target("node"), risk: z.literal("destructive"),
    approval: z.object({ ...approval, destructive: z.literal("separate-required"), reboot: z.literal("separate-required") }).strict(),
    expected: z.object({ generation, bootId: id, backup }).strict(),
    desired: z.object({ boot: z.literal("new-boot-id"), health: z.literal("healthy") }).strict(),
    reboot: z.literal("required"),
  }).strict(),
]);

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type ActionRequest = Immutable<z.infer<typeof actionRequestSchema>>;
function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

// Reject non-JSON data before parsing: Zod must never silently discard hidden
// fields, accessors, undefined values, array properties, or custom prototypes.
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new Error("Expected plain JSON data");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error("Expected plain JSON data");
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw new Error("Invalid JSON array");
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)
      || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error("Invalid JSON property");
    assertJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

export function parseActionRequest(input: unknown): ActionRequest {
  assertJson(input);
  const request = actionRequestSchema.parse(input);
  if (request.retryOf?.actionId === request.actionId) throw new Error("Retry requires a new action ID");
  return freeze(request);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}
function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonical(value)}`, "utf8").digest("hex");
}
export function canonicalizeActionRequest(input: unknown): string {
  return canonical(parseActionRequest(input));
}
export function hashActionRequest(input: unknown): string {
  return digest("typed-action-request-v1", parseActionRequest(input));
}
export function bindActionRequest(input: unknown) {
  const request = parseActionRequest(input);
  return freeze({ request, requestHash: hashActionRequest(request) });
}

export const maintenanceCheckKinds = Object.freeze([
  "ClusterQuorum", "NodeResources", "NodeUpdates", "GuestExpectedState", "GuestUpdates", "ApplicationVersion",
  "StorageHealth", "BackupFreshness", "ServiceHealth", "TimerHealth", "SecurityBoundary",
] as const);
export type MaintenanceCheckKind = typeof maintenanceCheckKinds[number];
export const maintenanceActionKinds = Object.freeze([
  "AptUpgradeNode", "AptUpgradeGuest", "AppUpgrade", "RestartService", "RebootNode",
] as const);
export type MaintenanceActionKind = typeof maintenanceActionKinds[number];
const maintenanceTargetKinds = ["cluster", "node", "guest", "application", "service", "storage", "backup", "timer", "security-boundary"] as const;
const maintenanceTargetSchema = z.object({ kind: z.enum(maintenanceTargetKinds), id }).strict();
const maintenanceObservationSchema = z.object({
  checkId: id, checkKind: z.enum(maintenanceCheckKinds), target: maintenanceTargetSchema,
  result: z.enum(["PASS", "WARN", "FAIL", "UNKNOWN"]), targetGeneration: generation,
  observedAt: timestamp, evidenceSha256: sha256,
}).strict();
const targetForCheck: Readonly<Record<MaintenanceCheckKind, typeof maintenanceTargetKinds[number]>> = Object.freeze({
  ClusterQuorum: "cluster", NodeResources: "node", NodeUpdates: "node", GuestExpectedState: "guest",
  GuestUpdates: "guest", ApplicationVersion: "application", StorageHealth: "storage", BackupFreshness: "backup",
  ServiceHealth: "service", TimerHealth: "timer", SecurityBoundary: "security-boundary",
});
export const maintenanceSnapshotSchema = z.object({
  schemaVersion: z.literal(1), snapshotId: id, collectorId: id, collectedAt: timestamp,
  inventoryGeneration: generation, inventorySha256: sha256, policySha256: sha256,
  checks: z.array(maintenanceObservationSchema).min(1).max(512),
}).strict().superRefine((snapshot, ctx) => {
  const seen = new Set<string>();
  for (const [index, check] of snapshot.checks.entries()) {
    if (seen.has(check.checkId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "checkId"], message: "Duplicate maintenance check ID" });
    seen.add(check.checkId);
    if (Date.parse(check.observedAt) > Date.parse(snapshot.collectedAt))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "observedAt"], message: "Observation is newer than snapshot" });
    const expected = targetForCheck[check.checkKind];
    if (check.target.kind !== expected)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "target", "kind"], message: "Maintenance check target mismatch" });
  }
});
export type MaintenanceSnapshot = Immutable<z.infer<typeof maintenanceSnapshotSchema>>;
const maintenanceDisposition = z.enum(["NO_ACTION", "OBSERVE", "PROPOSE_ACTION", "ESCALATE_HUMAN"]);
const maintenanceReasonCode = z.enum(["HEALTHY", "DEGRADED", "UPDATE_AVAILABLE", "RESTART_RECOMMENDED", "REBOOT_RECOMMENDED",
  "BACKUP_STALE", "POLICY_VIOLATION", "EVIDENCE_UNKNOWN", "MANUAL_REVIEW_REQUIRED"]);
const maintenanceRecommendationSchema = z.object({
  checkId: id, target: maintenanceTargetSchema, disposition: maintenanceDisposition,
  actionKind: z.enum(maintenanceActionKinds).nullable(), reasonCode: maintenanceReasonCode,
}).strict().superRefine((recommendation, ctx) => {
  if ((recommendation.disposition === "PROPOSE_ACTION") !== (recommendation.actionKind !== null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actionKind"], message: "Action kind is proposal-only" });
});
export const maintenancePlanSchema = z.object({
  schemaVersion: z.literal(1), planId: id, snapshotHash: sha256, createdAt: timestamp,
  semantics: z.object({ authority: z.literal("none"), executionPermission: z.literal(false),
    approval: z.literal("required-for-mutation"), done: z.literal(false) }).strict(),
  recommendations: z.array(maintenanceRecommendationSchema).min(1).max(512),
}).strict().superRefine((plan, ctx) => {
  const seen = new Set<string>();
  for (const [index, recommendation] of plan.recommendations.entries()) {
    if (seen.has(recommendation.checkId)) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: ["recommendations", index, "checkId"], message: "Duplicate maintenance recommendation" });
    seen.add(recommendation.checkId);
  }
});
export type MaintenancePlan = Immutable<z.infer<typeof maintenancePlanSchema>>;

export function parseMaintenanceSnapshot(input: unknown): MaintenanceSnapshot {
  assertJson(input);
  return freeze(maintenanceSnapshotSchema.parse(input));
}
export function canonicalizeMaintenanceSnapshot(input: unknown): string {
  return canonical(parseMaintenanceSnapshot(input));
}
export function hashMaintenanceSnapshot(input: unknown): string {
  return digest("dot-maintenance-snapshot-v1", parseMaintenanceSnapshot(input));
}
export function parseMaintenancePlan(input: unknown): MaintenancePlan {
  assertJson(input);
  return freeze(maintenancePlanSchema.parse(input));
}
export function canonicalizeMaintenancePlan(input: unknown): string {
  return canonical(parseMaintenancePlan(input));
}
export function hashMaintenancePlan(input: unknown): string {
  return digest("dot-maintenance-plan-v1", parseMaintenancePlan(input));
}
const maintenanceActionTarget: Readonly<Record<MaintenanceActionKind, typeof maintenanceTargetKinds[number]>> = Object.freeze({
  AptUpgradeNode: "node", AptUpgradeGuest: "guest", AppUpgrade: "application", RestartService: "service", RebootNode: "node",
});

/** Binds a proposal-only Dot plan to a complete trusted snapshot. This creates no
 * approval, execution permission, PASS, permit or DONE state. Mutation proposals
 * must become fresh typed-action requests and traverse the normal review/human path. */
export function bindMaintenancePlan(input: unknown, snapshotInput: unknown) {
  const snapshot = parseMaintenanceSnapshot(snapshotInput), plan = parseMaintenancePlan(input);
  const snapshotHash = hashMaintenanceSnapshot(snapshot);
  if (plan.snapshotHash !== snapshotHash) throw new Error("Maintenance snapshot binding mismatch");
  if (Date.parse(plan.createdAt) < Date.parse(snapshot.collectedAt)) throw new Error("Maintenance plan predates snapshot");
  if (plan.recommendations.length !== snapshot.checks.length) throw new Error("Maintenance plan must cover every check");
  const checks = new Map(snapshot.checks.map(check => [check.checkId, check] as const));
  for (const recommendation of plan.recommendations) {
    const check = checks.get(recommendation.checkId);
    if (!check || canonical(check.target) !== canonical(recommendation.target)) throw new Error("Maintenance recommendation binding mismatch");
    if (check.result !== "PASS" && recommendation.disposition === "NO_ACTION") throw new Error("Non-PASS maintenance result requires attention");
    if (recommendation.actionKind && recommendation.target.kind !== maintenanceActionTarget[recommendation.actionKind])
      throw new Error("Maintenance action target mismatch");
    checks.delete(recommendation.checkId);
  }
  if (checks.size) throw new Error("Maintenance plan omitted checks");
  return freeze({ snapshot, snapshotHash, plan, planHash: hashMaintenancePlan(plan) });
}

/** A trusted coordinator allocates IDs/sequences, persists them and prevents
 * reuse across history. This pure contract neither allocates nor consumes an
 * attempt, and its hash is NOT an approval/signature. Human Approval/Finalizer
 * must bind the domain-separated attemptHash (which includes requestHash), not
 * requestHash alone. Rehashing changed data creates a different approval identity.
 */
export const actionAttemptSchema = z.object({
  schemaVersion: z.literal(1), attemptId: id, actionId: id, requestHash: sha256,
  sequence, createdAt: timestamp,
  approvalIdentity: z.literal("typed-action-attempt-sha256-v1"),
}).strict();
export type ActionAttempt = Immutable<z.infer<typeof actionAttemptSchema>>;

export function bindActionAttempt(input: unknown, requestInput: unknown) {
  const request = parseActionRequest(requestInput);
  assertJson(input);
  const attempt = actionAttemptSchema.parse(input);
  if (attempt.actionId !== request.actionId || attempt.requestHash !== hashActionRequest(request)) {
    throw new Error("Attempt request mismatch");
  }
  if (attempt.sequence !== (request.retryOf ? request.retryOf.attemptSequence + 1 : 1)
    || attempt.attemptId === request.retryOf?.attemptId) throw new Error("Retry requires a new sequenced attempt");
  return freeze({ attempt, attemptHash: digest("typed-action-attempt-v1", attempt) });
}
export function hashActionAttempt(input: unknown, requestInput: unknown): string {
  return bindActionAttempt(input, requestInput).attemptHash;
}
export type BoundActionAttempt = ReturnType<typeof bindActionAttempt>;
const boundAttemptSchema = z.object({ attempt: actionAttemptSchema, attemptHash: sha256 }).strict();
function validateBoundAttempt(input: unknown, requestInput: unknown): BoundActionAttempt {
  assertJson(input);
  const supplied = boundAttemptSchema.parse(input);
  const bound = bindActionAttempt(supplied.attempt, requestInput);
  if (supplied.attemptHash !== bound.attemptHash) throw new Error("Attempt binding mismatch");
  return bound;
}

/** Observations must be gathered by a trusted adapter under an exclusive fence
 * immediately before mutation. This pure comparison is NOT an execution permit.
 * The future executor must hold the fence through mutation (or use atomic CAS).
 */
export function assertExpectedState(input: unknown, observation: unknown): void {
  const request = parseActionRequest(input);
  assertJson(observation);
  if (canonical(request.expected) !== canonical(observation)) throw new Error("Expected state mismatch");
}

export const actionStates = Object.freeze([
  "PROPOSED", "WAITING_APPROVAL", "APPROVED", "PREFLIGHT", "EXECUTING", "VERIFYING", "SUCCEEDED", "FAILED", "BLOCKED",
] as const);
export type ActionState = typeof actionStates[number];
const transitions: Readonly<Record<ActionState, readonly ActionState[]>> = freeze({
  PROPOSED: ["WAITING_APPROVAL", "BLOCKED"],
  WAITING_APPROVAL: ["APPROVED", "BLOCKED"],
  APPROVED: ["PREFLIGHT", "BLOCKED"],
  PREFLIGHT: ["EXECUTING", "FAILED", "BLOCKED"],
  EXECUTING: ["VERIFYING", "FAILED", "BLOCKED"],
  VERIFYING: ["SUCCEEDED", "FAILED", "BLOCKED"],
  SUCCEEDED: [], FAILED: [], BLOCKED: [],
});
/** Structural audit validation only. States (including APPROVED) carry no
 * authority. No transition issues approval or authorizes execution. A future
 * executor must independently validate Human Approver and independent review
 * evidence bound to request hash/attempt, expiry, and one-time consumption.
 */
export function assertActionTransition(from: ActionState, to: ActionState): void {
  if (!Object.hasOwn(transitions, from) || !transitions[from].includes(to)) throw new Error("Invalid action state transition");
}

const phaseResult = z.object({
  status: z.enum(["not-run", "passed", "failed", "indeterminate"]),
  evidenceHashes: z.array(sha256).max(256),
}).strict().superRefine((result, ctx) => {
  if (result.status !== "not-run" && result.evidenceHashes.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Attempted phase requires evidence" });
  }
});
// Future adapter: only main/origin, fetch --no-tags, normal merge --no-edit,
// abort on conflict (verify restoration, otherwise block and reconcile), verify
// parents and local changes before push, normal push, fetch and verify again.
// No caller/config-selected strategy, message, force, rebase, stash/autostash,
// reset, checkout, clean, amend or cherry-pick. Fast-forward/unchanged results
// have no generated merge commit. Actual generated SHAs belong only in receipts.
const gitResult = z.object({
  integration: z.enum(["merge", "fast-forward", "unchanged"]),
  finalHead: commit, originMainHead: commit,
  mergeCommit: commit.nullable(), mergeParents: z.array(commit).max(2),
  ...gitLocalState,
  ahead: generation, behind: generation,
}).strict();
export const actionReceiptSchema = z.object({
  schemaVersion: z.literal(1), actionId: id, attemptId: id, attemptHash: sha256, requestHash: sha256,
  startedAt: timestamp, completedAt: timestamp,
  authorization: z.object({ humanApprovalEvidenceHash: sha256, independentReviewEvidenceHash: sha256,
    destructiveApprovalEvidenceHash: sha256.nullable(), rebootApprovalEvidenceHash: sha256.nullable() }).strict().nullable(),
  preflight: phaseResult, execution: phaseResult, healthCheck: phaseResult,
  gitResult: gitResult.nullable(),
  rollback: z.object({ status: z.enum(["not-needed", "required", "separate-action"]),
    actionId: id.nullable(), receiptHash: sha256.nullable() }).strict(),
  finalState: z.enum(["SUCCEEDED", "FAILED", "BLOCKED"]), evidenceHashes: z.array(sha256).min(1).max(256),
}).strict().superRefine((receipt, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) fail("Invalid receipt chronology");
  if (receipt.execution.status !== "not-run" && (receipt.preflight.status !== "passed" || !receipt.authorization)) fail("Execution requires preflight and authorization evidence");
  if (receipt.healthCheck.status !== "not-run" && receipt.execution.status !== "passed") fail("Health check requires completed execution");
  if (receipt.finalState === "SUCCEEDED" && (receipt.preflight.status !== "passed" || receipt.execution.status !== "passed"
    || receipt.healthCheck.status !== "passed" || receipt.rollback.status !== "not-needed")) fail("Success requires verified execution");
  if (receipt.rollback.status === "separate-action"
    ? !receipt.rollback.actionId || !receipt.rollback.receiptHash
    : receipt.rollback.actionId !== null || receipt.rollback.receiptHash !== null) fail("Invalid rollback linkage");
});
export type ActionReceipt = Immutable<z.infer<typeof actionReceiptSchema>>;
/** Evidence hashes are audit references, not proof of authority. Persist through
 * a trusted append-only audit writer; never accept caller receipts as permits.
 */
export function bindActionReceipt(input: unknown, requestInput: unknown, attemptInput: unknown) {
  const request = parseActionRequest(requestInput);
  const bound = validateBoundAttempt(attemptInput, request);
  assertJson(input);
  const receipt = actionReceiptSchema.parse(input);
  if (receipt.actionId !== request.actionId || receipt.requestHash !== hashActionRequest(request)) throw new Error("Receipt request mismatch");
  if (receipt.attemptId !== bound.attempt.attemptId || receipt.attemptHash !== bound.attemptHash) throw new Error("Receipt attempt mismatch");
  if (Date.parse(receipt.startedAt) < Date.parse(bound.attempt.createdAt)) throw new Error("Receipt predates attempt");
  if (request.kind !== "GitIntegrateMain" && receipt.gitResult !== null) throw new Error("Unexpected Git result");
  if (request.kind === "GitIntegrateMain" && receipt.finalState === "SUCCEEDED") {
    const result = receipt.gitResult;
    if (!result || result.ahead !== 0 || result.behind !== 0
      || canonical(result.finalHead) !== canonical(result.originMainHead)
      || (Object.keys(gitLocalState) as (keyof typeof gitLocalState)[])
        .some((key) => result[key] !== request.expected[key])) throw new Error("Git postcondition mismatch");
    if (result.integration === "merge") {
      if (canonical(result.mergeCommit) !== canonical(result.finalHead)
        || canonical(result.mergeParents) !== canonical([request.expected.head, request.expected.remoteHead])
        || canonical(request.expected.head) === canonical(request.expected.remoteHead)
        || canonical(result.finalHead) === canonical(request.expected.head)
        || canonical(result.finalHead) === canonical(request.expected.remoteHead)) throw new Error("Git merge parent mismatch");
    } else if (result.mergeCommit !== null || result.mergeParents.length !== 0
      || canonical(result.finalHead) !== canonical(result.integration === "fast-forward" ? request.expected.remoteHead : request.expected.head)) {
      throw new Error("Git integration result mismatch");
    }
  }
  if (request.kind === "RebootNode" && receipt.execution.status !== "not-run"
    && (!receipt.authorization?.destructiveApprovalEvidenceHash || !receipt.authorization.rebootApprovalEvidenceHash)) {
    throw new Error("Missing separate approval evidence");
  }
  return freeze({ receipt, receiptHash: digest("typed-action-receipt-v1", receipt) });
}

/** Every retry is a new proposal, including indeterminate/time-out outcomes.
 * Reconcile prior effects before proposing; never resume a terminal attempt.
 * Approval and a fenced fresh preflight must be repeated even if state is equal.
 */
export function assertRetryRequest(previousInput: unknown, receiptInput: unknown, nextInput: unknown,
  previousAttemptInput: unknown, nextAttemptInput: unknown): void {
  const previous = parseActionRequest(previousInput);
  const previousAttempt = validateBoundAttempt(previousAttemptInput, previous);
  const { receipt, receiptHash } = bindActionReceipt(receiptInput, previous, previousAttempt);
  const next = parseActionRequest(nextInput);
  const nextAttempt = validateBoundAttempt(nextAttemptInput, next);
  if (receipt.finalState === "SUCCEEDED" || next.actionId === previous.actionId
    || next.kind !== previous.kind || canonical(next.target) !== canonical(previous.target)
    || next.retryOf?.actionId !== previous.actionId || next.retryOf.requestHash !== receipt.requestHash
    || next.retryOf.receiptHash !== receiptHash
    || next.retryOf.attemptId !== previousAttempt.attempt.attemptId
    || next.retryOf.attemptHash !== previousAttempt.attemptHash
    || next.retryOf.attemptSequence !== previousAttempt.attempt.sequence
    || nextAttempt.attempt.attemptId === previousAttempt.attempt.attemptId
    || Date.parse(nextAttempt.attempt.createdAt) < Date.parse(receipt.completedAt)) throw new Error("Invalid retry proposal");
}

// Deliberately no registration or execution API in this phase.
export const executableMutationAdapters: readonly never[] = Object.freeze([]);

/** Pure, non-authoritative Production KVM Executor readiness contract.
 * Evidence digests are references, not independently verified attestations.
 * No readiness result provisions, deploys, approves, permits or executes.
 */
const productionKvmIdentitySchema = z.object({
  inventory: z.object({ inventoryId: id, inventoryGeneration: generation, inventorySha256: sha256 }).strict(),
  sourceCommit: commit,
  executorPackageSha256: sha256,
  executorRuntimeSha256: sha256,
  executorPolicySha256: sha256,
  stage1ProofHashes: z.object({ substrateSha256: sha256, negativeBoundarySha256: sha256 }).strict(),
}).strict();

export const productionKvmCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  identity: productionKvmIdentitySchema,
  semantics: z.object({
    oauthCustody: z.literal("HOST_ONLY"),
    mutation: z.literal("FORBIDDEN"),
    deployment: z.literal("FORBIDDEN"),
    reviewSigningApproval: z.literal("FORBIDDEN"),
    genericExecution: z.literal("FORBIDDEN"),
  }).strict(),
}).strict();

export const productionKvmReadinessGateNames = Object.freeze([
  "stage1SubstrateKvm", "negativeCredentials", "negativeRepoExternalReads",
  "negativeUnapprovedNetwork", "negativeHostProcessSpawn",
  "negativeCanonicalControllerVerifierMutation", "negativeGenericShellToolEscalation",
  "negativeOutOfEvidencePathMutation", "cgroupResourceLimits", "providerOnlyEgress",
  "trustedHostOnlyOAuthCustody", "liveProviderCertification", "productionPlatformDurability",
  "exclusiveHostCustodyCurrentness",
] as const);
const readinessGateShape = z.object({
  result: z.enum(["PASS", "FAIL", "UNKNOWN"]), evidenceSha256: sha256,
}).strict();
const readinessGatesSchema = z.object(Object.fromEntries(
  productionKvmReadinessGateNames.map(name => [name, readinessGateShape]),
) as Record<typeof productionKvmReadinessGateNames[number], typeof readinessGateShape>).strict();
export const productionKvmEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  candidateHash: sha256,
  boundIdentity: productionKvmIdentitySchema,
  gates: readinessGatesSchema,
}).strict();

export function parseProductionKvmCandidate(input: unknown) {
  assertJson(input);
  return freeze(productionKvmCandidateSchema.parse(input));
}
export function parseProductionKvmEvidence(input: unknown) {
  assertJson(input);
  return freeze(productionKvmEvidenceSchema.parse(input));
}
export function hashProductionKvmCandidate(input: unknown): string {
  return digest("production-kvm-candidate-v1", parseProductionKvmCandidate(input));
}
export function hashProductionKvmEvidence(input: unknown): string {
  return digest("production-kvm-evidence-v1", parseProductionKvmEvidence(input));
}
export function assessProductionKvmReadiness(candidateInput: unknown, evidenceInput: unknown) {
  const candidate = parseProductionKvmCandidate(candidateInput);
  const evidence = parseProductionKvmEvidence(evidenceInput);
  const candidateHash = hashProductionKvmCandidate(candidate);
  const evidenceHash = hashProductionKvmEvidence(evidence);
  const ready = evidence.candidateHash === candidateHash
    && canonical(evidence.boundIdentity) === canonical(candidate.identity)
    && productionKvmReadinessGateNames.every(name => evidence.gates[name].result === "PASS");
  return freeze({
    candidateHash, evidenceHash,
    status: ready ? "READY_FOR_HUMAN_BOUNDARY_REVIEW" as const : "BLOCKED" as const,
    authority: "NONE" as const, productionExecution: false as const,
    permit: "NOT_ISSUED" as const, done: false as const,
  });
}
