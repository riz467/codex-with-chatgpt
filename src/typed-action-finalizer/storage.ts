import { DatabaseSync } from "node:sqlite";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJson, idSchema, immutable, jtiSchema, parseStrict, sha256Schema, timestampSchema } from "../typed-action-approval/contract.js";
import { consumptionNamespaces, signedExecutionPermitSchema, type AtomicExecutionConsumptionStore,
  type ConsumptionKey, type ExecutionGateDecision, type SignedExecutionPermit } from "./contract.js";
import { consumeExecutionPermit, verifyExecutionPermit } from "./verifier.js";

export const reconciliationCategories = [
  "STORE_OUTCOME_UNKNOWN", "EXECUTION_TIMEOUT", "OUTPUT_LIMIT", "MUTATION_INDETERMINATE",
  "POST_MUTATION_VERIFICATION_FAILED", "RESTORATION_UNVERIFIED", "GATE_RECHECK_FAILED",
] as const;
export type ReconciliationCategory = typeof reconciliationCategories[number];
const identitySchema = z.object({ permitJti: jtiSchema, attemptHash: sha256Schema }).strict();
export type PermitIdentity = z.infer<typeof identitySchema>;
type Identities = PermitIdentity & { humanJti: string };
const keysSchema = z.array(z.discriminatedUnion("namespace", [
  z.object({ namespace: z.literal(consumptionNamespaces.humanApproval), value: jtiSchema }).strict(),
  z.object({ namespace: z.literal(consumptionNamespaces.executionPermit), value: jtiSchema }).strict(),
  z.object({ namespace: z.literal(consumptionNamespaces.attempt), value: sha256Schema }).strict(),
])).length(3);
type PermitRow = {
  permit_id: string; permit_jti: string; attempt_hash: string; human_jti: string;
  canonical_envelope: string; issued_at: string; expires_at: string;
  state: "VERIFIED_NOT_CONSUMED" | "CONSUMED_FOR_EXECUTION" | "RECONCILE_REQUIRED";
  reconciliation_category: ReconciliationCategory | null;
  reconciled_at: string | null; execution_verified_at: string | null; created_at: string; updated_at: string;
};
type AuditEvent = "PERMIT_ISSUED" | "PERMIT_ISSUANCE_REJECTED_DUPLICATE" | "CONSUMPTION_STARTED"
  | "CONSUMPTION_SUCCEEDED" | "CONSUMPTION_REJECTED_DUPLICATE" | "RECONCILE_REQUIRED" | "EXECUTION_VERIFIED";
export type LedgerAuditRow = {
  id: number; event: AuditEvent; permit_jti: string; attempt_hash: string; human_jti: string;
  category: ReconciliationCategory | null; timestamp: string;
};

/** Never translate a database error into a duplicate/false or execution success.
 * If persistence is unavailable, the host must stop and reconcile with a healthy
 * ledger. This error is NOT a retry permit, even when a rollback was attempted. */
export class LedgerOutcomeUnknownError extends Error {
  readonly category = "STORE_OUTCOME_UNKNOWN";
  constructor(readonly identity: PermitIdentity | null, readonly reconciliationPersisted: boolean) {
    super("SQLite outcome requires reconciliation");
  }
}

/** Single trusted v1 definition, used only for empty DB creation and the isolated
 * in-memory reference manifest. Never applied to an existing ledger. */
function createSchema(db: DatabaseSync): void {
  db.exec(`
        CREATE TABLE finalized_permits (
          permit_id TEXT PRIMARY KEY, permit_jti TEXT NOT NULL UNIQUE,
          action_id TEXT NOT NULL, action_kind TEXT NOT NULL, target_id TEXT NOT NULL,
          request_hash TEXT NOT NULL, attempt_id TEXT NOT NULL, attempt_hash TEXT NOT NULL UNIQUE,
          attempt_sequence INTEGER NOT NULL CHECK(attempt_sequence > 0),
          human_evidence_hash TEXT NOT NULL, human_jti TEXT NOT NULL UNIQUE,
          review_evidence_hash TEXT NOT NULL, policy_hash TEXT NOT NULL, target_generation INTEGER NOT NULL,
          maintenance_window_id TEXT NOT NULL, canonical_envelope TEXT NOT NULL,
          issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('VERIFIED_NOT_CONSUMED','CONSUMED_FOR_EXECUTION','RECONCILE_REQUIRED')),
          reconciliation_category TEXT, reconciled_at TEXT, execution_verified_at TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE consumed_execution_identities (
          namespace TEXT NOT NULL CHECK(namespace IN (
            '${consumptionNamespaces.humanApproval}','${consumptionNamespaces.executionPermit}','${consumptionNamespaces.attempt}')),
          value TEXT NOT NULL, consumed_at TEXT NOT NULL,
          PRIMARY KEY(namespace,value)
        ) STRICT;
        CREATE TABLE finalizer_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event TEXT NOT NULL CHECK(event IN ('PERMIT_ISSUED','PERMIT_ISSUANCE_REJECTED_DUPLICATE',
            'CONSUMPTION_STARTED','CONSUMPTION_SUCCEEDED','CONSUMPTION_REJECTED_DUPLICATE','RECONCILE_REQUIRED','EXECUTION_VERIFIED')),
          permit_jti TEXT NOT NULL, attempt_hash TEXT NOT NULL, human_jti TEXT NOT NULL,
          category TEXT, timestamp TEXT NOT NULL
        ) STRICT;
        CREATE TRIGGER audit_no_update BEFORE UPDATE ON finalizer_audit BEGIN SELECT RAISE(ABORT,'append-only audit'); END;
        CREATE TRIGGER audit_no_delete BEFORE DELETE ON finalizer_audit BEGIN SELECT RAISE(ABORT,'append-only audit'); END;
        CREATE TRIGGER identities_no_update BEFORE UPDATE ON consumed_execution_identities BEGIN SELECT RAISE(ABORT,'permanent consumption'); END;
        CREATE TRIGGER identities_no_delete BEFORE DELETE ON consumed_execution_identities BEGIN SELECT RAISE(ABORT,'permanent consumption'); END;
        CREATE TRIGGER permits_no_delete BEFORE DELETE ON finalized_permits BEGIN SELECT RAISE(ABORT,'permanent issuance'); END;
        CREATE TRIGGER permits_evidence_immutable BEFORE UPDATE OF
          permit_id,permit_jti,action_id,action_kind,target_id,request_hash,attempt_id,attempt_hash,attempt_sequence,
          human_evidence_hash,human_jti,review_evidence_hash,policy_hash,target_generation,maintenance_window_id,
          canonical_envelope,issued_at,expires_at,created_at ON finalized_permits
          BEGIN SELECT RAISE(ABORT,'immutable permit evidence'); END;
        CREATE TRIGGER permits_no_reactivation BEFORE UPDATE OF state ON finalized_permits
          WHEN (OLD.state='RECONCILE_REQUIRED' AND NEW.state!='RECONCILE_REQUIRED')
            OR (OLD.state='CONSUMED_FOR_EXECUTION' AND NEW.state='VERIFIED_NOT_CONSUMED')
          BEGIN SELECT RAISE(ABORT,'terminal consumption'); END;
        PRAGMA application_id=1413563953; PRAGMA user_version=1;
  `);
}

const authorityTables = ["consumed_execution_identities", "finalized_permits", "finalizer_audit"] as const;
function schemaManifest(db: DatabaseSync): string {
  // SQL is compared verbatim as stored by SQLite: no normalization that could
  // erase literal, WHEN, UPDATE OF, or RAISE differences in security triggers.
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_schema
    WHERE substr(name,1,7) != 'sqlite_' ORDER BY type,name`).all();
  const tables = db.prepare("PRAGMA main.table_list").all()
    .filter(row => !String(row.name).startsWith("sqlite_"))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const structure = authorityTables.map(table => ({
    table,
    columns: db.prepare(`PRAGMA main.table_xinfo('${table}')`).all(),
    indexes: db.prepare(`PRAGMA main.index_list('${table}')`).all().map(index => ({
      ...index,
      name: index.name,
      // Names originate in engine metadata; bind them rather than building SQL.
      columns: db.prepare("SELECT * FROM pragma_index_xinfo(?, 'main') ORDER BY seqno").all(index.name),
    })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
  }));
  // node:sqlite rows have null prototypes; convert engine-only metadata to JSON.
  return canonicalJson(JSON.parse(JSON.stringify({ objects, tables, structure })));
}
const trustedSchemaManifest = (() => {
  const reference = new DatabaseSync(":memory:");
  try { createSchema(reference); return schemaManifest(reference); }
  finally { reference.close(); }
})();

export function verifySchema(db: DatabaseSync): void {
  const exact = (sql: string, expected: unknown) => {
    if (canonicalJson(JSON.parse(JSON.stringify(db.prepare(sql).all()))) !== canonicalJson(expected)) throw new Error("Ledger schema integrity check failed");
  };
  exact("PRAGMA main.quick_check", [{ quick_check: "ok" }]);
  exact("PRAGMA main.journal_mode", [{ journal_mode: "wal" }]);
  exact("PRAGMA main.synchronous", [{ synchronous: 2 }]);
  exact("PRAGMA foreign_keys", [{ foreign_keys: 1 }]);
  exact("PRAGMA main.application_id", [{ application_id: 1413563953 }]);
  exact("PRAGMA main.user_version", [{ user_version: 1 }]);
  if (db.prepare("SELECT 1 FROM temp.sqlite_schema LIMIT 1").get()
    || schemaManifest(db) !== trustedSchemaManifest) throw new Error("Ledger schema integrity mismatch");
}

/** Dedicated CT701 ledger. The trusted host injects an already-open file-backed
 * connection and public-key inventory. No request can choose a DB path or SQL.
 * Owns the connection; never share it with other transaction users. */
export class TypedActionFinalizerStore implements AtomicExecutionConsumptionStore {
  #db: DatabaseSync;
  #keys: ReadonlyMap<string, KeyObject>;
  #now: () => number;
  constructor(host: { database: DatabaseSync; trustedFinalizerKeys: ReadonlyMap<string, KeyObject>; now: () => number }) {
    this.#db = host.database; this.#keys = host.trustedFinalizerKeys; this.#now = host.now;
    const databases = this.#db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
    if (databases.length !== 1 || databases[0].name !== "main" || !databases[0].file) throw new Error("Dedicated durable database required");
    this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL");
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#transaction(() => {
      const version = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };
      const application = this.#db.prepare("PRAGMA application_id").get() as { application_id: number };
      if (version.user_version === 0 && application.application_id === 0
        && !this.#db.prepare("SELECT 1 FROM main.sqlite_schema LIMIT 1").get()) createSchema(this.#db);
      // Existing v1 databases are inspected, never repaired. The same checks run
      // for newly created ledgers, under the startup transaction's write fence.
      verifySchema(this.#db);
    });
  }
  close(): void { this.#db.close(); }
  #timestamp(): string {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid ledger clock");
    return parseStrict(timestampSchema, new Date(now).toISOString());
  }
  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.#db.exec("COMMIT"); return result; }
    catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* COMMIT may already have completed; never return success. */ }
      throw error;
    }
  }
  #row(jti: string): PermitRow | undefined {
    return this.#db.prepare("SELECT * FROM finalized_permits WHERE permit_jti=?").get(jti) as PermitRow | undefined;
  }
  #audit(event: AuditEvent, ids: Identities, timestamp: string, category: ReconciliationCategory | null = null): void {
    this.#db.prepare("INSERT INTO finalizer_audit(event,permit_jti,attempt_hash,human_jti,category,timestamp) VALUES(?,?,?,?,?,?)")
      .run(event, ids.permitJti, ids.attemptHash, ids.humanJti, category, timestamp);
  }
  #unknown(ids: PermitIdentity): LedgerOutcomeUnknownError {
    const identity = { permitJti: ids.permitJti, attemptHash: ids.attemptHash };
    let persisted = false;
    try { this.recordReconciliation(identity, "STORE_OUTCOME_UNKNOWN"); persisted = true; } catch { /* Host must reconcile when storage recovers. */ }
    return new LedgerOutcomeUnknownError(identity, persisted);
  }

  /** Persists already signed evidence only after independent verifier success.
   * This method has no private key and cannot issue a signature. All repeated
   * issuance (even byte-identical requests) is rejected permanently by SQL UNIQUE. */
  recordFinalizedPermit(input: unknown, trustedContext: unknown): boolean {
    const envelope = parseStrict(signedExecutionPermitSchema, input);
    if (!verifyExecutionPermit(envelope, trustedContext, this.#keys, this.#now()).valid) throw new Error("Invalid signed permit");
    const p = envelope.payload, ids = { permitJti: p.jti, attemptHash: p.attemptHash, humanJti: p.humanApprovalJti };
    const timestamp = this.#timestamp();
    try {
      return this.#transaction(() => {
        if (!verifyExecutionPermit(envelope, trustedContext, this.#keys, this.#now()).valid) throw new Error("Permit expired or revoked while acquiring SQLite lock");
        // Do not issue a permit for identities already consumed through another route.
        const consumed = this.#db.prepare(`SELECT 1 FROM consumed_execution_identities WHERE
          (namespace=? AND value=?) OR (namespace=? AND value=?) OR (namespace=? AND value=?) LIMIT 1`)
          .get(consumptionNamespaces.humanApproval, ids.humanJti, consumptionNamespaces.executionPermit, ids.permitJti,
            consumptionNamespaces.attempt, ids.attemptHash);
        if (consumed) { this.#audit("PERMIT_ISSUANCE_REJECTED_DUPLICATE", ids, timestamp); return false; }
        const result = this.#db.prepare(`INSERT INTO finalized_permits(
          permit_id,permit_jti,action_id,action_kind,target_id,request_hash,attempt_id,attempt_hash,attempt_sequence,
          human_evidence_hash,human_jti,review_evidence_hash,policy_hash,target_generation,maintenance_window_id,
          canonical_envelope,issued_at,expires_at,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'VERIFIED_NOT_CONSUMED',?,?) ON CONFLICT DO NOTHING`)
          .run(p.permitId, p.jti, p.actionId, p.actionKind, p.targetId, p.requestHash, p.attemptId, p.attemptHash, p.attemptSequence,
            p.humanApprovalEvidenceHash, p.humanApprovalJti, p.independentReviewEvidenceHash, p.policySha256, p.targetGeneration,
            p.maintenanceWindowId, canonicalJson(envelope), p.issuedAt, p.expiresAt, timestamp, timestamp);
        const inserted = result.changes === 1;
        this.#audit(inserted ? "PERMIT_ISSUED" : "PERMIT_ISSUANCE_REJECTED_DUPLICATE", ids, timestamp);
        return inserted;
      });
    } catch { throw this.#unknown(ids); }
  }

  /** Exactly three distinct namespaces; SQL uniqueness, not a process mutex,
   * arbitrates contenders. SAVEPOINT rolls back every fresh key on ANY duplicate
   * while retaining the rejection audit in the enclosing single transaction. */
  async consumeOnce(input: readonly ConsumptionKey[]): Promise<boolean> {
    const keys = parseStrict(keysSchema, input);
    const human = keys.find(key => key.namespace === consumptionNamespaces.humanApproval);
    const permit = keys.find(key => key.namespace === consumptionNamespaces.executionPermit);
    const attempt = keys.find(key => key.namespace === consumptionNamespaces.attempt);
    if (!human || !permit || !attempt) throw new Error("All three consumption namespaces required");
    const ids = { humanJti: human.value, permitJti: permit.value, attemptHash: attempt.value };
    const timestamp = this.#timestamp();
    try {
      return this.#transaction(() => {
        this.#audit("CONSUMPTION_STARTED", ids, timestamp);
        this.#db.exec("SAVEPOINT execution_keys");
        for (const key of keys) {
          const result = this.#db.prepare("INSERT INTO consumed_execution_identities(namespace,value,consumed_at) VALUES(?,?,?) ON CONFLICT(namespace,value) DO NOTHING")
            .run(key.namespace, key.value, timestamp);
          if (result.changes !== 1) {
            this.#db.exec("ROLLBACK TO execution_keys; RELEASE execution_keys");
            this.#audit("CONSUMPTION_REJECTED_DUPLICATE", ids, timestamp);
            return false;
          }
        }
        const row = this.#row(ids.permitJti);
        if (!row || row.attempt_hash !== ids.attemptHash || row.human_jti !== ids.humanJti
          || row.state !== "VERIFIED_NOT_CONSUMED" || Date.parse(row.expires_at) <= this.#now()) {
          throw new Error("Unissued, mismatched, expired or quarantined permit");
        }
        this.#db.prepare("UPDATE finalized_permits SET state='CONSUMED_FOR_EXECUTION',updated_at=? WHERE permit_jti=?")
          .run(timestamp, ids.permitJti);
        this.#db.exec("RELEASE execution_keys");
        this.#audit("CONSUMPTION_SUCCEEDED", ids, timestamp);
        return true;
      });
    } catch { throw this.#unknown(ids); }
  }

  /** Optional persistent wrapper around the unchanged Pure gate. The trusted host
   * still holds the target/policy/review fence. No adapter is invoked here. */
  async consumeForExecution(input: unknown, freshContext: () => unknown): Promise<ExecutionGateDecision> {
    const envelope = parseStrict(signedExecutionPermitSchema, input);
    const decision = await consumeExecutionPermit(input, this.#keys, { store: this, freshContext, now: this.#now });
    if (decision.state === "RECONCILE_REQUIRED") {
      const ids = { permitJti: envelope.payload.jti, attemptHash: envelope.payload.attemptHash };
      try {
        // Preserve an already recorded STORE_OUTCOME_UNKNOWN root cause.
        if (this.#row(ids.permitJti)?.state !== "RECONCILE_REQUIRED") this.recordReconciliation(ids, "GATE_RECHECK_FAILED");
      }
      catch { throw new LedgerOutcomeUnknownError(ids, false); }
    }
    return decision;
  }
  recordReconciliation(identity: PermitIdentity, category: ReconciliationCategory): void {
    this.#recordReconciliation(identity, category, false);
  }
  /** Bridge reports require permanent consumption, unlike internal unknown-outcome quarantine. */
  recordConsumedReconciliation(identity: PermitIdentity, category: ReconciliationCategory): void {
    this.#recordReconciliation(identity, category, true);
  }
  #recordReconciliation(identity: PermitIdentity, category: ReconciliationCategory, requireConsumed: boolean): void {
    const ids = parseStrict(identitySchema, identity), reason = parseStrict(z.enum(reconciliationCategories), category);
    const timestamp = this.#timestamp();
    this.#transaction(() => {
      const row = this.#row(ids.permitJti);
      if (!row || row.attempt_hash !== ids.attemptHash) throw new Error("Unknown reconciliation identity");
      if (requireConsumed && (row.state === "VERIFIED_NOT_CONSUMED" || ![
        [consumptionNamespaces.humanApproval, row.human_jti],
        [consumptionNamespaces.executionPermit, row.permit_jti],
        [consumptionNamespaces.attempt, row.attempt_hash],
      ].every(([namespace, value]) => this.#db.prepare(
        "SELECT 1 FROM consumed_execution_identities WHERE namespace=? AND value=?").get(namespace, value)))) {
        throw new Error("Unconsumed reconciliation identity");
      }
      this.#db.prepare("UPDATE finalized_permits SET state='RECONCILE_REQUIRED',reconciliation_category=?,reconciled_at=?,updated_at=? WHERE permit_jti=?")
        .run(reason, timestamp, timestamp, ids.permitJti);
      this.#audit("RECONCILE_REQUIRED", { ...ids, humanJti: row.human_jti }, timestamp, reason);
    });
  }
  recordVerifiedExecution(identity: PermitIdentity): void {
    const ids = parseStrict(identitySchema, identity), timestamp = this.#timestamp();
    this.#transaction(() => {
      const row = this.#row(ids.permitJti);
      if (!row || row.attempt_hash !== ids.attemptHash || row.state !== "CONSUMED_FOR_EXECUTION" || row.execution_verified_at) {
        throw new Error("Execution is not awaiting verification");
      }
      this.#db.prepare("UPDATE finalized_permits SET execution_verified_at=?,updated_at=? WHERE permit_jti=?").run(timestamp, timestamp, ids.permitJti);
      this.#audit("EXECUTION_VERIFIED", { ...ids, humanJti: row.human_jti }, timestamp);
    });
  }
  permit(jti: string) {
    const row = this.#row(parseStrict(jtiSchema, jti));
    if (!row) return null;
    const envelope = parseStrict(signedExecutionPermitSchema, JSON.parse(row.canonical_envelope)) as SignedExecutionPermit;
    if (canonicalJson(envelope) !== row.canonical_envelope || envelope.payload.jti !== row.permit_jti
      || envelope.payload.attemptHash !== row.attempt_hash) throw new Error("Stored evidence integrity mismatch");
    return immutable({ envelope, canonicalEnvelope: row.canonical_envelope, state: row.state,
      reconciliationCategory: row.reconciliation_category, reconciledAt: row.reconciled_at,
      executionVerifiedAt: row.execution_verified_at, createdAt: row.created_at, updatedAt: row.updated_at });
  }
  permitById(id: string) {
    const row = this.#db.prepare("SELECT permit_jti FROM finalized_permits WHERE permit_id=?")
      .get(parseStrict(idSchema, id)) as { permit_jti: string } | undefined;
    return row ? this.permit(row.permit_jti) : null;
  }
  audit(identity: PermitIdentity): readonly LedgerAuditRow[] {
    const ids = parseStrict(identitySchema, identity);
    return this.#db.prepare("SELECT * FROM finalizer_audit WHERE permit_jti=? AND attempt_hash=? ORDER BY id")
      .all(ids.permitJti, ids.attemptHash) as LedgerAuditRow[];
  }
}
