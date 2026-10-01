import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import path from "node:path";
import { actionBindingFields, hashTypedActionApproval } from "../src/typed-action-approval/contract.js";
import { independentReviewSigningBytes } from "../src/typed-action-review/contract.js";
import { verifyIndependentReview } from "../src/typed-action-review/verifier.js";
import { createTrustedAuthorityIngestor } from "../src/typed-action-finalizer/authority-ingestor.js";
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
    const db = new DatabaseSync(file), store = new TrustedContextStore({ database: db, ingestor: host });
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
      const store=new TrustedContextStore({database:db,ingestor:{currentAuthority:()=>w.snapshot,
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
    expect(Object.keys(ingestorModule)).toEqual(["createTrustedAuthorityIngestor"]);
    expect(Object.isFrozen(f.api)).toBe(true);
    for (const field of ["PASS", "current", "integrityValid", "policyAllowed", "generation", "maintenanceValid", "path", "table", "sql", "host"])
      expect(() => f.api.adoptIndependentReview({ identity: f.identity, evidence: f.evidence, [field]: true })).toThrow();
    expect(f.host.currentAuthority).not.toHaveBeenCalled();
  });
});
