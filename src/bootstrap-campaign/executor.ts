import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { canonicalJson, digest, parseJson } from "./hash.js";
import { checkpointSchema, manifestHash, parseManifest, strict, utc, type Checkpoint, type Manifest, type Step } from "./contract.js";
import { authorizationSchema, cancellationSchema, ceremonyReceiptSchema, cutoverReceiptSchema, parseAuthorization,
  preconditionSchema, stepReceiptSchema, verificationReceiptSchema } from "./authorization.js";
import { eventHash, operationId, reconstruct, verifyChain, zeroHash, type JournalEvent, type Reason, type Run } from "./journal.js";
import { phases, terminal, type State } from "./state-machine.js";

/** Host-owned local monotonic checkpoint contract. IR-08 must supply an independent durable anchor.
 * The checkpoint must survive separately from DB backups; resetting it is not recovery. */
export interface LocalHighWatermark {
  read(): Checkpoint;
  advance(previous: Checkpoint, next: Checkpoint): void;
}
export type Decision = { kind: "READY_TO_DISPATCH"; campaignId: string; stepId: string; operationId: string;
  operationKind: Step["operationKind"]; targetRef: "OFFLINE_FIXTURE" }
  | { kind: "WAITING_DEPENDENCY" | "WAITING_HUMAN_CEREMONY" | "BLOCKED" | "RECONCILE_REQUIRED" | "COMPLETE";
    reason: Reason | null };
export class StoreOutcomeUnknownError extends Error {
  constructor() { super("STORE_OUTCOME_UNKNOWN: stop; read-only recovery required"); }
}
const schemaSql = `
CREATE TABLE campaigns (campaign_id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, manifest_hash TEXT NOT NULL UNIQUE, manifest TEXT NOT NULL) STRICT;
CREATE TABLE authorizations (campaign_id TEXT PRIMARY KEY REFERENCES campaigns(campaign_id), nonce TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL) STRICT;
CREATE TABLE activations (campaign_id TEXT PRIMARY KEY REFERENCES authorizations(campaign_id), execution_identity TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE receipts (receipt_hash TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id), body TEXT NOT NULL) STRICT;
CREATE TABLE journal (sequence INTEGER PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id), event_hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL) STRICT;
CREATE TABLE tombstones (sequence INTEGER PRIMARY KEY REFERENCES journal(sequence), trust_domain TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('BOOTSTRAP_DISABLED_PENDING','PASSKEY_ONLY')), campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id), UNIQUE(trust_domain,mode)) STRICT;
${["campaigns", "authorizations", "activations", "receipts", "journal", "tombstones"].flatMap(table => ["UPDATE", "DELETE"].map(action =>
  `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'append-only'); END;`)).join("\n")}
PRAGMA application_id=1111707697; PRAGMA user_version=1;`;
function schemaManifest(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all());
}
const exactSchema = (() => { const db = new DatabaseSync(":memory:"); try { db.exec(schemaSql); return schemaManifest(db); } finally { db.close(); } })();
type Snapshot = { events: JournalEvent[]; runs: Map<string, Run>; checkpoint: Checkpoint };

/** Offline, synchronous, fixed-catalog decision engine. No mutation adapters exist here.
 * Host injection is a trusted composition boundary, never an AI/client API. Owns the DB connection. */
export class BootstrapCampaignExecutor {
  #db: DatabaseSync;
  #anchor: LocalHighWatermark;
  #now: () => number;
  #failure: ((point: "BEFORE_COMMIT" | "AFTER_COMMIT") => void) | undefined;
  #poisoned = false;
  #owned = new Set<string>();
  constructor(host: { database: DatabaseSync; highWatermark: LocalHighWatermark; now: () => number;
    failureInjection?: (point: "BEFORE_COMMIT" | "AFTER_COMMIT") => void }) {
    this.#db = host.database; this.#anchor = host.highWatermark; this.#now = host.now; this.#failure = host.failureInjection;
    const databases = this.#db.prepare("PRAGMA database_list").all();
    if (databases.length !== 1 || databases[0].name !== "main" || !databases[0].file) throw new Error("Dedicated file-backed SQLite required");
    const empty = !this.#db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      && this.#db.prepare("PRAGMA application_id").get()?.application_id === 0
      && this.#db.prepare("PRAGMA user_version").get()?.user_version === 0;
    // These are connection-local settings, not repairs of persistent database state.
    this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL");
    if (empty) {
      const checkpoint = strict(checkpointSchema, this.#anchor.read());
      if (checkpoint.sequence !== 0 || checkpoint.eventHash !== zeroHash) throw new Error("Store rollback");
      // journal_mode is persistent: only trusted initialization may change it.
      // Existing stores go directly to read-only verification, including mode=wal.
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("BEGIN IMMEDIATE");
      try { this.#db.exec(schemaSql); this.#schema(); this.#db.exec("COMMIT"); } catch (error) { try { this.#db.exec("ROLLBACK"); } catch {} throw error; }
    }
    // Existing stores: inspection only. Never renew ownership, repair, or migrate.
    this.#inspection();
  }
  close(): void { this.#owned.clear(); this.#poisoned = true; this.#db.close(); }
  #timestamp(): string { const n = this.#now(); if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid clock"); return utc.parse(new Date(n).toISOString()); }
  #schema(): void {
    if (this.#poisoned) throw new StoreOutcomeUnknownError();
    const databases = this.#db.prepare("PRAGMA database_list").all();
    if (databases.some(d => d.name !== "main" && d.name !== "temp") || !databases.find(d => d.name === "main")?.file) throw new Error("Dedicated database required");
    for (const [pragma, value] of [["quick_check", "ok"], ["journal_mode", "wal"], ["synchronous", 2], ["foreign_keys", 1],
      ["application_id", 1111707697], ["user_version", 1]] as const) {
      const rows = this.#db.prepare(`PRAGMA ${pragma}`).all();
      if (rows.length !== 1 || rows[0][pragma] !== value) throw new Error("SQLite integrity/settings mismatch");
    }
    if (schemaManifest(this.#db) !== exactSchema || this.#db.prepare("SELECT 1 FROM temp.sqlite_schema").get()
      || this.#db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SQLite schema integrity mismatch");
  }
  #read(checkAnchor = true): Snapshot {
    this.#schema();
    const rows = this.#db.prepare("SELECT * FROM journal ORDER BY sequence").all();
    const events = verifyChain(rows.map(row => parseJson(String(row.body))));
    rows.forEach((r, i) => { if (r.sequence !== events[i].sequence || r.event_hash !== events[i].eventHash || r.campaign_id !== events[i].campaignId) throw new Error("Journal row mismatch"); });
    const last = events.at(-1), checkpoint = { sequence: last?.sequence ?? 0, eventHash: last?.eventHash ?? zeroHash };
    if (checkAnchor && canonicalJson(checkpoint) !== canonicalJson(strict(checkpointSchema, this.#anchor.read()))) throw new Error("High-watermark mismatch/rollback");
    const runs = new Map<string, Run>();
    for (const row of this.#db.prepare("SELECT * FROM campaigns").all()) {
      const m = parseManifest(String(row.manifest)), hash = manifestHash(m);
      if (m.campaignId !== row.campaign_id || m.authorizationNonce !== row.nonce || hash !== row.manifest_hash
        || canonicalJson(m) !== row.manifest) throw new Error("Manifest store binding");
      const run = reconstruct(m, hash, events); runs.set(m.campaignId, run);
      const auth = this.#db.prepare("SELECT * FROM authorizations WHERE campaign_id=?").get(m.campaignId);
      if (Boolean(auth) !== run.authorized) throw new Error("Authorization journal mismatch");
      if (auth) {
        const a = strict(authorizationSchema, String(auth.receipt));
        parseAuthorization(a, m, a.authorizedAt);
        if (auth.nonce !== m.authorizationNonce) throw new Error("Nonce mismatch");
        const registered = events.find(e => e.campaignId === m.campaignId && e.event === "AUTHORIZATION_REGISTERED");
        if (registered?.details.receiptSha256 !== digest("bootstrap-receipt-v1", a)) throw new Error("Authorization receipt mismatch");
      }
      const activation = this.#db.prepare("SELECT * FROM activations WHERE campaign_id=?").get(m.campaignId);
      if (Boolean(activation) !== run.activated || (activation && activation.execution_identity !== run.executionIdentity)) throw new Error("Activation journal mismatch");
    }
    for (const e of events) {
      if (!runs.has(e.campaignId)) throw new Error("Unknown journal campaign");
      if (e.details.receiptSha256) {
        const r = this.#db.prepare("SELECT * FROM receipts WHERE receipt_hash=?").get(e.details.receiptSha256);
        if (!r || r.campaign_id !== e.campaignId || digest("bootstrap-receipt-v1", parseJson(String(r.body))) !== r.receipt_hash) throw new Error("Receipt integrity");
      }
    }
    const receiptSchemas = [authorizationSchema, cancellationSchema, ceremonyReceiptSchema, cutoverReceiptSchema,
      preconditionSchema, stepReceiptSchema, verificationReceiptSchema];
    for (const r of this.#db.prepare("SELECT * FROM receipts").all()) {
      const value = parseJson(String(r.body));
      if (!receiptSchemas.some(schema => schema.safeParse(value).success) || canonicalJson(value) !== r.body
        || digest("bootstrap-receipt-v1", value) !== r.receipt_hash
        || !events.some(e => e.campaignId === r.campaign_id && e.details.receiptSha256 === r.receipt_hash)) throw new Error("Unbound or malformed receipt");
    }
    const tombstones = this.#db.prepare("SELECT * FROM tombstones ORDER BY sequence").all();
    const cutoverEvents = events.filter(e => e.event === "BOOTSTRAP_DISABLED_PENDING" || e.event === "PASSKEY_ONLY");
    if (tombstones.length !== cutoverEvents.length) throw new Error("Tombstone journal mismatch");
    tombstones.forEach((t, i) => { const e = cutoverEvents[i]; if (t.sequence !== e.sequence || t.mode !== e.event || t.campaign_id !== e.campaignId
      || t.trust_domain !== runs.get(e.campaignId)!.manifest.trustDomainId) throw new Error("Tombstone integrity"); });
    return { events, runs, checkpoint };
  }
  #inspection(): Snapshot {
    this.#db.exec("BEGIN");
    try { const result = this.#read(); this.#db.exec("COMMIT"); return result; }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch {} throw error; }
  }
  #transaction<T>(fn: (snapshot: Snapshot) => T): T {
    if (this.#poisoned) throw new StoreOutcomeUnknownError();
    this.#db.exec("BEGIN IMMEDIATE"); let committing = false;
    try {
      const snapshot = this.#read();
      if (this.#timestamp() < (snapshot.events.at(-1)?.timestamp ?? "")) { this.#poisoned = true; throw new Error("CLOCK_ROLLBACK"); }
      const result = fn(snapshot), next = this.#read(false).checkpoint;
      committing = true; this.#failure?.("BEFORE_COMMIT"); this.#db.exec("COMMIT");
      this.#failure?.("AFTER_COMMIT");
      this.#anchor.advance(snapshot.checkpoint, next);
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* An unknown COMMIT outcome is never success. */ }
      if (committing) { this.#poisoned = true; this.#owned.clear(); throw new StoreOutcomeUnknownError(); }
      throw error;
    }
  }
  #run(snapshot: Snapshot, campaignId: string): Run { const run = snapshot.runs.get(campaignId); if (!run) throw new Error("Unknown campaign"); return run; }
  #receipt(campaignId: string, value: unknown): string {
    const hash = digest("bootstrap-receipt-v1", value);
    this.#db.prepare("INSERT INTO receipts(receipt_hash,campaign_id,body) VALUES(?,?,?) ON CONFLICT DO NOTHING").run(hash, campaignId, canonicalJson(value)); return hash;
  }
  #append(run: Pick<Run, "manifest" | "manifestSha256" | "state">, event: JournalEvent["event"], options: {
    state?: State; step?: Step; reason?: Reason; receipt?: unknown; evidence?: string; executionIdentity?: string;
  } = {}): void {
    const count = this.#db.prepare("SELECT COUNT(*) AS count FROM journal WHERE campaign_id=?").get(run.manifest.campaignId)!.count as number;
    if (count + 1 > run.manifest.audit.maxEvents) throw new Error("Journal capacity STOP");
    const lastRow = this.#db.prepare("SELECT body FROM journal ORDER BY sequence DESC LIMIT 1").get();
    const last = lastRow ? parseJson(String(lastRow.body)) as JournalEvent : null;
    const timestamp = this.#timestamp(); if (last && timestamp < last.timestamp) throw new Error("CLOCK_ROLLBACK");
    const body: Omit<JournalEvent, "eventHash"> = { schemaVersion: 1, sequence: (last?.sequence ?? 0) + 1,
      previousEventHash: last?.eventHash ?? zeroHash, event, campaignId: run.manifest.campaignId,
      manifestSha256: run.manifestSha256, timestamp, state: options.state ?? run.state, stepId: options.step?.stepId ?? null,
      operationId: options.step ? operationId(run.manifest, options.step) : null, evidenceHashes: options.evidence ? [options.evidence] : [],
      details: { reason: options.reason ?? null, receiptSha256: options.receipt ? this.#receipt(run.manifest.campaignId, options.receipt) : null,
        executionIdentity: options.executionIdentity ?? null } };
    const hash = eventHash(body);
    this.#db.prepare("INSERT INTO journal(sequence,campaign_id,event_hash,body) VALUES(?,?,?,?)").run(body.sequence, body.campaignId, hash, canonicalJson({ ...body, eventHash: hash }));
    run.state = body.state;
  }
  #disabled(domain: string): boolean { return Boolean(this.#db.prepare("SELECT 1 FROM tombstones WHERE trust_domain=? LIMIT 1").get(domain)); }
  #uncertain(run: Run): boolean {
    return run.manifest.steps.some(s => s.operationKind === "TEST_MUTATION" && !["NOT_STARTED", "VERIFIED"].includes(run.steps.get(s.stepId)!.state));
  }
  #stop(run: Run, reason: Reason): Decision {
    const state = this.#uncertain(run) ? "RECONCILE_REQUIRED" : "BLOCKED";
    this.#append(run, state === "BLOCKED" ? "CAMPAIGN_BLOCKED" : "RECONCILE_REQUIRED", { state, reason });
    this.#owned.delete(run.manifest.campaignId); return { kind: state, reason };
  }
  #gate(run: Run): Decision | null {
    if (terminal(run.state)) return { kind: run.state as "BLOCKED" | "RECONCILE_REQUIRED" | "COMPLETE", reason: run.reason };
    if (!this.#owned.has(run.manifest.campaignId)) return this.#stop(run, "CONTINUATION_AUTHORIZATION_REQUIRED");
    if (this.#disabled(run.manifest.trustDomainId)) return { kind: "BLOCKED", reason: "CUTOVER_PENDING" };
    if (this.#timestamp() >= run.manifest.validity.expiresAt) return this.#stop(run, "EXPIRED");
    for (const s of run.manifest.steps) {
      const p = run.steps.get(s.stepId)!;
      if (p.intentAt && p.state !== "VERIFIED" && Date.parse(this.#timestamp()) - Date.parse(p.intentAt) >= s.timeoutMs) return this.#stop(run, "TIMEOUT");
    }
    return null;
  }
  #fresh(run: Run, timestamp: string): void {
    const age = Date.parse(this.#timestamp()) - Date.parse(timestamp);
    if (age < 0 || age > run.manifest.validity.observationMaxAgeMs) throw new Error("Stale/future observation");
  }
  #step(run: Run, stepId: string): Step { const s = run.manifest.steps.find(s => s.stepId === stepId); if (!s) throw new Error("Unknown step"); return s; }
  #advance(run: Run): void {
    while (run.state === "AUTHORIZED" || phases.includes(run.state as typeof phases[number])) {
      if (run.state !== "AUTHORIZED" && run.manifest.steps.some(s => s.phase === run.state && run.steps.get(s.stepId)!.state !== "VERIFIED")) break;
      const next: State = run.state === "AUTHORIZED" ? "PREFLIGHT" : phases.at(phases.indexOf(run.state as typeof phases[number]) + 1) ?? "READY_FOR_PASSKEY_CUTOVER";
      this.#append(run, next === "READY_FOR_PASSKEY_CUTOVER" ? "READY_FOR_PASSKEY_CUTOVER" : "STATE_ENTERED", { state: next });
    }
  }
  prepare(input: unknown): string {
    const m = parseManifest(input), hash = manifestHash(m);
    return this.#transaction(snapshot => {
      if (this.#disabled(m.trustDomainId)) throw new Error("Bootstrap permanently disabled");
      if (m.continuation) this.#validateContinuation(m, snapshot);
      this.#db.prepare("INSERT INTO campaigns(campaign_id,nonce,manifest_hash,manifest) VALUES(?,?,?,?)").run(m.campaignId, m.authorizationNonce, hash, canonicalJson(m));
      const run = { manifest: m, manifestSha256: hash, state: "PREPARED" as State };
      this.#append(run, "CAMPAIGN_PREPARED"); this.#append(run, "WAITING_HUMAN_AUTHORIZATION", { state: "WAITING_HUMAN_AUTHORIZATION" }); return hash;
    });
  }
  registerAuthorization(input: unknown): void {
    const parsed = strict(authorizationSchema, input);
    const inserted = this.#transaction(snapshot => {
      const run = this.#run(snapshot, parsed.campaignId);
      if (this.#disabled(run.manifest.trustDomainId) || terminal(run.state)) throw new Error("Bootstrap receipt rejected");
      const receipt = parseAuthorization(parsed, run.manifest, this.#timestamp());
      const old = this.#db.prepare("SELECT receipt FROM authorizations WHERE campaign_id=?").get(parsed.campaignId);
      if (old) { if (old.receipt !== canonicalJson(receipt)) throw new Error("Authorization replay mismatch"); return false; }
      if (this.#timestamp() >= run.manifest.validity.authorizeBefore) throw new Error("Authorization registration deadline");
      this.#db.prepare("INSERT INTO authorizations(campaign_id,nonce,receipt) VALUES(?,?,?)").run(parsed.campaignId, parsed.authorizationNonce, canonicalJson(receipt));
      this.#append(run, "AUTHORIZATION_REGISTERED", { receipt });
      return true;
    });
    if (inserted) this.#registeredHere.add(parsed.campaignId);
  }
  activate(campaignId: string): void {
    this.#transaction(snapshot => {
      const run = this.#run(snapshot, campaignId);
      if (run.state !== "WAITING_HUMAN_AUTHORIZATION" || !run.authorized || run.activated || this.#disabled(run.manifest.trustDomainId)
        || this.#timestamp() >= run.manifest.validity.expiresAt) throw new Error("Activation rejected");
      // Only the instance that registered the receipt may activate it; restart cannot re-use authority.
      if (!this.#registeredHere.has(campaignId)) throw new Error("CONTINUATION_AUTHORIZATION_REQUIRED");
      if ([...snapshot.runs.values()].some(r => r.activated && !terminal(r.state))) throw new Error("Global campaign lock");
      const executionIdentity = randomUUID();
      this.#db.prepare("INSERT INTO activations(campaign_id,execution_identity) VALUES(?,?)").run(campaignId, executionIdentity);
      this.#append(run, "CAMPAIGN_AUTHORIZED", { state: "AUTHORIZED", executionIdentity });
    });
    this.#owned.add(campaignId);
  }
  #registeredHere = new Set<string>();
  inspect(campaignId: string): Run { return this.#run(this.#inspection(), campaignId); }
  journal(): JournalEvent[] { return this.#inspection().events; }
  recover(campaignId: string): Decision {
    return this.#transaction(snapshot => {
      const run = this.#run(snapshot, campaignId);
      if (terminal(run.state)) return { kind: run.state as "BLOCKED" | "RECONCILE_REQUIRED" | "COMPLETE", reason: run.reason };
      if (!run.authorized) return { kind: "WAITING_DEPENDENCY", reason: null };
      return this.#stop(run, this.#uncertain(run) ? "MUTATION_UNCERTAIN" : "CONTINUATION_AUTHORIZATION_REQUIRED");
    });
  }
  decision(campaignId: string, stepId: string): Decision {
    return this.#transaction(snapshot => {
      const run = this.#run(snapshot, campaignId);
      if (!run.authorized && !terminal(run.state)) return { kind: "WAITING_DEPENDENCY", reason: null };
      const gate = this.#gate(run); if (gate) return gate;
      this.#advance(run); const s = this.#step(run, stepId), p = run.steps.get(stepId)!;
      if (p.state === "VERIFIED") return { kind: "COMPLETE", reason: null };
      if (run.waiting) return { kind: "WAITING_HUMAN_CEREMONY", reason: null };
      if (s.phase !== run.state || s.dependencies.some(d => run.steps.get(d)?.state !== "VERIFIED")
        || [...run.steps.entries()].some(([key, p]) => key !== stepId && !["NOT_STARTED", "VERIFIED"].includes(p.state))) return { kind: "WAITING_DEPENDENCY", reason: null };
      if (s.operationKind === "TEST_HUMAN_CEREMONY") {
        this.#append(run, "HUMAN_CEREMONY_WAIT", { step: s }); return { kind: "WAITING_HUMAN_CEREMONY", reason: null };
      }
      if (p.state !== "INTENT_DURABLE") return { kind: "WAITING_DEPENDENCY", reason: null };
      return { kind: "READY_TO_DISPATCH", campaignId, stepId, operationId: operationId(run.manifest, s), operationKind: s.operationKind, targetRef: s.targetRef };
    });
  }
  intent(campaignId: string, input: unknown): Decision {
    const observation = strict(preconditionSchema, input);
    return this.#transaction(snapshot => {
      const run = this.#run(snapshot, campaignId), gate = this.#gate(run); if (gate) return gate;
      this.#advance(run); const s = this.#step(run, observation.stepId), p = run.steps.get(s.stepId)!;
      if (p.state !== "NOT_STARTED" || run.waiting || s.operationKind === "TEST_HUMAN_CEREMONY" || s.phase !== run.state
        || s.dependencies.some(d => run.steps.get(d)?.state !== "VERIFIED")
        || [...run.steps.values()].some(p => !["NOT_STARTED", "VERIFIED"].includes(p.state))) throw new Error("Intent admission rejected");
      if (observation.campaignId !== campaignId || observation.manifestSha256 !== run.manifestSha256 || observation.preconditionDigest !== s.preconditionDigest) return this.#stop(run, "PRECONDITION_MISMATCH");
      this.#fresh(run, observation.observedAt);
      this.#append(run, "STEP_INTENT", { step: s, receipt: observation, evidence: observation.evidenceRoot });
      return { kind: "READY_TO_DISPATCH", campaignId, stepId: s.stepId, operationId: operationId(run.manifest, s), operationKind: s.operationKind, targetRef: s.targetRef };
    });
  }
  dispatch(campaignId: string, stepId: string): Decision {
    return this.#transaction(snapshot => {
      const run = this.#run(snapshot, campaignId), gate = this.#gate(run); if (gate) return gate;
      const s = this.#step(run, stepId), p = run.steps.get(stepId)!;
      if (p.state !== "INTENT_DURABLE" || run.waiting || s.phase !== run.state) throw new Error("Durable intent required; no repeat dispatch");
      const intent = snapshot.events.find(e => e.campaignId === campaignId && e.stepId === stepId && e.event === "STEP_INTENT")!;
      const stored = this.#db.prepare("SELECT body FROM receipts WHERE receipt_hash=?").get(intent.details.receiptSha256!);
      const observation = strict(preconditionSchema, String(stored!.body));
      if (Date.parse(this.#timestamp()) - Date.parse(observation.observedAt) > run.manifest.validity.observationMaxAgeMs) return this.#stop(run, "PRECONDITION_MISMATCH");
      this.#append(run, "STEP_DISPATCHED", { step: s });
      return { kind: "READY_TO_DISPATCH", campaignId, stepId, operationId: operationId(run.manifest, s), operationKind: s.operationKind, targetRef: s.targetRef };
    });
  }
  observe(campaignId: string, input: unknown): Decision {
    const receipt = strict(stepReceiptSchema, input);
    return this.#transaction(snapshot => {
      const run = this.#run(snapshot, campaignId), gate = this.#gate(run); if (gate) return gate;
      const s = this.#step(run, receipt.stepId), p = run.steps.get(s.stepId)!;
      if (p.state !== "DISPATCHED") throw new Error("Observation requires dispatch");
      if (receipt.campaignId !== campaignId || receipt.manifestSha256 !== run.manifestSha256 || receipt.operationId !== operationId(run.manifest, s)
        || receipt.inputDigest !== s.inputDigest || receipt.postconditionDigest !== s.postconditionDigest) return this.#stop(run, "VERIFICATION_MISMATCH");
      this.#fresh(run, receipt.observedAt);
      const dispatched = snapshot.events.find(e => e.campaignId === campaignId && e.stepId === s.stepId && e.event === "STEP_DISPATCHED")!;
      if (receipt.observedAt < dispatched.timestamp) return this.#stop(run, "VERIFICATION_MISMATCH");
      this.#append(run, "STEP_OBSERVED", { step: s, receipt, evidence: receipt.evidenceRoot }); return { kind: "WAITING_DEPENDENCY", reason: null };
    });
  }
  verify(campaignId: string, input: unknown): Decision {
    const receipt = strict(verificationReceiptSchema, input);
    return this.#transaction(snapshot => {
      const run = this.#run(snapshot, campaignId), gate = this.#gate(run); if (gate) return gate;
      const s = this.#step(run, receipt.stepId), p = run.steps.get(s.stepId)!;
      if (p.state !== "OBSERVED") throw new Error("Verification requires observation");
      if (receipt.campaignId !== campaignId || receipt.manifestSha256 !== run.manifestSha256 || receipt.operationId !== operationId(run.manifest, s)
        || receipt.observedReceiptSha256 !== p.receiptSha256 || receipt.postconditionDigest !== s.postconditionDigest) return this.#stop(run, "VERIFICATION_MISMATCH");
      this.#fresh(run, receipt.verifiedAt);
      const observed = snapshot.events.find(e => e.campaignId === campaignId && e.stepId === s.stepId && e.event === "STEP_OBSERVED")!;
      if (receipt.verifiedAt < observed.timestamp) return this.#stop(run, "VERIFICATION_MISMATCH");
      this.#append(run, "STEP_VERIFIED", { step: s, receipt, evidence: receipt.evidenceRoot }); p.state = "VERIFIED";
      this.#advance(run); return { kind: "COMPLETE", reason: null };
    });
  }
  resumeCeremony(campaignId: string, input: unknown): Decision {
    const receipt = strict(ceremonyReceiptSchema, input);
    return this.#transaction(snapshot => {
      const run = this.#run(snapshot, campaignId), gate = this.#gate(run); if (gate) return gate;
      if (!run.waiting) throw new Error("No waiting ceremony");
      const s = this.#step(run, run.waiting), c = run.manifest.humanCeremonies.find(c => c.ceremonyId === s.ceremonyId)!;
      if (receipt.campaignId !== campaignId || receipt.manifestSha256 !== run.manifestSha256 || receipt.ceremonyId !== c.ceremonyId
        || receipt.operatorIdentity !== c.operatorIdentity || receipt.executionHostIdentity !== run.manifest.executor.executionHostIdentity
        || receipt.evidenceDigest !== c.expectedEvidenceDigest || this.#timestamp() >= c.expiresAt) throw new Error("Ceremony receipt binding");
      this.#fresh(run, receipt.completedAt);
      const waiting = snapshot.events.find(e => e.campaignId === campaignId && e.stepId === s.stepId && e.event === "HUMAN_CEREMONY_WAIT")!;
      if (receipt.completedAt < waiting.timestamp) throw new Error("Ceremony receipt predates wait");
      this.#append(run, "HUMAN_CEREMONY_RESUMED", { step: s, receipt, evidence: receipt.evidenceDigest });
      run.steps.get(s.stepId)!.state = "VERIFIED"; run.waiting = null; this.#advance(run); return { kind: "COMPLETE", reason: null };
    });
  }
  cancel(input: unknown): Decision {
    const receipt = strict(cancellationSchema, input);
    return this.#transaction(snapshot => {
      const run = this.#run(snapshot, receipt.campaignId);
      if (terminal(run.state)) throw new Error("Terminal campaign");
      if (receipt.manifestSha256 !== run.manifestSha256 || receipt.authorizationNonce !== run.manifest.authorizationNonce
        || receipt.operatorIdentity !== run.manifest.executor.operatorIdentity || receipt.executionHostIdentity !== run.manifest.executor.executionHostIdentity) throw new Error("Human cancellation binding");
      this.#fresh(run, receipt.cancelledAt);
      const state = this.#uncertain(run) ? "RECONCILE_REQUIRED" : "BLOCKED";
      this.#append(run, state === "BLOCKED" ? "CAMPAIGN_BLOCKED" : "RECONCILE_REQUIRED", { state, reason: "CANCELLED", receipt });
      this.#owned.delete(receipt.campaignId); return { kind: state, reason: "CANCELLED" };
    });
  }
  recordCutover(input: unknown): void {
    const receipt = strict(cutoverReceiptSchema, input);
    this.#transaction(snapshot => {
      const run = this.#run(snapshot, receipt.campaignId);
      if (run.state !== "READY_FOR_PASSKEY_CUTOVER" || !this.#owned.has(receipt.campaignId)
        || this.#timestamp() >= run.manifest.validity.expiresAt || receipt.manifestSha256 !== run.manifestSha256
        || receipt.trustDomainId !== run.manifest.trustDomainId || receipt.evidenceRoot !== run.manifest.cutover.requiredEvidenceRoot
        || receipt.protocolSha256 !== run.manifest.cutover.irreversibleProtocolSha256) throw new Error("Cutover binding");
      this.#fresh(run, receipt.recordedAt);
      this.#append(run, receipt.mode, { receipt, evidence: receipt.evidenceRoot });
      const sequence = this.#db.prepare("SELECT MAX(sequence) AS sequence FROM journal").get()!.sequence;
      this.#db.prepare("INSERT INTO tombstones(sequence,trust_domain,mode,campaign_id) VALUES(?,?,?,?)").run(sequence, receipt.trustDomainId, receipt.mode, receipt.campaignId);
    });
  }
  complete(campaignId: string): void {
    this.#transaction(snapshot => {
      const run = this.#run(snapshot, campaignId);
      if (run.state !== "READY_FOR_PASSKEY_CUTOVER" || run.mode !== "PASSKEY_ONLY" || !this.#owned.has(campaignId)) throw new Error("Completion gate");
      this.#append(run, "COMPLETE", { state: "COMPLETE" });
    }); this.#owned.delete(campaignId);
  }
  #validateContinuation(m: Manifest, snapshot: Snapshot): void {
    const c = m.continuation!, prior = this.#run(snapshot, c.previousCampaignId);
    if (prior.state !== "BLOCKED" || prior.reason !== "CONTINUATION_AUTHORIZATION_REQUIRED" || this.#uncertain(prior)
      || c.previousManifestSha256 !== prior.manifestSha256 || c.originalCampaignId !== (prior.manifest.continuation?.originalCampaignId ?? prior.manifest.campaignId)
      || c.originalManifestSha256 !== (prior.manifest.continuation?.originalManifestSha256 ?? prior.manifestSha256)
      || canonicalJson(c.previousCheckpoint) !== canonicalJson(prior.checkpoint)
      || canonicalJson(c.lastVerifiedCheckpoint) !== canonicalJson(prior.lastVerifiedCheckpoint)) throw new Error("Continuation requires safe terminal boundary");
    const receipts = prior.manifest.steps.filter(s => prior.steps.get(s.stepId)!.state === "VERIFIED").map(s => ({ stepId: s.stepId,
      receiptSha256: prior.steps.get(s.stepId)!.receiptSha256!, evidenceRoot: prior.steps.get(s.stepId)!.evidenceRoot! }));
    const remaining = prior.manifest.steps.filter(s => prior.steps.get(s.stepId)!.state !== "VERIFIED").map(s => s.stepId);
    if (canonicalJson(c.verifiedReceipts) !== canonicalJson(receipts) || canonicalJson(c.remainingStepIds) !== canonicalJson(remaining)) throw new Error("Continuation receipts/remaining steps mismatch");
    const scope = (manifest: Manifest) => { const { campaignId, authorizationNonce, validity, continuation, ...rest } = manifest; return rest; };
    if (canonicalJson(scope(m)) !== canonicalJson(scope(prior.manifest)) || m.campaignId === prior.manifest.campaignId
      || m.authorizationNonce === prior.manifest.authorizationNonce || m.validity.expiresAt > prior.manifest.validity.expiresAt
      || m.validity.notBefore < prior.manifest.validity.notBefore || m.validity.maxClockSkewMs !== prior.manifest.validity.maxClockSkewMs
      || m.validity.observationMaxAgeMs !== prior.manifest.validity.observationMaxAgeMs) throw new Error("Continuation scope/expiry change");
    this.#fresh({ ...prior, manifest: m }, c.observedAt);
    if (snapshot.events.find(e => e.sequence === c.previousCheckpoint.sequence)!.timestamp > c.observedAt) throw new Error("Continuation observation predates boundary");
    if ([...snapshot.runs.values()].some(r => r.manifest.continuation?.previousCampaignId === c.previousCampaignId)) throw new Error("Continuation already allocated");
  }
}
