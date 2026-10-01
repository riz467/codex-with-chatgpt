import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { BootstrapCampaignExecutor, StoreOutcomeUnknownError, type LocalHighWatermark } from "../src/bootstrap-campaign/executor.js";
import { catalogSha256, manifestHash, parseManifest, type Checkpoint, type Manifest } from "../src/bootstrap-campaign/contract.js";
import { canonicalJson, digest, parseJson } from "../src/bootstrap-campaign/hash.js";
import { operationId, verifyChain, zeroHash } from "../src/bootstrap-campaign/journal.js";
import { assertTransition, states } from "../src/bootstrap-campaign/state-machine.js";

const H = "a".repeat(64), B = "b".repeat(64), baseTime = Date.parse("2026-10-01T10:00:00.000Z");
const time = (delta = 0) => new Date(baseTime + delta).toISOString();
function manifest(): Manifest {
  const placeholder = (kind: string) => ({ schemaVersion: 1, kind, status: "NOT_IMPLEMENTED", contractSha256: H });
  const steps = ["first", "second", "third"].map((stepId, i) => ({ stepId, operationKind: "TEST_MUTATION", targetRef: "OFFLINE_FIXTURE",
    phase: ["PREFLIGHT", "CREATING", "KEYING"][i], dependencies: i ? [["first", "second"][i - 1]] : [], inputDigest: H,
    preconditionDigest: H, postconditionDigest: H, timeoutMs: 30_000, maxMutationAttempts: 1,
    expectedReceipt: { schemaVersion: 1, kind: "OfflineTestStepReceipt" }, ceremonyId: null }));
  return parseManifest({ schemaVersion: 1, kind: "SecurityTrustBootstrapCampaign", campaignId: randomUUID(), authorizationNonce: randomUUID(),
    trustDomainId: "tp-bootstrap-fixture-test", validity: { notBefore: time(-1000), authorizeBefore: time(3600_000), expiresAt: time(7200_000),
      maxClockSkewMs: 5000, observationMaxAgeMs: 300_000 },
    sources: { schemaVersion: 1, kind: "OfflineSourceBinding", buildCommit: "a".repeat(40), sourceTreeSha256: H, evidenceRoot: H, cleanBuild: true },
    executor: { schemaVersion: 1, kind: "OfflineFixedExecutor", artifactId: "fixture", executorSha256: H, payloadSha256: H,
      runtimeIdentity: "node-test", osIdentity: "offline-test", executionHostIdentity: "human-pc", operatorIdentity: "human",
      catalogVersion: 1, catalogSha256 },
    policyAdoptions: placeholder("PolicyAdoptionsPlaceholder"), ctManifests: placeholder("CtManifestsPlaceholder"),
    artifacts: placeholder("ArtifactsPlaceholder"), network: placeholder("NetworkPlaceholder"), keyTopology: placeholder("KeyTopologyPlaceholder"),
    authority: placeholder("AuthorityPlaceholder"), steps,
    allowedMutations: steps.map(s => ({ stepId: s.stepId, targetRef: s.targetRef, operationKind: s.operationKind, inputDigest: s.inputDigest, phase: s.phase })),
    forbiddenMutations: ["PRODUCTION", "ARBITRARY_EXECUTION", "ROLLBACK", "RETRY", "REKEY", "SCOPE_CHANGE", "MANIFEST_PATCH"],
    expectedPostCreateState: placeholder("PostCreateStatePlaceholder"), humanCeremonies: [], verification: placeholder("VerificationPlaceholder"),
    stopConditions: ["UNKNOWN", "MISMATCH", "EXPIRED", "CANCELLED", "CLOCK_ROLLBACK"],
    reconciliationPolicy: { schemaVersion: 1, kind: "NewBoundedAuthorizationOnly", automaticRetry: false },
    cutover: { schemaVersion: 1, kind: "OfflineCutoverModel", requiredEvidenceRoot: H, irreversibleProtocolSha256: H, productionMode: "PASSKEY_ONLY" },
    audit: { schemaVersion: 1, kind: "LocalJournalContract", journalId: "fixture-journal", ownerIdentity: "human",
      externalAnchor: "IR_08_NOT_IMPLEMENTED", hashChain: "SHA256_BOOTSTRAP_JOURNAL_V1", redaction: "HASHES_AND_ENUMS_ONLY", maxEvents: 1000, retention: "PERMANENT" }, continuation: null });
}
function authorization(m: Manifest) {
  return { schemaVersion: 1, kind: "BootstrapLocalAuthorizationReceipt", domain: "bootstrap-human-admin-local-v1", campaignId: m.campaignId,
    manifestSha256: manifestHash(m), authorizationNonce: m.authorizationNonce, executorSha256: m.executor.executorSha256, trustDomainId: m.trustDomainId,
    authorizedAt: time(), expiresAt: m.validity.expiresAt, operatorIdentity: "human", executionHostIdentity: "human-pc", sourceEvidenceRoot: H,
    authorizationTextDigest: H, messageReference: null, localAttestationDigest: H, verificationMethod: "INDEPENDENT_HUMAN_ADMIN_PC", productionApproval: false };
}
class Anchor implements LocalHighWatermark {
  checkpoint: Checkpoint = { sequence: 0, eventHash: zeroHash };
  read() { return structuredClone(this.checkpoint); }
  advance(previous: Checkpoint, next: Checkpoint) {
    if (canonicalJson(previous) !== canonicalJson(this.checkpoint) || next.sequence < previous.sequence) throw new Error("Anchor CAS");
    this.checkpoint = structuredClone(next);
  }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });
function fixture(m = manifest()) {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-campaign-")), path = join(dir, "campaign.sqlite");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const anchor = new Anchor(); let now = baseTime, failure: string | null = null;
  const open = () => {
    const db = new DatabaseSync(path);
    cleanup.push(() => { try { db.close(); } catch {} });
    return new BootstrapCampaignExecutor({ database: db, highWatermark: anchor, now: () => now,
      failureInjection: point => { if (point === failure) throw new Error("Injected storage failure"); } });
  };
  let core = open();
  const f = { m, path, anchor, open, get core() { return core; }, now: (delta: number) => { now = baseTime + delta; },
    fail: (point: string | null) => { failure = point; },
    prepare: () => core.prepare(m), register: () => core.registerAuthorization(authorization(m)),
    start: () => { f.prepare(); f.register(); core.activate(m.campaignId); },
    restart: () => { core.close(); core = open(); return core; },
    intent: (stepId = "first") => core.intent(m.campaignId, observation(m, stepId)),
    dispatch: (stepId = "first") => core.dispatch(m.campaignId, stepId),
    observed: (stepId = "first") => core.observe(m.campaignId, observed(m, stepId)),
    verified: (stepId = "first") => verify(core, m, stepId),
    finish: (stepId: string) => { f.intent(stepId); f.dispatch(stepId); f.observed(stepId); f.verified(stepId); },
    raw: (fn: (db: DatabaseSync) => void) => { const db = new DatabaseSync(path); try { fn(db); } finally { db.close(); } },
  };
  return f;
}
function observation(m: Manifest, stepId: string) {
  return { schemaVersion: 1, kind: "OfflinePreconditionObservation", campaignId: m.campaignId, manifestSha256: manifestHash(m), stepId,
    preconditionDigest: H, evidenceRoot: H, observedAt: time() };
}
function observed(m: Manifest, stepId: string) {
  return { schemaVersion: 1, kind: "OfflineTestStepReceipt", campaignId: m.campaignId, manifestSha256: manifestHash(m), stepId,
    operationId: operationId(m, m.steps.find(s => s.stepId === stepId)!), inputDigest: H, postconditionDigest: H, evidenceRoot: H, observedAt: time(), result: "OBSERVED" };
}
function verify(core: BootstrapCampaignExecutor, m: Manifest, stepId: string) {
  return core.verify(m.campaignId, { schemaVersion: 1, kind: "OfflineVerificationReceipt", campaignId: m.campaignId, manifestSha256: manifestHash(m), stepId,
    operationId: operationId(m, m.steps.find(s => s.stepId === stepId)!), observedReceiptSha256: core.inspect(m.campaignId).steps.get(stepId)!.receiptSha256,
    postconditionDigest: H, evidenceRoot: H, verifiedAt: time() });
}
function cancellation(m: Manifest) {
  return { schemaVersion: 1, kind: "BootstrapHumanCancellationReceipt", domain: "bootstrap-human-admin-cancellation-v1", campaignId: m.campaignId,
    manifestSha256: manifestHash(m), authorizationNonce: m.authorizationNonce, operatorIdentity: "human", executionHostIdentity: "human-pc",
    cancelledAt: time(), localAttestationDigest: H };
}
function continuation(f: ReturnType<typeof fixture>): Manifest {
  const prior = f.core.inspect(f.m.campaignId), m = structuredClone(f.m);
  m.campaignId = randomUUID(); m.authorizationNonce = randomUUID();
  m.continuation = { schemaVersion: 1, kind: "BootstrapBoundedContinuation", originalCampaignId: f.m.campaignId, originalManifestSha256: manifestHash(f.m),
    previousCampaignId: f.m.campaignId, previousManifestSha256: manifestHash(f.m), previousCheckpoint: prior.checkpoint,
    lastVerifiedCheckpoint: prior.lastVerifiedCheckpoint,
    verifiedReceipts: f.m.steps.filter(s => prior.steps.get(s.stepId)!.state === "VERIFIED").map(s => ({ stepId: s.stepId,
      receiptSha256: prior.steps.get(s.stepId)!.receiptSha256!, evidenceRoot: prior.steps.get(s.stepId)!.evidenceRoot! })),
    freshObservationRoot: H, observedAt: time(), remainingStepIds: f.m.steps.filter(s => prior.steps.get(s.stepId)!.state !== "VERIFIED").map(s => s.stepId) };
  return m;
}
function ceremonyManifest() {
  const m = manifest(); m.steps[0].operationKind = "TEST_HUMAN_CEREMONY"; m.steps[0].ceremonyId = "enroll"; m.allowedMutations.shift();
  m.humanCeremonies = [{ schemaVersion: 1, ceremonyId: "enroll", kind: "TEST_PASSKEY_ENROLLMENT", operatorIdentity: "human",
    expiresAt: m.validity.expiresAt, expectedEvidenceDigest: H }]; return parseManifest(m);
}
function ceremony(m: Manifest) {
  return { schemaVersion: 1, kind: "BootstrapOfflineCeremonyReceipt", domain: "bootstrap-offline-ceremony-v1", campaignId: m.campaignId,
    manifestSha256: manifestHash(m), ceremonyId: "enroll", operatorIdentity: "human", executionHostIdentity: "human-pc", completedAt: time(),
    evidenceDigest: H, localAttestationDigest: H };
}
function cutover(m: Manifest, mode: "BOOTSTRAP_DISABLED_PENDING" | "PASSKEY_ONLY") {
  return { schemaVersion: 1, kind: "OfflineCutoverModelReceipt", domain: "bootstrap-offline-cutover-model-v1", campaignId: m.campaignId,
    manifestSha256: manifestHash(m), trustDomainId: m.trustDomainId, mode, evidenceRoot: H, protocolSha256: H, recordedAt: time(), productionPasskeyEvidence: false };
}

function persistentSettings(db: DatabaseSync) {
  return { journalMode: db.prepare("PRAGMA journal_mode").get()?.journal_mode,
    applicationId: db.prepare("PRAGMA application_id").get()?.application_id,
    userVersion: db.prepare("PRAGMA user_version").get()?.user_version,
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all() };
}
function durableBytes(path: string) {
  // SHM contains transient locks/read marks, not durable database content.
  const read = (file: string) => existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  return { main: read(path), wal: read(path + "-wal"), rollbackJournal: read(path + "-journal") };
}

describe("IR-01 per-campaign journal capacity hardening", () => {
  it("isolates campaign budgets across restart, enforces the exact limit, and preserves global sequence", () => {
    const budgetManifest = () => {
      const m = manifest(); m.audit.maxEvents = 100;
      m.steps = Array.from({ length: 25 }, (_, i) => ({ ...m.steps[0], stepId: `step-${i}`, phase: "PREFLIGHT" as const,
        dependencies: i ? [`step-${i - 1}`] : [] }));
      m.allowedMutations = m.steps.map(s => ({ stepId: s.stepId, targetRef: s.targetRef, operationKind: "TEST_MUTATION" as const,
        inputDigest: s.inputDigest, phase: s.phase }));
      return parseManifest(m);
    };
    const a = budgetManifest(), b = budgetManifest(), f = fixture(a);
    f.start();
    for (const s of a.steps.slice(0, 20)) f.finish(s.stepId);
    f.core.cancel(cancellation(a));
    const aEvents = f.core.journal(); expect(aEvents).toHaveLength(86);
    f.core.prepare(b);
    // B is still un-authorized: restart allows new authorization, not old authority reuse.
    f.restart(); f.core.registerAuthorization(authorization(b)); f.core.activate(b.campaignId);
    for (const s of b.steps.slice(0, 23)) {
      f.core.intent(b.campaignId, observation(b, s.stepId)); f.core.dispatch(b.campaignId, s.stepId);
      f.core.observe(b.campaignId, observed(b, s.stepId)); verify(f.core, b, s.stepId);
    }
    expect(f.core.journal().filter(e => e.campaignId === b.campaignId)).toHaveLength(97);
    const next = b.steps[23].stepId;
    f.core.intent(b.campaignId, observation(b, next)); f.core.dispatch(b.campaignId, next);
    f.core.observe(b.campaignId, observed(b, next));
    const atLimit = f.core.journal(), checkpoint = f.anchor.read();
    expect(atLimit.filter(e => e.campaignId === b.campaignId)).toHaveLength(b.audit.maxEvents);
    expect(atLimit.filter(e => e.campaignId === a.campaignId)).toEqual(aEvents);
    expect(atLimit.map(e => e.sequence)).toEqual(Array.from({ length: 186 }, (_, i) => i + 1));
    expect(verifyChain(atLimit)).toEqual(atLimit);
    expect(() => verify(f.core, b, next)).toThrow("Journal capacity STOP");
    expect(f.core.journal()).toEqual(atLimit); expect(f.anchor.read()).toEqual(checkpoint);
    expect(f.core.inspect(b.campaignId).steps.get(next)?.state).toBe("OBSERVED");
    f.restart();
    expect(f.core.journal()).toEqual(atLimit);
    // Recovery is also an append; restart cannot reset or borrow another campaign's budget.
    expect(() => f.core.recover(b.campaignId)).toThrow("Journal capacity STOP");
    expect(f.core.journal()).toEqual(atLimit); expect(f.anchor.read()).toEqual(checkpoint);
    const c = manifest(); c.audit.maxEvents = 100;
    f.core.prepare(c);
    expect(f.core.journal().slice(-2).map(e => e.sequence)).toEqual([187, 188]);
    expect(f.core.journal().filter(e => e.campaignId === c.campaignId)).toHaveLength(2);
  }, 60_000);
});

describe("IR-01 existing database no-repair hardening", () => {
  it("opens valid existing WAL without changing persistent bytes/settings, while configuring the connection", () => {
    const f = fixture(); f.start(); const events = f.core.journal(); f.core.close();
    const closedBefore = durableBytes(f.path), db = new DatabaseSync(f.path);
    try {
      db.exec("PRAGMA synchronous=OFF; PRAGMA foreign_keys=OFF");
      const before = persistentSettings(db), openBefore = durableBytes(f.path);
      const core = new BootstrapCampaignExecutor({ database: db, highWatermark: f.anchor, now: () => baseTime });
      expect(core.journal()).toEqual(events);
      expect(persistentSettings(db)).toEqual(before); expect(durableBytes(f.path)).toEqual(openBefore);
      expect(db.prepare("PRAGMA synchronous").get()?.synchronous).toBe(2);
      expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    } finally { db.close(); }
    expect(durableBytes(f.path)).toEqual(closedBefore);
  });
  it.each([
    ["altered DELETE journal mode", "PRAGMA journal_mode=DELETE"],
    ["old user_version", "PRAGMA user_version=0"],
    ["wrong application_id", "PRAGMA application_id=1"],
    ["malformed schema", "DROP TRIGGER journal_no_delete"],
  ])("rejects %s without repairing bytes or persistent settings", (_fault, tamper) => {
    const f = fixture(); f.start(); f.core.close(); f.raw(db => db.exec(tamper));
    const closedBefore = durableBytes(f.path), checkpoint = f.anchor.read(), db = new DatabaseSync(f.path);
    let before: ReturnType<typeof persistentSettings>;
    try {
      before = persistentSettings(db); const openBefore = durableBytes(f.path);
      if (tamper.includes("journal_mode")) expect(before.journalMode).toBe("delete");
      expect(() => new BootstrapCampaignExecutor({ database: db, highWatermark: f.anchor, now: () => baseTime })).toThrow();
      expect(persistentSettings(db)).toEqual(before); expect(durableBytes(f.path)).toEqual(openBefore);
      expect(f.anchor.read()).toEqual(checkpoint);
    } finally { db.close(); }
    expect(durableBytes(f.path)).toEqual(closedBefore);
    f.raw(check => expect(persistentSettings(check)).toEqual(before));
    expect(durableBytes(f.path)).toEqual(closedBefore);
  });
  it("initializes only a completely empty unversioned DB with the exact zero checkpoint", () => {
    const f = fixture(), path = f.path + "-new", db = new DatabaseSync(path), anchor = new Anchor();
    try {
      expect(persistentSettings(db)).toEqual({ journalMode: "delete", applicationId: 0, userVersion: 0, schema: [] });
      const core = new BootstrapCampaignExecutor({ database: db, highWatermark: anchor, now: () => baseTime });
      expect(core.journal()).toEqual([]);
      expect(persistentSettings(db)).toMatchObject({ journalMode: "wal", applicationId: 1111707697, userVersion: 1 });
      expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
      expect(anchor.read()).toEqual({ sequence: 0, eventHash: zeroHash });
    } finally { db.close(); }
  });
  it.each(["versioned", "application-id", "schema", "checkpoint-sequence", "checkpoint-hash"])
    ("does not initialize an otherwise empty DB with %s", fault => {
      const f = fixture(), path = f.path + "-not-new", db = new DatabaseSync(path), anchor = new Anchor();
      try {
        if (fault === "versioned") db.exec("PRAGMA user_version=1");
        if (fault === "application-id") db.exec("PRAGMA application_id=1111707697");
        if (fault === "schema") db.exec("CREATE TABLE unrelated(x)");
        if (fault === "checkpoint-sequence") anchor.checkpoint = { sequence: 1, eventHash: H };
        if (fault === "checkpoint-hash") anchor.checkpoint = { sequence: 0, eventHash: H };
        const settings = persistentSettings(db), bytes = durableBytes(path);
        expect(() => new BootstrapCampaignExecutor({ database: db, highWatermark: anchor, now: () => baseTime })).toThrow();
        expect(persistentSettings(db)).toEqual(settings); expect(durableBytes(path)).toEqual(bytes);
        db.close(); expect(durableBytes(path)).toEqual(bytes);
      } finally { try { db.close(); } catch {} }
    });
});

describe("IR-01 strict manifest / hash", () => {
  it("valid closed v1 manifest and DAG", () => { const m = manifest(); expect(parseManifest(JSON.stringify(m))).toEqual(m); });
  it.each(["top", "executor", "placeholder", "step", "self-hash"])("rejects unknown field: %s", where => {
    const m: any = manifest(); const target = where === "executor" ? m.executor : where === "placeholder" ? m.network : where === "step" ? m.steps[0] : m;
    target[where === "self-hash" ? "manifestSha256" : "unknown"] = H; expect(() => parseManifest(m)).toThrow();
  });
  it.each([undefined, NaN, -0, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5, 1n, Symbol("x"), () => 1, new Date(), Object.create(null)])("rejects non-JSON %s", value => {
    const m: any = manifest(); m.extra = value; expect(() => canonicalJson(m)).toThrow();
  });
  it("does not invoke getters", () => {
    let calls = 0; const m = manifest(); Object.defineProperty(m.executor, "artifactId", { get() { calls++; return "fixture"; }, enumerable: true });
    expect(() => parseManifest(m)).toThrow(); expect(calls).toBe(0);
  });
  it("rejects custom prototypes, symbols, holes and non-enumerable properties", () => {
    const m = manifest(); Object.setPrototypeOf(m.executor, { hidden: true }); expect(() => parseManifest(m)).toThrow();
    for (const v of [Object.assign({}, { [Symbol("x")]: 1 }), Array(2), Object.defineProperty({}, "x", { value: 1 })]) expect(() => canonicalJson(v)).toThrow();
  });
  it("rejects cycles and invalid Unicode", () => { const a: any = {}; a.a = a; expect(() => canonicalJson(a)).toThrow(); expect(() => canonicalJson("\ud800")).toThrow(); });
  it("sorts recursive keys and uses exact UTF-8 domain without trailing newline", () => {
    const m = manifest(), reversed = Object.fromEntries(Object.entries(m).reverse());
    expect(manifestHash(m)).toBe(manifestHash(reversed));
    expect(manifestHash(m)).toBe(createHash("sha256").update("security-trust-bootstrap-campaign-v1\n" + canonicalJson(m), "utf8").digest("hex"));
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: "日本語" })).toBe('{"a":"日本語","z":[{"a":1,"b":2}]}');
  });
  it("field tamper and array order change digest", () => {
    const m = manifest(), hash = manifestHash(m); m.executor.payloadSha256 = B; expect(manifestHash(m)).not.toBe(hash);
    const second = manifestHash(m); m.steps.reverse(); m.allowedMutations.reverse(); expect(manifestHash(m)).not.toBe(second);
  });
  it("separates manifest, Typed Action and receipt domains", () => {
    const m = manifest(); expect(manifestHash(m)).not.toBe(digest("typed-action-v1", m)); expect(manifestHash(m)).not.toBe(digest("bootstrap-receipt-v1", m));
  });
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":1}}', '\ufeff{}', '{}x', '{"a":-0}', '{"a":9007199254740992}', '[1,]', '{"a":1,}'])
    ("rejects ambiguous/invalid wire JSON %s", text => { expect(() => parseJson(text)).toThrow(); });
  it.each(["cycle", "missing", "duplicate", "over-limit", "unknown-operation", "backward-phase", "wrong-catalog"])("rejects DAG %s", fault => {
    const m: any = manifest();
    if (fault === "cycle") { m.steps[0].phase = "KEYING"; m.allowedMutations[0].phase = "KEYING"; m.steps[0].dependencies = ["third"]; }
    if (fault === "missing") m.steps[0].dependencies = ["absent"];
    if (fault === "duplicate") m.steps[1].stepId = "first";
    if (fault === "over-limit") m.steps = Array(257).fill(m.steps[0]);
    if (fault === "unknown-operation") m.steps[0].operationKind = "PVE_CREATE";
    if (fault === "backward-phase") m.steps[0].dependencies = ["third"];
    if (fault === "wrong-catalog") m.executor.catalogSha256 = B;
    expect(() => parseManifest(m)).toThrow();
  });
});

describe("IR-01 authorization, identity and storage", () => {
  it("registers independent-PC receipt idempotently, persistently, without production approval", () => {
    const f = fixture(); f.prepare(); f.register(); f.register();
    expect(f.core.journal().filter(e => e.event === "AUTHORIZATION_REGISTERED")).toHaveLength(1);
    f.restart(); expect(f.core.inspect(f.m.campaignId).authorized).toBe(true);
    f.register(); expect(() => f.core.activate(f.m.campaignId)).toThrow("CONTINUATION");
  });
  it.each(["manifestSha256", "campaignId", "authorizationNonce", "executorSha256", "trustDomainId", "operatorIdentity", "executionHostIdentity", "expiresAt", "domain", "productionApproval"])
    ("rejects wrong authorization binding %s", field => {
      const f = fixture(); f.prepare(); const a: any = authorization(f.m);
      a[field] = field === "productionApproval" ? true : field === "expiresAt" ? time(8000_000) : field.endsWith("Sha256") ? B : field === "campaignId" || field === "authorizationNonce" ? randomUUID() : "wrong";
      expect(() => f.core.registerAuthorization(a)).toThrow();
    });
  it("rejects expired receipt and late registration", () => {
    const f = fixture(); f.prepare(); f.now(7200_000); expect(() => f.register()).toThrow();
    f.now(3600_000); expect(() => f.register()).toThrow();
  });
  it.each(["nonce", "campaign"])("permanently rejects %s replay / altered manifest", field => {
    const f = fixture(); f.start(); const m = manifest();
    if (field === "nonce") m.authorizationNonce = f.m.authorizationNonce; else m.campaignId = f.m.campaignId;
    m.executor.payloadSha256 = B; expect(() => f.core.prepare(m)).toThrow();
  });
  it("rejects altered exact authorization duplicate", () => {
    const f = fixture(); f.prepare(); f.register(); expect(() => f.core.registerAuthorization({ ...authorization(f.m), localAttestationDigest: B })).toThrow();
  });
  it.each(["authorizations", "campaigns", "activations", "receipts", "journal"])("append-only %s rejects UPDATE and DELETE", table => {
    const f = fixture(); f.start(); f.raw(db => {
      const column = table === "receipts" ? "body" : table === "journal" ? "body" : "campaign_id";
      expect(() => db.exec(`UPDATE ${table} SET ${column}=${column}`)).toThrow("append-only");
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow("append-only");
    });
  });
  it("requires durable dedicated DB, WAL/FULL/FK, application ID/version", () => {
    const db = new DatabaseSync(":memory:"); try { expect(() => new BootstrapCampaignExecutor({ database: db, highWatermark: new Anchor(), now: () => baseTime })).toThrow(); } finally { db.close(); }
    const f = fixture(); f.prepare(); f.raw(db2 => {
      expect(db2.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(db2.prepare("PRAGMA application_id").get()?.application_id).toBe(1111707697);
      expect(db2.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    });
  });
  it.each(["trigger", "table", "old-schema", "application-id"])("rejects schema tamper %s without repair", fault => {
    const f = fixture(); f.prepare();
    f.raw(db => db.exec(fault === "trigger" ? "DROP TRIGGER journal_no_delete" : fault === "table" ? "CREATE TABLE surprise(x)" : fault === "old-schema" ? "PRAGMA user_version=2" : "PRAGMA application_id=1"));
    expect(() => f.open()).toThrow();
    f.raw(db => { if (fault === "trigger") expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='journal_no_delete'").get()).toBeUndefined(); });
  });
  it("rejects malformed DB", () => {
    const f = fixture(); f.core.close(); writeFileSync(f.path, "not sqlite"); expect(() => f.open()).toThrow();
  });
  it("concurrent activation yields exactly one owner across connections", async () => {
    const f = fixture(); f.prepare(); f.register(); const second = f.open(); second.registerAuthorization(authorization(f.m));
    const results = await Promise.allSettled([Promise.resolve().then(() => f.core.activate(f.m.campaignId)), Promise.resolve().then(() => second.activate(f.m.campaignId))]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(f.core.journal().filter(e => e.event === "CAMPAIGN_AUTHORIZED")).toHaveLength(1);
  });
  it("global campaign lock rejects simultaneous separate campaigns", () => {
    const f = fixture(); f.start(); const m = manifest(); f.core.prepare(m); f.core.registerAuthorization(authorization(m));
    expect(() => f.core.activate(m.campaignId)).toThrow("Global campaign lock");
  });
});

describe("IR-01 uninterrupted state machine and mutation", () => {
  it("has exactly 17 campaign states", () => expect(states).toHaveLength(17));
  it("intent precedes dispatch and direct dispatch is forbidden", () => {
    const f = fixture(); f.start(); expect(() => f.dispatch()).toThrow(); expect(f.intent().kind).toBe("READY_TO_DISPATCH");
    expect(f.core.journal().at(-1)?.event).toBe("STEP_INTENT"); expect(f.dispatch().kind).toBe("READY_TO_DISPATCH");
  });
  it("decisions wait for dependencies and never dispatch adapters", () => {
    const f = fixture(); f.start(); expect(f.core.decision(f.m.campaignId, "third").kind).toBe("WAITING_DEPENDENCY");
    f.intent(); expect(f.core.decision(f.m.campaignId, "first")).toEqual({ kind: "READY_TO_DISPATCH", campaignId: f.m.campaignId,
      stepId: "first", operationId: operationId(f.m, f.m.steps[0]), operationKind: "TEST_MUTATION", targetRef: "OFFLINE_FIXTURE" });
    expect(f.core.inspect(f.m.campaignId).steps.get("first")?.state).toBe("INTENT_DURABLE");
  });
  it("duplicate dispatch and VERIFIED mutation replay are rejected", () => {
    const f = fixture(); f.start(); f.intent(); f.dispatch(); expect(() => f.dispatch()).toThrow(); f.observed(); f.verified();
    expect(() => f.dispatch()).toThrow(); expect(() => f.intent()).toThrow();
  });
  it("concurrent dispatch delivers exactly one decision", async () => {
    const f = fixture(); f.start(); f.intent(); const results = await Promise.allSettled([Promise.resolve().then(() => f.dispatch()), Promise.resolve().then(() => f.dispatch())]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(f.core.journal().filter(e => e.event === "STEP_DISPATCHED")).toHaveLength(1);
  });
  it("uninterrupted DAG advances through every phase with one authorization", () => {
    const f = fixture(); f.start(); f.m.steps.forEach(s => f.finish(s.stepId));
    expect(f.core.inspect(f.m.campaignId).state).toBe("READY_FOR_PASSKEY_CUTOVER");
    expect(f.core.journal().filter(e => e.event === "AUTHORIZATION_REGISTERED")).toHaveLength(1);
    expect(new Set(f.core.journal().map(e => e.state))).toEqual(new Set(states.filter(s => !["COMPLETE", "BLOCKED", "RECONCILE_REQUIRED"].includes(s))));
  });
  it("fixed read-only operation is supported without registering production adapters", () => {
    const m = manifest(); m.steps[0].operationKind = "TEST_READ_ONLY"; m.allowedMutations.shift();
    const f = fixture(m); f.start(); f.finish("first"); expect(f.core.inspect(m.campaignId).steps.get("first")?.state).toBe("VERIFIED");
  });
  it.each(["BLOCKED", "RECONCILE_REQUIRED", "COMPLETE"] as const)("%s is terminal with no ACTIVE transition", state => {
    for (const next of states) expect(() => assertTransition(state, next)).toThrow("Terminal");
  });
  it("rejects stale preconditions and mismatched predicates", () => {
    const f = fixture(); f.start(); expect(() => f.core.intent(f.m.campaignId, { ...observation(f.m, "first"), observedAt: time(-400_000) })).toThrow();
    expect(f.core.intent(f.m.campaignId, { ...observation(f.m, "first"), preconditionDigest: B }).kind).toBe("BLOCKED");
  });
  it("rechecks original observation freshness at dispatch", () => {
    const f = fixture(); f.start();
    f.core.intent(f.m.campaignId, { ...observation(f.m, "first"), observedAt: time(-299_000) });
    f.now(2000); expect(f.dispatch()).toEqual({ kind: "RECONCILE_REQUIRED", reason: "PRECONDITION_MISMATCH" });
    expect(f.core.journal().some(e => e.event === "STEP_DISPATCHED")).toBe(false);
  });
  it("postcondition mismatch retains uncertain mutation", () => {
    const f = fixture(); f.start(); f.intent(); f.dispatch();
    expect(f.core.observe(f.m.campaignId, { ...observed(f.m, "first"), postconditionDigest: B }).kind).toBe("RECONCILE_REQUIRED");
    expect(() => f.core.activate(f.m.campaignId)).toThrow();
  });
  it("timeout stops at intent rather than retrying", () => {
    const f = fixture(); f.start(); f.intent(); f.now(30_000); expect(f.dispatch()).toEqual({ kind: "RECONCILE_REQUIRED", reason: "TIMEOUT" });
  });
  it("clock rollback poisons admission even if clock is restored", () => {
    const f = fixture(); f.start(); f.now(-1); expect(() => f.intent()).toThrow("CLOCK_ROLLBACK");
    f.now(0); expect(() => f.intent()).toThrow(StoreOutcomeUnknownError);
  });
});

describe("IR-01 crash and bounded continuation", () => {
  it("before authorization restart is read-only and permits later new authorization", () => {
    const f = fixture(); f.prepare(); const before = f.core.journal(); f.restart(); expect(f.core.journal()).toEqual(before);
    expect(f.core.recover(f.m.campaignId).kind).toBe("WAITING_DEPENDENCY"); f.register(); f.core.activate(f.m.campaignId); expect(f.intent().kind).toBe("READY_TO_DISPATCH");
  });
  it.each(["registered", "activated", "verified", "ceremony"])("restart at %s requires new continuation authorization", boundary => {
    const f = fixture(boundary === "ceremony" ? ceremonyManifest() : manifest()); f.prepare(); f.register();
    if (boundary !== "registered") f.core.activate(f.m.campaignId);
    if (boundary === "verified") f.finish("first");
    if (boundary === "ceremony") f.core.decision(f.m.campaignId, "first");
    const before = f.core.journal(); f.restart(); expect(f.core.journal()).toEqual(before);
    expect(f.core.recover(f.m.campaignId)).toEqual({ kind: "BLOCKED", reason: "CONTINUATION_AUTHORIZATION_REQUIRED" });
    expect(f.core.decision(f.m.campaignId, "second").kind).toBe("BLOCKED"); expect(() => f.core.activate(f.m.campaignId)).toThrow();
  });
  it.each(["INTENT_DURABLE", "DISPATCHED", "OBSERVED"])("crash after %s always requires reconciliation", boundary => {
    const f = fixture(); f.start(); f.intent(); if (boundary !== "INTENT_DURABLE") f.dispatch(); if (boundary === "OBSERVED") f.observed();
    f.restart(); expect(f.core.recover(f.m.campaignId)).toEqual({ kind: "RECONCILE_REQUIRED", reason: "MUTATION_UNCERTAIN" });
    expect(f.core.inspect(f.m.campaignId).steps.get("first")?.state).toBe(boundary);
    expect(f.dispatch().kind).toBe("RECONCILE_REQUIRED"); expect(() => f.core.prepare(continuation(f))).toThrow();
  });
  it("restart without explicit recover cannot dispatch an old intent", () => {
    const f = fixture(); f.start(); f.intent(); f.restart(); expect(f.dispatch().kind).toBe("RECONCILE_REQUIRED");
    expect(f.core.journal().filter(e => e.event === "STEP_DISPATCHED")).toHaveLength(0);
  });
  it("continuation binds verified receipts and uses new nonce, identity and authorization", () => {
    const f = fixture(); f.start(); f.finish("first"); const previousIdentity = f.core.inspect(f.m.campaignId).executionIdentity;
    f.restart(); f.core.recover(f.m.campaignId); const m = continuation(f); f.core.prepare(m);
    expect(() => f.core.registerAuthorization({ ...authorization(f.m), campaignId: m.campaignId })).toThrow();
    expect(() => f.core.activate(m.campaignId)).toThrow(); f.core.registerAuthorization(authorization(m)); f.core.activate(m.campaignId);
    expect(f.core.inspect(m.campaignId).executionIdentity).not.toBe(previousIdentity);
    expect(f.core.inspect(m.campaignId).steps.get("first")?.state).toBe("VERIFIED");
    expect(() => f.core.intent(m.campaignId, observation(m, "first"))).toThrow();
    expect(f.core.intent(m.campaignId, observation(m, "second")).kind).toBe("READY_TO_DISPATCH");
    f.core.dispatch(m.campaignId, "second"); f.core.observe(m.campaignId, observed(m, "second")); verify(f.core, m, "second");
    expect(f.core.inspect(f.m.campaignId).state).toBe("BLOCKED");
    expect(f.core.journal().filter(e => e.stepId === "first" && e.event === "STEP_DISPATCHED")).toHaveLength(1);
  });
  it.each(["receipts", "remaining", "step", "target", "expiry", "nonce", "checkpoint", "observation"])("rejects continuation %s modification", field => {
    const f = fixture(); f.start(); f.finish("first"); f.restart(); f.core.recover(f.m.campaignId); const m: any = continuation(f);
    if (field === "receipts") m.continuation.verifiedReceipts[0].receiptSha256 = B;
    if (field === "remaining") m.continuation.remainingStepIds.unshift("first");
    if (field === "step") { m.steps[1].inputDigest = B; m.allowedMutations[1].inputDigest = B; }
    if (field === "target") m.steps[1].targetRef = "PRODUCTION";
    if (field === "expiry") m.validity.expiresAt = time(7300_000);
    if (field === "nonce") m.authorizationNonce = f.m.authorizationNonce;
    if (field === "checkpoint") m.continuation.previousCheckpoint.eventHash = B;
    if (field === "observation") m.continuation.observedAt = time(-400_000);
    expect(() => f.core.prepare(m)).toThrow();
  });
  it("prevents branching two continuations from one run", () => {
    const f = fixture(); f.start(); f.restart(); f.core.recover(f.m.campaignId); f.core.prepare(continuation(f));
    expect(() => f.core.prepare(continuation(f))).toThrow("already allocated");
  });
  it("successive continuations retain ancestral last-verified checkpoint", () => {
    const f = fixture(); f.start(); f.finish("first"); const checkpoint = f.core.inspect(f.m.campaignId).lastVerifiedCheckpoint;
    f.restart(); f.core.recover(f.m.campaignId); const m = continuation(f); f.core.prepare(m);
    f.core.registerAuthorization(authorization(m)); f.core.activate(m.campaignId); f.restart(); f.core.recover(m.campaignId);
    const prior = f.core.inspect(m.campaignId); expect(prior.lastVerifiedCheckpoint).toEqual(checkpoint);
    const next = structuredClone(m); next.campaignId = randomUUID(); next.authorizationNonce = randomUUID();
    next.continuation!.previousCampaignId = m.campaignId; next.continuation!.previousManifestSha256 = manifestHash(m);
    next.continuation!.previousCheckpoint = prior.checkpoint;
    f.core.prepare(next); f.core.registerAuthorization(authorization(next)); f.core.activate(next.campaignId);
    expect(f.core.intent(next.campaignId, observation(next, "second")).kind).toBe("READY_TO_DISPATCH");
    expect(f.core.inspect(next.campaignId).steps.get("first")?.receiptSha256).toBe(prior.steps.get("first")?.receiptSha256);
  });
});

describe("IR-01 ceremony, cancel, expiry and tombstones", () => {
  it("waits within phase and resumes only with exact typed ceremony evidence", () => {
    const f = fixture(ceremonyManifest()); f.start(); expect(f.core.decision(f.m.campaignId, "first").kind).toBe("WAITING_HUMAN_CEREMONY");
    expect(f.core.inspect(f.m.campaignId).state).toBe("PREFLIGHT");
    expect(f.core.resumeCeremony(f.m.campaignId, ceremony(f.m)).kind).toBe("COMPLETE"); expect(f.intent("second").kind).toBe("READY_TO_DISPATCH");
  });
  it.each(["boolean", "id", "evidence", "campaign", "operator"])("rejects forged ceremony %s", fault => {
    const f = fixture(ceremonyManifest()); f.start(); f.core.decision(f.m.campaignId, "first"); const r: any = ceremony(f.m);
    if (fault === "boolean") r.completed = true;
    if (fault === "id") r.ceremonyId = "wrong";
    if (fault === "evidence") r.evidenceDigest = B;
    if (fault === "campaign") r.campaignId = randomUUID();
    if (fault === "operator") r.operatorIdentity = "AI";
    expect(() => f.core.resumeCeremony(f.m.campaignId, r)).toThrow(); expect(f.core.inspect(f.m.campaignId).waiting).toBe("first");
  });
  it.each([false, true])("cancel after dispatch=%s preserves execution uncertainty", dispatched => {
    const f = fixture(); f.start(); if (dispatched) { f.intent(); f.dispatch(); }
    expect(f.core.cancel(cancellation(f.m)).kind).toBe(dispatched ? "RECONCILE_REQUIRED" : "BLOCKED");
    expect(f.core.inspect(f.m.campaignId).steps.get("first")?.state).toBe(dispatched ? "DISPATCHED" : "NOT_STARTED");
    f.restart(); expect(() => f.register()).toThrow(); expect(() => f.core.activate(f.m.campaignId)).toThrow();
  });
  it("rejects cancellation from wrong operator", () => {
    const f = fixture(); f.start(); expect(() => f.core.cancel({ ...cancellation(f.m), operatorIdentity: "AI" })).toThrow();
  });
  it.each([false, true])("expiry after dispatch=%s preserves execution uncertainty", dispatched => {
    const f = fixture(); f.start(); if (dispatched) { f.intent(); f.dispatch(); } f.now(7200_000);
    expect(f.core.decision(f.m.campaignId, "first")).toEqual({ kind: dispatched ? "RECONCILE_REQUIRED" : "BLOCKED", reason: "EXPIRED" });
    expect(f.core.inspect(f.m.campaignId).steps.get("first")?.state).toBe(dispatched ? "DISPATCHED" : "NOT_STARTED");
  });
  it("PASSKEY_ONLY permanently rejects bootstrap receipts, old activation and new campaigns", () => {
    const f = fixture(); f.start(); f.m.steps.forEach(s => f.finish(s.stepId));
    expect(() => f.core.recordCutover(cutover(f.m, "PASSKEY_ONLY"))).toThrow();
    f.core.recordCutover(cutover(f.m, "BOOTSTRAP_DISABLED_PENDING"));
    expect(() => f.register()).toThrow(); expect(() => f.core.prepare(manifest())).toThrow();
    f.core.recordCutover(cutover(f.m, "PASSKEY_ONLY")); f.core.complete(f.m.campaignId);
    expect(f.core.inspect(f.m.campaignId).state).toBe("COMPLETE"); f.restart();
    expect(() => f.register()).toThrow(); expect(() => f.core.activate(f.m.campaignId)).toThrow(); expect(() => f.core.prepare(manifest())).toThrow();
    f.raw(db => { expect(() => db.exec("DELETE FROM tombstones")).toThrow("append-only"); expect(() => db.exec("UPDATE tombstones SET mode='BOOTSTRAP_DISABLED_PENDING'")).toThrow("append-only"); });
  });
  it("pending cutover crash never falls back to bootstrap", () => {
    const f = fixture(); f.start(); f.m.steps.forEach(s => f.finish(s.stepId)); f.core.recordCutover(cutover(f.m, "BOOTSTRAP_DISABLED_PENDING"));
    f.restart(); expect(f.core.recover(f.m.campaignId).kind).toBe("BLOCKED"); expect(() => f.core.prepare(manifest())).toThrow();
    expect(() => f.core.recordCutover(cutover(f.m, "PASSKEY_ONLY"))).toThrow();
  });
});

describe("IR-01 journal / failure injection / executor boundary", () => {
  it("validates hash chain, event identities and typed sanitized details", () => {
    const f = fixture(); f.start(); f.finish("first"); const journal = f.core.journal(); expect(verifyChain(journal)).toEqual(journal);
    expect(journal.map(e => e.sequence)).toEqual(journal.map((_, i) => i + 1));
    for (const e of journal) { expect(e.manifestSha256).toBe(manifestHash(f.m)); expect(Object.keys(e.details).sort()).toEqual(["executionIdentity", "reason", "receiptSha256"]); }
  });
  it.each(["hash", "gap", "order", "details"])("rejects journal %s tamper", field => {
    const f = fixture(); f.start(); const rows: any[] = f.core.journal();
    if (field === "hash") rows[0].manifestSha256 = B;
    if (field === "gap") rows.splice(1, 1);
    if (field === "order") rows.reverse();
    if (field === "details") rows[0].details.command = "arbitrary";
    expect(() => verifyChain(rows)).toThrow();
  });
  it("rejects on-disk body tamper even with triggers restored exactly", () => {
    const f = fixture(); f.start(); f.raw(db => {
      const trigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='journal_no_update'").get()!.sql);
      db.exec("DROP TRIGGER journal_no_update"); db.prepare("UPDATE journal SET body=? WHERE sequence=1").run("{}"); db.exec(trigger);
    }); expect(() => f.open()).toThrow();
  });
  it("rejects whole-store rollback using retained local high-watermark", () => {
    const f = fixture(); f.prepare(); const oldPath = join(f.path + "-old");
    // Preserve WAL mode in the rollback fixture; VACUUM INTO creates a DELETE-mode DB.
    f.raw(db => { expect(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0); copyFileSync(f.path, oldPath); });
    f.register(); f.core.activate(f.m.campaignId);
    const old = new DatabaseSync(oldPath); cleanup.push(() => { try { old.close(); } catch {} });
    expect(old.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(() => new BootstrapCampaignExecutor({ database: old, highWatermark: f.anchor, now: () => baseTime })).toThrow("High-watermark");
  });
  it("rejects pre-cutover DB rollback against post-PASSKEY_ONLY checkpoint", () => {
    const f = fixture(); f.start(); f.m.steps.forEach(s => f.finish(s.stepId));
    const oldPath = f.path + "-before-cutover";
    f.raw(db => { expect(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0); copyFileSync(f.path, oldPath); });
    f.core.recordCutover(cutover(f.m, "BOOTSTRAP_DISABLED_PENDING")); f.core.recordCutover(cutover(f.m, "PASSKEY_ONLY"));
    const db = new DatabaseSync(oldPath); cleanup.push(() => { try { db.close(); } catch {} });
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(() => new BootstrapCampaignExecutor({ database: db, highWatermark: f.anchor, now: () => baseTime })).toThrow("High-watermark");
  });
  it("rejects on-disk sequence deletion with exact triggers restored", () => {
    const f = fixture(); f.start(); f.raw(db => {
      const trigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='journal_no_delete'").get()!.sql);
      db.exec("DROP TRIGGER journal_no_delete; DELETE FROM journal WHERE sequence=2"); db.exec(trigger);
    }); expect(() => f.open()).toThrow("Journal chain integrity");
  });
  it("rejects a populated version-zero database without migration", () => {
    const f = fixture(); f.prepare(); f.raw(db => db.exec("PRAGMA user_version=0")); expect(() => f.open()).toThrow();
    f.raw(db => expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(0));
  });
  it("detects unbound receipt insertion", () => {
    const f = fixture(); f.start(); f.raw(db => db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(B, f.m.campaignId, canonicalJson(authorization(f.m))));
    expect(() => f.open()).toThrow("Unbound or malformed receipt");
  });
  it("real parallel workers admit only one activation and mutation dispatch", async () => {
    const f = fixture(); f.prepare();
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 67), words = new Int32Array(shared);
    words[1] = f.anchor.checkpoint.sequence;
    [...f.anchor.checkpoint.eventHash].forEach((c, i) => { words[i + 2] = c.charCodeAt(0); });
    const barrier = new SharedArrayBuffer(4), start = new Int32Array(barrier);
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { tsImport } = await import('tsx/esm/api');
        const { DatabaseSync } = await import('node:sqlite');
        const { BootstrapCampaignExecutor } = await tsImport(workerData.module, workerData.base);
        const a = new Int32Array(workerData.shared), barrier = new Int32Array(workerData.barrier);
        function locked(fn) {
          while (Atomics.compareExchange(a, 0, 0, 1) !== 0) Atomics.wait(a, 0, 1);
          try { return fn(); } finally { Atomics.store(a, 0, 0); Atomics.notify(a, 0); }
        }
        function read() { return { sequence: a[1], eventHash: Array.from(a.slice(2, 66), n => String.fromCharCode(n)).join('') }; }
        const anchor = { read: () => locked(read), advance: (previous, next) => locked(() => {
          if (JSON.stringify(previous) !== JSON.stringify(read())) throw new Error('anchor CAS');
          a[1] = next.sequence; [...next.eventHash].forEach((c, i) => a[i+2] = c.charCodeAt(0));
        }) };
        const db = new DatabaseSync(workerData.path);
        let core;
        try {
          core = new BootstrapCampaignExecutor({ database: db, highWatermark: anchor, now: () => workerData.now });
          parentPort.postMessage({ ready: true });
          Atomics.wait(barrier, 0, 0);
          core.registerAuthorization(workerData.authorization);
          core.activate(workerData.campaignId);
          core.intent(workerData.campaignId, workerData.observation);
          const decision = core.dispatch(workerData.campaignId, 'first');
          parentPort.postMessage({ dispatched: decision.kind === 'READY_TO_DISPATCH' });
        } catch (e) { parentPort.postMessage({ dispatched: false, error: String(e) }); }
        finally { if (core) core.close(); else db.close(); }
      })().catch(e => { parentPort.postMessage({ fatal: String(e) }); });
    `;
    let ready = 0;
    const results = await Promise.all([0, 1].map(() => new Promise<boolean>((resolve, reject) => {
      const worker = new Worker(source, { eval: true, workerData: { shared, barrier, path: f.path, now: baseTime,
        module: pathToFileURL(join(process.cwd(), "src/bootstrap-campaign/executor.ts")).href,
        base: pathToFileURL(join(process.cwd(), "package.json")).href,
        campaignId: f.m.campaignId, authorization: authorization(f.m), observation: observation(f.m, "first") } });
      cleanup.push(() => { void worker.terminate(); });
      worker.on("message", message => {
        if (message.ready) { if (++ready === 2) { Atomics.store(start, 0, 1); Atomics.notify(start, 0); } }
        else if (message.fatal) reject(new Error(message.fatal));
        else resolve(message.dispatched);
      }); worker.on("error", reject);
    })));
    expect(results.filter(Boolean)).toHaveLength(1);
    f.anchor.checkpoint = { sequence: words[1], eventHash: Array.from(words.slice(2, 66), n => String.fromCharCode(n)).join("") };
    expect(f.core.journal().filter(e => e.event === "CAMPAIGN_AUTHORIZED")).toHaveLength(1);
    expect(f.core.journal().filter(e => e.event === "STEP_DISPATCHED")).toHaveLength(1);
  });
  it.each(["BEFORE_COMMIT", "AFTER_COMMIT"])("unknown %s result is never success and poisons executor", point => {
    const f = fixture(); f.start(); f.intent(); f.fail(point);
    expect(() => f.dispatch()).toThrow(StoreOutcomeUnknownError); f.fail(null); expect(() => f.dispatch()).toThrow(StoreOutcomeUnknownError);
    if (point === "BEFORE_COMMIT") { f.restart(); expect(f.core.recover(f.m.campaignId).kind).toBe("RECONCILE_REQUIRED"); }
    else expect(() => f.open()).toThrow("High-watermark");
  });
  it("anchor acknowledgement loss after commit fails closed", () => {
    const f = fixture(); f.start(); f.intent(); f.anchor.advance = () => { throw new Error("anchor lost"); };
    expect(() => f.dispatch()).toThrow(StoreOutcomeUnknownError); expect(() => f.open()).toThrow("High-watermark");
  });
  it("does not expose generic execution, raw append, SQL or reactivation APIs", () => {
    const names = Object.getOwnPropertyNames(BootstrapCampaignExecutor.prototype);
    expect(names.sort()).toEqual(["constructor", "close", "prepare", "registerAuthorization", "activate", "inspect", "journal", "recover", "decision", "intent",
      "dispatch", "observe", "verify", "resumeCeremony", "cancel", "recordCutover", "complete"].sort());
    for (const name of ["exec", "shell", "command", "argv", "path", "url", "ssh", "pve", "sql", "table", "append", "retry", "renew", "reactivate"]) expect(names).not.toContain(name);
  });
});
