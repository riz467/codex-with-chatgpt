import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { ApprovalRequest, SignedApproval } from "../human-approval/contract.js";

export type Credential = { id: string; publicKey: string; counter: number; transports: string[]; enabled: boolean };
type RequestRow = { payload: string; state: string; challenge: string | null; ceremony: string | null; challenge_expires: number | null };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** All mutations are local synchronous SQLite transactions; no request-controlled SQL. */
export class ApproverStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
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
      transports: JSON.parse(row.transports as string) as string[], enabled: true,
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
      this.db.prepare("INSERT INTO approval_requests(request_id,canonical_payload,nonce,issued_at,expires_at,state) VALUES(?,?,?,?,?,'PENDING')")
        .run(payload.request_id, JSON.stringify(payload), payload.nonce, payload.issued_at, payload.expires_at);
      this.audit("REQUEST", payload.request_id, "PENDING", now);
      return true;
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
      const updated = this.db.prepare("UPDATE webauthn_credentials SET sign_count=? WHERE credential_id=? AND enabled=1 AND sign_count=?")
        .run(newCounter, credential.id, credential.counter);
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
  /** Future consumption gate only; not called by this service's approval API. */
  consumeJti(jti: string, now: number): boolean {
    try { this.db.prepare("INSERT INTO consumed_jti(jti,consumed_at) VALUES(?,?)").run(jti, new Date(now).toISOString()); return true; }
    catch { return false; }
  }
}
