import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immutable } from '../typed-action-approval/contract.js';
import { claimLiveHandoff, hashHandoff, type Handoff, type CustodyReceipt } from './contract.js';

function install(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE attempts (attempt_hash TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE,
      handoff_id TEXT NOT NULL UNIQUE, target_id TEXT NOT NULL, token INTEGER NOT NULL UNIQUE,
      body TEXT NOT NULL, receipt TEXT NOT NULL) STRICT;
    CREATE TABLE targets (target_id TEXT PRIMARY KEY, high_watermark INTEGER NOT NULL CHECK(high_watermark>0),
      active_handoff TEXT UNIQUE REFERENCES attempts(handoff_id)) STRICT;
    CREATE TABLE outcomes (handoff_id TEXT PRIMARY KEY REFERENCES attempts(handoff_id),
      outcome TEXT NOT NULL CHECK(outcome IN ('VERIFIED','RECONCILE_REQUIRED'))) STRICT;
    CREATE TABLE reconciliations (handoff_id TEXT PRIMARY KEY REFERENCES attempts(handoff_id), evidence_hash TEXT NOT NULL) STRICT;
    CREATE TRIGGER targets_no_delete BEFORE DELETE ON targets BEGIN SELECT RAISE(ABORT,'permanent fence'); END;
    CREATE TRIGGER targets_monotonic BEFORE UPDATE ON targets WHEN NEW.target_id!=OLD.target_id OR
      NEW.high_watermark<OLD.high_watermark OR (NEW.active_handoff IS NOT NULL AND
      (OLD.active_handoff IS NOT NULL OR NEW.high_watermark<=OLD.high_watermark))
      BEGIN SELECT RAISE(ABORT,'exclusive monotonic fence'); END;
    CREATE TRIGGER targets_release_guard BEFORE UPDATE ON targets WHEN OLD.active_handoff IS NOT NULL AND NEW.active_handoff IS NULL AND
      NOT EXISTS(SELECT 1 FROM outcomes WHERE handoff_id=OLD.active_handoff AND outcome='VERIFIED') AND
      NOT EXISTS(SELECT 1 FROM reconciliations WHERE handoff_id=OLD.active_handoff)
      BEGIN SELECT RAISE(ABORT,'terminal observation required'); END;
    PRAGMA application_id=1413563955; PRAGMA user_version=1;
  `);
  for (const table of ['attempts', 'outcomes', 'reconciliations']) for (const op of ['UPDATE', 'DELETE'])
    db.exec(`CREATE TRIGGER ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'permanent custody'); END;`);
}
const manifest = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());
const reference = new DatabaseSync(':memory:'); install(reference); const expected = manifest(reference); reference.close();
export interface ProtectedExecutor {
  /** Synchronous host-owned generation, serialized with this target fence. */
  generation(targetId: string): number;
  execute(handoff: Readonly<Handoff>): Promise<'VERIFIED' | 'RECONCILE_REQUIRED'>;
  /** Read-only actual-state investigation, never repeat the mutation. */
  reconcile?(handoff: Readonly<Handoff>): Promise<{ terminal: true; evidenceHash: string }>;
}
/** Dedicated protected-host DB. No adapter or authentication is installed by default. */
export class ProtectedExecutionBridge {
  #db: DatabaseSync;
  #failed = false;
  #executing = new Set<string>();
  constructor(private host: { database: DatabaseSync; executor?: ProtectedExecutor; now?: () => number; afterCommit?: () => void }) {
    this.#db = host.database;
    const dbs = this.#db.prepare('PRAGMA database_list').all();
    if (dbs.length !== 1 || !dbs[0].file) throw Error('DEDICATED_DURABLE_BRIDGE_DATABASE_REQUIRED');
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
    const empty = !this.#db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get() &&
      this.#db.prepare('PRAGMA user_version').get()!.user_version === 0 && this.#db.prepare('PRAGMA application_id').get()!.application_id === 0;
    if (empty) { this.#db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE'); try { install(this.#db); this.#db.exec('COMMIT'); } catch (e) { this.#db.exec('ROLLBACK'); throw e; } }
    this.#verify();
  }
  #verify() {
    if (this.#failed) throw Error('RECONCILE_REQUIRED');
    const p = (name: string) => Object.values(this.#db.prepare(`PRAGMA ${name}`).get()!)[0];
    if (p('user_version') !== 1 || p('application_id') !== 1413563955 || p('journal_mode') !== 'wal' || p('synchronous') !== 2 ||
      p('foreign_keys') !== 1 || p('integrity_check') !== 'ok' || this.#db.prepare('PRAGMA foreign_key_check').all().length ||
      this.#db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get() || manifest(this.#db) !== expected) throw Error('BRIDGE_SCHEMA_MISMATCH');
  }
  #write<T>(fn: () => T): T {
    this.#verify(); this.#db.exec('BEGIN IMMEDIATE'); let committing = false;
    try { const result = fn(); committing = true; this.#db.exec('COMMIT'); this.host.afterCommit?.(); return result; }
    catch (e) { if (committing) this.#failed = true; else { try { this.#db.exec('ROLLBACK'); } catch { this.#failed = true; } } throw this.#failed ? Error('RECONCILE_REQUIRED') : e; }
  }
  async handoff(live: Readonly<Handoff>): Promise<CustodyReceipt> {
    const h = claimLiveHandoff(live), executor = this.host.executor;
    if (!executor) throw Error('EXECUTOR_DENIED');
    const receipt = this.#write(() => {
      const now = (this.host.now ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < Date.parse(h.issuedAt) || now >= Date.parse(h.expiresAt)) throw Error('HANDOFF_EXPIRED');
      if (this.#db.prepare('SELECT 1 FROM attempts WHERE attempt_hash=? OR attempt_id=? OR handoff_id=?').get(h.attemptHash, h.attemptId, h.handoffId)) throw Error('PERMANENT_DUPLICATE');
      const target = this.#db.prepare('SELECT * FROM targets WHERE target_id=?').get(h.targetId);
      if (target?.active_handoff || (target && Number(target.high_watermark) >= h.fencingToken)) throw Error('TARGET_FENCED');
      if (executor.generation(h.targetId) !== h.targetGeneration) throw Error('TARGET_GENERATION_MISMATCH');
      const r: CustodyReceipt = { handoffId: h.handoffId, handoffHash: hashHandoff(h), attemptHash: h.attemptHash,
        targetId: h.targetId, fencingToken: h.fencingToken, state: 'CUSTODY_DURABLE' };
      this.#db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?)').run(h.attemptHash, h.attemptId, h.handoffId, h.targetId, h.fencingToken, canonicalJson(h), canonicalJson(r));
      this.#db.prepare('INSERT INTO targets VALUES(?,?,?) ON CONFLICT(target_id) DO UPDATE SET high_watermark=excluded.high_watermark,active_handoff=excluded.active_handoff')
        .run(h.targetId, h.fencingToken, h.handoffId);
      return immutable(r);
    });
    this.#executing.add(h.handoffId);
    // Settlement belongs to Bridge custody, not the CT701/CT702 currentness gate.
    // This live invocation is never reconstructed from persisted attempts.
    void this.#settle(h, executor);
    return receipt;
  }
  async #settle(h: Readonly<Handoff>, executor: ProtectedExecutor): Promise<void> {
    try {
      // Custody is durable before any executor invocation. A restart never invokes it.
      let outcome: 'VERIFIED' | 'RECONCILE_REQUIRED' = 'RECONCILE_REQUIRED';
      try { if (await executor.execute(immutable(h)) === 'VERIFIED') outcome = 'VERIFIED'; } catch { /* Unknown mutation remains fenced. */ }
      this.#write(() => {
        this.#db.prepare('INSERT INTO outcomes VALUES(?,?)').run(h.handoffId, outcome);
        if (outcome === 'VERIFIED') this.#db.prepare('UPDATE targets SET active_handoff=NULL WHERE target_id=? AND active_handoff=?').run(h.targetId, h.handoffId);
      });
    } catch {
      // Custody has already been acknowledged. Quarantine settlement write failures
      // locally; never reject an unobserved task or retry the accepted mutation.
      this.#failed = true;
    } finally { this.#executing.delete(h.handoffId); }
  }
  receipt(handoffId: string, handoffHash: string) {
    this.#verify();
    const row = this.#db.prepare('SELECT body,receipt FROM attempts WHERE handoff_id=?').get(handoffId);
    if (!row || hashHandoff(JSON.parse(row.body as string)) !== handoffHash) throw Error('UNKNOWN_HANDOFF');
    const outcome = this.#db.prepare('SELECT outcome FROM outcomes WHERE handoff_id=?').get(handoffId)?.outcome ?? 'RECONCILE_REQUIRED';
    return immutable({ custody: JSON.parse(row.receipt as string) as CustodyReceipt, outcome });
  }
  async reconcileTarget(handoffId: string, handoffHash: string) {
    this.receipt(handoffId, handoffHash);
    if (this.#executing.has(handoffId) || !this.host.executor?.reconcile) throw Error('RECONCILE_REQUIRED');
    const row = this.#db.prepare('SELECT body FROM attempts WHERE handoff_id=?').get(handoffId)!;
    const h: Handoff = JSON.parse(row.body as string);
    const result = await this.host.executor.reconcile(immutable(h));
    if (result.terminal !== true || !/^[a-f0-9]{64}$/.test(result.evidenceHash)) throw Error('RECONCILE_REQUIRED');
    this.#write(() => {
      const old = this.#db.prepare('SELECT evidence_hash FROM reconciliations WHERE handoff_id=?').get(handoffId);
      if (old && old.evidence_hash !== result.evidenceHash) throw Error('RECONCILIATION_CONFLICT');
      if (!old) this.#db.prepare('INSERT INTO reconciliations VALUES(?,?)').run(handoffId, result.evidenceHash);
      this.#db.prepare('UPDATE targets SET active_handoff=NULL WHERE target_id=? AND active_handoff=?').run(h.targetId, handoffId);
    });
  }
  close() { if (this.#executing.size) throw Error('ACTIVE_EXECUTION'); this.#db.close(); }
}
