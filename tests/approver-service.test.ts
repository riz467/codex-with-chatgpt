import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApproverService, type ApproverConfig } from "../src/approver-service/server.js";
import { ApproverStore } from "../src/approver-service/storage.js";
import { verifySignedApproval } from "../src/human-approval/verifier.js";
import type { ApprovalRequest, TrustedApprovalContext } from "../src/human-approval/contract.js";
import { authenticator } from "./fixtures/webauthn-simulator.js";

const rp = "ai-approver.tail2f618d.ts.net";
const origin = `https://${rp}`;
const review = "review-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const hash = (c: string) => c.repeat(64);
const config: ApproverConfig = { rp_id: rp, origin, key_id: "test-approver-key", db_path: "/var/lib/ai-approver/approver.db",
  signing_key_path: "/var/lib/ai-approver/signing.key", port: 48768 };

describe("isolated Approver service ↔ existing signed verifier", () => {
  const servers: Server[] = [], stores: ApproverStore[] = [], dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    stores.splice(0).forEach(store => store.close());
    dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  });
  async function setup() {
    let clock = Date.parse("2026-09-26T12:00:00.000Z");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approver-service-")); dirs.push(dir);
    const store = new ApproverStore(path.join(dir, "approver.db")); stores.push(store);
    const signing = generateKeyPairSync("ed25519");
    const server = createServer(createApproverService(config, store, signing.privateKey, () => clock)).listen(0, "127.0.0.1"); servers.push(server);
    await new Promise<void>(resolve => server.once("listening", resolve));
    const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("NO_LISTENER");
    const call = (method: "GET" | "POST", route: string, body?: unknown, browser = false) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: addr.port, method, path: route, headers: {
        Host: rp, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(browser ? { Origin: origin } : {}),
      } }, res => { let text = ""; res.on("data", data => { text += data; });
        res.on("end", () => { try { resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }); } catch { resolve({ status: res.statusCode!, body: text }); } }); });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const payload = (): ApprovalRequest => ({ schema_version: 1, type: "AI_WORKSPACE_DONE_APPROVAL_REQUEST",
      request_id: `req-${randomBytes(16).toString("hex")}`, task_id: "rpc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      run_id: "auto-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", authoritative_review_id: review,
      review_evidence_hash: hash("a"), bundle_manifest_sha256: hash("b"), canonical_goal_sha256: hash("c"),
      issued_at: new Date(clock).toISOString(), expires_at: new Date(clock + 240_000).toISOString(),
      nonce: randomBytes(32).toString("base64url") });
    const context: TrustedApprovalContext = { task_id: "rpc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      run_id: "auto-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", authoritative_review_id: review,
      review_evidence_hash: hash("a"), bundle_manifest_sha256: hash("b"), canonical_goal_sha256: hash("c"),
      current_review_id: review, current_review_evidence_hash: hash("a"), review_result: "PASS",
      review_is_current: true, bundle_integrity_valid: true };
    const keys = new Map([[config.key_id, signing.publicKey]]);
    const enroll = async () => {
      const device = authenticator();
      const token = store.openEnrollment(clock);
      const options = await call("POST", "/enrollment/options", { token }, true);
      expect(options.status).toBe(200);
      expect(options.body.options.authenticatorSelection.userVerification).toBe("required");
      expect(options.body.options.authenticatorSelection.authenticatorAttachment).toBeUndefined();
      const body = { token, ceremony: options.body.ceremony, credential: device.registration(options.body.options.challenge, origin, rp) };
      expect((await call("POST", "/enrollment/verify", body, true)).status).toBe(201);
      return { device, body, token };
    };
    return { call, store, payload, context, keys, enroll, clock: () => clock, advance: (ms: number) => { clock += ms; }, dir };
  }
  it("rejects closed enrollment, unbounded API input and browser-origin forgery", async () => {
    const x = await setup();
    expect((await x.call("POST", "/enrollment/options", { token: "fake" }, true)).status).toBe(403);
    expect((await x.call("POST", "/api/approval-requests", { done_approved: true })).status).toBe(400);
    expect((await x.call("POST", "/api/approval-requests", { ...x.payload(), command: "whoami" })).status).toBe(400);
    expect((await x.call("POST", "/api/webauthn/authentication/options", { request_id: x.payload().request_id })).status).toBe(403);
    expect((await x.call("GET", "/api/approval-evidence/req-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await x.call("GET", "/api/admin/signing-key")).status).toBe(404);
    expect((await x.call("POST", "/api/enroll", {})).status).toBe(404);
  });
  it("issues exact signed evidence only after UV; existing AI-Workspace verifier accepts it", async () => {
    const x = await setup(); const { device } = await x.enroll(); const payload = x.payload();
    expect((await x.call("POST", "/api/approval-requests", payload)).status).toBe(201);
    expect((await x.call("GET", `/api/approval-evidence/${payload.request_id}`)).status).toBe(404);
    const options = await x.call("POST", "/api/webauthn/authentication/options", { request_id: payload.request_id }, true);
    expect(options.status).toBe(200);
    expect(options.body.options.userVerification).toBe("required");
    const assertion = device.assertion(options.body.options.challenge, origin, rp);
    expect((await x.call("POST", "/api/webauthn/authentication/verify", { request_id: payload.request_id,
      ceremony: options.body.ceremony, credential: assertion }, true)).status).toBe(201);
    const evidence = (await x.call("GET", `/api/approval-evidence/${payload.request_id}`)).body;
    expect(verifySignedApproval(evidence, x.context, x.keys, x.clock())).toMatchObject({ valid: true, jti: payload.nonce });
    expect(x.store.consumeJti(payload.nonce, x.clock())).toBe(true);
    expect(x.store.consumeJti(payload.nonce, x.clock())).toBe(false);
    expect((x.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='APPROVAL'").get() as { n: number }).n).toBe(1);
    expect((await x.call("POST", "/api/webauthn/authentication/verify", { request_id: payload.request_id,
      ceremony: options.body.ceremony, credential: assertion }, true)).status).toBe(403);
    expect((await x.call("POST", "/api/approval-requests", payload)).status).toBe(409);
  });
  it("rejects unsigned/wrong-key/tampered evidence, wrong bindings and expired/future requests", async () => {
    const x = await setup(); const { device } = await x.enroll(); const payload = x.payload();
    await x.call("POST", "/api/approval-requests", payload);
    const options = await x.call("POST", "/api/webauthn/authentication/options", { request_id: payload.request_id }, true);
    await x.call("POST", "/api/webauthn/authentication/verify", { request_id: payload.request_id, ceremony: options.body.ceremony,
      credential: device.assertion(options.body.options.challenge, origin, rp) }, true);
    const e = (await x.call("GET", `/api/approval-evidence/${payload.request_id}`)).body;
    for (const forged of [{ ...e, signature: undefined }, { ...e, signature: randomBytes(64).toString("base64url") },
      { ...e, payload: { ...e.payload, task_id: "rpc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },
      { ...e, payload: { ...e.payload, authoritative_review_id: "review-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
      { ...e, payload: { ...e.payload, bundle_manifest_sha256: hash("d") } },
      { ...e, payload: { ...e.payload, canonical_goal_sha256: hash("d") } },
    ]) expect(verifySignedApproval(forged, x.context, x.keys, x.clock()).valid).toBe(false);
    expect(verifySignedApproval(e, x.context, new Map([[config.key_id, generateKeyPairSync("ed25519").publicKey]]), x.clock()).valid).toBe(false);
    expect(verifySignedApproval(e, { ...x.context, run_id: "auto-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, x.keys, x.clock()).valid).toBe(false);
    expect(verifySignedApproval(e, x.context, x.keys, x.clock() + 240_000).valid).toBe(false);
    expect((await x.call("POST", "/api/approval-requests", { ...x.payload(), issued_at: new Date(x.clock() + 60_000).toISOString() })).status).toBe(400);
    const expired = x.payload(); x.advance(240_001);
    expect((await x.call("POST", "/api/approval-requests", expired)).status).toBe(400);
  });
  it("consumes bad UV and replayed challenges, rejects disabled credential and bad counter", async () => {
    const x = await setup(); const { device, body, token } = await x.enroll();
    expect((await x.call("POST", "/enrollment/verify", body, true)).status).toBe(403);
    expect((await x.call("POST", "/enrollment/options", { token }, true)).status).toBe(403);
    const p = x.payload(); await x.call("POST", "/api/approval-requests", p);
    const a = await x.call("POST", "/api/webauthn/authentication/options", { request_id: p.request_id }, true);
    const invalid = { request_id: p.request_id, ceremony: a.body.ceremony,
      credential: device.assertion(a.body.options.challenge, origin, rp, 1, false) };
    expect((await x.call("POST", "/api/webauthn/authentication/verify", invalid, true)).status).toBe(403);
    expect((await x.call("POST", "/api/webauthn/authentication/verify", invalid, true)).status).toBe(403);
    const b = await x.call("POST", "/api/webauthn/authentication/options", { request_id: p.request_id }, true);
    expect((await x.call("POST", "/api/webauthn/authentication/verify", { request_id: p.request_id, ceremony: b.body.ceremony,
      credential: device.assertion(b.body.options.challenge, origin, rp, 1) }, true)).status).toBe(201);
    const p2 = x.payload(); await x.call("POST", "/api/approval-requests", p2);
    const c = await x.call("POST", "/api/webauthn/authentication/options", { request_id: p2.request_id }, true);
    expect((await x.call("POST", "/api/webauthn/authentication/verify", { request_id: p2.request_id, ceremony: c.body.ceremony,
      credential: device.assertion(c.body.options.challenge, origin, rp, 1) }, true)).status).toBe(403);
    expect(x.store.disableCredential(device.id, x.clock())).toBe(true);
    expect((await x.call("POST", "/api/webauthn/authentication/options", { request_id: p2.request_id }, true)).status).toBe(403);
    expect((await x.call("GET", `/api/approval-evidence/${p2.request_id}`)).status).toBe(404);
  });
  it("requires the CT-only token and UV for enrollment, with expiry", async () => {
    const x = await setup(); const token = x.store.openEnrollment(x.clock()); const device = authenticator();
    const opt = await x.call("POST", "/enrollment/options", { token }, true);
    const body = { token, ceremony: opt.body.ceremony, credential: device.registration(opt.body.options.challenge, origin, rp, false) };
    expect((await x.call("POST", "/enrollment/verify", body, true)).status).toBe(403);
    expect((await x.call("POST", "/enrollment/verify", { ...body, credential: device.registration(opt.body.options.challenge, origin, rp) }, true)).status).toBe(403);
    x.advance(300_001);
    expect((await x.call("POST", "/enrollment/options", { token }, true)).status).toBe(403);
  });
  it("persists single-use challenge and jti state across SQLite connections", async () => {
    const x = await setup(); const token = x.store.openEnrollment(x.clock());
    const opt = await x.call("POST", "/enrollment/options", { token }, true);
    const another = new ApproverStore(path.join(x.dir, "approver.db"));
    try {
      expect(another.consumeEnrollment(token, opt.body.ceremony, x.clock())).toBe(opt.body.options.challenge);
      expect(x.store.consumeEnrollment(token, opt.body.ceremony, x.clock())).toBeNull();
      const jti = randomBytes(32).toString("base64url");
      expect(another.consumeJti(jti, x.clock())).toBe(true);
      expect(x.store.consumeJti(jti, x.clock())).toBe(false);
    } finally { another.close(); }
  });
});
