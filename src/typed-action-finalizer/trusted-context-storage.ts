import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { actionBindingShape, canonicalJson, hashTypedActionApproval, idSchema, immutable, parseStrict,
  sha256Schema, signedTypedActionApprovalSchema, timestampSchema } from "../typed-action-approval/contract.js";

/** Reserved for a future reviewed host bootstrap. This module never opens paths.
 * The host injects a dedicated file-backed connection; no HTTP/config selectors. */
export const trustedAuthorityDatabasePath = "/var/lib/ct701-typed-action-finalizer-authority/authority.sqlite";
export const requestAuthoritySchema = z.object({ ...actionBindingShape, attemptCreatedAt: timestampSchema }).strict();
export const reviewAuthoritySchema = z.object({
  ...actionBindingShape, result: z.enum(["PASS", "FAIL", "NEEDS_WORK"]), evidenceIntegrityValid: z.boolean(),
  issuedAt: timestampSchema, expiresAt: timestampSchema,
}).strict();
export const policyAuthoritySchema = z.object({
  targetId: idSchema, actionKind: actionBindingShape.actionKind, policySha256: sha256Schema,
  targetGeneration: actionBindingShape.targetGeneration, actionAllowed: z.boolean(), maintenanceWindowId: idSchema,
  maintenanceWindowStartsAt: timestampSchema, maintenanceWindowExpiresAt: timestampSchema,
}).strict();
const targetSchema = z.object({ targetId: idSchema, generation: actionBindingShape.targetGeneration }).strict();
const stateSchema = z.enum(["current", "stale", "superseded"]);
const record = <S extends z.ZodTypeAny>(body: S) => z.object({ state: stateSchema, body }).strict();
const fixtureSchema = z.object({
  targets: z.array(targetSchema), requests: z.array(record(requestAuthoritySchema)),
  reviews: z.array(record(reviewAuthoritySchema)), policies: z.array(record(policyAuthoritySchema)),
  approvals: z.array(record(signedTypedActionApprovalSchema)),
}).strict();
export type AuthorityFixture = z.infer<typeof fixtureSchema>;
type AuthorityTable = "requests" | "reviews" | "policies" | "approvals";
const tables: readonly AuthorityTable[] = ["requests", "reviews", "policies", "approvals"];
const columns = { requests: "attempt_hash", reviews: "attempt_hash", policies: "policy_hash", approvals: "evidence_hash" } as const;

function createSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE authority_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
    INSERT INTO authority_revision VALUES(1,0);
    CREATE TABLE targets (target_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>=0)) STRICT;
    CREATE TRIGGER revision_no_delete BEFORE DELETE ON authority_revision BEGIN SELECT RAISE(ABORT,'permanent revision'); END;
    CREATE TRIGGER revision_monotonic BEFORE UPDATE ON authority_revision
      WHEN NEW.id!=OLD.id OR NEW.revision!=OLD.revision+1 BEGIN SELECT RAISE(ABORT,'monotonic revision'); END;
    CREATE TRIGGER targets_no_delete BEFORE DELETE ON targets BEGIN SELECT RAISE(ABORT,'permanent target'); END;
    CREATE TRIGGER targets_monotonic BEFORE UPDATE ON targets
      WHEN NEW.target_id!=OLD.target_id OR NEW.generation<=OLD.generation BEGIN SELECT RAISE(ABORT,'monotonic generation'); END;
    CREATE TRIGGER targets_insert_revision AFTER INSERT ON targets BEGIN UPDATE authority_revision SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER targets_update_revision AFTER UPDATE ON targets BEGIN UPDATE authority_revision SET revision=revision+1 WHERE id=1; END;
    PRAGMA application_id=1413563954; PRAGMA user_version=1;
  `);
  for (const table of tables) {
    const key = columns[table];
    db.exec(`
      CREATE TABLE ${table} (${key} TEXT PRIMARY KEY, body TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('current','stale','superseded'))) STRICT;
      CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'permanent authority'); END;
      CREATE TRIGGER ${table}_immutable BEFORE UPDATE OF ${key},body ON ${table} BEGIN SELECT RAISE(ABORT,'immutable authority'); END;
      CREATE TRIGGER ${table}_no_reactivation BEFORE UPDATE OF state ON ${table}
        WHEN OLD.state!='current' AND NEW.state!=OLD.state BEGIN SELECT RAISE(ABORT,'terminal revocation'); END;
      CREATE TRIGGER ${table}_insert_revision AFTER INSERT ON ${table} BEGIN UPDATE authority_revision SET revision=revision+1 WHERE id=1; END;
      CREATE TRIGGER ${table}_update_revision AFTER UPDATE ON ${table} BEGIN UPDATE authority_revision SET revision=revision+1 WHERE id=1; END;
    `);
  }
}
function manifest(db: DatabaseSync) {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE substr(name,1,7)!='sqlite_' ORDER BY type,name").all());
}
const reference = (() => {
  const db = new DatabaseSync(":memory:");
  try { createSchema(db); return manifest(db); } finally { db.close(); }
})();
function verify(db: DatabaseSync) {
  const scalar = (pragma: string, expected: unknown) => {
    if (Object.values(db.prepare(pragma).get() ?? {})[0] !== expected) throw new Error("Authority schema integrity mismatch");
  };
  scalar("PRAGMA main.application_id", 1413563954); scalar("PRAGMA main.user_version", 1);
  scalar("PRAGMA main.quick_check", "ok"); scalar("PRAGMA main.journal_mode", "wal");
  scalar("PRAGMA main.synchronous", 2); scalar("PRAGMA foreign_keys", 1);
  if (manifest(db) !== reference || db.prepare("SELECT 1 FROM temp.sqlite_schema LIMIT 1").get()) throw new Error("Authority schema integrity mismatch");
}
type Fence = { revision: number; poisoned: boolean; open: boolean };

/** Separate authority DB: a global SQLite RESERVED writer lock is deliberately
 * coarser than target/request locking. Every host writer must use this store.
 * Hold it through the live handoff; never take the ledger lock before this lock.
 * SQLITE_BUSY rejects rather than synchronously waiting on an async owner. */
export class TrustedContextStore {
  #db: DatabaseSync;
  #active: Fence | undefined;
  #scope = new AsyncLocalStorage<Fence>();
  #closed = false;
  #failed = false;
  constructor(host: { database: DatabaseSync }) {
    this.#db = host.database;
    const dbs = this.#db.prepare("PRAGMA database_list").all();
    if (dbs.length !== 1 || dbs[0].name !== "main" || !dbs[0].file) throw new Error("Dedicated durable authority database required");
    this.#db.exec("PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL");
    const empty = !this.#db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      && this.#db.prepare("PRAGMA user_version").get()!.user_version === 0
      && this.#db.prepare("PRAGMA application_id").get()!.application_id === 0;
    // Never change an existing database's journal mode to 'repair' it.
    if (empty) this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("BEGIN IMMEDIATE");
    try { if (empty) createSchema(this.#db); verify(this.#db); this.#db.exec("COMMIT"); }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #ready() { if (this.#closed || this.#failed) throw new Error("Authority store unavailable"); }
  #revision(): number {
    const revision = this.#db.prepare("SELECT revision FROM authority_revision WHERE id=1").get()?.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid authority revision");
    return revision;
  }
  assertFence() {
    this.#ready();
    const fence = this.#scope.getStore();
    if (!fence || fence !== this.#active || !fence.open || fence.poisoned || this.#revision() !== fence.revision) throw new Error("Authority fence invalid");
  }
  async withFence<T>(operation: () => Promise<T>): Promise<T> {
    this.#ready();
    if (this.#active) throw new Error("Authority fence busy");
    this.#db.exec("BEGIN IMMEDIATE");
    let fence: Fence | undefined;
    try {
      verify(this.#db);
      fence = { revision: this.#revision(), poisoned: false, open: true }; this.#active = fence;
      return await this.#scope.run(fence, async () => {
        const result = await operation();
        this.assertFence(); verify(this.#db);
        try { this.#db.exec("COMMIT"); } catch (error) { this.#failed = true; throw error; }
        return result;
      });
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { this.#failed = true; }
      throw error;
    } finally { if (fence) fence.open = false; this.#active = undefined; }
  }
  #write(operation: () => void) {
    this.#ready();
    if (this.#active) { this.#active.poisoned = true; throw new Error("Authority update during fence rejected"); }
    this.#db.exec("BEGIN IMMEDIATE");
    try { verify(this.#db); operation(); this.#db.exec("COMMIT"); }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch { this.#failed = true; } throw error; }
  }
  /** Fixture/bootstrap seam only: insert-only, explicit independent record sets.
   * No production ingestion route or generic 'trust caller booleans' API exists. */
  bootstrapFixture(input: AuthorityFixture) {
    const value = parseStrict(fixtureSchema, input);
    this.#write(() => {
      for (const target of value.targets) this.#db.prepare("INSERT INTO targets VALUES(?,?)").run(target.targetId, target.generation);
      const insert = (table: AuthorityTable, key: string, body: unknown, state: string) =>
        this.#db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(key, canonicalJson(body), state);
      for (const r of value.requests) insert("requests", r.body.attemptHash, r.body, r.state);
      for (const r of value.reviews) insert("reviews", r.body.attemptHash, r.body, r.state);
      for (const r of value.policies) insert("policies", r.body.policySha256, r.body, r.state);
      for (const r of value.approvals) insert("approvals", hashTypedActionApproval(r.body), r.body, r.state);
    });
  }
  #read<S extends z.ZodTypeAny>(table: AuthorityTable, key: string, schema: S): z.infer<S> {
    this.assertFence();
    const row = this.#db.prepare(`SELECT body,state FROM ${table} WHERE ${columns[table]}=?`).get(key);
    if (!row || row.state !== "current" || typeof row.body !== "string") throw new Error("Missing or revoked authority");
    const body = parseStrict(schema, JSON.parse(row.body));
    if (canonicalJson(body) !== row.body) throw new Error("Authority encoding mismatch");
    return immutable(body);
  }
  snapshot(attemptHash: string, approvalEvidenceHash: string) {
    const request = this.#read("requests", parseStrict(sha256Schema, attemptHash), requestAuthoritySchema);
    const review = this.#read("reviews", attemptHash, reviewAuthoritySchema);
    const policy = this.#read("policies", request.policySha256, policyAuthoritySchema);
    const approval = this.#read("approvals", parseStrict(sha256Schema, approvalEvidenceHash), signedTypedActionApprovalSchema);
    const target = this.#db.prepare("SELECT generation FROM targets WHERE target_id=?").get(request.targetId);
    if (!target || typeof target.generation !== "number") throw new Error("Missing target authority");
    return immutable({ request, review, policy, approval, generation: target.generation });
  }
  #revoke(table: AuthorityTable, key: string, state: "stale" | "superseded") {
    parseStrict(sha256Schema, key);
    this.#write(() => {
      const row = this.#db.prepare(`SELECT state FROM ${table} WHERE ${columns[table]}=?`).get(key);
      if (!row) throw new Error("Unknown authority");
      if (row.state === "current") this.#db.prepare(`UPDATE ${table} SET state=? WHERE ${columns[table]}=?`).run(state, key);
    });
  }
  staleRequest(attemptHash: string) { this.#revoke("requests", attemptHash, "stale"); }
  supersedeRequest(attemptHash: string) { this.#revoke("requests", attemptHash, "superseded"); }
  revokeReview(attemptHash: string) { this.#revoke("reviews", attemptHash, "stale"); }
  supersedeReview(attemptHash: string) { this.#revoke("reviews", attemptHash, "superseded"); }
  revokePolicy(policyHash: string) { this.#revoke("policies", policyHash, "stale"); }
  revokeHumanApproval(evidenceHash: string) { this.#revoke("approvals", evidenceHash, "stale"); }
  advanceGeneration(targetId: string, generation: number) {
    const target = parseStrict(targetSchema, { targetId, generation });
    this.#write(() => {
      const result = this.#db.prepare("UPDATE targets SET generation=? WHERE target_id=?").run(target.generation, target.targetId);
      if (result.changes !== 1) throw new Error("Unknown target");
    });
  }
  close() {
    if (this.#active) { this.#active.poisoned = true; throw new Error("Cannot close active fence"); }
    if (!this.#closed) { this.#db.close(); this.#closed = true; }
  }
}
