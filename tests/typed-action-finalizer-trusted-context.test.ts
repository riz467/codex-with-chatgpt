import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { actionBindingFields, hashTypedActionApproval } from "../src/typed-action-approval/contract.js";
import { createTrustedContextProvider } from "../src/typed-action-finalizer/trusted-context.js";
import { TrustedContextStore, type AuthorityFixture } from "../src/typed-action-finalizer/trusted-context-storage.js";
import { createFinalizerService, type ContextIdentity } from "../src/typed-action-finalizer/server.js";
import { sqliteFixture, type SqliteFixture } from "./typed-action-sqlite-fixtures.js";
import { hash, now, time } from "./typed-action-fixtures.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function records(f: SqliteFixture): AuthorityFixture {
  // Independent host fixture records, never a provider transformation of caller JSON.
  const binding = Object.fromEntries(actionBindingFields.map(k => [k, f.input.independentReview[k]]));
  const { isCurrent: _r, ...review } = f.input.independentReview;
  const { isCurrent: _p, requestIsCurrent: _q, ...policy } = f.input.policyContext;
  return {
    targets: [{ targetId: f.humanContext.targetId, generation: 4 }],
    requests: [{ state: "current", body: { ...binding, attemptCreatedAt: f.input.boundAttempt.attempt.createdAt } as AuthorityFixture["requests"][number]["body"] }],
    reviews: [{ state: "current", body: structuredClone(review) }],
    policies: [{ state: "current", body: structuredClone(policy) }],
    approvals: [{ state: "current", body: structuredClone(f.approval) }],
  };
}
async function setup(change?: (seed: AuthorityFixture, fixture: SqliteFixture) => void) {
  const f = await sqliteFixture(); cleanups.push(() => f.cleanup());
  const authorityPath = path.join(path.dirname(f.file), "authority.sqlite");
  let clock = now;
  function open() {
    const database = new DatabaseSync(authorityPath);
    let store: TrustedContextStore;
    try { store = new TrustedContextStore({ database }); } catch (error) { database.close(); throw error; }
    cleanups.push(() => store.close());
    const provider = createTrustedContextProvider({ store, trustedHumanKeys: f.humanKeys, now: () => clock });
    return { store, provider };
  }
  let host = open();
  const seed = records(f); change?.(seed, f); host.store.bootstrapFixture(seed);
  const p = f.approval.payload;
  const identity: ContextIdentity = { actionId: p.actionId, targetId: p.targetId, requestHash: p.requestHash,
    attemptId: p.attemptId, attemptHash: p.attemptHash, approvalRequestId: p.approvalRequestId,
    humanApprovalJti: p.jti, humanApprovalEvidenceHash: hashTypedActionApproval(f.approval) };
  const { approvalRequestId: _approval, ...executionIdentity } = identity;
  return {
    ...f, authorityPath, seed, identity, executionIdentity, open,
    get authority() { return host.store; }, get provider() { return host.provider; },
    setTime(value: number) { clock = value; f.setClock(value); },
    restartAuthority() { host.store.close(); host = open(); },
    snapshot(id: ContextIdentity = identity) { return host.provider.withFence(id, async () => host.provider.finalization(id)); },
    issue() { return host.provider.withFence(identity, async () => f.kernel.finalizeAndSignTypedAction({ ...f.input, ...host.provider.finalization(identity) })); },
    consume() { return host.provider.withFence(executionIdentity, async () => f.store.consumeForExecution(f.permit, () => host.provider.execution(executionIdentity))); },
  };
}
async function issued(f: Awaited<ReturnType<typeof setup>>) { expect((await f.issue()).state).toBe("VERIFIED_NOT_CONSUMED"); }

describe("CT701 trusted authority core", () => {
  it("generates trusted Human, independent CT702, policy and fresh execution contexts", async () => {
    const f = await setup();
    expect(await f.snapshot()).toEqual({ humanContext: f.humanContext, independentReview: f.input.independentReview, policyContext: f.input.policyContext });
    await f.provider.withFence(f.executionIdentity, async () => {
      expect(f.provider.execution(f.executionIdentity)).toEqual(f.executionContext);
      expect(Object.isFrozen(f.provider.finalization(f.executionIdentity))).toBe(true);
    });
  });
  it("caller PASS/current/allowed/generation cannot grant or revive authority", async () => {
    const f = await setup(s => { s.reviews[0].body.result = "FAIL"; });
    await expect(f.snapshot({ ...f.identity, result: "PASS", current: true, actionAllowed: true, generation: 4, maintenanceValid: true } as any)).rejects.toThrow();
    await expect(f.snapshot()).rejects.toThrow();
    expect(f.count("finalized_permits")).toBe(0);
  });
  const invalid: [string, (seed: AuthorityFixture) => void][] = [
    ["missing request", s => { s.requests = []; }],
    ["stale request", s => { s.requests[0].state = "stale"; }],
    ["superseded request", s => { s.requests[0].state = "superseded"; }],
    ["missing CT702 evidence", s => { s.reviews = []; }],
    ["review not PASS", s => { s.reviews[0].body.result = "NEEDS_WORK"; }],
    ["review stale", s => { s.reviews[0].state = "stale"; }],
    ["review superseded", s => { s.reviews[0].state = "superseded"; }],
    ["review integrity invalid", s => { s.reviews[0].body.evidenceIntegrityValid = false; }],
    ["review hash mismatch", s => { s.reviews[0].body.independentReviewEvidenceHash = hash(); }],
    ["review wrong target", s => { s.reviews[0].body.targetId = randomUUID(); }],
    ["review wrong attempt", s => { s.reviews[0].body.attemptSequence++; }],
    ["future review", s => { s.reviews[0].body.issuedAt = time(1); }],
    ["expired review", s => { s.reviews[0].body.expiresAt = time(0); }],
    ["missing policy", s => { s.policies = []; }],
    ["policy stale", s => { s.policies[0].state = "stale"; }],
    ["action denied", s => { s.policies[0].body.actionAllowed = false; }],
    ["policy hash mismatch", s => { s.policies[0].body.policySha256 = hash(); }],
    ["policy wrong target", s => { s.policies[0].body.targetId = randomUUID(); }],
    ["policy generation mismatch", s => { s.policies[0].body.targetGeneration++; }],
    ["policy wrong maintenance identity", s => { s.policies[0].body.maintenanceWindowId = randomUUID(); }],
    ["target generation mismatch", s => { s.targets[0].generation++; }],
    ["target missing", s => { s.targets = []; }],
    ["maintenance not started", s => { s.policies[0].body.maintenanceWindowStartsAt = time(1); }],
    ["maintenance expired (exclusive end)", s => { s.policies[0].body.maintenanceWindowExpiresAt = time(0); }],
    ["approval extends beyond window", s => { s.policies[0].body.maintenanceWindowExpiresAt = time(60_000); }],
    ["approval issued before window", s => { s.policies[0].body.maintenanceWindowStartsAt = time(-1); }],
    ["missing independent Human registration", s => { s.approvals = []; }],
    ["Human registration stale", s => { s.approvals[0].state = "stale"; }],
  ];
  it.each(invalid)("rejects %s", async (_name, change) => {
    const f = await setup(change); await expect(f.issue()).rejects.toThrow(); expect(f.count("finalized_permits")).toBe(0);
  });
  it.each(["requestHash", "attemptHash", "actionId", "targetId", "attemptId", "humanApprovalEvidenceHash", "humanApprovalJti", "approvalRequestId"] as const)("rejects wrong identity %s", async field => {
    const f = await setup();
    const value = field.endsWith("Hash") ? hash() : field === "humanApprovalJti" ? Buffer.alloc(32, 9).toString("base64url") : randomUUID();
    await expect(f.snapshot({ ...f.identity, [field]: value })).rejects.toThrow();
  });
  it("authenticates the registered Human signature rather than trusting its stored JSON", async () => {
    const f = await setup(s => { s.approvals[0].body.signature = Buffer.alloc(64, 1).toString("base64url"); });
    const identity = { ...f.identity, humanApprovalEvidenceHash: hashTypedActionApproval(f.seed.approvals[0].body) };
    await expect(f.snapshot(identity)).rejects.toThrow();
  });
  it("maintenance start is inclusive, while approval and review must already exist", async () => {
    const f = await setup((s, fixture) => {
      s.policies[0].body.maintenanceWindowStartsAt = time(0);
      s.approvals[0].body = fixture.signApproval({ ...fixture.approval, payload: { ...fixture.approval.payload, issuedAt: time(0) } });
    });
    const identity = { ...f.identity, humanApprovalEvidenceHash: hashTypedActionApproval(f.seed.approvals[0].body) };
    expect(await f.snapshot(identity)).toBeDefined();
    f.setTime(now - 1); await expect(f.snapshot(identity)).rejects.toThrow();
  });
  it("persists registrations, revocations and generation across restart", async () => {
    const f = await setup(); const before = await f.snapshot(); f.restartAuthority(); expect(await f.snapshot()).toEqual(before);
    f.authority.revokeReview(f.identity.attemptHash); f.restartAuthority(); await expect(f.snapshot()).rejects.toThrow();
    f.authority.advanceGeneration(f.identity.targetId, 5); f.restartAuthority();
    expect(() => f.authority.advanceGeneration(f.identity.targetId, 4)).toThrow(/generation/);
    expect(() => f.authority.bootstrapFixture(f.seed)).toThrow();
  });
  it("requires the owning async fence; detached work and foreign identities cannot reuse it", async () => {
    const f = await setup(); expect(() => f.provider.finalization(f.identity)).toThrow();
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; }); let detached!: Promise<unknown>;
    await f.provider.withFence(f.identity, async () => {
      expect(() => f.provider.execution({ ...f.identity, targetId: randomUUID() })).toThrow();
      detached = wait.then(() => f.provider.execution(f.identity));
    });
    release(); await expect(detached).rejects.toThrow();
  });
  it("rejects and poisons a same-connection update attempted during the fence", async () => {
    const f = await setup();
    await expect(f.provider.withFence(f.identity, async () => {
      expect(() => f.authority.revokeReview(f.identity.attemptHash)).toThrow(/during fence/);
      expect(() => f.provider.execution(f.identity)).toThrow(/fence/);
    })).rejects.toThrow();
    expect(await f.snapshot()).toBeDefined(); // rejected update never committed
  });
  it("detects direct same-connection revision changes and rolls them back", async () => {
    const f = await setup(); f.authority.close();
    const db = new DatabaseSync(f.authorityPath), store = new TrustedContextStore({ database: db }); cleanups.push(() => store.close());
    await expect(store.withFence(async () => {
      db.prepare("UPDATE reviews SET state='stale' WHERE attempt_hash=?").run(f.identity.attemptHash);
    })).rejects.toThrow(/fence/);
    const provider = createTrustedContextProvider({ store, trustedHumanKeys: f.humanKeys, now: () => now });
    await expect(provider.withFence(f.identity, async () => provider.finalization(f.identity))).resolves.toBeDefined();
  });
  it("serializes independent connections: finalization wins fence, writer fails busy, then revokes", async () => {
    const f = await setup(), other = f.open();
    await f.provider.withFence(f.identity, async () => {
      expect(() => other.store.revokeReview(f.identity.attemptHash)).toThrow(/locked/);
      expect(f.kernel.finalizeAndSignTypedAction({ ...f.input, ...f.provider.finalization(f.identity) }).state).toBe("VERIFIED_NOT_CONSUMED");
    });
    other.store.revokeReview(f.identity.attemptHash);
    await expect(f.consume()).rejects.toThrow(); expect(f.count("consumed_execution_identities")).toBe(0);
  });
  it("an update winning first rejects concurrent finalization without issuing", async () => {
    const f = await setup(), other = f.open(); other.store.supersedeReview(f.identity.attemptHash);
    await expect(f.issue()).rejects.toThrow(); expect(f.count("finalized_permits")).toBe(0);
  });
  it("SQLite cross-worker writer is excluded throughout an awaited operation", async () => {
    const f = await setup();
    await f.provider.withFence(f.identity, async () => {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
        const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData.file);
        db.exec('PRAGMA busy_timeout=0');
        try { db.exec('BEGIN IMMEDIATE'); db.prepare("UPDATE reviews SET state='stale' WHERE attempt_hash=?").run(workerData.attempt); db.exec('COMMIT'); parentPort.postMessage('updated'); }
        catch(e) { parentPort.postMessage(e.message.includes('locked')?'busy':'unexpected'); }
        finally { db.close(); }`, { eval: true, workerData: { file: f.authorityPath, attempt: f.identity.attemptHash } });
      cleanups.push(async () => { await worker.terminate(); });
      const outcome = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
      expect(outcome).toBe("busy"); expect(f.provider.execution(f.identity)).toEqual(f.executionContext);
    });
  });
  it("fresh execution reconstructs state on every call, including time changes", async () => {
    const f = await setup(); await issued(f);
    const spy = vi.spyOn(f.authority, "snapshot");
    await f.provider.withFence(f.executionIdentity, async () => {
      f.provider.execution(f.executionIdentity); f.provider.execution(f.executionIdentity);
    });
    expect(spy).toHaveBeenCalledTimes(4); // acquire, each explicit read, exit
    f.setTime(now + 120_000); await expect(f.consume()).rejects.toThrow();
    expect(f.count("consumed_execution_identities")).toBe(0);
  });
  it.each(["review", "policy", "generation", "request", "human", "superseded"] as const)("post-finalization %s revocation blocks consume", async kind => {
    const f = await setup(); await issued(f);
    switch (kind) {
      case "review": f.authority.revokeReview(f.identity.attemptHash); break;
      case "policy": f.authority.revokePolicy(f.humanContext.policySha256); break;
      case "generation": f.authority.advanceGeneration(f.identity.targetId, 5); break;
      case "request": f.authority.staleRequest(f.identity.attemptHash); break;
      case "human": f.authority.revokeHumanApproval(f.identity.humanApprovalEvidenceHash); break;
      case "superseded": f.authority.supersedeRequest(f.identity.attemptHash); break;
    }
    f.restartAuthority(); await expect(f.consume()).rejects.toThrow(); expect(f.count("consumed_execution_identities")).toBe(0);
  });
  it("consumes once through the existing signer/gate and cannot revive after either DB restarts", async () => {
    const f = await setup(); await issued(f);
    expect((await f.consume()).executionMayStart).toBe(true);
    expect((await f.consume()).executionMayStart).toBe(false);
    expect(f.count("consumed_execution_identities")).toBe(3);
    f.restartAuthority(); f.store.close(); const reopened = f.connect();
    await f.provider.withFence(f.executionIdentity, async () => {
      expect((await reopened.store.consumeForExecution(f.permit, () => f.provider.execution(f.executionIdentity))).executionMayStart).toBe(false);
    });
    f.authority.revokeReview(f.identity.attemptHash);
    expect(() => f.authority.bootstrapFixture({ ...f.seed, targets: [], requests: [], policies: [], approvals: [] })).toThrow();
    await expect(f.consume()).rejects.toThrow();
    expect(reopened.db.prepare("SELECT count(*) AS n FROM consumed_execution_identities").get()!.n).toBe(3);
    expect(() => reopened.db.exec("DELETE FROM consumed_execution_identities")).toThrow(/permanent/);
  });
  it("post-consume fence violation quarantines permanently without a live handoff", async () => {
    const f = await setup(); await issued(f); const handoff = vi.fn();
    const original = f.store.consumeOnce.bind(f.store);
    vi.spyOn(f.store, "consumeOnce").mockImplementation(async keys => {
      const result = await original(keys);
      expect(() => f.authority.advanceGeneration(f.identity.targetId, 5)).toThrow(/during fence/);
      return result;
    });
    await expect(f.provider.withFence(f.executionIdentity, async () => {
      const result = await f.store.consumeForExecution(f.permit, () => f.provider.execution(f.executionIdentity));
      if (result.executionMayStart) handoff();
      expect(result.state).toBe("RECONCILE_REQUIRED");
    })).rejects.toThrow();
    expect(handoff).not.toHaveBeenCalled(); expect(f.count("consumed_execution_identities")).toBe(3);
    expect(f.store.permit(f.permit.payload.jti)!.state).toBe("RECONCILE_REQUIRED");
  });
  it("fails closed if the trusted clock moves backwards while fenced", async () => {
    const f = await setup();
    await expect(f.provider.withFence(f.identity, async () => { f.setTime(now - 1); })).rejects.toThrow();
  });
  it.each(["DROP TRIGGER reviews_no_reactivation", "CREATE TABLE unexpected(x)", "PRAGMA user_version=2", "PRAGMA application_id=0", "PRAGMA journal_mode=DELETE"])("rejects altered schema without repair: %s", async sql => {
    const f = await setup(); f.authority.close();
    const db = new DatabaseSync(f.authorityPath);
    try {
      db.exec(sql);
      const before = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
      expect(() => new TrustedContextStore({ database: db })).toThrow(/schema/);
      expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
    } finally { db.close(); }
  });
  it("rejects malformed authority DB, in-memory DB, and mixing authority with the consumption ledger", async () => {
    const f = await setup(); f.authority.close();
    writeFileSync(f.authorityPath, "invalid sqlite"); expect(() => f.open()).toThrow();
    expect(readFileSync(f.authorityPath, "utf8")).toBe("invalid sqlite");
    const memory = new DatabaseSync(":memory:");
    try { expect(() => new TrustedContextStore({ database: memory })).toThrow(/durable/); } finally { memory.close(); }
    const ledger = new DatabaseSync(f.file);
    try { expect(() => new TrustedContextStore({ database: ledger })).toThrow(/schema/); } finally { ledger.close(); }
  });
  it("DB triggers forbid reactivation, deleting authority and decreasing generation", async () => {
    const f = await setup(); f.authority.revokeReview(f.identity.attemptHash);
    const db = new DatabaseSync(f.authorityPath);
    try {
      expect(() => db.exec("UPDATE reviews SET state='current'")).toThrow(/terminal/);
      expect(() => db.exec("DELETE FROM requests")).toThrow(/permanent/);
      expect(() => db.exec("UPDATE targets SET generation=3")).toThrow(/generation/);
      expect(() => db.exec("UPDATE requests SET body='{}'")).toThrow(/immutable/);
    } finally { db.close(); }
  });
  it("embeds in the existing service through host injection without opening a network listener", async () => {
    const f = await setup();
    const config = JSON.parse(readFileSync("deploy/ct701-typed-action-finalizer/config.json", "utf8"));
    const service = createFinalizerService({ ...config, finalizerKeyId: "ct701-test", trustedHumanKeyId: "ct700-test", trustedContextProvider: { kind: "host-injected" } }, {
      provider: f.provider, privateKey: f.finalizer.privateKey, humanPublicKey: f.human.publicKey,
      databasePath: f.file, bridgeToken: Buffer.alloc(32, 8).toString("base64url"), now: () => now,
    });
    await service.close();
    expect(config.trustedContextProvider.kind).toBe("deny-all");
    await issued(f); expect((await f.consume()).executionMayStart).toBe(true);
  });
});
