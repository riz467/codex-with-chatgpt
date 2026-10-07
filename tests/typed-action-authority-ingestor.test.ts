import https from "node:https";
import { EventEmitter } from "node:events";
import { createHash, X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import path from "node:path";
import { actionBindingFields, hashTypedActionApproval } from "../src/typed-action-approval/contract.js";
import { presentationHash, parsePresentation } from "../src/approver-service/presentation.js";
import { independentReviewSigningBytes } from "../src/typed-action-review/contract.js";
import { verifyIndependentReview } from "../src/typed-action-review/verifier.js";
import { createTrustedAuthorityIngestor, createTrustedPresentationPeerHttps } from "../src/typed-action-finalizer/authority-ingestor.js";
import * as ingestorModule from "../src/typed-action-finalizer/authority-ingestor.js";
import { TrustedContextStore } from "../src/typed-action-finalizer/trusted-context-storage.js";
import { createTrustedContextProvider } from "../src/typed-action-finalizer/trusted-context.js";
import { sqliteFixture } from "./typed-action-sqlite-fixtures.js";
import { hash, jti, now, time } from "./typed-action-fixtures.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const f = await sqliteFixture(); cleanups.push(() => f.cleanup());
  const key = generateKeyPairSync("ed25519"), keys = new Map([["ct702-test", key.publicKey]]);
  const binding = Object.fromEntries(actionBindingFields.map(field => [field, f.humanContext[field]]));
  const { isCurrent: _p, requestIsCurrent: _r, ...policy } = f.input.policyContext;
  const request = { ...binding, attemptCreatedAt: f.input.boundAttempt.attempt.createdAt };
  const reviewBinding = { actionId: request.actionId, actionKind: request.actionKind, targetId: request.targetId,
    requestHash: request.requestHash, attemptId: request.attemptId, attemptHash: request.attemptHash,
    attemptSequence: request.attemptSequence, reviewId: randomUUID() };
  const snapshot: any = { request: { current: true, body: request }, policy: { current: true, body: policy }, generation: 4,
    reviewContext: { ...reviewBinding, expectedReviewEvidenceHash: binding.independentReviewEvidenceHash,
      expectedBundleManifestSha256: hash(), expectedReviewerKeyId: "ct702-test", expectedResult: "PASS",
      currentReviewId: reviewBinding.reviewId, reviewIsCurrent: true, bundleIntegrityVerified: true } };
  const unsigned: any = { schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_SIGNED_INDEPENDENT_REVIEW",
    reviewerKeyId: "ct702-test", signatureAlgorithm: "Ed25519", signature: Buffer.alloc(64).toString("base64url"),
    payload: { schemaVersion: 1, type: "AI_WORKSPACE_TYPED_ACTION_INDEPENDENT_REVIEW", ...reviewBinding,
      reviewEvidenceHash: binding.independentReviewEvidenceHash, bundleManifestSha256: snapshot.reviewContext.expectedBundleManifestSha256,
      result: "PASS", issuedAt: time(-20_000), expiresAt: time(180_000), jti: jti() } };
  const resign = (value: any) => ({ ...value, signature: sign(null, independentReviewSigningBytes(value), key.privateKey).toString("base64url") });
  const evidence = resign(unsigned);
  const identity: any = { actionId: request.actionId, targetId: request.targetId, requestHash: request.requestHash,
    attemptId: request.attemptId, attemptHash: request.attemptHash };
  const providerIdentity = { ...identity, humanApprovalJti: f.approval.payload.jti,
    humanApprovalEvidenceHash: hashTypedActionApproval(f.approval) };
  let clock = now;
  const host = { currentAuthority: vi.fn(() => snapshot), trustedReviewKeys: keys, trustedHumanKeys: f.humanKeys, now: () => clock };
  const file = path.join(path.dirname(f.file), "authority.sqlite");
  function open() {
    const db = new DatabaseSync(file), store = new TrustedContextStore({ database: db, ingestor: host, isolatedIngestion: true });
    cleanups.push(() => store.close());
    const api = createTrustedAuthorityIngestor(store);
    return { db, store, api, provider: createTrustedContextProvider({ store, trustedHumanKeys: f.humanKeys, now: () => clock }) };
  }
  let active = open();
  return { ...f, snapshot, evidence, identity, providerIdentity, host, keys, resign, file, open,
    get authority() { return active.store; }, get authorityDb() { return active.db; }, get api() { return active.api; },
    get provider() { return active.provider; },
    adopt: (value = evidence, lookup = identity) => active.api.adoptIndependentReview({ identity: lookup, evidence: value }),
    register: (value = f.approval, lookup = identity) => active.api.registerHumanApproval({ identity: lookup, evidence: value }),
    restart() { active.store.close(); active = open(); }, setTime(value: number) { clock = value; },
    counts() { return ["targets", "requests", "reviews", "policies", "review_adoptions", "approvals", "human_registrations"]
      .map(table => Number(active.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)); },
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const changeValue = (field: string) => field.endsWith("Id") ? randomUUID() : field === "actionKind" ? "AppUpgrade"
  : field === "attemptSequence" || field === "targetGeneration" ? 9 : hash();

async function peerFixture() {
  const f = await setup();
  const body = { schemaVersion: 1 as const, presentationId: randomUUID(), request: f.approval.payload,
    context: f.humanContext, trustedSourceIdentity: "ct701-test" };
  const presentation = parsePresentation({ ...body, presentationHash: presentationHash(body) });
  const peer = {
    registerPresentation: vi.fn((): unknown => ({ approvalRequestId: presentation.request.approvalRequestId,
      presentationHash: presentation.presentationHash })),
    status: vi.fn((_id: string): unknown => ({ approvalRequestId: presentation.request.approvalRequestId,
      presentationHash: presentation.presentationHash, state: "CURRENT", approvalState: "APPROVED", current: true })),
    evidence: vi.fn((_id: string): unknown => f.approval),
  };
  const api = createTrustedAuthorityIngestor(f.authority, peer);
  return { f, presentation, peer, api };
}

describe("production Trusted Authority Ingestor", () => {
  it("adopts PASS, registers Human, feeds provider and finalizes/consumes only once", async () => {
    const f = await setup();
    const issue = () => f.provider.withFence(f.providerIdentity, async () =>
      f.kernel.finalizeAndSignTypedAction({ ...f.input, ...f.provider.finalization(f.providerIdentity) }));
    await expect(issue()).rejects.toThrow();
    const adoption = f.adopt(); expect(adoption.status).toBe("adopted");
    await expect(issue()).rejects.toThrow();
    expect(f.register().status).toBe("registered");
    expect(f.counts()).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(f.count("finalized_permits")).toBe(0);
    expect(adoption).not.toHaveProperty("executionMayStart"); expect(adoption).not.toHaveProperty("permit");
    expect((await issue()).state).toBe("VERIFIED_NOT_CONSUMED");
    await f.provider.withFence(f.providerIdentity, async () => {
      expect(f.provider.finalization(f.providerIdentity)).toEqual({ humanContext: f.humanContext,
        independentReview: f.input.independentReview, policyContext: f.input.policyContext });
      expect((await f.store.consumeForExecution(f.permit, () => f.provider.execution(f.providerIdentity))).executionMayStart).toBe(true);
      expect((await f.store.consumeForExecution(f.permit, () => f.provider.execution(f.providerIdentity))).executionMayStart).toBe(false);
    });
  });
  it.each(["FAIL", "NEEDS_WORK"])("never adopts valid signed %s", async result => {
    const f = await setup(); f.snapshot.reviewContext.expectedResult = result;
    const evidence = f.resign({ ...f.evidence, payload: { ...f.evidence.payload, result } });
    expect(verifyIndependentReview(evidence, f.snapshot.reviewContext, f.keys, now).valid).toBe(true);
    expect(() => f.adopt(evidence)).toThrow(); expect(f.counts()).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(() => f.register()).toThrow();
  });
  it.each(["actionId", "actionKind", "targetId", "requestHash", "attemptId", "attemptHash", "attemptSequence",
    "reviewId", "reviewEvidenceHash", "bundleManifestSha256"])("rejects signed wrong review %s", async field => {
    const f = await setup();
    expect(() => f.adopt(f.resign({ ...f.evidence, payload: { ...f.evidence.payload, [field]: changeValue(field) } }))).toThrow();
    expect(f.counts()).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
  const invalidHost: [string, (f: Fixture) => void][] = [
    ["stale review", f => { f.snapshot.reviewContext.reviewIsCurrent = false; }],
    ["integrity false", f => { f.snapshot.reviewContext.bundleIntegrityVerified = false; }],
    ["wrong current review", f => { f.snapshot.reviewContext.currentReviewId = randomUUID(); }],
    ["missing policy", f => { delete f.snapshot.policy; }],
    ["denied policy", f => { f.snapshot.policy.body.actionAllowed = false; }],
    ["stale policy", f => { f.snapshot.policy.current = false; }],
    ["stale request", f => { f.snapshot.request.current = false; }],
    ["generation mismatch", f => { f.snapshot.generation++; }],
    ["policy generation mismatch", f => { f.snapshot.policy.body.targetGeneration++; }],
    ["policy hash mismatch", f => { f.snapshot.policy.body.policySha256 = hash(); }],
    ["policy target mismatch", f => { f.snapshot.policy.body.targetId = randomUUID(); }],
    ["policy action mismatch", f => { f.snapshot.policy.body.actionKind = "AppUpgrade"; }],
    ["window identity mismatch", f => { f.snapshot.policy.body.maintenanceWindowId = randomUUID(); }],
    ["window expired", f => { f.snapshot.policy.body.maintenanceWindowExpiresAt = time(0); }],
    ["window not started", f => { f.snapshot.policy.body.maintenanceWindowStartsAt = time(1); }],
    ["host evidence mismatch", f => { f.snapshot.request.body.independentReviewEvidenceHash = hash(); }],
    ["host request mismatch", f => { f.snapshot.request.body.requestHash = hash(); }],
    ["unavailable host", f => { f.host.currentAuthority.mockImplementation(() => { throw new Error("offline"); }); }],
    ["invalid clock", f => { f.setTime(NaN); }],
  ];
  it.each(invalidHost)("rejects %s", async (_name, change) => {
    const f = await setup(); change(f); expect(() => f.adopt()).toThrow(); expect(f.counts()).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
  it("rejects forged signature and unknown/pin-mismatched keys", async () => {
    const f = await setup();
    expect(() => f.adopt({ ...f.evidence, signature: Buffer.alloc(64, 1).toString("base64url") })).toThrow();
    const other = f.resign({ ...f.evidence, reviewerKeyId: "unknown" });
    expect(() => f.adopt(other)).toThrow();
    f.snapshot.reviewContext.expectedReviewerKeyId = "unknown";
    expect(() => f.adopt(other)).toThrow();
    expect(f.counts()).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
  it.each([[time(-60_000), time(0)], [time(1), time(120_000)], [time(-20_000), time(300_000)]])(
    "rejects expired/future/overlong review %s %s", async (issuedAt, expiresAt) => {
      const f = await setup(); expect(() => f.adopt(f.resign({ ...f.evidence, payload: { ...f.evidence.payload, issuedAt, expiresAt } }))).toThrow();
    });
  it("exact adoption/registration is idempotent across restart with no revision change", async () => {
    const f = await setup(); f.adopt(); f.register();
    const revision = f.authorityDb.prepare("SELECT revision FROM authority_revision").get(); f.restart();
    expect(f.adopt().status).toBe("already-adopted"); expect(f.register().status).toBe("already-registered");
    expect(f.authorityDb.prepare("SELECT revision FROM authority_revision").get()).toEqual(revision);
    expect(f.counts()).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
  it("rejects second review/envelope for an already adopted attempt", async () => {
    const f = await setup(); f.adopt();
    expect(() => f.adopt(f.resign({ ...f.evidence, payload: { ...f.evidence.payload, jti: jti() } }))).toThrow();
    const nextId = randomUUID(), nextHash = hash();
    Object.assign(f.snapshot.reviewContext, { reviewId: nextId, currentReviewId: nextId, expectedReviewEvidenceHash: nextHash });
    f.snapshot.request.body.independentReviewEvidenceHash = nextHash;
    expect(() => f.adopt(f.resign({ ...f.evidence, payload: { ...f.evidence.payload, reviewId: nextId, reviewEvidenceHash: nextHash, jti: jti() } }))).toThrow();
  });
  it.each(["reviewId", "jti", "reviewEvidenceHash"])("permanently rejects reused %s on a fresh attempt, rolling back partial writes", async retained => {
    const f = await setup(); f.adopt(); f.restart();
    const payload = { ...f.evidence.payload, attemptId: randomUUID(), attemptHash: hash(), attemptSequence: 2,
      reviewId: randomUUID(), jti: jti(), reviewEvidenceHash: hash() };
    payload[retained] = f.evidence.payload[retained];
    Object.assign(f.snapshot.request.body, { attemptId: payload.attemptId, attemptHash: payload.attemptHash,
      attemptSequence: 2, independentReviewEvidenceHash: payload.reviewEvidenceHash });
    Object.assign(f.snapshot.reviewContext, { attemptId: payload.attemptId, attemptHash: payload.attemptHash, attemptSequence: 2,
      reviewId: payload.reviewId, currentReviewId: payload.reviewId, expectedReviewEvidenceHash: payload.reviewEvidenceHash });
    const identity = { ...f.identity, attemptId: payload.attemptId, attemptHash: payload.attemptHash };
    expect(() => f.adopt(f.resign({ ...f.evidence, payload }), identity)).toThrow(/UNIQUE/);
    expect(f.counts()).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });
  it("rollback on an injected final adoption write failure leaves zero authority", async () => {
    const f = await setup(), original = f.authorityDb.prepare.bind(f.authorityDb);
    const spy = vi.spyOn(f.authorityDb, "prepare").mockImplementation(sql => {
      if (sql === "INSERT INTO review_adoptions VALUES(?,?,?,?,?)") throw new Error("disk failure");
      return original(sql);
    });
    expect(() => f.adopt()).toThrow(/disk failure/); spy.mockRestore();
    expect(f.counts()).toEqual([0, 0, 0, 0, 0, 0, 0]); expect(f.adopt().status).toBe("adopted");
  });
  it.each([false, true])("unknown COMMIT outcome (committed=%s) never succeeds; store becomes unavailable", async committed => {
    const f = await setup(), original = f.authorityDb.exec.bind(f.authorityDb);
    const spy = vi.spyOn(f.authorityDb, "exec").mockImplementation(sql => {
      if (sql === "COMMIT") { if (committed) original(sql); throw new Error("unknown commit"); } return original(sql);
    });
    expect(() => f.adopt()).toThrow(/unknown commit/); spy.mockRestore();
    expect(() => f.adopt()).toThrow(/unavailable/);
    f.restart(); expect(f.adopt().status).toBe(committed ? "already-adopted" : "adopted");
  });
  it("serializes competing store connections under SQLite lock with one canonical adoption", async () => {
    const f = await setup(), other = f.open();
    f.host.currentAuthority.mockImplementationOnce(() => {
      expect(() => other.api.adoptIndependentReview({ identity: f.identity, evidence: f.evidence })).toThrow(/locked/);
      return f.snapshot;
    });
    expect(f.adopt().status).toBe("adopted");
    expect(other.api.adoptIndependentReview({ identity: f.identity, evidence: f.evidence }).status).toBe("already-adopted");
    expect(f.counts()).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });
  it("cross-worker concurrent adoption has exactly one canonical winner", async () => {
    const f = await setup(), barrier = new SharedArrayBuffer(4);
    const outcomes: Promise<string>[] = [];
    for (let i = 0; i < 2; i++) {
      const worker = new Worker(`
      require('tsx/cjs');
      const {parentPort,workerData:w}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite'); const {createPublicKey}=require('node:crypto');
      const {TrustedContextStore}=require(w.module);
      const db=new DatabaseSync(w.file);
      const store=new TrustedContextStore({database:db,isolatedIngestion:true,ingestor:{currentAuthority:()=>w.snapshot,
        trustedReviewKeys:new Map([['ct702-test',createPublicKey(w.key)]]),trustedHumanKeys:new Map(),now:()=>w.now}});
      parentPort.postMessage('ready'); Atomics.wait(new Int32Array(w.barrier),0,0);
      try {parentPort.postMessage(store.adoptIndependentReview(w.input).status);}
      catch(e) {parentPort.postMessage(e.message.includes('locked')?'busy':e.message);}
      finally {store.close();}
    `, { eval: true, workerData: { module: path.resolve("src/typed-action-finalizer/trusted-context-storage.ts"),
      file: f.file, snapshot: f.snapshot, key: f.keys.get("ct702-test")!.export({ type: "spki", format: "pem" }),
      now, barrier, input: { identity: f.identity, evidence: f.evidence } } });
      cleanups.push(async () => { await worker.terminate(); });
      let ready!: () => void;
      const started = new Promise<void>((resolve, reject) => { ready = resolve; worker.once("error", reject); });
      const outcome = new Promise<string>((resolve, reject) => {
        worker.on("message", value => { if (value === "ready") ready(); else resolve(value); });
        worker.once("error", reject);
      });
      outcomes.push(outcome);
      await started;
    }
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    const results = await Promise.all(outcomes);
    expect(results.filter(result => result === "adopted")).toHaveLength(1);
    expect(results.every(result => ["adopted", "already-adopted", "busy"].includes(result))).toBe(true);
    expect(f.adopt().status).toBe("already-adopted"); expect(f.counts()).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });
  it.each(["staleRequest", "supersedeRequest", "revokeReview", "supersedeReview", "revokePolicy", "advanceGeneration"] as const)(
    "host acquisition holds the authority lock against concurrent %s", async method => {
      const f = await setup(); f.adopt(); const other = f.open();
      f.host.currentAuthority.mockImplementationOnce(() => {
        expect(() => {
          if (method === "advanceGeneration") other.store.advanceGeneration(f.identity.targetId, 5);
          else if (method === "revokePolicy") other.store.revokePolicy(f.snapshot.policy.body.policySha256);
          else other.store[method](f.identity.attemptHash);
        }).toThrow(/locked/);
        return f.snapshot;
      });
      expect(f.adopt().status).toBe("already-adopted");
    });
  it("fence excludes ingestion and competing revocations; winner's revocation persists", async () => {
    const f = await setup(); f.adopt(); f.register(); const other = f.open();
    await f.provider.withFence(f.providerIdentity, async () => {
      expect(() => other.api.adoptIndependentReview({ identity: f.identity, evidence: f.evidence })).toThrow(/locked/);
      expect(() => other.store.revokeReview(f.identity.attemptHash)).toThrow(/locked/);
    });
    other.store.revokeReview(f.identity.attemptHash); expect(() => f.adopt()).toThrow(); expect(() => f.register()).toThrow();
  });
  it.each(["DROP TRIGGER review_adoptions_immutable", "DROP TRIGGER human_registrations_no_delete", "PRAGMA user_version=1",
    "PRAGMA application_id=0", "CREATE TABLE unexpected(x)"])("rejects tampering without migration/repair: %s", async sql => {
    const f = await setup(); f.authority.close(); const db = new DatabaseSync(f.file);
    try {
      db.exec(sql); const schema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
      const version = db.prepare("PRAGMA user_version").get();
      expect(() => new TrustedContextStore({ database: db, ingestor: f.host })).toThrow(/schema/);
      expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
      expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
    } finally { db.close(); }
  });
  it("requires prior production adoption for Human registration", async () => {
    const f = await setup(); expect(() => f.register()).toThrow(/adoption/); expect(f.counts()).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
  it.each(["independentReviewEvidenceHash", "policySha256", "targetGeneration", "maintenanceWindowId", "requestHash",
    "attemptHash", "attemptId", "attemptSequence", "actionId", "actionKind", "targetId"])("rejects valid Human signature with wrong %s", async field => {
    const f = await setup(); f.adopt();
    expect(() => f.register(f.signApproval({ ...f.approval, payload: { ...f.approval.payload, [field]: changeValue(field) } }))).toThrow();
    expect(f.counts()).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });
  it("rejects forged and expired Human evidence", async () => {
    const f = await setup(); f.adopt();
    expect(() => f.register({ ...f.approval, signature: Buffer.alloc(64, 1).toString("base64url") })).toThrow();
    expect(() => f.register(f.signApproval({ ...f.approval, payload: { ...f.approval.payload, expiresAt: time(0) } }))).toThrow();
  });
  it("Human jti cannot alias a different immutable evidence body", async () => {
    const f = await setup(); f.adopt(); f.register(); f.restart();
    expect(() => f.register(f.signApproval({ ...f.approval, payload: { ...f.approval.payload, approvalRequestId: randomUUID() } }))).toThrow(/UNIQUE/);
    expect(f.counts()).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
  it("registration write failure rolls back approval body and identity together", async () => {
    const f = await setup(); f.adopt(); const original = f.authorityDb.prepare.bind(f.authorityDb);
    const spy = vi.spyOn(f.authorityDb, "prepare").mockImplementation(sql => {
      if (sql === "INSERT INTO human_registrations VALUES(?,?)") throw new Error("disk failure");
      return original(sql);
    });
    expect(() => f.register()).toThrow(/disk failure/); spy.mockRestore();
    expect(f.counts()).toEqual([1, 1, 1, 1, 1, 0, 0]); expect(f.register().status).toBe("registered");
  });
  it("unknown Human registration commit is never reported as success", async () => {
    const f = await setup(); f.adopt(); const original = f.authorityDb.exec.bind(f.authorityDb);
    const spy = vi.spyOn(f.authorityDb, "exec").mockImplementation(sql => {
      original(sql); if (sql === "COMMIT") throw new Error("unknown commit");
    });
    expect(() => f.register()).toThrow(/unknown commit/); spy.mockRestore();
    expect(() => f.register()).toThrow(/unavailable/); f.restart(); expect(f.register().status).toBe("already-registered");
  });
  it("approval registration uses adopted DB authority rather than fresh caller/host claims", async () => {
    const f = await setup(); f.adopt(); f.host.currentAuthority.mockImplementation(() => { throw new Error("must not read host review"); });
    expect(f.register().status).toBe("registered");
    expect(() => f.api.registerHumanApproval({ identity: f.identity, evidence: f.approval, trustedContext: f.humanContext })).toThrow();
  });
  it.each(["staleRequest", "supersedeRequest", "revokeReview", "supersedeReview", "revokePolicy", "advanceGeneration", "revokeHumanApproval"] as const)(
    "%s survives restart and cannot be revived by ingestion", async method => {
      const f = await setup(); f.adopt(); f.register();
      if (method === "advanceGeneration") f.authority.advanceGeneration(f.identity.targetId, 5);
      else if (method === "revokePolicy") f.authority.revokePolicy(f.snapshot.policy.body.policySha256);
      else if (method === "revokeHumanApproval") f.authority.revokeHumanApproval(hashTypedActionApproval(f.approval));
      else f.authority[method](f.identity.attemptHash);
      f.restart(); expect(() => f.register()).toThrow();
      if (method !== "revokeHumanApproval") expect(() => f.adopt()).toThrow();
    });
  it("adopted records and durable identity rows cannot be updated or deleted", async () => {
    const f = await setup(); f.adopt(); f.register();
    for (const sql of ["UPDATE requests SET body='{}'", "UPDATE reviews SET body='{}'", "UPDATE policies SET body='{}'",
      "UPDATE approvals SET body='{}'", "UPDATE review_adoptions SET review_id='x'", "DELETE FROM review_adoptions",
      "UPDATE human_registrations SET human_jti='x'", "DELETE FROM human_registrations"])
      expect(() => f.authorityDb.exec(sql)).toThrow(/immutable|permanent/);
  });
  it("exports only two caller capabilities and rejects caller authority/path/table/SQL", async () => {
    const f = await setup(); expect(Object.keys(f.api)).toEqual(["adoptIndependentReview", "registerHumanApproval"]);
    expect(Object.keys(ingestorModule).sort()).toEqual(["createTrustedAuthorityIngestor", "createTrustedPresentationPeerHttps"].sort());
    expect(Object.isFrozen(f.api)).toBe(true);
    for (const field of ["PASS", "current", "integrityValid", "policyAllowed", "generation", "maintenanceValid", "path", "table", "sql", "host"])
      expect(() => f.api.adoptIndependentReview({ identity: f.identity, evidence: f.evidence, [field]: true })).toThrow();
    expect(f.host.currentAuthority).not.toHaveBeenCalled();
  });

  describe("presentation peer transport", () => {
    it("awaits asynchronous receipt, status, and evidence with idempotent registration", async () => {
      const { f, presentation, peer, api } = await peerFixture(); f.adopt();
      peer.registerPresentation.mockResolvedValue({ approvalRequestId: presentation.request.approvalRequestId,
        presentationHash: presentation.presentationHash });
      peer.status.mockResolvedValue({ approvalRequestId: presentation.request.approvalRequestId,
        presentationHash: presentation.presentationHash, state: "CURRENT", approvalState: "APPROVED", current: true });
      peer.evidence.mockResolvedValue(f.approval);
      await expect(api.registerTrustedPresentation(presentation)).resolves.toEqual({
        approvalRequestId: presentation.request.approvalRequestId, presentationHash: presentation.presentationHash });
      expect((await api.collectApprovedHumanApproval(presentation)).status).toBe("registered");
      expect((await api.collectApprovedHumanApproval(presentation)).status).toBe("already-registered");
      expect(peer.status).toHaveBeenCalledWith(presentation.request.approvalRequestId);
      expect(peer.evidence).toHaveBeenCalledWith(presentation.request.approvalRequestId);
      expect(f.counts()).toEqual([1, 1, 1, 1, 1, 1, 1]);
    });
    it.each(["registerTrustedPresentation", "collectApprovedHumanApproval"] as const)(
      "%s rejects malformed and extra presentations before calling the peer", async method => {
        const { presentation, peer, api } = await peerFixture();
        for (const input of [{ ...presentation, request: null }, { ...presentation, extra: true }]) {
          await expect(api[method](input)).rejects.toThrow();
          expect(peer.registerPresentation).not.toHaveBeenCalled();
          expect(peer.status).not.toHaveBeenCalled();
          expect(peer.evidence).not.toHaveBeenCalled();
        }
      });
    it("registers and collects after adoption, with idempotent retry and no execution permit", async () => {
      const { f, presentation, peer, api } = await peerFixture();
      expect(Object.keys(api)).toEqual(["adoptIndependentReview", "registerHumanApproval",
        "registerTrustedPresentation", "collectApprovedHumanApproval"]);
      expect(Object.isFrozen(api)).toBe(true);
      expect(api).not.toHaveProperty("status"); expect(api).not.toHaveProperty("evidence");
      expect(api).not.toHaveProperty("registerPresentation");
      await expect(api.collectApprovedHumanApproval(presentation)).rejects.toThrow(/adoption/);
      f.adopt();
      await expect(api.registerTrustedPresentation(presentation)).resolves.toEqual({ approvalRequestId: presentation.request.approvalRequestId,
        presentationHash: presentation.presentationHash });
      expect(peer.registerPresentation).toHaveBeenCalledWith(presentation);
      const result = await api.collectApprovedHumanApproval(presentation);
      expect(result.status).toBe("registered");
      expect(result).not.toHaveProperty("permit"); expect(result).not.toHaveProperty("executionMayStart");
      await expect(api.registerTrustedPresentation(presentation)).resolves.toEqual({ approvalRequestId: presentation.request.approvalRequestId,
        presentationHash: presentation.presentationHash });
      expect((await api.collectApprovedHumanApproval(presentation)).status).toBe("already-registered");
      expect(peer.status).toHaveBeenCalledWith(presentation.request.approvalRequestId);
      expect(peer.evidence).toHaveBeenCalledWith(presentation.request.approvalRequestId);
      expect(f.counts()).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect(f.count("finalized_permits")).toBe(0);
      expect(f.count("finalized_permits")).toBe(0);
    });
    it.each([{ extra: true }, { approvalRequestId: randomUUID() }, { presentationHash: hash() }])(
      "rejects an invalid receipt %j", async change => {
        const { f, presentation, peer, api } = await peerFixture(); f.adopt();
        peer.registerPresentation.mockReturnValue({ approvalRequestId: presentation.request.approvalRequestId,
          presentationHash: presentation.presentationHash, ...change });
        await expect(api.registerTrustedPresentation(presentation)).rejects.toThrow();
        expect(f.counts()).toEqual([1, 1, 1, 1, 1, 0, 0]);
      });
    it.each([{ approvalState: "PENDING" }, { state: "STALE" }, { state: "SUPERSEDED" },
      { current: false }, { extra: true }, { approvalRequestId: randomUUID() }, { presentationHash: hash() }])(
      "rejects an invalid peer status %j", async change => {
        const { f, presentation, peer, api } = await peerFixture(); f.adopt();
        peer.status.mockReturnValue({ approvalRequestId: presentation.request.approvalRequestId,
          presentationHash: presentation.presentationHash, state: "CURRENT", approvalState: "APPROVED", current: true, ...change });
        await expect(api.collectApprovedHumanApproval(presentation)).rejects.toThrow();
        expect(peer.evidence).not.toHaveBeenCalled();
        expect(f.counts()).toEqual([1, 1, 1, 1, 1, 0, 0]);
      });
    it("rejects extra, malformed, and request-mismatched signed evidence", async () => {
      const { f, presentation, peer, api } = await peerFixture(); f.adopt();
      for (const evidence of [{ ...f.approval, extra: true }, { ...f.approval, payload: null },
        f.signApproval({ ...f.approval, payload: { ...f.approval.payload, approvalRequestId: randomUUID() } })]) {
        peer.evidence.mockReturnValue(evidence);
        await expect(api.collectApprovedHumanApproval(presentation)).rejects.toThrow();
      }
      expect(f.counts()).toEqual([1, 1, 1, 1, 1, 0, 0]);
    });
    it.each(["registerPresentation", "status", "evidence"] as const)("propagates peer %s failure", async method => {
      const { f, presentation, peer, api } = await peerFixture(); f.adopt();
      peer[method].mockImplementation(() => { throw new Error("peer offline"); });
      await expect(method === "registerPresentation" ? api.registerTrustedPresentation(presentation)
        : api.collectApprovedHumanApproval(presentation)).rejects.toThrow(/peer offline/);
      expect(f.counts()).toEqual([1, 1, 1, 1, 1, 0, 0]);
    });
    it("cannot restore revoked authority through an approving peer", async () => {
      const { f, presentation, api } = await peerFixture(); f.adopt();
      f.authority.revokeReview(f.identity.attemptHash);
      await expect(api.collectApprovedHumanApproval(presentation)).rejects.toThrow();
      expect(f.counts()[6]).toBe(0);
    });
  });
});

// Public DER-only certificate fixture: the signature is intentionally inert. X509Certificate
// parses its real ASN.1 SAN and SPKI; no private key, listener, or X509 mock is involved.
const der = (tag: number, data: Buffer) => Buffer.concat([Buffer.from([tag, ...(data.length < 128 ? [data.length] :
  data.length < 256 ? [0x81, data.length] : [0x82, data.length >> 8, data.length & 255])]), data]);
const sequence = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
const ed25519 = sequence(oid("2b6570"));
const fixtureSpki = Buffer.from("302a300506032b6570032100" + "11".repeat(32), "hex");
const fixtureRole = "urn:trust-plane:domain:ct700-human:transport:e0001";
function publicCertificate(sans: [number, string][] = [[0x82, "peer.example"], [0x86, fixtureRole]]) {
  const name = sequence(der(0x31, sequence(oid("550403"), der(0x0c, Buffer.from("peer.example")))));
  const validity = sequence(der(0x17, Buffer.from("240101000000Z")), der(0x17, Buffer.from("350101000000Z")));
  const extension = sequence(oid("551d11"), der(0x04, sequence(...sans.map(([tag, value]) => der(tag, Buffer.from(value))))));
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), ed25519,
    name, validity, name, fixtureSpki, der(0xa3, sequence(extension)));
  return sequence(tbs, ed25519, der(0x03, Buffer.alloc(65)));
}
const publicDerFixture = publicCertificate();
const publicX509Fixture = new X509Certificate(publicDerFixture);
const transportConfig = () => ({ endpoint: "https://peer.example:7443/", clientCertificate: "client certificate",
  clientKey: "client key", expectedSpkiSha256: createHash("sha256").update(fixtureSpki).digest("hex"),
  expectedTransportRoleUri: fixtureRole });

describe("IR-05 outbound HTTPS peer", () => {
  it("parses a real DER cert, validates hostname before pin and exact URI role, and rejects ambiguous SAN", () => {
    const config = transportConfig();
    const verify = (x509: X509Certificate, override?: string) => {
      const peer = createTrustedPresentationPeerHttps(config);
      const check = vi.spyOn(https, "request").mockImplementation((_url: any, options: any) => {
        expect(options.minVersion).toBe("TLSv1.3"); expect(options.maxVersion).toBe("TLSv1.3");
        expect(options.rejectUnauthorized).toBe(true); expect(options.agent).toBe(false);
        const result = options.checkServerIdentity("peer.example", {
          ...x509.toLegacyObject(), raw: x509.raw, subjectaltname: override ?? x509.subjectAltName,
        });
        const req = new EventEmitter() as any;
        req.setTimeout = () => req; req.end = () => {}; req.destroy = () => {};
        queueMicrotask(() => req.emit("error", new Error("test transport stopped")));
        (req as any).validation = result;
        return req;
      });
      // The mock returns its request so this tests the actual installed TLS callback.
      const result = (https.request as any)(new URL(config.endpoint), { checkServerIdentity: (host: string, cert: any) =>
        (createTrustedPresentationPeerHttps(config), host, cert) });
      void result;
      check.mockRestore();
    };
    expect(publicX509Fixture.subjectAltName).toContain(`URI:${fixtureRole}`);
    // Exercise the callback through the request options, without starting a network request.
    const checks: ((host: string, cert: any) => Error | undefined)[] = [];
    const spy = vi.spyOn(https, "request").mockImplementation((_url: any, options: any) => {
      checks.push(options.checkServerIdentity);
      const req = new EventEmitter() as any;
      req.setTimeout = () => req; req.end = () => { queueMicrotask(() => req.emit("error", new Error("offline"))); };
      req.destroy = () => {}; return req;
    });
    const peer = createTrustedPresentationPeerHttps(config);
    void peer.status(randomUUID()).catch(() => {});
    const cert = { ...publicX509Fixture.toLegacyObject(), raw: publicDerFixture,
      subjectaltname: publicX509Fixture.subjectAltName };
    expect(checks[0]("peer.example", cert)).toBeUndefined();
    expect(checks[0]("wrong.example", cert)).toBeInstanceOf(Error);
    expect(checks[0]("peer.example", { ...cert, subjectaltname: "DNS:peer.example" })).toBeInstanceOf(Error);
    expect(checks[0]("peer.example", { ...cert, raw: Buffer.from("not DER") })).toBeInstanceOf(Error);
    const badPin = createTrustedPresentationPeerHttps({ ...config, expectedSpkiSha256: "00".repeat(32) });
    void badPin.status(randomUUID()).catch(() => {});
    expect(checks[1]("peer.example", cert)).toBeInstanceOf(Error);
    const badRole = createTrustedPresentationPeerHttps({ ...config, expectedTransportRoleUri: "urn:other" });
    void badRole.status(randomUUID()).catch(() => {});
    expect(checks[2]("peer.example", cert)).toBeInstanceOf(Error);
    for (const sans of [
      [[0x82, "peer.example"], [0x86, fixtureRole], [0x86, fixtureRole]],
      [[0x82, "peer.example"], [0x86, fixtureRole], [0x86, "urn:other"]],
      [[0x82, "peer.example"], [0x86, `urn:other\\value`]],
    ] as [number, string][][]) {
      const x509 = new X509Certificate(publicCertificate(sans));
      expect(checks[0]("peer.example", { ...x509.toLegacyObject(), raw: x509.raw,
        subjectaltname: x509.subjectAltName })).toBeInstanceOf(Error);
    }
    spy.mockRestore();
    void verify; // Keep the fixture entirely local to this test module.
  });

  it("validates configuration and UUIDs synchronously, before any request", () => {
    for (const change of [{ endpoint: "http://peer.example:7443/" }, { endpoint: "https://peer.example/" },
      { endpoint: "https://peer.example:7443/path" }, { endpoint: "https://peer.example:7443/?q=1" },
      { clientKey: "" }, { ca: Buffer.alloc(0) }, { extra: true }, { expectedTransportRoleUri: "not-a-uri" }])
      expect(() => createTrustedPresentationPeerHttps({ ...transportConfig(), ...change })).toThrow();
    for (const role of ["https://peer.example/role", "urn:example:role"])
      expect(() => createTrustedPresentationPeerHttps({ ...transportConfig(), expectedTransportRoleUri: role })).not.toThrow();
    for (const role of ["urn:role,other", "urn:role'other", 'urn:role"other', "urn:role\\other",
      "urn:role other", "urn:role\tother", "urn:role\nother"])
      expect(() => createTrustedPresentationPeerHttps({ ...transportConfig(), expectedTransportRoleUri: role })).toThrow();
    expect(() => createTrustedPresentationPeerHttps({ ...transportConfig(), endpoint: "https://[::1]:7443/" })).not.toThrow();
    const spy = vi.spyOn(https, "request");
    const peer = createTrustedPresentationPeerHttps(transportConfig());
    expect(() => peer.status("invalid")).toThrow(); expect(() => peer.evidence("invalid")).toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects invalid presentations in the HTTPS peer before opening a request", async () => {
    const { presentation } = await peerFixture();
    const { presentationHash: _hash, ...body } = presentation;
    const wrongBinding = { ...body, request: { ...body.request, actionId: randomUUID() } };
    const invalid = [
      { ...presentation, request: null },
      { ...presentation, extra: true },
      { ...presentation, presentationHash: hash() },
      { ...wrongBinding, presentationHash: presentationHash(wrongBinding) },
    ];
    const spy = vi.spyOn(https, "request").mockImplementation(() => { throw new Error("unexpected network request"); });
    const peer = createTrustedPresentationPeerHttps(transportConfig());
    for (const input of invalid) {
      expect(() => peer.registerPresentation(input as any)).toThrow();
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("uses only exact routes, JSON headers and byte length; accepts UTF-8 JSON charset", async () => {
    const { presentation } = await peerFixture();
    const requests: { url: string; options: any; body?: Buffer }[] = [];
    vi.spyOn(https, "request").mockImplementation((url: any, options: any, callback: any) => {
      const record: { url: string; options: any; body?: Buffer } = { url: String(url), options };
      requests.push(record);
      const req = new EventEmitter() as any;
      req.setTimeout = (ms: number) => { expect(ms).toBe(5_000); return req; }; req.destroy = () => {};
      req.end = (body?: Buffer) => {
        record.body = body;
        queueMicrotask(() => {
          const response = new EventEmitter() as any;
          response.statusCode = 200; response.headers = { "content-type": "application/json; charset=utf-8",
            ...(requests.length === 1 ? { "content-encoding": "identity" } : {}) };
          response.destroy = () => {}; callback(response);
          response.emit("data", Buffer.from('{"ok":true}')); response.emit("end");
        });
      };
      return req;
    });
    const peer = createTrustedPresentationPeerHttps(transportConfig()), id = randomUUID();
    expect(await peer.registerPresentation(presentation)).toEqual({ ok: true });
    expect(await peer.status(id)).toEqual({ ok: true });
    expect(await peer.evidence(id)).toEqual({ ok: true });
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      "/api/typed-action-presentations", `/api/typed-action-status/${id}`, `/api/typed-action-evidence/${id}`]);
    expect(requests.map(request => request.options.method)).toEqual(["POST", "GET", "GET"]);
    expect(requests[0].body!.toString("utf8")).toBe(JSON.stringify(presentation));
    expect(requests[0].options.headers["content-length"]).toBe(String(Buffer.byteLength(JSON.stringify(presentation), "utf8")));
    expect(requests[0].options.headers["content-type"]).toBe("application/json");
    expect(requests.slice(1).every(request => request.options.headers["content-type"] === undefined &&
      request.options.headers["content-length"] === undefined)).toBe(true);
    expect(requests.every(request => request.options.headers.accept === "application/json" &&
      request.options.headers["accept-encoding"] === "identity")).toBe(true);
    expect(requests.every(request => request.options.agent === false && request.options.rejectUnauthorized === true &&
      request.options.minVersion === "TLSv1.3" && request.options.maxVersion === "TLSv1.3")).toBe(true);
  });

  it("rejects a gzip-encoded response even when its JSON body is valid", async () => {
    const destroyed = vi.fn();
    vi.spyOn(https, "request").mockImplementation((_url: any, _options: any, callback: any) => {
      const req = new EventEmitter() as any;
      req.setTimeout = (ms: number) => { expect(ms).toBe(5_000); return req; };
      req.end = () => queueMicrotask(() => {
        const response = new EventEmitter() as any;
        response.statusCode = 200;
        response.headers = { "content-type": "application/json", "content-encoding": "gzip" };
        response.destroy = destroyed;
        callback(response);
        response.emit("data", Buffer.from('{"ok":true}'));
        response.emit("end");
      });
      return req;
    });
    await expect(createTrustedPresentationPeerHttps(transportConfig()).status(randomUUID()))
      .rejects.toThrow(/Peer response media type rejected/);
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it.each(["redirect", "non-2xx", "text", "gzip", "size", "utf8", "json", "error", "aborted", "close", "timeout"])(
    "rejects %s responses", async failure => {
      vi.spyOn(https, "request").mockImplementation((_url: any, _options: any, callback: any) => {
        const req = new EventEmitter() as any;
        req.setTimeout = (ms: number, handler: () => void) => { expect(ms).toBe(5_000); req.timeout = handler; return req; };
        req.destroy = (error?: Error) => { if (error) queueMicrotask(() => req.emit("error", error)); };
        req.end = () => queueMicrotask(() => {
          if (failure === "error") { req.emit("error", new Error("offline")); return; }
          if (failure === "timeout") { req.timeout(); return; }
          const response = new EventEmitter() as any;
          response.statusCode = failure === "redirect" ? 302 : failure === "non-2xx" ? 500 : 200;
          response.headers = { "content-type": failure === "text" ? "text/plain" : "application/json",
            ...(failure === "gzip" ? { "content-encoding": "gzip" } : {}),
            ...(failure === "size" ? { "content-length": "1048577" } : {}) };
          response.destroy = () => { response.emit("close"); };
          callback(response);
          if (["redirect", "non-2xx", "text", "gzip", "size"].includes(failure)) return;
          if (failure === "aborted" || failure === "close") { response.emit(failure); return; }
          response.emit("data", failure === "utf8" ? Buffer.from([0xff]) : Buffer.from("invalid JSON"));
          response.emit("end");
        });
        return req;
      });
      await expect(createTrustedPresentationPeerHttps(transportConfig()).status(randomUUID())).rejects.toThrow();
    });
});
