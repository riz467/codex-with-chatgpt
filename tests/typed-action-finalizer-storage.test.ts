import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { consumptionNamespaces } from "../src/typed-action-finalizer/contract.js";
import { LedgerOutcomeUnknownError, reconciliationCategories, TypedActionFinalizerStore } from "../src/typed-action-finalizer/storage.js";
import { hash, jti, now, time } from "./typed-action-fixtures.js";
import { sqliteFixture, type SqliteFixture } from "./typed-action-sqlite-fixtures.js";

const active: SqliteFixture[] = [];
const workers: Worker[] = [];
async function setup(issued = true) {
  const f = await sqliteFixture(); active.push(f);
  if (issued) expect(f.kernel.finalizeAndSignTypedAction(f.input).state).toBe("VERIFIED_NOT_CONSUMED");
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workers.splice(0).map(worker => worker.terminate()));
  for (const f of active.splice(0)) await f.cleanup();
});

describe("CT701 startup schema integrity", () => {
  function open(db: DatabaseSync, f: SqliteFixture) {
    return new TypedActionFinalizerStore({ database: db, trustedFinalizerKeys: f.finalizerKeys, now: () => now });
  }
  function snapshot(db: DatabaseSync) {
    return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  }
  function rejectedWithoutRepair(db: DatabaseSync, f: SqliteFixture) {
    const before = snapshot(db);
    let authority: TypedActionFinalizerStore | undefined;
    expect(() => { authority = open(db, f); }).toThrow(/schema|integrity/i);
    expect(authority).toBeUndefined(); // No authority API can escape a rejected open.
    expect(snapshot(db)).toEqual(before); // Neither missing objects nor weak constraints repaired.
  }

  it("fresh create and reopen use the same verification, preserving normal restart evidence", async () => {
    const f = await setup(false);
    const before = snapshot(f.db);
    f.store.close();
    const restarted = f.connect();
    expect(snapshot(restarted.db)).toEqual(before);
    expect(restarted.kernel.finalizeAndSignTypedAction(f.input).state).toBe("VERIFIED_NOT_CONSUMED");
    restarted.store.close();
    expect(f.connect().store.permit(f.identity.permitJti)!.state).toBe("VERIFIED_NOT_CONSUMED");
  });

  const triggers = ["audit_no_update", "audit_no_delete", "identities_no_update", "identities_no_delete",
    "permits_no_delete", "permits_evidence_immutable", "permits_no_reactivation"];
  const tampering = [
    ["wrong application_id", "PRAGMA application_id=123"],
    ["wrong user_version", "PRAGMA user_version=2"],
    ...["finalized_permits", "consumed_execution_identities", "finalizer_audit"].map(table => [`missing ${table}`, `DROP TABLE ${table}`]),
    ["extra user table", "CREATE TABLE unexpected (id INTEGER)"],
    ["internal-looking user table", "CREATE TABLE sqliteXauthority (id INTEGER)"],
    ["extra view", "CREATE VIEW unexpected AS SELECT * FROM finalized_permits"],
    ...triggers.map(trigger => [`missing ${trigger}`, `DROP TRIGGER ${trigger}`]),
  ];
  it.each(tampering)("rejects %s without repair or authority access", async (_name, sql) => {
    const f = await setup(); f.store.close();
    const raw = new DatabaseSync(f.file);
    try { raw.exec(sql); rejectedWithoutRepair(raw, f); }
    finally { raw.close(); }
  });

  it.each(triggers)("rejects same-name no-op trigger %s without replacement", async name => {
    const f = await setup(); f.store.close(); const raw = new DatabaseSync(f.file);
    try {
      const row = raw.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name) as { sql: string };
      raw.exec(`DROP TRIGGER ${name}`);
      raw.exec(row.sql.replace(/BEGIN[\s\S]*END$/, "BEGIN SELECT 1; END"));
      rejectedWithoutRepair(raw, f);
    } finally { raw.close(); }
  });

  const malformed: [string, (sql: string) => string][] = [
    ["wrong column name", sql => sql.replace("action_id TEXT", "other_id TEXT")],
    ["wrong column order", sql => sql.replace("action_id TEXT NOT NULL, action_kind TEXT NOT NULL", "action_kind TEXT NOT NULL, action_id TEXT NOT NULL")],
    ["wrong declared type", sql => sql.replace("action_id TEXT", "action_id BLOB")],
    ["missing NOT NULL", sql => sql.replace("action_id TEXT NOT NULL", "action_id TEXT")],
    ["permit_jti without UNIQUE", sql => sql.replace("permit_jti TEXT NOT NULL UNIQUE", "permit_jti TEXT NOT NULL")],
    ["attempt_hash without UNIQUE", sql => sql.replace("attempt_hash TEXT NOT NULL UNIQUE", "attempt_hash TEXT NOT NULL")],
    ["human_jti without UNIQUE", sql => sql.replace("human_jti TEXT NOT NULL UNIQUE", "human_jti TEXT NOT NULL")],
    ["consumed without composite PK", sql => sql.replace(",\n          PRIMARY KEY(namespace,value)", "")],
    ["malformed PK order", sql => sql.replace("PRIMARY KEY(namespace,value)", "PRIMARY KEY(value,namespace)")],
    ["wrong permit PK", sql => sql.replace("permit_id TEXT PRIMARY KEY", "permit_id TEXT NOT NULL UNIQUE")],
    ["non-STRICT table", sql => sql.replace(/\) STRICT$/, ")")],
    ["weakened reactivation WHEN", sql => sql.replace("WHEN (OLD.state", "WHEN 0 AND (OLD.state")],
    ["weakened immutable columns", sql => sql.replace("canonical_envelope,issued_at,expires_at,created_at ON", "issued_at,expires_at,created_at ON")],
  ];
  it.each(malformed)("rejects directly created v1 schema: %s", async (_name, change) => {
    const f = await setup(false);
    const definitions = f.db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")
      .all() as { sql: string }[];
    const raw = new DatabaseSync(`${f.file}.malformed`);
    try {
      const original = definitions.map(row => row.sql), changed = original.map(change);
      expect(changed).not.toEqual(original); // Each case must really alter the schema.
      for (const sql of changed) raw.exec(sql);
      raw.exec("PRAGMA application_id=1413563953; PRAGMA user_version=1");
      rejectedWithoutRepair(raw, f);
    } finally { raw.close(); }
  });

  it.each([
    ["PRAGMA main.quick_check", [{ quick_check: "corrupt" }]],
    ["PRAGMA main.quick_check", [{ quick_check: "ok" }, { quick_check: "ok" }]],
    ["PRAGMA main.journal_mode", [{ journal_mode: "delete" }]],
    ["PRAGMA main.synchronous", [{ synchronous: 1 }]],
    ["PRAGMA foreign_keys", [{ foreign_keys: 0 }]],
  ])("fails closed when read-back validation fails: %s %j", async (pragma, rows) => {
    const f = await setup(false); f.store.close(); const raw = new DatabaseSync(f.file);
    const prepare = raw.prepare.bind(raw);
    const spy = vi.spyOn(raw, "prepare").mockImplementation(sql => sql === pragma
      ? { all: () => rows } as any : prepare(sql));
    try { rejectedWithoutRepair(raw, f); }
    finally { spy.mockRestore(); raw.close(); }
  });
});

/** Each worker is an independent JS isolate with its own real SQLite connection.
 * No shared process-local mutex/Set. The parent only releases the start barrier. */
function contender(f: SqliteFixture, operation: "consume" | "issue") {
  const worker = new Worker(`
    const { parentPort, workerData: d } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const { createPublicKey, createPrivateKey } = require('node:crypto');
    (async () => {
      const { tsImport } = await import('tsx/esm/api');
      const { TypedActionFinalizerStore } = await tsImport(d.storageURL, d.parentURL);
      const db = new DatabaseSync(d.file);
      const store = new TypedActionFinalizerStore({ database: db,
        trustedFinalizerKeys: new Map([['ct701-test', createPublicKey(d.finalizerPublic)]]), now: () => d.now });
      let kernel;
      if (d.operation === 'issue') {
        const { createTypedActionPermitSigningKernel } = await tsImport(d.signerURL, d.parentURL);
        kernel = createTypedActionPermitSigningKernel({ store,
          privateKey: createPrivateKey(d.finalizerPrivate), finalizerKeyId: 'ct701-test',
          trustedHumanKeys: new Map([['ct700-test', createPublicKey(d.humanPublic)]]), now: () => d.now });
      }
      parentPort.once('message', async () => {
        try {
          const value = d.operation === 'consume' ? await store.consumeOnce(d.keys)
            : kernel.finalizeAndSignTypedAction(d.input).state === 'VERIFIED_NOT_CONSUMED';
          store.close(); parentPort.postMessage({ result: value });
        } catch (error) { parentPort.postMessage({ failure: String(error) }); }
      });
      parentPort.postMessage({ ready: true });
    })().catch(error => parentPort.postMessage({ failure: String(error) }));
  `, { eval: true, workerData: {
    operation, file: f.file, now, keys: f.keys,
    input: { ...f.input, issuance: { ...f.input.issuance, jti: jti(), permitId: randomUUID() } },
    storageURL: new URL("../src/typed-action-finalizer/storage.ts", import.meta.url).href,
    signerURL: new URL("../src/typed-action-finalizer/signer.ts", import.meta.url).href,
    parentURL: import.meta.url,
    finalizerPublic: f.finalizer.publicKey.export({ type: "spki", format: "pem" }),
    finalizerPrivate: f.finalizer.privateKey.export({ type: "pkcs8", format: "pem" }),
    humanPublic: f.human.publicKey.export({ type: "spki", format: "pem" }),
  } });
  workers.push(worker);
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let resultResolve!: (result: boolean) => void, resultReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise<boolean>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  // Attach handlers immediately: a worker startup error must not become unhandled.
  void result.catch(() => {});
  const fail = (error: Error) => { readyReject(error); resultReject(error); };
  worker.on("error", fail);
  worker.on("message", message => {
    if (message.failure) fail(new Error(message.failure));
    else if (message.ready) readyResolve();
    else resultResolve(message.result);
  });
  worker.on("exit", code => { if (code !== 0) fail(new Error(`Worker failed: ${code}`)); });
  return { ready, result, start: () => worker.postMessage("go") };
}

describe("durable CT701 SQLite replay ledger", () => {
  it("uses dedicated file-backed SQLite with WAL, FULL durability and foreign keys", async () => {
    const f = await setup();
    expect(f.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(f.db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(f.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(f.db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    const memory = new DatabaseSync(":memory:");
    try { expect(() => new TypedActionFinalizerStore({ database: memory, trustedFinalizerKeys: f.finalizerKeys, now: () => now })).toThrow(/durable/); }
    finally { memory.close(); }
  });

  it("atomic three-key consumption commits state and audit together, and restart rejects replay", async () => {
    const f = await setup();
    expect(f.count("consumed_execution_identities")).toBe(0);
    expect(await f.store.consumeOnce(f.keys)).toBe(true);
    expect(f.count("consumed_execution_identities")).toBe(3);
    expect(f.store.permit(f.identity.permitJti)!.state).toBe("CONSUMED_FOR_EXECUTION");
    expect(f.store.audit(f.identity).map(row => row.event)).toEqual(["PERMIT_ISSUED", "CONSUMPTION_STARTED", "CONSUMPTION_SUCCEEDED"]);
    f.store.close(); const restarted = f.connect();
    expect(await restarted.store.consumeOnce(f.keys)).toBe(false);
    expect(restarted.store.audit(f.identity).at(-1)!.event).toBe("CONSUMPTION_REJECTED_DUPLICATE");
    expect((restarted.db.prepare("SELECT count(*) AS n FROM consumed_execution_identities").get() as any).n).toBe(3);
  });

  it.each(Object.values(consumptionNamespaces))("duplicate %s rolls back every fresh key, independent of insert order", async namespace => {
    const f = await setup(); expect(await f.store.consumeOnce(f.keys)).toBe(true);
    const altered = f.keys.map(key => key.namespace === namespace ? key : {
      ...key, value: key.namespace === consumptionNamespaces.attempt ? hash() : jti(),
    });
    // Duplicate is intentionally last, after two successful fresh INSERTs.
    altered.sort((a, b) => Number(a.namespace === namespace) - Number(b.namespace === namespace));
    expect(await f.store.consumeOnce(altered)).toBe(false);
    expect(f.count("consumed_execution_identities")).toBe(3);
    for (const key of altered.filter(key => key.namespace !== namespace)) {
      expect(f.db.prepare("SELECT 1 FROM consumed_execution_identities WHERE namespace=? AND value=?").get(key.namespace, key.value)).toBeUndefined();
    }
    expect((f.db.prepare("SELECT event FROM finalizer_audit ORDER BY id DESC LIMIT 1").get() as any).event).toBe("CONSUMPTION_REJECTED_DUPLICATE");
  });

  it("rejects missing, repeated or unknown namespaces without writing partial identities", async () => {
    const f = await setup();
    for (const keys of [f.keys.slice(1), [f.keys[0], f.keys[0], f.keys[2]],
      [...f.keys, f.keys[0]], [{ namespace: "arbitrary", value: jti() }, ...f.keys.slice(1)]]) {
      await expect(f.store.consumeOnce(keys as any)).rejects.toThrow();
    }
    expect(f.count("consumed_execution_identities")).toBe(0);
  });

  it("independent worker connections have exactly one consume winner", async () => {
    const f = await setup();
    const contenders = Array.from({ length: 6 }, () => contender(f, "consume"));
    await Promise.all(contenders.map(value => value.ready));
    contenders.forEach(value => value.start());
    const outcomes = await Promise.all(contenders.map(value => value.result));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(f.count("consumed_execution_identities")).toBe(3);
    expect(f.store.audit(f.identity).filter(row => row.event === "CONSUMPTION_SUCCEEDED")).toHaveLength(1);
    expect(f.store.audit(f.identity).filter(row => row.event === "CONSUMPTION_REJECTED_DUPLICATE")).toHaveLength(5);
  }, 30_000);

  it("concurrent distinct issuance metadata cannot produce two permits for one attempt", async () => {
    const f = await setup(false);
    const contenders = Array.from({ length: 4 }, () => contender(f, "issue"));
    await Promise.all(contenders.map(value => value.ready)); contenders.forEach(value => value.start());
    expect((await Promise.all(contenders.map(value => value.result))).filter(Boolean)).toHaveLength(1);
    expect(f.count("finalized_permits")).toBe(1); expect(f.count("consumed_execution_identities")).toBe(0);
  }, 30_000);

  it("case C: a real SQLite error after partial inserts rolls back all keys and persists reconciliation", async () => {
    const f = await setup();
    f.db.exec(`CREATE TRIGGER test_failure BEFORE INSERT ON consumed_execution_identities
      WHEN NEW.namespace='${consumptionNamespaces.attempt}' BEGIN SELECT RAISE(ABORT,'test failure'); END`);
    await expect(f.store.consumeOnce(f.keys)).rejects.toMatchObject({ category: "STORE_OUTCOME_UNKNOWN", reconciliationPersisted: true });
    expect(f.count("consumed_execution_identities")).toBe(0);
    expect(f.store.permit(f.identity.permitJti)!.state).toBe("RECONCILE_REQUIRED");
    f.db.exec("DROP TRIGGER test_failure");
    // Even a rolled-back attempt is quarantined until reconciliation; no blind retry.
    await expect(f.store.consumeOnce(f.keys)).rejects.toThrow(LedgerOutcomeUnknownError);
    expect(f.count("consumed_execution_identities")).toBe(0);
  });

  it("commit outcome uncertainty never returns true and remains consumed across restart", async () => {
    const f = await setup(), original = f.db.exec.bind(f.db); let injected = false;
    vi.spyOn(f.db, "exec").mockImplementation(sql => {
      original(sql);
      if (sql === "COMMIT" && !injected) { injected = true; throw new Error("acknowledgement lost"); }
    });
    await expect(f.store.consumeOnce(f.keys)).rejects.toMatchObject({ category: "STORE_OUTCOME_UNKNOWN", reconciliationPersisted: true });
    expect(f.count("consumed_execution_identities")).toBe(3);
    expect(f.store.permit(f.identity.permitJti)!.state).toBe("RECONCILE_REQUIRED");
    vi.restoreAllMocks(); f.store.close(); const restarted = f.connect();
    expect(await restarted.store.consumeOnce(f.keys)).toBe(false);
    expect(restarted.store.permit(f.identity.permitJti)!.reconciliationCategory).toBe("STORE_OUTCOME_UNKNOWN");
  });

  it("unavailable storage throws a non-retryable reconciliation candidate", async () => {
    const f = await setup(); f.store.close();
    await expect(f.store.consumeOnce(f.keys)).rejects.toMatchObject({ category: "STORE_OUTCOME_UNKNOWN", reconciliationPersisted: false });
  });

  it.each(reconciliationCategories)("case D: %s survives restart and never releases consumed identities", async category => {
    const f = await setup(); await f.store.consumeOnce(f.keys);
    f.store.recordReconciliation(f.identity, category);
    f.store.close(); const restarted = f.connect();
    expect(restarted.store.permit(f.identity.permitJti)).toMatchObject({ state: "RECONCILE_REQUIRED", reconciliationCategory: category, reconciledAt: time(0) });
    expect(await restarted.store.consumeOnce(f.keys)).toBe(false);
    expect(restarted.store.audit(f.identity).some(row => row.event === "RECONCILE_REQUIRED" && row.category === category)).toBe(true);
    expect(() => restarted.store.recordVerifiedExecution(f.identity)).toThrow();
    expect((restarted.db.prepare("SELECT count(*) AS n FROM consumed_execution_identities").get() as any).n).toBe(3);
  });

  it("verified execution remains permanently consumed, including after expiry", async () => {
    const f = await setup(); await f.store.consumeOnce(f.keys); f.store.recordVerifiedExecution(f.identity);
    expect(f.store.permit(f.identity.permitJti)).toMatchObject({ state: "CONSUMED_FOR_EXECUTION", executionVerifiedAt: time(0) });
    expect(f.store.audit(f.identity).at(-1)!.event).toBe("EXECUTION_VERIFIED");
    f.setClock(now + 86400_000);
    expect(await f.store.consumeOnce(f.keys)).toBe(false); expect(f.count("consumed_execution_identities")).toBe(3);
    expect(() => f.store.recordVerifiedExecution(f.identity)).toThrow();
  });

  it("append-only audit and immutable evidence/identities are enforced by SQLite too", async () => {
    const f = await setup(); await f.store.consumeOnce(f.keys);
    for (const sql of ["UPDATE finalizer_audit SET event='EXECUTION_VERIFIED'", "DELETE FROM finalizer_audit",
      "DELETE FROM consumed_execution_identities", "UPDATE consumed_execution_identities SET value='other'",
      "DELETE FROM finalized_permits", "UPDATE finalized_permits SET canonical_envelope='{}'",
      "UPDATE finalized_permits SET state='VERIFIED_NOT_CONSUMED'"]) expect(() => f.db.exec(sql)).toThrow();
    expect(f.store.audit(f.identity).map(row => row.event)).toEqual(["PERMIT_ISSUED", "CONSUMPTION_STARTED", "CONSUMPTION_SUCCEEDED"]);
    expect(f.count("consumed_execution_identities")).toBe(3);
  });

  it("fixed reconciliation API rejects arbitrary log data and mismatched identities", async () => {
    const f = await setup();
    expect(() => f.store.recordReconciliation(f.identity, "shell command" as any)).toThrow();
    expect(() => f.store.recordReconciliation({ ...f.identity, output: "arbitrary" } as any, "EXECUTION_TIMEOUT")).toThrow();
    expect(() => f.store.recordReconciliation({ ...f.identity, attemptHash: hash() }, "EXECUTION_TIMEOUT")).toThrow();
    expect(f.store.permit(f.identity.permitJti)!.state).toBe("VERIFIED_NOT_CONSUMED");
  });

  it("unchanged Pure gate consumes through the real store without invoking any adapter", async () => {
    const f = await setup();
    const evidence = f.store.permit(f.identity.permitJti)!.envelope;
    expect(await f.store.consumeForExecution(evidence, () => f.executionContext)).toMatchObject({ state: "CONSUMED_FOR_EXECUTION", executionMayStart: true });
    expect(await f.store.consumeForExecution(evidence, () => f.executionContext)).toEqual({ state: "REJECTED", executionMayStart: false });
  });

  it("gate post-consumption context failure is durably RECONCILE_REQUIRED", async () => {
    const f = await setup(); let calls = 0;
    const decision = await f.store.consumeForExecution(f.store.permit(f.identity.permitJti)!.envelope,
      () => ++calls === 1 ? f.executionContext : { ...f.executionContext, reviewIsCurrent: false });
    expect(decision).toEqual({ state: "RECONCILE_REQUIRED", executionMayStart: false });
    expect(f.count("consumed_execution_identities")).toBe(3);
    f.store.close(); const restarted = f.connect();
    expect(restarted.store.permit(f.identity.permitJti)!.reconciliationCategory).toBe("GATE_RECHECK_FAILED");
    expect(await restarted.store.consumeOnce(f.keys)).toBe(false);
  });
});
