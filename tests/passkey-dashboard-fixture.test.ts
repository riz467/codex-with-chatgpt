import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request, type Server } from "node:http";
import { createHumanApprover } from "../src/human-approver/server.js";
import { PasskeyFixture } from "../src/dashboard/passkey-fixture.js";
import { authenticator } from "./fixtures/webauthn-simulator.js";

const origin = "http://localhost:48767";
const servers: Server[] = [], roots: string[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
async function setup(register = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "passkey-dashboard-fixture-")); roots.push(root);
  let time = Date.now();
  const fixture = new PasskeyFixture(path.join(root, "test-only"), () => time);
  const app = createHumanApprover({ storePath: path.join(root, "test-credential.json"), now: () => time, fixture });
  const server = createServer(app).listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(r => server.once("listening", r));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("NO_PORT");
  const base = `http://127.0.0.1:${address.port}`;
  const get = async (route: string) => fetch(base + route).then(r => r.json());
  const post = (route: string, body: unknown, from = origin, headers: Record<string, string> = {}) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path: route, method: "POST",
      headers: { Origin: from, Host: "localhost:48767", "Content-Type": "application/json", ...headers } }, res => {
      let data = ""; res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
  const key = authenticator();
  if (register) {
    const registration = await post("/registration/options", {});
    expect(registration.status, JSON.stringify(registration.body)).toBe(200);
    expect((await post("/registration/verify", { ceremony: registration.body.ceremony,
      credential: key.registration(registration.body.options.challenge, origin, "localhost") })).status).toBe(200);
  }
  const requestState = fixture.status();
  const binding = { request_id: requestState.request.request_id, request_sha256: requestState.request_sha256 };
  const completion = path.join(root, "test-only", "completion.json");
  return { root, base, fixture, key, get, post, binding, completion, advance: (ms: number) => { time += ms; } };
}

describe("isolated Dashboard passkey test approval (simulated authenticator, not real browser)", () => {
  it("binds a verified signature and UV to one request and writes only the test completion once", async () => {
    const x = await setup();
    expect((await x.get("/passkey-fixture/status")).state).toBe("PENDING");
    expect(fs.existsSync(x.completion)).toBe(false);
    const screen = await fetch(`http://127.0.0.1:${(servers[0].address() as {port:number}).port}/passkey-fixture`).then(r => r.text());
    expect(screen).toContain("パスキーで承認");
    expect(screen).toContain("本番操作なし");
    const issued = await x.post("/passkey-fixture/options", x.binding);
    expect(issued.status).toBe(200);
    expect(issued.body.options.userVerification).toBe("required");
    const body = { ...x.binding, ceremony: issued.body.ceremony,
      credential: x.key.assertion(issued.body.options.challenge, origin, "localhost") };
    expect(await x.post("/passkey-fixture/verify", body)).toMatchObject({ status: 201,
      body: { state: "APPROVED_TEST_ONLY", request_sha256: x.binding.request_sha256 } });
    expect((await x.get("/passkey-fixture/status")).state).toBe("APPROVED_TEST_ONLY");
    expect(JSON.parse(fs.readFileSync(x.completion, "utf8"))).toMatchObject({ kind: "PASSKEY_FIXTURE_COMPLETION_ONLY",
      request_id: x.binding.request_id, request_sha256: x.binding.request_sha256, binding: null,
      result: "TEST_COMPLETION_RECORDED", approved_at: expect.any(String), receipt_id: expect.any(String),
      receipt_mac: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.parse(fs.readFileSync(path.join(x.root, "test-credential.json"), "utf8")).counter).toBe(1);
    const completion = fs.readFileSync(x.completion);
    expect((await x.post("/passkey-fixture/verify", body)).status).toBe(403);
    expect((await x.post("/passkey-fixture/options", x.binding)).status).toBe(409);
    expect(fs.readFileSync(x.completion).equals(completion)).toBe(true);
  });
  it("rejects no assertion, wrong origin, no UV, wrong request/hash, changed content and expiry", async () => {
    const x = await setup();
    expect((await x.post("/passkey-fixture/verify", { ...x.binding, ceremony: "fake", credential: {} })).status).toBe(403);
    expect((await x.post("/passkey-fixture/options", x.binding, "http://evil.invalid")).status).toBe(403);
    expect((await x.post("/passkey-fixture/options", x.binding, origin, { Host: "evil.invalid" })).status).toBe(403);
    expect((await x.post("/passkey-fixture/options", x.binding, origin, { "Content-Type": "text/plain" })).status).toBe(403);
    expect((await x.post("/passkey-fixture/options", { ...x.binding, request_sha256: "0".repeat(64) })).status).toBe(409);
    expect((await x.post("/passkey-fixture/options", { ...x.binding, request_id: "fixture-wrong" })).status).toBe(409);
    for (const [from, uv] of [["http://evil.invalid", true], [origin, false]] as const) {
      const issued = await x.post("/passkey-fixture/options", x.binding);
      expect((await x.post("/passkey-fixture/verify", { ...x.binding, ceremony: issued.body.ceremony,
        credential: x.key.assertion(issued.body.options.challenge, from, "localhost", 1, uv) })).status).toBe(403);
    }
    const pending = await x.post("/passkey-fixture/options", x.binding);
    const file = path.join(x.root, "test-only", "request.json");
    const content = JSON.parse(fs.readFileSync(file, "utf8")); content.revision = 2;
    fs.writeFileSync(file, JSON.stringify(content));
    expect((await x.get("/passkey-fixture/status")).state).toBe("CHANGED");
    expect((await x.post("/passkey-fixture/verify", { ...x.binding, ceremony: pending.body.ceremony,
      credential: x.key.assertion(pending.body.options.challenge, origin, "localhost") })).status).toBe(403);
    expect(fs.existsSync(x.completion)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ ...content, revision: 1 }));
    x.advance(15 * 60_000 + 1);
    expect((await x.get("/passkey-fixture/status")).state).toBe("EXPIRED");
    expect((await x.post("/passkey-fixture/options", x.binding)).status).toBe(409);
  });
  it("binds each single-use ceremony to its request and verifies challenge, RP, credential and signature", async () => {
    const x = await setup();
    const assertion = (challenge: string, rp = "localhost") => x.key.assertion(challenge, origin, rp);
    const wrong = [
      (challenge: string) => assertion("wrong-challenge"),
      (challenge: string) => assertion(challenge, "evil.invalid"),
      (challenge: string) => authenticator().assertion(challenge, origin, "localhost"),
      (challenge: string) => ({ ...assertion(challenge), response: { ...assertion(challenge).response, signature: "invalid" } }),
    ];
    for (const response of wrong) {
      const issued = await x.post("/passkey-fixture/options", x.binding);
      const body = { ...x.binding, ceremony: issued.body.ceremony, credential: response(issued.body.options.challenge) };
      expect((await x.post("/passkey-fixture/verify", body)).status).toBe(403);
      expect((await x.post("/passkey-fixture/verify", body)).status).toBe(403);
    }
    for (const changed of [{ request_id: "fixture-other" }, { request_sha256: "0".repeat(64) }]) {
      const issued = await x.post("/passkey-fixture/options", x.binding);
      const signed = assertion(issued.body.options.challenge);
      expect((await x.post("/passkey-fixture/verify", { ...x.binding, ...changed, ceremony: issued.body.ceremony, credential: signed })).status).toBe(403);
      expect((await x.post("/passkey-fixture/verify", { ...x.binding, ceremony: issued.body.ceremony, credential: signed })).status).toBe(403);
    }
    const expired = await x.post("/passkey-fixture/options", x.binding);
    x.advance(120_001);
    expect((await x.post("/passkey-fixture/verify", { ...x.binding, ceremony: expired.body.ceremony,
      credential: assertion(expired.body.options.challenge) })).status).toBe(403);
    expect(fs.existsSync(x.completion)).toBe(false);
  });
  it("never begins fixture authentication without an already registered passkey", async () => {
    const x = await setup(false);
    expect((await x.get("/passkey-fixture/status")).credential_registered).toBe(false);
    expect((await x.post("/passkey-fixture/options", x.binding)).status).toBe(409);
    const script = await (await fetch(`${x.base}/passkey-fixture.js`)).text();
    expect(script).toContain("登録済みパスキーなし");
    expect(script).toContain("event.isTrusted");
    expect(script).toContain("!current.credential_registered");
    expect(fs.existsSync(x.completion)).toBe(false);
  });
  it("exposes fixture routes only with an explicit fixture on localhost", async () => {
    const x = await setup();
    for (const mode of ["localhost", "tailscale"] as const) {
      const app = createHumanApprover({ mode, storePath: path.join(x.root, `credential-${mode}.json`),
        ...(mode === "tailscale" ? { fixture: x.fixture } : {}) });
      const server = createServer(app).listen(0, "127.0.0.1"); servers.push(server);
      await new Promise<void>(resolve => server.once("listening", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("NO_PORT");
      const base = `http://127.0.0.1:${address.port}`;
      for (const route of ["/passkey-fixture", "/passkey-fixture.js", "/passkey-fixture/status"]) {
        expect((await fetch(base + route)).status).toBe(404);
      }
    }
  });
  it("does not accept a manually planted approved flag or a restarted stale receipt", async () => {
    const x = await setup();
    fs.writeFileSync(x.completion, JSON.stringify({ request_id: x.binding.request_id,
      request_sha256: x.binding.request_sha256, result: "TEST_COMPLETION_RECORDED", receipt_mac: "0".repeat(64) }));
    expect((await x.get("/passkey-fixture/status")).state).toBe("INVALID_RECEIPT");
    expect((await x.post("/passkey-fixture/options", x.binding)).status).toBe(409);
    fs.unlinkSync(x.completion);
    const issued = await x.post("/passkey-fixture/options", x.binding);
    expect((await x.post("/passkey-fixture/verify", { ...x.binding, ceremony: issued.body.ceremony,
      credential: x.key.assertion(issued.body.options.challenge, origin, "localhost") })).status).toBe(201);
    expect(new PasskeyFixture(path.join(x.root, "test-only")).status().state).toBe("INVALID_RECEIPT");
  });
});
