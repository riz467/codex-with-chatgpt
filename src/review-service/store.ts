import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../typed-action-approval/contract.js';
import { parseStrict } from '../typed-action-approval/contract.js';
import { hashReviewedEvidence, independentlyVerifiedReviewSchema, reviewBindingFields } from '../typed-action-review/contract.js';
import { freezeCandidate, hash, type Material } from './material.js';
import { reservationSchema, resolutionSchema, type ReviewReservation } from './coordination.js';

const tables = ['blobs', 'materials', 'reviews', 'events', 'results', 'signatures', 'reservations', 'resolutions'];
function install(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE blobs (digest TEXT PRIMARY KEY, bytes BLOB NOT NULL) STRICT;
    CREATE TABLE materials (root TEXT PRIMARY KEY, manifest TEXT NOT NULL, manifest_hash TEXT NOT NULL) STRICT;
    CREATE TABLE reviews (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, action_id TEXT NOT NULL, attempt_sequence INTEGER NOT NULL,
      binding TEXT NOT NULL, root TEXT NOT NULL REFERENCES materials(root), UNIQUE(action_id,attempt_sequence)) STRICT;
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL REFERENCES reviews(id),
      state TEXT NOT NULL CHECK(state IN ('REVIEW_PENDING','MATERIAL_FIXED','REVIEW_RUNNING','RESULT_DURABLE','SIGNED_PENDING_PUBLICATION','PUBLICATION_ACKNOWLEDGED','INVALIDATION_PENDING','SUPERSESSION_PENDING','INVALIDATED','SUPERSEDED')),
      detail TEXT NOT NULL, operation_id TEXT UNIQUE, UNIQUE(review_id,state)) STRICT;
    CREATE TABLE results (review_id TEXT PRIMARY KEY REFERENCES reviews(id), evidence_hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL) STRICT;
    CREATE TABLE signatures (review_id TEXT PRIMARY KEY REFERENCES results(review_id), jti TEXT NOT NULL UNIQUE, body TEXT NOT NULL) STRICT;
    CREATE TABLE reservations (id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id), body TEXT NOT NULL) STRICT;
    CREATE TABLE resolutions (id TEXT PRIMARY KEY REFERENCES reservations(id), body TEXT NOT NULL) STRICT;
    PRAGMA user_version=7023;
  `);
  for (const table of tables) for (const operation of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;`);
  db.exec(`CREATE TRIGGER event_transition BEFORE INSERT ON events WHEN NOT COALESCE((
    (NEW.state='REVIEW_PENDING' AND NOT EXISTS(SELECT 1 FROM events WHERE review_id=NEW.review_id)) OR
    (NEW.state='MATERIAL_FIXED' AND (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1)='REVIEW_PENDING') OR
    (NEW.state='REVIEW_RUNNING' AND (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1)='MATERIAL_FIXED') OR
    (NEW.state='RESULT_DURABLE' AND (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1)='REVIEW_RUNNING' AND EXISTS(SELECT 1 FROM results WHERE review_id=NEW.review_id)) OR
    (NEW.state='SIGNED_PENDING_PUBLICATION' AND (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1)='RESULT_DURABLE' AND EXISTS(SELECT 1 FROM signatures WHERE review_id=NEW.review_id)) OR
    (NEW.state='PUBLICATION_ACKNOWLEDGED' AND (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1)='SIGNED_PENDING_PUBLICATION') OR
    (NEW.state IN ('INVALIDATION_PENDING','SUPERSESSION_PENDING') AND (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1)='PUBLICATION_ACKNOWLEDGED') OR
    (NEW.state IN ('INVALIDATED','SUPERSEDED') AND (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1)
      IN ('REVIEW_PENDING','MATERIAL_FIXED','REVIEW_RUNNING','RESULT_DURABLE','SIGNED_PENDING_PUBLICATION')) OR
    (NEW.state IN ('INVALIDATED','SUPERSEDED') AND
      (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1)=CASE NEW.state WHEN 'INVALIDATED' THEN 'INVALIDATION_PENDING' ELSE 'SUPERSESSION_PENDING' END AND
      NEW.operation_id IS NOT NULL AND json_valid(NEW.detail) AND
      json_extract(NEW.detail,'$.acknowledgementId')=NEW.operation_id AND
      json_extract(NEW.detail,'$.expectedSequence')=(SELECT seq FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1) AND
      json_extract(NEW.detail,'$.intent')=(SELECT detail FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1))
  ),0) BEGIN SELECT RAISE(ABORT,'INVALID_TRANSITION'); END;
  CREATE TRIGGER result_phase BEFORE INSERT ON results WHEN
    (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1) != 'REVIEW_RUNNING'
    BEGIN SELECT RAISE(ABORT,'INVALID_RESULT_PHASE'); END;
  CREATE TRIGGER signature_phase BEFORE INSERT ON signatures WHEN
    (SELECT state FROM events WHERE review_id=NEW.review_id ORDER BY seq DESC LIMIT 1) != 'RESULT_DURABLE'
    BEGIN SELECT RAISE(ABORT,'RESULT_NOT_DURABLE'); END;`);
  db.exec(`CREATE TRIGGER reservation_event_fence BEFORE INSERT ON events WHEN EXISTS
    (SELECT 1 FROM reservations r WHERE NOT EXISTS(SELECT 1 FROM resolutions s WHERE s.id=r.id))
    BEGIN SELECT RAISE(ABORT,'BARRIER_HELD'); END;`);
  db.exec(`CREATE TRIGGER reservation_exclusive BEFORE INSERT ON reservations WHEN EXISTS
    (SELECT 1 FROM reservations r WHERE NOT EXISTS(SELECT 1 FROM resolutions s WHERE s.id=r.id))
    BEGIN SELECT RAISE(ABORT,'BARRIER_HELD'); END;`);
}
const schemaIdentity = (db: DatabaseSync) => canonicalJson(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(r => ({ ...r })));
const reference = new DatabaseSync(':memory:'); install(reference);
const expectedSchema = schemaIdentity(reference); reference.close();
export type ReviewRow = { id: string; attempt_id: string; action_id: string; attempt_sequence: number; binding: string; root: string };
export class ReviewStore {
  private db: DatabaseSync;
  private uncertain = false;
  constructor(file: string, options: { initialize?: boolean; afterCommit?: () => void } = {}) {
    if (options.initialize) {
      const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd);
    } else if (!fs.existsSync(file)) throw Error('DATABASE_MISSING');
    this.db = new DatabaseSync(file); this.afterCommit = options.afterCommit;
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0;');
      if (options.initialize) { this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'); install(this.db); }
      this.db.exec('PRAGMA synchronous=FULL;');
      const pragma = (name: string) => Object.values(this.db.prepare(`PRAGMA ${name}`).get()!)[0];
      if (pragma('user_version') !== 7023 || pragma('journal_mode') !== 'wal' || pragma('synchronous') !== 2 || pragma('foreign_keys') !== 1 || pragma('trusted_schema') !== 0 || pragma('busy_timeout') !== 0 ||
          schemaIdentity(this.db) !== expectedSchema || pragma('integrity_check') !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').all().length) throw Error('DATABASE_SCHEMA_OR_INTEGRITY');
      for (const row of this.db.prepare('SELECT * FROM reviews').all()) {
        this.material(row as ReviewRow); this.result(row.id as string);
        if (!this.state(row.id as string)) throw Error('MISSING_CHRONOLOGY');
      }
    } catch (e) { this.db.close(); throw e; }
  }
  private afterCommit?: () => void;
  reservation(input: unknown) {
    const r = parseStrict(reservationSchema, input);
    return this.mutate(() => {
      const old = this.db.prepare('SELECT body FROM reservations WHERE id=?').get(r.barrierId);
      if (old) {
        if (old.body !== canonicalJson(r)) throw Error('BARRIER_IDENTITY_MISMATCH');
        return this.reservationReceipt(r);
      }
      if (this.db.prepare('SELECT 1 FROM reservations r WHERE NOT EXISTS(SELECT 1 FROM resolutions s WHERE s.id=r.id)').get()) throw Error('BARRIER_HELD');
      const row = this.row(r.reviewId), history = this.history(r.reviewId), last = history.at(-1);
      if (!row || row.root !== r.materialRoot || this.result(r.reviewId)?.snapshot.context.expectedReviewEvidenceHash !== r.evidenceHash ||
        history.find(e => e.state === 'SIGNED_PENDING_PUBLICATION')?.seq !== r.publicationSequence ||
        last?.seq !== r.expectedSequence || last.state !== (r.kind === 'READINESS' ? 'PUBLICATION_ACKNOWLEDGED' : 'SIGNED_PENDING_PUBLICATION')) throw Error('READINESS_REJECTED');
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(r.barrierId, r.reviewId, canonicalJson(r));
      return this.reservationReceipt(r);
    });
  }
  private reservationReceipt(r: ReviewReservation) {
    return { ...r, state: this.db.prepare('SELECT 1 FROM resolutions WHERE id=?').get(r.barrierId) ? 'RESOLVED' as const : 'HELD' as const, pendingInvalidation: null };
  }
  resolveBarrier(input: unknown) {
    const value = parseStrict(resolutionSchema, input), r = value.reservation;
    if (r.kind !== 'READINESS' || (value.disposition === 'CUSTODY') !== (value.handoffHash !== null)) throw Error('INVALID_RESOLUTION');
    return this.mutate(() => {
      const old = this.db.prepare('SELECT body FROM reservations WHERE id=?').get(r.barrierId);
      if (old?.body !== canonicalJson(r)) throw Error('BARRIER_IDENTITY_MISMATCH');
      const resolved = this.db.prepare('SELECT body FROM resolutions WHERE id=?').get(r.barrierId);
      if (resolved && resolved.body !== canonicalJson(value)) throw Error('RESOLUTION_CONFLICT');
      if (!resolved) this.db.prepare('INSERT INTO resolutions VALUES(?,?)').run(r.barrierId, canonicalJson(value));
      return { ...value, state: 'RESOLVED' as const };
    });
  }
  /** Called inside the publication ACK transaction; release and event are atomic. */
  resolvePublication(reviewId: string, expectedSequence: number, acknowledgementId: string) {
    const row = this.db.prepare('SELECT body FROM reservations WHERE id=?').get(acknowledgementId);
    if (!row) return; // Historical isolated IR-03 callers have no production activation capability.
    const r = parseStrict(reservationSchema, JSON.parse(row.body as string));
    if (r.kind !== 'PUBLICATION' || r.reviewId !== reviewId || r.expectedSequence !== expectedSequence) throw Error('PUBLICATION_IDENTITY_MISMATCH');
    this.db.prepare('INSERT INTO resolutions VALUES(?,?)').run(r.barrierId, canonicalJson({ reviewId, expectedSequence, acknowledgementId }));
  }
  available() { if (this.uncertain) throw Error('RECONCILE_REQUIRED'); }
  mutate<T>(fn: () => T): T {
    this.available(); this.db.exec('BEGIN IMMEDIATE');
    let committing = false;
    try { const result = fn(); committing = true; this.db.exec('COMMIT'); this.afterCommit?.(); return result; }
    catch (e) {
      if (committing) this.uncertain = true;
      else { try { this.db.exec('ROLLBACK'); } catch { this.uncertain = true; } }
      throw this.uncertain ? Error('RECONCILE_REQUIRED') : e;
    }
  }
  row(id: string) { this.available(); return this.db.prepare('SELECT * FROM reviews WHERE id=?').get(id) as ReviewRow | undefined; }
  reviewIds() { this.available(); return this.db.prepare('SELECT id FROM reviews ORDER BY id').all().map(r => r.id as string); }
  history(id: string) { this.available(); return this.db.prepare('SELECT seq,state,detail FROM events WHERE review_id=? ORDER BY seq').all(id).map(r => ({ ...r })); }
  state(id: string) { const events = this.history(id); return events.at(-1)?.state as string | undefined; }
  event(id: string, state: string, detail = '', operationId: string | null = null) {
    this.db.prepare('INSERT INTO events(review_id,state,detail,operation_id) VALUES(?,?,?,?)').run(id, state, detail, operationId);
  }
  accept(m: Material) {
    return this.mutate(() => {
      const previous = this.row(m.binding.reviewId);
      if (previous) {
        if (previous.binding !== canonicalJson(m.binding) || previous.root !== m.root) throw Error('CONFLICTING_REPLACEMENT');
        this.material(previous); return false;
      }
      const older = this.db.prepare('SELECT * FROM reviews WHERE action_id=? ORDER BY attempt_sequence DESC').all(m.binding.actionId) as ReviewRow[];
      if (m.predecessor) {
        const parent = this.db.prepare('SELECT * FROM reviews WHERE attempt_id=?').get(m.predecessor.attemptId) as ReviewRow | undefined;
        if (!parent) throw Error('UNKNOWN_PREDECESSOR');
        if (['SUPERSEDED', 'SUPERSESSION_PENDING'].includes(this.state(parent.id)!)) throw Error('PREDECESSOR_SUPERSEDED');
        const binding = JSON.parse(parent.binding);
        if (parent.action_id !== m.predecessor.actionId || parent.attempt_sequence !== m.predecessor.attemptSequence ||
            binding.requestHash !== m.predecessor.requestHash || binding.attemptHash !== m.predecessor.attemptHash ||
            binding.targetId !== m.binding.targetId || binding.actionKind !== m.binding.actionKind) throw Error('PREDECESSOR_BINDING_MISMATCH');
        older.push(parent);
      }
      if (older.some(r => r.attempt_sequence >= m.binding.attemptSequence)) throw Error('ATTEMPT_ROLLBACK');
      for (const f of m.files) {
        this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(f.sha256, f.bytes);
        const saved = this.db.prepare('SELECT bytes FROM blobs WHERE digest=?').get(f.sha256)!;
        if (!Buffer.from(saved.bytes as Uint8Array).equals(f.bytes)) throw Error('CONTENT_CONFLICT');
      }
      this.db.prepare('INSERT OR IGNORE INTO materials VALUES(?,?,?)').run(m.root, m.manifest, m.manifestHash);
      const saved = this.db.prepare('SELECT manifest,manifest_hash FROM materials WHERE root=?').get(m.root)!;
      if (saved.manifest !== m.manifest || saved.manifest_hash !== m.manifestHash) throw Error('MANIFEST_CONFLICT');
      this.db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?,?)').run(m.binding.reviewId, m.binding.attemptId, m.binding.actionId, m.binding.attemptSequence, canonicalJson(m.binding), m.root);
      for (const r of older) {
        const last = this.history(r.id).at(-1)!;
        // Pending revocation remains a separate durable obligation. Accepting or
        // publishing a replacement cannot erase it or assert CT701 revocation.
        if (['INVALIDATED', 'SUPERSEDED', 'INVALIDATION_PENDING', 'SUPERSESSION_PENDING'].includes(String(last.state))) continue;
        const detail = canonicalJson({ reviewId: r.id, expectedSequence: last.seq, replacementReviewId: m.binding.reviewId });
        this.event(r.id, last.state === 'PUBLICATION_ACKNOWLEDGED' ? 'SUPERSESSION_PENDING' : 'SUPERSEDED', detail);
      }
      this.event(m.binding.reviewId, 'REVIEW_PENDING'); this.event(m.binding.reviewId, 'MATERIAL_FIXED', m.root); return true;
    });
  }
  material(row: ReviewRow): Material {
    this.available();
    const stored = this.db.prepare('SELECT * FROM materials WHERE root=?').get(row.root);
    if (!stored || typeof stored.manifest !== 'string') throw Error('MATERIAL_MISSING');
    const manifest = JSON.parse(stored.manifest) as { files: { path: string; sha256: string; bytes: number }[] };
    const files = manifest.files.map(f => {
      const blob = this.db.prepare('SELECT bytes FROM blobs WHERE digest=?').get(f.sha256);
      if (!blob || !(blob.bytes instanceof Uint8Array) || hash(blob.bytes) !== f.sha256 || blob.bytes.length !== f.bytes) throw Error('CONTENT_TAMPER');
      return { path: f.path, base64: Buffer.from(blob.bytes).toString('base64') };
    });
    const material = freezeCandidate({ binding: JSON.parse(row.binding), files });
    if (material.root !== row.root || material.manifest !== stored.manifest || material.manifestHash !== stored.manifest_hash) throw Error('MANIFEST_TAMPER');
    return material;
  }
  result(id: string) {
    this.available(); const r = this.db.prepare('SELECT body,evidence_hash FROM results WHERE review_id=?').get(id);
    if (!r) return undefined;
    const body = JSON.parse(r.body as string), snapshot = parseStrict(independentlyVerifiedReviewSchema, body.snapshot);
    const row = this.row(id)!;
    const material = this.material(row);
    const history = this.history(id);
    if (!reviewBindingFields.every(field => snapshot.evidence[field] === material.binding[field] && snapshot.context[field] === material.binding[field]) ||
        body.report.reviewId !== id || body.report.materialRoot !== material.root ||
        body.report.materialFixedSequence !== history.find(e => e.state === 'MATERIAL_FIXED')?.seq ||
        body.report.reviewRunningSequence !== history.find(e => e.state === 'REVIEW_RUNNING')?.seq ||
        canonicalJson(snapshot.evidence.reviewBundle) !== canonicalJson({ sha256: material.root }) ||
        snapshot.evidence.manifest.sha256 !== material.manifestHash || hashReviewedEvidence(snapshot.evidence) !== r.evidence_hash ||
        snapshot.context.expectedReviewEvidenceHash !== r.evidence_hash || snapshot.context.expectedResult !== body.report.result ||
        snapshot.evidence.review.result !== body.report.result || snapshot.evidence.review.reportSha256 !== hash(canonicalJson(body.report)) ||
        snapshot.evidence.integrity.reportSha256 !== hash(canonicalJson(body.integrity))) throw Error('RESULT_TAMPER');
    return body;
  }
  saveResult(id: string, body: unknown, evidenceHash: string) {
    this.mutate(() => { this.db.prepare('INSERT INTO results VALUES(?,?,?)').run(id, evidenceHash, canonicalJson(body)); this.event(id, 'RESULT_DURABLE', evidenceHash); });
  }
  signature(id: string) { this.available(); const r = this.db.prepare('SELECT body FROM signatures WHERE review_id=?').get(id); return r ? JSON.parse(r.body as string) : undefined; }
  saveSignature(id: string, body: { payload: { jti: string } }) {
    this.mutate(() => { this.db.prepare('INSERT INTO signatures VALUES(?,?,?)').run(id, body.payload.jti, canonicalJson(body)); this.event(id, 'SIGNED_PENDING_PUBLICATION'); });
  }
  close() { this.db.close(); }
}
