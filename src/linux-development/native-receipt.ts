import fs from "node:fs";
import { z } from "zod";
import { canonicalJson } from "../task-contract/contract.js";
import { hashRecord, parseBinding } from "../execution-orchestrator/development/contract.js";
import { DevelopmentStore, type StoreAnchor } from "../execution-orchestrator/development/store.js";
import { admitFixedNative, assertNativeDirectory, assertNativeProcessIdentity, authorizationSchema, digestSchema, nativeBlocked, nativeHash,
  NATIVE_ROOTS, NATIVE_UID, readNativeFile, taskIdSchema, type NativeAuthorization } from "./native-admission.js";
import { launchFixedNativeRole, nativeCgroupMembership, type NativeRoleLauncher } from "./native-launcher.js";
import { nativeWorkerInputSchema, nativeWorkerOutputSchema, type NativeWorkerInput } from "./native-worker.js";
import { publishNativePublicReceipt, assertNativePublicResultProvisioning } from "./native-observer.js";

const sessionSchema = z.string().regex(/^ses_[A-Za-z0-9]+$/);
export const nativePublicReceiptSchema = z.object({ version: z.literal(1), task: z.literal("COUNTER_JSON_V1"),
  taskId: taskIdSchema, receiptId: z.literal("receipt-001"), mode: z.enum(["NATIVE_LINUX_HOST", "OFFLINE_INJECTED_NOT_OS_PROOF"]),
  result: z.enum(["UNKNOWN_NO_REPLAY", "NEEDS_WORK", "NATIVE_FIXED_DATA_ADVISORY_PASS_ONLY", "OFFLINE_CONTRACT_PASS_NOT_NATIVE"]),
  authority: z.literal("NONE"), productionDispatch: z.literal("CLOSED"), replay: z.literal(false),
  qualification: z.literal("NOT_RUN"), candidateCode: z.literal("NOT_EXECUTED"), fastOsProof: z.literal("NOT_CLAIMED"),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), manifestSha256: digestSchema, requestDigest: digestSchema,
  proposerSessionId: sessionSchema.nullable(), reviewerSessionId: sessionSchema.nullable(), candidateDigest: digestSchema.nullable(),
  settlements: z.array(z.object({ role: z.enum(["proposer", "reviewer"]),
    proof: z.enum(["EXIT_0_AND_CGROUP_EMPTY", "OFFLINE_OBSERVATION_ONLY"]) }).strict()).max(2),
  evidence: z.array(z.object({ id: z.string().regex(/^dev2-artifact-native-[a-z-]+$/), sha256: digestSchema }).strict()).max(16) }).strict()
  .superRefine((r, ctx) => {
    const nativePass = r.result === "NATIVE_FIXED_DATA_ADVISORY_PASS_ONLY", offlinePass = r.result === "OFFLINE_CONTRACT_PASS_NOT_NATIVE";
    if ((nativePass && r.mode !== "NATIVE_LINUX_HOST") || (offlinePass && r.mode !== "OFFLINE_INJECTED_NOT_OS_PROOF") ||
      (r.mode === "OFFLINE_INJECTED_NOT_OS_PROOF" && r.settlements.some(s => s.proof !== "OFFLINE_OBSERVATION_ONLY")) ||
      (r.mode === "NATIVE_LINUX_HOST" && r.settlements.some(s => s.proof !== "EXIT_0_AND_CGROUP_EMPTY")) ||
      ((nativePass || offlinePass || r.result === "NEEDS_WORK") && (!r.candidateDigest || !r.proposerSessionId || !r.reviewerSessionId ||
        r.proposerSessionId === r.reviewerSessionId || r.settlements.length !== 2 || r.settlements[0].role !== "proposer" ||
        r.settlements[1].role !== "reviewer" || (nativePass && r.settlements.some(s => s.proof !== "EXIT_0_AND_CGROUP_EMPTY"))))) {
      ctx.addIssue({ code: "custom", message: "UNSETTLED_PUBLIC_RESULT" });
    }
  });
export type NativePublicReceipt = z.infer<typeof nativePublicReceiptSchema>;
export interface NativeIntentJournal {
  /** Must be durable and exclusive before returning. Failure MUST prevent launch. */
  record(name: string, data: unknown): void;
  evidence(): NativePublicReceipt["evidence"];
}
const claimSchema = z.object({ version: z.literal(1), taskId: taskIdSchema, requestDigest: digestSchema,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), manifestSha256: digestSchema, replay: z.literal(false) }).strict();
function flushDirectory(dir: string) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function publish(file: string, value: unknown) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, canonicalJson(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  flushDirectory(NATIVE_ROOTS.receipt);
}
function requestDigest(auth: NativeAuthorization) {
  return nativeHash(canonicalJson({ task: "COUNTER_JSON_V1", taskId: auth.taskId, before: { counter: 0 }, after: { counter: 1 } }));
}
function initialReceipt(auth: NativeAuthorization, mode: NativePublicReceipt["mode"]): NativePublicReceipt {
  return nativePublicReceiptSchema.parse({ version: 1, task: "COUNTER_JSON_V1", taskId: auth.taskId, receiptId: "receipt-001", mode,
    result: "UNKNOWN_NO_REPLAY", authority: "NONE", productionDispatch: "CLOSED", replay: false, qualification: "NOT_RUN",
    candidateCode: "NOT_EXECUTED", fastOsProof: "NOT_CLAIMED", sourceCommit: auth.sourceCommit,
    manifestSha256: auth.manifestSha256, requestDigest: requestDigest(auth), proposerSessionId: null,
    reviewerSessionId: null, candidateDigest: null, settlements: [], evidence: [] });
}
async function coordinate(auth: NativeAuthorization, journal: NativeIntentJournal, launcher: NativeRoleLauncher,
  mode: NativePublicReceipt["mode"]): Promise<NativePublicReceipt> {
  const receipt = initialReceipt(auth, mode);
  try {
    for (const role of ["proposer", "reviewer"] as const) {
      const input: NativeWorkerInput = nativeWorkerInputSchema.parse({ version: 1, task: "COUNTER_JSON_V1", taskId: auth.taskId,
        role, request: { counter: 0 }, candidate: role === "reviewer" ? { counter: 1 } : null,
        proposalSessionId: role === "reviewer" ? receipt.proposerSessionId : null });
      const inputDigest = nativeHash(canonicalJson(input));
      journal.record(`${role}-intent`, { version: 1, role, taskId: auth.taskId, inputDigest,
        settlement: "UNKNOWN_UNTIL_RECEIPT", replay: false });
      const launched = await launcher(input);
      if (launched.settlement !== "EXIT_0_AND_CGROUP_EMPTY") throw nativeBlocked();
      const output = nativeWorkerOutputSchema.parse(launched.output);
      if (output.role !== role || output.taskId !== auth.taskId || output.pid !== launched.pid || output.inputDigest !== inputDigest ||
        (role === "proposer" && (!output.proposal || output.review !== null)) ||
        (role === "reviewer" && (output.proposal !== null || !output.review || output.sessionId === receipt.proposerSessionId))) throw nativeBlocked();
      const proof = mode === "NATIVE_LINUX_HOST" ? "EXIT_0_AND_CGROUP_EMPTY" : "OFFLINE_OBSERVATION_ONLY";
      journal.record(`${role}-settled`, { role, sessionId: output.sessionId, inputDigest, proof });
      receipt.settlements.push({ role, proof });
      if (role === "proposer") {
        receipt.proposerSessionId = output.sessionId;
        receipt.candidateDigest = nativeHash(canonicalJson(output.proposal));
        // Comparison of fixed JSON DATA only; never executes candidate scripts or claims FAST OS evidence.
        journal.record("fixed-data-verification", { candidateDigest: receipt.candidateDigest, task: "COUNTER_JSON_V1", counter: 1,
          verification: "FIXED_JSON_COMPARISON_ONLY", fastOsProof: "NOT_CLAIMED", candidateCode: "NOT_EXECUTED" });
      } else {
        receipt.reviewerSessionId = output.sessionId;
        receipt.result = output.review === "NEEDS_WORK" ? "NEEDS_WORK" :
          mode === "NATIVE_LINUX_HOST" ? "NATIVE_FIXED_DATA_ADVISORY_PASS_ONLY" : "OFFLINE_CONTRACT_PASS_NOT_NATIVE";
      }
    }
    journal.record("result", { result: receipt.result, authority: "NONE", replay: false });
  } catch {
    receipt.result = "UNKNOWN_NO_REPLAY";
    try { journal.record("unknown", { result: "UNKNOWN_NO_REPLAY", replay: false }); } catch { /* prior exclusive claim/intent remains the fence */ }
  }
  try { receipt.evidence = journal.evidence(); } catch { receipt.result = "UNKNOWN_NO_REPLAY"; receipt.evidence = []; }
  return nativePublicReceiptSchema.parse(receipt);
}
/** Explicit offline observations: this API can never return a native-completed label. */
const usedOfflineJournals = new WeakSet<NativeIntentJournal>();
export function coordinateOfflineFixedNative(auth: NativeAuthorization, journal: NativeIntentJournal, launcher: NativeRoleLauncher) {
  if (usedOfflineJournals.has(journal)) return Promise.reject(nativeBlocked());
  usedOfflineJournals.add(journal);
  return coordinate(authorizationSchema.parse(auth), journal, launcher, "OFFLINE_INJECTED_NOT_OS_PROOF");
}
/** Pure DATA binding construction, not admission or a transport/FAST capability. */
export function nativeIntentBinding(input: NativeAuthorization) {
  const auth = authorizationSchema.parse(input);
  const id = (kind: string) => `dev2-${kind}-${auth.taskId}`;
  const seal = <T>(r: T) => ({ ...r, digest: hashRecord(r) });
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION", id: id("delegation"), policyId: id("policy"),
    policyDigest: nativeHash(canonicalJson(auth)), repositoryId: id("repository"), baselineHead: auth.sourceCommit,
    scope: ["fixture/counter.json"], maxAttempts: 1, digest: "0".repeat(64) });
  const request = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST", id: id("request"), delegationDigest: delegation.digest,
    goalDigest: requestDigest(auth), acceptanceCriteriaDigest: nativeHash("COUNTER_JSON_V1_EXACT_DATA"), digest: "0".repeat(64) });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT", id: id("attempt"), requestDigest: request.digest, sequence: 1,
    predecessor: null, candidateId: id("candidate"), candidateGeneration: 1, sessionId: id("session"), executionId: id("execution"),
    inputSnapshotDigest: requestDigest(auth), manifestId: id("manifest"), fastId: id("fast"), advisoryReviewId: id("review"),
    materializationId: id("materialization"), reviewReceiptId: id("receipt"), digest: "0".repeat(64) });
  return parseBinding({ delegation, request, attempt });
}
function createJournal(auth: NativeAuthorization): NativeIntentJournal {
  const root = `${NATIVE_ROOTS.state}/receipt-001-store`;
  fs.mkdirSync(root, { mode: 0o700 }); flushDirectory(NATIVE_ROOTS.state);
  const binding = nativeIntentBinding(auth);
  const { store, receipt } = DevelopmentStore.create(root,
    { operation: "CREATE", transactionId: "dev2-store-tx-native-create", expectedVersion: 0, binding }, binding);
  publish(`${NATIVE_ROOTS.receipt}/store-anchor.json`, store.anchorOf(receipt));
  return {
    record(name, data) {
      if (!/^[a-z-]+$/.test(name)) throw nativeBlocked();
      const recovered = store.recover();
      if (recovered.writerFenced || recovered.disposition === "RECONCILE_REQUIRED") throw nativeBlocked();
      store.transact({ operation: "ARTIFACT", transactionId: `dev2-store-tx-native-${name}`, expectedVersion: recovered.state.version,
        binding, artifactId: `dev2-artifact-native-${name}`, contentBase64: Buffer.from(canonicalJson(data)).toString("base64") }, binding);
    },
    evidence() { return store.recover().state.artifacts.map(a => ({ id: a.id, sha256: a.sha256 })); },
  };
}

/** Single root-authenticated fixed intent. Claim survives every failure; no resume API exists. */
export async function runAuthenticatedFixedNative(): Promise<NativePublicReceipt> {
  const auth = admitFixedNative();
  // Public result path/group must be provisioned BEFORE consuming the task/credential.
  assertNativePublicResultProvisioning();
  // Claim is persisted before store creation, role launch, host module import or provider contact.
  publish(`${NATIVE_ROOTS.receipt}/claim.json`, claimSchema.parse({ version: 1, taskId: auth.taskId,
    requestDigest: requestDigest(auth), sourceCommit: auth.sourceCommit, manifestSha256: auth.manifestSha256, replay: false }));
  let receipt: NativePublicReceipt;
  try { receipt = await coordinate(auth, createJournal(auth), launchFixedNativeRole, "NATIVE_LINUX_HOST"); }
  catch { receipt = initialReceipt(auth, "NATIVE_LINUX_HOST"); }
  publish(`${NATIVE_ROOTS.receipt}/handoff.json`, nativePublicReceiptSchema.parse(receipt));
  publishNativePublicReceipt(receipt);
  return receipt;
}
const workerClaimSchema = z.object({ taskId: taskIdSchema, role: z.enum(["proposer", "reviewer"]),
  inputDigest: digestSchema, pid: z.number().int().positive() }).strict();
/** Worker-side one-shot barrier: invoking the executable directly cannot bypass
 * the supervisor's durable intent, and a second worker cannot reuse that intent. */
export function claimFixedNativeWorkerTurn(input: NativeWorkerInput, auth: NativeAuthorization) {
  assertNativeProcessIdentity();
  const claim = claimSchema.parse(JSON.parse(readNativeFile(`${NATIVE_ROOTS.receipt}/claim.json`, NATIVE_UID).toString("utf8")));
  if (claim.taskId !== auth.taskId || input.taskId !== auth.taskId || claim.requestDigest !== requestDigest(auth) ||
    claim.manifestSha256 !== auth.manifestSha256 || claim.sourceCommit !== auth.sourceCommit) throw nativeBlocked();
  try { fs.lstatSync(`${NATIVE_ROOTS.receipt}/handoff.json`); throw nativeBlocked(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw nativeBlocked(); }
  const anchor = JSON.parse(readNativeFile(`${NATIVE_ROOTS.receipt}/store-anchor.json`, NATIVE_UID).toString("utf8")) as StoreAnchor;
  const store = DevelopmentStore.open(`${NATIVE_ROOTS.state}/receipt-001-store`, anchor), recovered = store.recover();
  if (recovered.writerFenced || recovered.disposition === "RECONCILE_REQUIRED") throw nativeBlocked();
  const artifact = (name: string) => recovered.state.artifacts.find(a => a.id === `dev2-artifact-native-${name}`);
  const intent = artifact(`${input.role}-intent`);
  if (!intent || artifact(`${input.role}-settled`) || artifact("result") || artifact("unknown") ||
    (input.role === "reviewer" && !artifact("proposer-settled"))) throw nativeBlocked();
  const value = JSON.parse(Buffer.from(recovered.state.blobs[intent.sha256], "base64").toString("utf8"));
  const expected = { version: 1, role: input.role, taskId: input.taskId, inputDigest: nativeHash(canonicalJson(input)),
    settlement: "UNKNOWN_UNTIL_RECEIPT", replay: false };
  if (canonicalJson(value) !== canonicalJson(expected)) throw nativeBlocked();
  publish(`${NATIVE_ROOTS.receipt}/${input.role}-worker-claim.json`, workerClaimSchema.parse({
    taskId: input.taskId, role: input.role, inputDigest: expected.inputDigest, pid: process.pid }));
}
/** The host credential capability issuer must call this guard, not just admission.
 * This guard binds provider dispatch to an actually joined, intent-claimed worker. */
export function assertAuthenticatedNativeWorkerTurn(role: "proposer" | "reviewer", expectedInputDigest?: string) {
  const auth = admitFixedNative();
  if (role !== "proposer" && role !== "reviewer") throw nativeBlocked();
  if (fs.readFileSync("/proc/self/cgroup", "utf8").trim() !== nativeCgroupMembership(role)) throw nativeBlocked();
  const claim = workerClaimSchema.parse(JSON.parse(readNativeFile(`${NATIVE_ROOTS.receipt}/${role}-worker-claim.json`, NATIVE_UID).toString("utf8")));
  if (claim.pid !== process.pid || claim.role !== role || claim.taskId !== auth.taskId ||
    (expectedInputDigest !== undefined && claim.inputDigest !== expectedInputDigest)) throw nativeBlocked();
  // A late worker MUST lose dispatch admission after any terminal/UNKNOWN publication.
  try { fs.lstatSync(`${NATIVE_ROOTS.receipt}/handoff.json`); throw nativeBlocked(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw nativeBlocked(); }
  const anchor = JSON.parse(readNativeFile(`${NATIVE_ROOTS.receipt}/store-anchor.json`, NATIVE_UID).toString("utf8")) as StoreAnchor;
  const recovered = DevelopmentStore.open(`${NATIVE_ROOTS.state}/receipt-001-store`, anchor).recover();
  if (recovered.writerFenced || recovered.disposition === "RECONCILE_REQUIRED") throw nativeBlocked();
  assertUnresolvedNativeIntent(recovered, role, auth.taskId, claim.inputDigest);
}
/** Offline-testable journal condition only; calling it never issues admission. */
export function assertUnresolvedNativeIntent(recovered: ReturnType<DevelopmentStore["recover"]>, role: "proposer" | "reviewer", taskId: string, inputDigest: string) {
  if (recovered.writerFenced || recovered.disposition === "RECONCILE_REQUIRED") throw nativeBlocked();
  const artifact = (name: string) => recovered.state.artifacts.find(a => a.id === `dev2-artifact-native-${name}`);
  if (artifact("unknown") || artifact("result") || artifact(`${role}-settled`) ||
    (role === "reviewer" && !artifact("proposer-settled"))) throw nativeBlocked();
  const intent = artifact(`${role}-intent`); if (!intent) throw nativeBlocked();
  const data = JSON.parse(Buffer.from(recovered.state.blobs[intent.sha256], "base64").toString("utf8"));
  if (canonicalJson(data) !== canonicalJson({ version: 1, role, taskId, inputDigest,
    settlement: "UNKNOWN_UNTIL_RECEIPT", replay: false })) throw nativeBlocked();
}
/** Read-only SSH-friendly observer: never admits, loads transport, repairs storage, or relaunches. */
export function readNativeReceipt(): NativePublicReceipt {
  assertNativeProcessIdentity();
  assertNativeDirectory(NATIVE_ROOTS.receipt, NATIVE_UID);
  const claim = claimSchema.parse(JSON.parse(readNativeFile(`${NATIVE_ROOTS.receipt}/claim.json`, NATIVE_UID).toString("utf8")));
  const file = `${NATIVE_ROOTS.receipt}/handoff.json`;
  try {
    const r = nativePublicReceiptSchema.parse(JSON.parse(readNativeFile(file, NATIVE_UID).toString("utf8")));
    if (r.mode !== "NATIVE_LINUX_HOST" || r.taskId !== claim.taskId || r.requestDigest !== claim.requestDigest ||
      r.manifestSha256 !== claim.manifestSha256 || r.sourceCommit !== claim.sourceCommit) throw nativeBlocked();
    return r;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw nativeBlocked();
    return nativePublicReceiptSchema.parse({ ...initialReceipt({ ...claim, task: "COUNTER_JSON_V1", custodianUid: 993,
      dispatch: "ONE_FIXED_ATTEMPT", receiptId: "receipt-001" }, "NATIVE_LINUX_HOST"), requestDigest: claim.requestDigest });
  }
}
