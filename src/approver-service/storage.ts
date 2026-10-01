import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { ApprovalRequest, SignedApproval } from "../human-approval/contract.js";
import { canonicalJson, parseStrict, typedActionApprovalRequestSchema, signedTypedActionApprovalSchema, type TypedActionApprovalRequest, type SignedTypedActionApproval } from "../typed-action-approval/contract.js";
import { validTimeRange } from "../typed-action-approval/verifier.js";

export type Credential = { id: string; publicKey: string; counter: number; transports: string[]; enabled: boolean; revision?: number };
type RequestRow = { payload: string; state: string; challenge: string | null; ceremony: string | null; challenge_expires: number | null };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** All mutations are local synchronous SQLite transactions; no request-controlled SQL. */
export class ApproverStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    try {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    const legacy = ['webauthn_credentials', 'approval_requests', 'approval_evidence', 'consumed_jti', 'audit', 'enrollment_window', 'enrollment_challenges'];
    if (tables.length && (legacy.some(name => !tables.includes(name)) || tables.some(name => ![...legacy, 'typed_action_approval_requests', 'typed_action_approval_evidence'].includes(String(name))))) {
      throw new Error('FOREIGN_APPROVER_SCHEMA');
    }
    if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
        tables.includes('typed_action_approval_requests') !== tables.includes('typed_action_approval_evidence')) {
      throw new Error('INVALID_APPROVER_DATABASE');
    }
    if (tables.length) {
      // Validate the existing schema before applying any additive migration.
      for (const query of [
        'SELECT credential_id,public_key,sign_count,transports,created_at,enabled FROM webauthn_credentials',
        'SELECT request_id,canonical_payload,nonce,challenge,ceremony,challenge_expires,issued_at,expires_at,state FROM approval_requests',
        'SELECT request_id,envelope,jti,approved_at FROM approval_evidence',
        'SELECT jti,consumed_at FROM consumed_jti', 'SELECT id,timestamp,event,request_id,result,safe_metadata FROM audit',
        'SELECT id,token_hash,expires FROM enrollment_window', 'SELECT ceremony,token_hash,challenge,expires FROM enrollment_challenges',
      ]) this.db.prepare(`${query} LIMIT 0`).all();
      if (tables.includes('typed_action_approval_requests')) {
        this.db.prepare(`SELECT approval_request_id,canonical_payload,jti,action_id,request_hash,attempt_hash,
          issued_at,expires_at,state,challenge,ceremony,challenge_expires FROM typed_action_approval_requests LIMIT 0`).all();
        this.db.prepare('SELECT approval_request_id,envelope,jti,approved_at FROM typed_action_approval_evidence LIMIT 0').all();
        if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='typed_action_payload_immutable'").get() ||
            !this.db.prepare('PRAGMA table_info(webauthn_credentials)').all().some(r => r.name === 'authentication_revision')) {
          throw new Error('INVALID_APPROVER_DATABASE');
        }
      }
    }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
      credential_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, sign_count INTEGER NOT NULL,
      transports TEXT NOT NULL, created_at TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
      CREATE TABLE IF NOT EXISTS approval_requests (
        request_id TEXT PRIMARY KEY, canonical_payload TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE,
        challenge TEXT, ceremony TEXT, challenge_expires INTEGER, issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED')));
      CREATE TABLE IF NOT EXISTS approval_evidence (
        request_id TEXT PRIMARY KEY REFERENCES approval_requests(request_id), envelope TEXT NOT NULL,
        jti TEXT NOT NULL UNIQUE, approved_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumed_jti (jti TEXT PRIMARY KEY, consumed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, event TEXT NOT NULL,
        request_id TEXT, result TEXT NOT NULL, safe_metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS enrollment_window (
        id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS enrollment_challenges (
        ceremony TEXT PRIMARY KEY, token_hash TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_requests_expiry ON approval_requests(expires_at);`);
    // Additive, transactional migration: legacy rows and wire contracts are untouched.
    this.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(webauthn_credentials)').all().some(r => r.name === 'authentication_revision')) {
        this.db.exec('ALTER TABLE webauthn_credentials ADD COLUMN authentication_revision INTEGER NOT NULL DEFAULT 0');
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS typed_action_approval_requests (
        approval_request_id TEXT PRIMARY KEY, canonical_payload TEXT NOT NULL, jti TEXT NOT NULL UNIQUE,
        action_id TEXT NOT NULL, request_hash TEXT NOT NULL, attempt_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED')),
        challenge TEXT, ceremony TEXT, challenge_expires INTEGER);
        CREATE TABLE IF NOT EXISTS typed_action_approval_evidence (
        approval_request_id TEXT PRIMARY KEY REFERENCES typed_action_approval_requests(approval_request_id),
        envelope TEXT NOT NULL, jti TEXT NOT NULL UNIQUE, approved_at TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS typed_action_payload_immutable BEFORE UPDATE OF
        approval_request_id,canonical_payload,jti,action_id,request_hash,attempt_hash,issued_at,expires_at
        ON typed_action_approval_requests BEGIN SELECT RAISE(ABORT,'IMMUTABLE_APPROVAL'); END;`);
    });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  audit(event: string, requestId: string | null, result: string, now: number) {
    this.db.prepare("INSERT INTO audit(timestamp,event,request_id,result,safe_metadata) VALUES(?,?,?,?,?)")
      .run(new Date(now).toISOString(), event, requestId, result, "{}");
  }
  openEnrollment(now: number): string {
    const token = randomBytes(32).toString("base64url");
    this.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO enrollment_window(id,token_hash,expires) VALUES(1,?,?)").run(digest(token), now + 300_000);
      this.db.prepare("DELETE FROM enrollment_challenges").run();
      this.audit("ENROLLMENT_OPEN", null, "OPEN", now);
    });
    return token; // Printed by CT-local CLI only; never returned by an API.
  }
  enrollmentOpen(token: string, now: number): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const row = this.db.prepare("SELECT token_hash,expires FROM enrollment_window WHERE id=1").get() as { token_hash: string; expires: number } | undefined;
    return !!row && row.expires > now && row.token_hash === digest(token);
  }
  issueEnrollment(token: string, challenge: string, now: number): string | null {
    if (!this.enrollmentOpen(token, now)) return null;
    const ceremony = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO enrollment_challenges(ceremony,token_hash,challenge,expires) VALUES(?,?,?,?)")
      .run(ceremony, digest(token), challenge, now + 120_000);
    return ceremony;
  }
  consumeEnrollment(token: string, ceremony: string, now: number): string | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT token_hash,challenge,expires FROM enrollment_challenges WHERE ceremony=?").get(ceremony) as
        { token_hash: string; challenge: string; expires: number } | undefined;
      this.db.prepare("DELETE FROM enrollment_challenges WHERE ceremony=?").run(ceremony);
      return row && row.expires > now && row.token_hash === digest(token) && this.enrollmentOpen(token, now) ? row.challenge : null;
    });
  }
  register(credential: Credential, token: string, now: number): boolean {
    if (!this.enrollmentOpen(token, now)) return false;
    return this.transaction(() => {
      if (!this.enrollmentOpen(token, now)) return false;
      this.db.prepare("INSERT INTO webauthn_credentials(credential_id,public_key,sign_count,transports,created_at,enabled) VALUES(?,?,?,?,?,1)")
        .run(credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports), new Date(now).toISOString());
      this.db.prepare("DELETE FROM enrollment_window WHERE id=1").run();
      this.db.prepare("DELETE FROM enrollment_challenges").run();
      this.audit("ENROLLMENT", null, "VERIFIED", now);
      return true;
    });
  }
  credentials(): Credential[] {
    return (this.db.prepare("SELECT * FROM webauthn_credentials WHERE enabled=1").all() as Record<string, unknown>[]).map(row => ({
      id: row.credential_id as string, publicKey: row.public_key as string, counter: row.sign_count as number,
      transports: JSON.parse(row.transports as string) as string[], enabled: true, revision: row.authentication_revision as number,
    }));
  }
  credential(id: string): Credential | undefined { return this.credentials().find(c => c.id === id); }
  disableCredential(id: string, now: number): boolean {
    const result = this.db.prepare("UPDATE webauthn_credentials SET enabled=0 WHERE credential_id=? AND enabled=1").run(id);
    if (result.changes) this.audit("CREDENTIAL_DISABLE", null, "DISABLED", now);
    return result.changes === 1;
  }
  createRequest(payload: ApprovalRequest, now: number): boolean {
    try {
      return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM typed_action_approval_requests WHERE jti=?").get(payload.nonce)) return false;
      this.db.prepare("INSERT INTO approval_requests(request_id,canonical_payload,nonce,issued_at,expires_at,state) VALUES(?,?,?,?,?,'PENDING')")
        .run(payload.request_id, JSON.stringify(payload), payload.nonce, payload.issued_at, payload.expires_at);
      this.audit("REQUEST", payload.request_id, "PENDING", now);
      return true;
      });
    } catch { return false; } // duplicate ID or nonce: fail closed
  }
  request(id: string): { payload: ApprovalRequest; state: string } | null {
    const row = this.db.prepare("SELECT canonical_payload,state FROM approval_requests WHERE request_id=?").get(id) as
      { canonical_payload: string; state: string } | undefined;
    return row ? { payload: JSON.parse(row.canonical_payload) as ApprovalRequest, state: row.state } : null;
  }
  issueAuthentication(id: string, challenge: string, now: number): string | null {
    const ceremony = randomBytes(32).toString("base64url");
    const changes = this.db.prepare("UPDATE approval_requests SET challenge=?,ceremony=?,challenge_expires=? WHERE request_id=? AND state='PENDING' AND expires_at>?")
      .run(challenge, ceremony, now + 120_000, id, new Date(now).toISOString()).changes;
    return changes === 1 ? ceremony : null;
  }
  consumeAuthentication(id: string, ceremony: string, now: number): string | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT canonical_payload AS payload,state,challenge,ceremony,challenge_expires FROM approval_requests WHERE request_id=?")
        .get(id) as RequestRow | undefined;
      this.db.prepare("UPDATE approval_requests SET challenge=NULL,ceremony=NULL,challenge_expires=NULL WHERE request_id=?").run(id);
      const payload = row && JSON.parse(row.payload) as ApprovalRequest;
      return row?.state === "PENDING" && row.ceremony === ceremony && row.challenge_expires !== null && row.challenge_expires > now &&
        Date.parse(payload!.expires_at) > now ? row.challenge : null;
    });
  }
  approve(id: string, credential: Credential, newCounter: number, evidence: SignedApproval, now: number): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT state,expires_at,nonce FROM approval_requests WHERE request_id=?").get(id) as
        { state: string; expires_at: string; nonce: string } | undefined;
      if (!row || row.state !== "PENDING" || Date.parse(row.expires_at) <= now || row.nonce !== evidence.payload.nonce ||
          this.db.prepare("SELECT 1 FROM consumed_jti WHERE jti=?").get(row.nonce)) return false;
      const updated = this.db.prepare("UPDATE webauthn_credentials SET sign_count=?,authentication_revision=authentication_revision+1 WHERE credential_id=? AND enabled=1 AND sign_count=? AND authentication_revision=?")
        .run(newCounter, credential.id, credential.counter, credential.revision ?? 0);
      if (updated.changes !== 1) return false;
      this.db.prepare("INSERT INTO approval_evidence(request_id,envelope,jti,approved_at) VALUES(?,?,?,?)")
        .run(id, JSON.stringify(evidence), row.nonce, new Date(now).toISOString());
      this.db.prepare("UPDATE approval_requests SET state='APPROVED' WHERE request_id=?").run(id);
      this.audit("APPROVAL", id, "SIGNED", now);
      return true;
    });
  }
  evidence(id: string): SignedApproval | null {
    const row = this.db.prepare("SELECT envelope FROM approval_evidence WHERE request_id=?").get(id) as { envelope: string } | undefined;
    return row ? JSON.parse(row.envelope) as SignedApproval : null;
  }
  createTypedRequest(input: TypedActionApprovalRequest, now: number): boolean {
    try {
      const p = parseStrict(typedActionApprovalRequestSchema, input);
      if (!validTimeRange(p.issuedAt, p.expiresAt, now)) return false;
      return this.transaction(() => {
        if (this.db.prepare('SELECT 1 FROM approval_requests WHERE nonce=?').get(p.jti) ||
            this.db.prepare('SELECT 1 FROM consumed_jti WHERE jti=?').get(p.jti)) return false;
        this.db.prepare(`INSERT INTO typed_action_approval_requests
          (approval_request_id,canonical_payload,jti,action_id,request_hash,attempt_hash,issued_at,expires_at,state)
          VALUES(?,?,?,?,?,?,?,?,'PENDING')`).run(p.approvalRequestId, canonicalJson(p), p.jti, p.actionId, p.requestHash, p.attemptHash, p.issuedAt, p.expiresAt);
        this.audit('TYPED_REQUEST', p.approvalRequestId, 'PENDING', now);
        return true;
      });
    } catch { return false; }
  }
  typedRequest(id: string): { payload: TypedActionApprovalRequest; state: string } | null {
    try {
      const r = this.db.prepare('SELECT * FROM typed_action_approval_requests WHERE approval_request_id=?').get(id);
      if (!r) return null;
      const p = parseStrict(typedActionApprovalRequestSchema, JSON.parse(String(r.canonical_payload)));
      if (canonicalJson(p) !== r.canonical_payload || p.approvalRequestId !== id || p.jti !== r.jti || p.actionId !== r.action_id ||
          p.requestHash !== r.request_hash || p.attemptHash !== r.attempt_hash || p.issuedAt !== r.issued_at || p.expiresAt !== r.expires_at) return null;
      return { payload: p, state: String(r.state) };
    } catch { return null; }
  }
  issueTypedAuthentication(id: string, challenge: string, now: number): string | null {
    return this.transaction(() => {
      const item = this.typedRequest(id);
      if (!item || item.state !== 'PENDING' || !validTimeRange(item.payload.issuedAt, item.payload.expiresAt, now)) return null;
      const ceremony = `typed-${randomBytes(32).toString('base64url')}`;
      this.db.prepare('UPDATE typed_action_approval_requests SET challenge=?,ceremony=?,challenge_expires=? WHERE approval_request_id=?')
        .run(challenge, ceremony, Math.min(now + 120_000, Date.parse(item.payload.expiresAt)), id);
      return ceremony;
    });
  }
  consumeTypedAuthentication(id: string, ceremony: string, now: number): { challenge: string; expires: number } | null {
    return this.transaction(() => {
      const item = this.typedRequest(id);
      const row = this.db.prepare('SELECT challenge,ceremony,challenge_expires FROM typed_action_approval_requests WHERE approval_request_id=?').get(id);
      this.db.prepare('UPDATE typed_action_approval_requests SET challenge=NULL,ceremony=NULL,challenge_expires=NULL WHERE approval_request_id=?').run(id);
      return item?.state === 'PENDING' && validTimeRange(item.payload.issuedAt, item.payload.expiresAt, now) &&
        row?.ceremony === ceremony && typeof row.challenge === 'string' && Number(row.challenge_expires) > now
        ? { challenge: row.challenge, expires: Number(row.challenge_expires) } : null;
    });
  }
  approveTyped(id: string, credential: Credential, newCounter: number,
    issueEvidence: (payload: TypedActionApprovalRequest) => SignedTypedActionApproval, now: number): boolean {
    return this.transaction(() => {
      const item = this.typedRequest(id);
      if (!item || item.state !== 'PENDING' || !validTimeRange(item.payload.issuedAt, item.payload.expiresAt, now) ||
          !Number.isSafeInteger(newCounter) || newCounter < 0 || ((credential.counter !== 0 || newCounter !== 0) && newCounter <= credential.counter) ||
          this.db.prepare('SELECT 1 FROM consumed_jti WHERE jti=?').get(item.payload.jti) ||
          this.db.prepare('SELECT 1 FROM approval_requests WHERE nonce=?').get(item.payload.jti)) return false;
      const updated = this.db.prepare('UPDATE webauthn_credentials SET sign_count=?,authentication_revision=authentication_revision+1 WHERE credential_id=? AND public_key=? AND enabled=1 AND sign_count=? AND authentication_revision=?')
        .run(newCounter, credential.id, credential.publicKey, credential.counter, credential.revision ?? 0);
      if (updated.changes !== 1) return false;
      // Signing occurs only after every gate, inside the same transaction as counter CAS.
      const parsed = signedTypedActionApprovalSchema.parse(issueEvidence(item.payload));
      if (canonicalJson(parsed.payload) !== canonicalJson(item.payload)) throw new Error('APPROVAL_BINDING_MISMATCH');
      this.db.prepare('INSERT INTO typed_action_approval_evidence VALUES(?,?,?,?)').run(id, canonicalJson(parsed), item.payload.jti, new Date(now).toISOString());
      this.db.prepare("UPDATE typed_action_approval_requests SET state='APPROVED' WHERE approval_request_id=?").run(id);
      this.audit('TYPED_APPROVAL', id, 'SIGNED', now);
      return true;
    });
  }
  typedEvidence(id: string): SignedTypedActionApproval | null {
    try {
      const row = this.db.prepare('SELECT envelope FROM typed_action_approval_evidence WHERE approval_request_id=?').get(id);
      return row ? parseStrict(signedTypedActionApprovalSchema, JSON.parse(String(row.envelope))) : null;
    } catch { return null; }
  }
  /** Future consumption gate only; not called by this service's approval API. */
  consumeJti(jti: string, now: number): boolean {
    try { this.db.prepare("INSERT INTO consumed_jti(jti,consumed_at) VALUES(?,?)").run(jti, new Date(now).toISOString()); return true; }
    catch { return false; }
  }
}
