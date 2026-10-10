import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { canonicalJson } from "../task-contract/contract.js";
import { hashRecord, parseBinding } from "../execution-orchestrator/development/contract.js";
import { DevelopmentStore, type StoreAnchor } from "../execution-orchestrator/development/store.js";
import { proposalSchema, receiptSchema, requestSchema, type Role } from "./fixture.js";
import { inspectLinuxCustodyMetadata } from "./custody.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export class OutcomeUnknown extends Error { constructor() { super("FIXTURE_OUTCOME_UNKNOWN_NO_REPLAY"); } }
function safe(target: string) {
  if (!path.isAbsolute(target)) throw new Error("ABSOLUTE_STATE_ROOT_REQUIRED");
  for (let p = path.resolve(target); ; p = path.dirname(p)) {
    try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error("STATE_PATH_ALIAS"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (path.dirname(p) === p) break;
  }
}
function directoryFlush(dir: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function publish(file: string, body: unknown) {
  safe(file); const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, canonicalJson(body)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  directoryFlush(path.dirname(file));
}
function read(file: string) {
  safe(file); const s = fs.lstatSync(file);
  if (!s.isFile() || s.nlink !== 1 || s.size > 65536 || process.platform === "linux" && (s.uid !== process.getuid?.() || (s.mode & 0o077))) throw new Error("STATE_CUSTODY");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function assertLinuxIdentity(platform: string, uid: number | undefined, euid: number | undefined) {
  if (platform !== "linux" || uid === undefined || euid === undefined || uid === 0 || euid === 0) throw new Error("NONROOT_LINUX_REQUIRED");
}
export function assertNonprivilegedLinux() {
  assertLinuxIdentity(process.platform, process.getuid?.(), process.geteuid?.());
}
export function providerReadiness() {
  return { provider: "NOT_RUN", openCode: "NOT_RUN", reason: "EXISTING_HOST_OAUTH_CUSTODY_ADAPTER_CLOSED",
    credentialImported: false, custody: inspectLinuxCustodyMetadata(), productionDispatch: "CLOSED", authority: "NONE" } as const;
}

export async function spawnFixtureRole(role: Role, input: unknown, cwd: string) {
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  const env: NodeJS.ProcessEnv = { HOME: cwd, XDG_CONFIG_HOME: cwd, XDG_DATA_HOME: cwd, XDG_STATE_HOME: cwd,
    XDG_CACHE_HOME: cwd, TMPDIR: cwd, TEMP: cwd, TMP: cwd, LANG: "C", TZ: "UTC" };
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, ["--disable-proto=throw", worker, role], { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
  return await new Promise<ReturnType<typeof receiptSchema.parse>>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, done = false;
    const finish = (error?: Error, value?: ReturnType<typeof receiptSchema.parse>) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => {
      // Do not kill or repeat even this new fixture child. Its settlement is unknown.
      child.unref(); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); finish(new OutcomeUnknown());
    }, 10000);
    child.stdout.on("data", (data: Buffer) => {
      size += data.length;
      if (size > 8192) { child.unref(); child.stdout.destroy(); child.stderr.destroy(); finish(new OutcomeUnknown()); }
      else chunks.push(data);
    });
    child.stderr.on("data", () => { /* Discard body, never persist raw exception data. */ });
    child.stdin.on("error", () => finish(new OutcomeUnknown()));
    child.on("error", () => finish(new OutcomeUnknown()));
    child.on("close", (code, signal) => {
      if (code !== 0 || signal) return finish(new OutcomeUnknown());
      try {
        const result = receiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (result.role !== role || result.pid !== child.pid) throw new Error("CHILD_IDENTITY");
        finish(undefined, result);
      } catch { finish(new OutcomeUnknown()); }
    });
    child.stdin.end(canonicalJson(input));
  });
}
type RoleRunner = typeof spawnFixtureRole;

/** Explicit fixed fixture task, not Qualification, production or an AI semantic review.
 * Existing append-only DevelopmentStore persists public intents/results. No resume API. */
export async function runFixedFixture(root: string, sourceCommit: string, roleRunner: RoleRunner = spawnFixtureRole) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("SOURCE_COMMIT_REQUIRED");
  safe(root); fs.mkdirSync(root, { mode: 0o700 }); directoryFlush(path.dirname(root));
  if (process.platform === "linux") {
    const s = fs.lstatSync(root);
    if (s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error("STATE_CUSTODY");
  }
  const taskId = randomUUID(), request = requestSchema.parse({ fixture: "COUNTER_V1", taskId, before: 0 });
  const seal = <T>(record: T) => ({ ...record, digest: hashRecord(record) });
  const id = (kind: string) => `dev2-${kind}-${taskId}`;
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION", id: id("delegation"), policyId: id("policy"),
    policyDigest: sha("FIXED_FIXTURE_ONLY_NO_AUTHORITY"), repositoryId: id("repository"), baselineHead: sourceCommit,
    scope: ["fixture/counter.json"], maxAttempts: 1, digest: "0".repeat(64) });
  const task = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST", id: id("request"), delegationDigest: delegation.digest,
    goalDigest: sha("COUNTER_0_TO_1_FIXTURE"), acceptanceCriteriaDigest: sha("FIXED_COUNTER_REVIEW"), digest: "0".repeat(64) });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT", id: id("attempt"), requestDigest: task.digest,
    sequence: 1, predecessor: null, candidateId: id("candidate"), candidateGeneration: 1,
    sessionId: id("session"), executionId: id("execution"), inputSnapshotDigest: sha(canonicalJson(request)),
    manifestId: id("manifest"), fastId: id("fast"), advisoryReviewId: id("review"), materializationId: id("materialization"),
    reviewReceiptId: id("receipt"), digest: "0".repeat(64) });
  const binding = parseBinding({ delegation, request: task, attempt });
  const { store, receipt } = DevelopmentStore.create(root, { operation: "CREATE", transactionId: "dev2-store-tx-create", expectedVersion: 0, binding }, binding);
  publish(path.join(root, "anchor.json"), store.anchorOf(receipt));
  const record = (name: string, body: unknown) => {
    const state = store.recover().state;
    store.transact({ operation: "ARTIFACT", transactionId: `dev2-store-tx-${name}`, expectedVersion: state.version, binding,
      artifactId: `dev2-artifact-${name}`, contentBase64: Buffer.from(canonicalJson(body)).toString("base64") }, binding);
  };
  record("request", request);
  try {
    const directories = ["proposer", "reviewer"].map(role => { const p = path.join(root, role); fs.mkdirSync(p, { mode: 0o700 }); return p; });
    directoryFlush(root);
    record("proposal-intent", { phase: "PROPOSER", outcome: "UNKNOWN_UNTIL_RECEIPT", replay: false });
    const proposal = receiptSchema.parse(await roleRunner("proposer", request, directories[0]));
    if (proposal.taskId !== taskId || proposal.role !== "proposer" || !proposal.proposal || proposal.review) throw new OutcomeUnknown();
    record("proposal", proposal);
    record("apply-intent", { operation: "FIXED_DATA_ONLY", replay: false });
    const candidate = { counter: proposalSchema.parse(proposal.proposal).value };
    publish(path.join(root, "candidate.json"), candidate);
    record("verification", { profile: "FIXED_COUNTER_ONLY", result: candidate.counter === 1 ? "PASS" : "FAIL" });
    record("review-intent", { phase: "REVIEWER", outcome: "UNKNOWN_UNTIL_RECEIPT", replay: false });
    const persistedCandidate = read(path.join(root, "candidate.json"));
    if (canonicalJson(persistedCandidate) !== canonicalJson(candidate)) throw new OutcomeUnknown();
    const review = receiptSchema.parse(await roleRunner("reviewer", { request, candidate: persistedCandidate }, directories[1]));
    if (review.taskId !== taskId || review.role !== "reviewer" || review.sessionId === proposal.sessionId || review.pid === proposal.pid || review.proposal || review.review !== "PASS") throw new OutcomeUnknown();
    record("review", review);
    record("result", { result: "FIXED_FIXTURE_PASS_NOT_AI_E2E", taskId, sourceCommit, platform: process.platform,
      uid: process.getuid?.() ?? null, provider: "NOT_RUN", nativeOpenCodeSessions: "NOT_RUN", arbitraryCode: "NOT_RUN",
      qualification: "NOT_RUN", productionDispatch: "CLOSED", authority: "NONE", replay: false });
    return readFixedFixture(root);
  } catch {
    // Saving UNKNOWN must succeed, otherwise throw and leave prior durable intents as the fence.
    record("result", { result: "UNKNOWN_NO_REPLAY", taskId, provider: "NOT_RUN", productionDispatch: "CLOSED", authority: "NONE", replay: false });
    return readFixedFixture(root);
  }
}

/** Reopen existing receipts only. Missing/partial result is UNKNOWN, never a dispatch permit. */
export function readFixedFixture(root: string) {
  safe(root); const store = DevelopmentStore.open(root, read(path.join(root, "anchor.json")) as StoreAnchor), recovered = store.recover();
  const artifacts = recovered.state.artifacts.map(a => ({ id: a.id, sha256: a.sha256,
    value: JSON.parse(Buffer.from(recovered.state.blobs[a.sha256], "base64").toString("utf8")) as Record<string, unknown> }));
  const terminal = artifacts.find(a => a.id === "dev2-artifact-result");
  return { result: terminal?.value.result ?? "UNKNOWN_NO_REPLAY", artifacts, storageState: recovered.state.state,
    mode: "FIXED_FIXTURE_ONLY", productionDispatch: "CLOSED", authority: "NONE" };
}
