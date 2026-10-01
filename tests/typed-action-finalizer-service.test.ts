import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createFinalizerService, type FinalizerServiceDependencies, type TrustedContextProvider } from "../src/typed-action-finalizer/server.js";
import { reconciliationCategories, TypedActionFinalizerStore } from "../src/typed-action-finalizer/storage.js";
import { verifyExecutionPermit } from "../src/typed-action-finalizer/verifier.js";
import { fixture, hash, jti, now, time } from "./typed-action-fixtures.js";

const config = {
  host: "127.0.0.1", port: 0, databasePath: "/var/lib/ct701-typed-action-finalizer/ledger.sqlite",
  signingKeyPath: "/etc/ct701-typed-action-finalizer/signing-key.pem", finalizerKeyId: "ct701-test",
  trustedHumanKeyPath: "/etc/ct701-typed-action-finalizer/ct700-public.pem", trustedHumanKeyId: "ct700-test",
  bridgeTokenPath: "/etc/ct701-typed-action-finalizer/bridge-token", trustedContextProvider: { kind: "host-injected" },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(start = true) {
  const f = fixture();
  const base = path.join(tmpdir(), "opencode"); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "ct701-http-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let fenceHeld = false;
  const provider: TrustedContextProvider = {
    async withFence(_identity, operation) {
      // Real host fences also serialize against external generation/policy writers.
      // Tests exercise SQL concurrency separately using multiple service instances.
      fenceHeld = true; try { return await operation(); } finally { fenceHeld = false; }
    },
    finalization: vi.fn(identity => {
      expect(fenceHeld).toBe(true);
      expect(identity).toMatchObject({ requestHash: f.input.boundRequest.requestHash, attemptHash: f.input.boundAttempt.attemptHash,
        humanApprovalJti: f.approval.payload.jti, approvalRequestId: f.approval.payload.approvalRequestId });
      return { humanContext: f.input.humanContext, independentReview: f.input.independentReview, policyContext: f.input.policyContext };
    }),
    execution: vi.fn(() => { expect(fenceHeld).toBe(true); return structuredClone(f.executionContext); }),
  };
  const handoff = vi.fn(() => { expect(fenceHeld).toBe(true); });
  const deps: FinalizerServiceDependencies = { privateKey: f.finalizer.privateKey, humanPublicKey: f.human.publicKey,
    databasePath: path.join(directory, "ledger.sqlite"), bridgeToken: jti(), provider, bridge: { handoff }, now: () => now };
  const services = new Set<ReturnType<typeof createFinalizerService>>();
  cleanups.push(async () => { for (const service of services) await service.close(); });
  async function launch() {
    const service = createFinalizerService(config, deps); services.add(service);
    const port = await service.listen();
    return { service, url: `http://127.0.0.1:${port}` };
  }
  let running = start ? await launch() : undefined;
  async function request(route: string, body?: unknown, options: { auth?: boolean; url?: string; headers?: Record<string, string>; raw?: string } = {}) {
    const response = await fetch((options.url ?? running!.url) + route, {
      method: body === undefined && options.raw === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(options.auth === false ? {} : { Authorization: `Bearer ${deps.bridgeToken}` }), ...options.headers },
      body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  }
  const input = () => ({ boundRequest: f.input.boundRequest, boundAttempt: f.input.boundAttempt, humanApproval: f.input.humanApproval });
  async function issue() {
    const result = await request("/api/typed-action-finalizations", input()); expect(result.status).toBe(201);
    return { id: result.body.permitId as string, identity: { permitJti: result.body.permitJti as string, attemptHash: f.input.boundAttempt.attemptHash as string } };
  }
  return { ...f, trustedInput: f.input, deps, provider, handoff, request, input, issue, launch,
    async restart() { await running!.service.close(); services.delete(running!.service); running = await launch(); },
  };
}
const route = (id: string, suffix = "") => `/api/typed-action-permits/${id}${suffix ? `/${suffix}` : ""}`;

describe("CT701 isolated HTTP service", () => {
  it("starts valid config, serves secret-free hardened health", async () => {
    const f = await setup(), response = await f.request("/health");
    expect(response.status).toBe(200); expect(response.body).toEqual({ status: "ok", boundary: "isolated-loopback" });
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    for (const h of ["x-powered-by", "access-control-allow-origin", "etag"]) expect(response.headers.get(h)).toBeNull();
  });
  it.each([{ port: -1 }, { port: "80" }, { unknown: true }, { databasePath: "arbitrary.sqlite" },
    { signingKeyPath: "arbitrary.pem" }, { trustedHumanKeyPath: "http://caller/key" },
    { trustedContextProvider: { kind: "url", url: "https://caller" } }])("rejects invalid configuration %j", async change => {
    const f = await setup(false); expect(() => createFinalizerService({ ...config, ...change }, f.deps)).toThrow();
  });
  it.each(["0.0.0.0", "::", "192.168.1.1", "localhost"])("rejects external/ambiguous bind %s", async host => {
    const f = await setup(false); expect(() => createFinalizerService({ ...config, host }, f.deps)).toThrow();
  });
  it("requires the host provider and strong bridge credential", async () => {
    const f = await setup(false);
    expect(() => createFinalizerService(config, { ...f.deps, provider: undefined })).toThrow(/provider/);
    expect(() => createFinalizerService(config, { ...f.deps, bridgeToken: "weak" })).toThrow(/token/);
  });
  it("rejects non-private/non-Ed25519 keys at startup", async () => {
    const f = await setup(false);
    for (const privateKey of [f.finalizer.publicKey, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey]) {
      expect(() => createFinalizerService(config, { ...f.deps, privateKey })).toThrow(/Ed25519/);
    }
    expect(() => createFinalizerService(config, { ...f.deps, humanPublicKey: f.human.privateKey })).toThrow(/Ed25519/);
  });
  it("rejects malformed and tampered ledger startup", async () => {
    const f = await setup(false);
    await writeFile(f.deps.databasePath!, "not sqlite");
    expect(() => createFinalizerService(config, f.deps)).toThrow();
    await rm(f.deps.databasePath!);
    const service = createFinalizerService(config, f.deps); await service.close();
    const db = new DatabaseSync(f.deps.databasePath!); db.exec("DROP TRIGGER identities_no_delete"); db.close();
    expect(() => createFinalizerService(config, f.deps)).toThrow(/schema/);
  });
  it("finalizes with host identity, persists signed evidence, retrieves after restart", async () => {
    const f = await setup(), issued = await f.issue();
    const evidence = await f.request(route(issued.id));
    expect(evidence.status).toBe(200); expect(evidence.body.state).toBe("VERIFIED_NOT_CONSUMED");
    expect(verifyExecutionPermit(evidence.body.envelope, f.executionContext, f.finalizerKeys, now).valid).toBe(true);
    expect(f.provider.finalization).toHaveBeenCalledOnce(); expect(f.handoff).not.toHaveBeenCalled();
    await f.restart(); expect((await f.request(route(issued.id))).body).toEqual(evidence.body);
    expect((await f.request("/api/typed-action-finalizations", f.input())).status).toBe(409);
    expect(JSON.stringify(evidence.body)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(evidence.body)).not.toContain(f.deps.databasePath);
    const db = new DatabaseSync(f.deps.databasePath!);
    expect((db.prepare("SELECT count(*) AS n FROM finalized_permits").get() as any).n).toBe(1); db.close();
  });
  it.each(["signature", "requestHash", "attemptHash", "actual-request", "actual-attempt", "review", "review-expiry", "policy", "maintenance", "generation", "expiry"])("rejects invalid %s", async fault => {
    const f = await setup();
    if (fault === "signature") f.input().humanApproval.signature = Buffer.alloc(64, 1).toString("base64url");
    if (fault === "requestHash") f.input().boundRequest.requestHash = hash();
    if (fault === "attemptHash") f.input().boundAttempt.attemptHash = hash();
    if (fault === "actual-request") f.trustedInput.boundRequest.request.timeout.executionMs++;
    if (fault === "actual-attempt") f.trustedInput.boundAttempt.attempt.createdAt = time(-31_000);
    if (fault === "review") f.trustedInput.independentReview.isCurrent = false;
    if (fault === "review-expiry") f.trustedInput.independentReview.expiresAt = time(-1);
    if (fault === "policy") f.trustedInput.policyContext.policySha256 = hash();
    if (fault === "maintenance") f.humanContext.maintenanceWindowExpiresAt = time(-1);
    if (fault === "generation") f.humanContext.targetGeneration++;
    if (fault === "expiry") f.deps.now = () => now + 180_000;
    if (fault === "expiry") await f.restart();
    const response = await f.request("/api/typed-action-finalizations", f.input());
    expect(response.status).toBeGreaterThanOrEqual(400); expect(f.handoff).not.toHaveBeenCalled();
    const db = new DatabaseSync(f.deps.databasePath!);
    expect((db.prepare("SELECT count(*) AS n FROM finalized_permits").get() as any).n).toBe(0); db.close();
  });
  it.each(["humanContext", "independentReview", "policyContext", "issuance", "path", "command", "ref", "url", "finalizerKeyId", "domain"])("rejects caller authority/selector %s", async field => {
    const f = await setup();
    const response = await f.request("/api/typed-action-finalizations", { ...f.input(), [field]: { result: "PASS", isCurrent: true } });
    expect(response.status).toBe(400); expect(f.provider.finalization).not.toHaveBeenCalled();
  });
  it("caller PASS cannot bypass host denial", async () => {
    const f = await setup(); f.provider.finalization = () => { throw new Error("secret provider denial"); };
    const response = await f.request("/api/typed-action-finalizations", f.input());
    expect(response.status).toBe(400); expect(JSON.stringify(response.body)).not.toContain("secret");
  });
  it("rejects unknown and malformed permit IDs", async () => {
    const f = await setup(); expect((await f.request(route(randomUUID()))).status).toBe(404);
    for (const id of ["not-an-id", "..%2Fkey.pem"]) expect((await f.request(route(id))).status).toBe(400);
  });
  it("consumes once, hands off only live under fence, rejects replay after restart", async () => {
    const f = await setup(), p = await f.issue();
    const first = await f.request(route(p.id, "consume"), p.identity);
    expect(first.body).toEqual({ state: "CONSUMED_FOR_EXECUTION", executionMayStart: true });
    expect(f.handoff).toHaveBeenCalledOnce(); expect(f.provider.execution).toHaveBeenCalledTimes(2);
    expect((await f.request(route(p.id, "consume"), p.identity)).body.executionMayStart).toBe(false);
    await f.restart(); expect((await f.request(route(p.id, "consume"), p.identity)).body.executionMayStart).toBe(false);
    expect((await f.request(route(p.id, "consume"), first.body)).status).toBe(400);
    expect(f.handoff).toHaveBeenCalledOnce();
    const db = new DatabaseSync(f.deps.databasePath!);
    expect((db.prepare("SELECT count(*) AS n FROM consumed_execution_identities").get() as any).n).toBe(3); db.close();
  });
  it("concurrent service connections produce exactly one handoff", async () => {
    const f = await setup(), p = await f.issue(), second = await f.launch();
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.request(route(p.id, "consume"), p.identity, i % 2 ? { url: second.url } : {})));
    expect(responses.filter(r => r.body.executionMayStart === true)).toHaveLength(1); expect(f.handoff).toHaveBeenCalledOnce();
  });
  it("lost COMMIT acknowledgement quarantines durably and never retries", async () => {
    const f = await setup(), p = await f.issue();
    const original = DatabaseSync.prototype.exec; let injected = false;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      original.call(this, sql);
      if (sql === "COMMIT" && !injected) { injected = true; throw new Error("lost ack secret"); }
    });
    const response = await f.request(route(p.id, "consume"), p.identity); spy.mockRestore();
    expect(response.body).toEqual({ state: "RECONCILE_REQUIRED", executionMayStart: false }); expect(f.handoff).not.toHaveBeenCalled();
    await f.restart(); expect((await f.request(route(p.id))).body.state).toBe("RECONCILE_REQUIRED");
    expect((await f.request(route(p.id, "consume"), p.identity)).body.executionMayStart).toBe(false);
  });
  it("fresh context changes after consume require reconciliation", async () => {
    const f = await setup(), p = await f.issue(); let calls = 0;
    f.provider.execution = () => ({ ...f.executionContext, targetGeneration: f.executionContext.targetGeneration + (calls++ ? 1 : 0) });
    expect((await f.request(route(p.id, "consume"), p.identity)).body.state).toBe("RECONCILE_REQUIRED");
    f.provider.execution = () => f.executionContext;
    await f.restart(); expect((await f.request(route(p.id, "consume"), p.identity)).body.executionMayStart).toBe(false);
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it("handoff failure remains consumed and requires reconciliation", async () => {
    const f = await setup(), p = await f.issue(); f.handoff.mockImplementation(() => { throw new Error("handoff lost"); });
    expect((await f.request(route(p.id, "consume"), p.identity)).body.state).toBe("RECONCILE_REQUIRED");
    expect((await f.request(route(p.id, "consume"), p.identity)).body.executionMayStart).toBe(false);
  });
  it("awaits asynchronous handoff under the fence and quarantines a lost bridge acknowledgement", async () => {
    const f = await setup(), p = await f.issue();
    f.deps.bridge!.handoff = async () => {
      await Promise.resolve();
      f.provider.execution({} as any); // The fake asserts that the fence is still held.
      throw new Error("lost asynchronous acknowledgement");
    };
    expect((await f.request(route(p.id, "consume"), p.identity)).body).toEqual({ state: "RECONCILE_REQUIRED", executionMayStart: false });
    await f.restart(); expect((await f.request(route(p.id, "consume"), p.identity)).body.executionMayStart).toBe(false);
  });
  it("handoff failure plus unavailable reconciliation storage latches closed", async () => {
    const f = await setup(), p = await f.issue(); f.handoff.mockImplementation(() => { throw new Error("lost handoff"); });
    vi.spyOn(TypedActionFinalizerStore.prototype, "recordConsumedReconciliation").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect((await f.request(route(p.id, "consume"), p.identity)).body).toEqual({ state: "RECONCILE_REQUIRED", executionMayStart: false });
    expect((await f.request("/health")).status).toBe(503);
  });
  it.each(reconciliationCategories)("records fixed reconciliation category %s across restart", async category => {
    const f = await setup(), p = await f.issue(); await f.request(route(p.id, "consume"), p.identity);
    expect((await f.request(route(p.id, "reconcile"), { ...p.identity, category })).body.state).toBe("RECONCILE_REQUIRED");
    await f.restart(); expect((await f.request(route(p.id))).body.state).toBe("RECONCILE_REQUIRED");
    expect((await f.request(route(p.id, "consume"), p.identity)).body.executionMayStart).toBe(false);
    expect((await f.request(route(p.id, "execution-verified"), p.identity)).status).toBe(400);
  });
  it("rejects free reasons, wrong identity, unissued and unconsumed reconciliation", async () => {
    const f = await setup(), p = await f.issue();
    for (const body of [{ ...p.identity, category: "caller text" }, { ...p.identity, category: "EXECUTION_TIMEOUT", reason: "free" },
      { ...p.identity, category: "EXECUTION_TIMEOUT" }, { ...p.identity, attemptHash: hash(), category: "EXECUTION_TIMEOUT" }]) {
      expect((await f.request(route(p.id, "reconcile"), body)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await f.request(route(randomUUID(), "reconcile"), { ...p.identity, category: "EXECUTION_TIMEOUT" })).status).toBe(404);
    expect((await f.request(route(p.id))).body.state).toBe("VERIFIED_NOT_CONSUMED");
  });
  it("verification requires consumed correct identity and is one-time", async () => {
    const f = await setup(), p = await f.issue();
    expect((await f.request(route(p.id, "execution-verified"), p.identity)).status).toBe(400);
    await f.request(route(p.id, "consume"), p.identity);
    expect((await f.request(route(p.id, "execution-verified"), { ...p.identity, attemptHash: hash() })).status).toBe(409);
    expect((await f.request(route(p.id, "execution-verified"), p.identity)).body).toEqual({ recorded: true });
    await f.restart(); expect((await f.request(route(p.id, "execution-verified"), p.identity)).status).toBe(400);
    expect(f.handoff).toHaveBeenCalledOnce();
  });
  it("bridge auth, strict bodies and persisted evidence prevent envelope substitution", async () => {
    const f = await setup(), p = await f.issue();
    for (const operation of ["consume", "reconcile", "execution-verified"]) {
      expect((await f.request(route(p.id, operation), p.identity, { auth: false })).status).toBe(401);
    }
    for (const extra of [{ envelope: f.permit }, { trustedContext: f.executionContext }, { command: "git" }]) {
      expect((await f.request(route(p.id, "consume"), { ...p.identity, ...extra })).status).toBe(400);
    }
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it("rejects generic endpoints, non-JSON, oversized, malformed and browser requests without leaks", async () => {
    const f = await setup();
    for (const endpoint of ["/sign", "/api/sign", "/api/execute", "/key.pem", "/api/typed-action-permits/x/reactivate"]) {
      expect((await f.request(endpoint, {})).status).toBe(404);
    }
    expect((await f.request("/api/typed-action-finalizations", {}, { headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await f.request("/api/typed-action-finalizations", {}, { raw: "{" })).body).toEqual({ error: "REQUEST_REJECTED", executionMayStart: false });
    expect((await f.request("/api/typed-action-finalizations", { data: "x".repeat(70000) })).status).toBe(413);
    expect((await f.request("/health", undefined, { headers: { Origin: "https://caller" } })).status).toBe(400);
    expect((await f.request("/health?path=key.pem")).status).toBe(400);
  });
  it("storage failure with unpersisted quarantine latches service closed", async () => {
    const f = await setup(), p = await f.issue();
    vi.spyOn(TypedActionFinalizerStore.prototype, "consumeOnce").mockRejectedValue(new Error("unavailable"));
    vi.spyOn(TypedActionFinalizerStore.prototype, "recordReconciliation").mockImplementation(() => { throw new Error("unavailable"); });
    expect((await f.request(route(p.id, "consume"), p.identity)).status).toBe(503);
    expect((await f.request("/health")).body).toEqual({ state: "RECONCILE_REQUIRED", executionMayStart: false });
    expect(f.handoff).not.toHaveBeenCalled();
  });
});
