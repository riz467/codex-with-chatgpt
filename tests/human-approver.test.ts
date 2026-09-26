import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHumanApprover } from "../src/human-approver/server.js";

const origin = "http://localhost:48767";
const rpID = "localhost";
const tailOrigin = "https://ai-workspace-win.tail2f618d.ts.net";
const tailRP = "ai-workspace-win.tail2f618d.ts.net";
const b64 = (value: Buffer | Uint8Array) => Buffer.from(value).toString("base64url");
// Small definite-length CBOR encoder for the ES256 software-authenticator test fixture.
function cbor(value: unknown): Buffer {
  const head = (major: number, size: number) => size < 24 ? Buffer.from([major << 5 | size]) :
    size < 256 ? Buffer.from([major << 5 | 24, size]) : Buffer.from([major << 5 | 25, size >> 8, size & 255]);
  if (typeof value === "number") return Buffer.concat([head(value < 0 ? 1 : 0, value < 0 ? -value - 1 : value)]);
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value && typeof value === "object") return Buffer.concat([head(5, Object.keys(value).length), ...Object.entries(value).flatMap(([key, entry]) => [cbor(/^-?\d+$/.test(key) ? Number(key) : key), cbor(entry)])]);
  throw new Error("unsupported CBOR fixture");
}
const client = (type: string, challenge: string, from = origin) => b64(Buffer.from(JSON.stringify({ type, challenge, origin: from, crossOrigin: false })));
const rpHash = (id = rpID) => createHash("sha256").update(id).digest();

describe("isolated Human Approver WebAuthn ceremony", () => {
  const servers: Server[] = [], directories: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  });
  async function setup(mode: "localhost" | "tailscale" = "localhost") {
    let time = 1_000_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "human-approver-test-")); directories.push(dir);
    const storePath = path.join(dir, "credential.json");
    const server = createServer(createHumanApprover({ mode, storePath, now: () => time })).listen(0, "127.0.0.1"); servers.push(server);
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("NO_ADDRESS");
    const expectedOrigin = mode === "tailscale" ? tailOrigin : origin;
    const expectedRP = mode === "tailscale" ? tailRP : rpID;
    const post = (route: string, body: unknown, from = expectedOrigin) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: address.port, path: route, method: "POST",
        headers: { "Content-Type": "application/json", Origin: from, Host: mode === "tailscale" ? tailRP : "localhost:48767" } }, res => {
        let data = ""; res.on("data", chunk => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      });
      req.on("error", reject); req.end(JSON.stringify(body));
    });
    return { post, storePath, expectedOrigin, expectedRP, advance: (ms: number) => { time += ms; } };
  }
  const keys = () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const id = randomBytes(32);
    const publicKey = cbor({ 1: 2, 3: -7, "-1": 1, "-2": Buffer.from(jwk.x!, "base64url"), "-3": Buffer.from(jwk.y!, "base64url") });
    return { pair, id, publicKey };
  };
  const registration = (challenge: string, key: ReturnType<typeof keys>, opts: { from?: string; rp?: string; uv?: boolean } = {}) => {
    const auth = Buffer.concat([rpHash(opts.rp), Buffer.from([opts.uv === false ? 0x41 : 0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, key.id.length]), key.id, key.publicKey]);
    return { id: b64(key.id), rawId: b64(key.id), type: "public-key", response: { clientDataJSON: client("webauthn.create", challenge, opts.from), attestationObject: b64(cbor({ fmt: "none", attStmt: {}, authData: auth })) }, clientExtensionResults: {} };
  };
  const assertion = (challenge: string, key: ReturnType<typeof keys>, opts: { from?: string; rp?: string; uv?: boolean } = {}) => {
    const auth = Buffer.concat([rpHash(opts.rp), Buffer.from([opts.uv === false ? 0x01 : 0x05]), Buffer.from([0, 0, 0, 1])]);
    const data = client("webauthn.get", challenge, opts.from);
    const signature = sign("sha256", Buffer.concat([auth, createHash("sha256").update(Buffer.from(data, "base64url")).digest()]), key.pair.privateKey);
    return { id: b64(key.id), rawId: b64(key.id), type: "public-key", response: { clientDataJSON: data, authenticatorData: b64(auth), signature: b64(signature), userHandle: null }, clientExtensionResults: {} };
  };
  async function enroll(env: Awaited<ReturnType<typeof setup>>) {
    const key = keys();
    const issued = await env.post("/registration/options", {});
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.options.authenticatorSelection.userVerification).toBe("required");
    expect(issued.body.options.authenticatorSelection.authenticatorAttachment).toBe("platform");
    const result = await env.post("/registration/verify", { ceremony: issued.body.ceremony, credential: registration(issued.body.options.challenge, key) });
    expect(result).toMatchObject({ status: 200, body: { registered: true, userVerified: true } });
    expect(JSON.parse(fs.readFileSync(env.storePath, "utf8"))).toMatchObject({ rpID, id: b64(key.id), counter: 0 });
    return key;
  }
  it("valid registration and authentication persist only public credential material", async () => {
    const env = await setup(); const key = await enroll(env);
    const saved = JSON.parse(fs.readFileSync(env.storePath, "utf8"));
    expect(Object.keys(saved).sort()).toEqual(["counter", "id", "publicKey", "rpID"]);
    const issued = await env.post("/authentication/options", {});
    expect(issued.body.options.userVerification).toBe("required");
    expect(await env.post("/authentication/verify", { ceremony: issued.body.ceremony, credential: assertion(issued.body.options.challenge, key) }))
      .toMatchObject({ status: 200, body: { humanVerification: "VERIFIED", userVerified: true } });
    expect(JSON.parse(fs.readFileSync(env.storePath, "utf8")).counter).toBe(1);
  });
  it("rejects direct POST, replay, expiry, wrong origin/RP/credential, missing UV and malformed assertion", async () => {
    const env = await setup(); const key = await enroll(env);
    expect((await env.post("/authentication/verify", { ceremony: "forged", credential: { id: b64(key.id) } })).status).toBe(403);
    expect((await env.post("/authentication/options", { command: "whoami" })).status).toBe(400);
    expect((await env.post("/registration/options", {})).status).toBe(409);
    for (const mutation of [
      (challenge: string) => assertion(challenge, key, { from: "http://evil.example" }),
      (challenge: string) => assertion(challenge, key, { rp: "evil.example" }),
      (challenge: string) => assertion(challenge, keys()),
      (challenge: string) => assertion(challenge, key, { uv: false }),
      () => ({ id: b64(key.id), response: { signature: "???" } }),
    ]) {
      const issued = await env.post("/authentication/options", {});
      const body = { ceremony: issued.body.ceremony, credential: mutation(issued.body.options.challenge) };
      expect((await env.post("/authentication/verify", body)).status).toBe(403);
      expect((await env.post("/authentication/verify", body)).status).toBe(403);
    }
    const expired = await env.post("/authentication/options", {});
    env.advance(120_001);
    expect((await env.post("/authentication/verify", { ceremony: expired.body.ceremony, credential: assertion(expired.body.options.challenge, key) })).status).toBe(403);
    const wrongHeader = await env.post("/authentication/options", {}, "http://evil.example");
    expect(wrongHeader.status).toBe(403);
    const replay = await env.post("/authentication/options", {});
    const body = { ceremony: replay.body.ceremony, credential: assertion(replay.body.options.challenge, key) };
    expect((await env.post("/authentication/verify", body)).status).toBe(200);
    expect((await env.post("/authentication/verify", body)).status).toBe(403);
  });
  it("rejects invalid registration origin, RP, UV and expired challenges", async () => {
    const env = await setup(); const key = keys();
    for (const opts of [{ from: "http://evil.example" }, { rp: "evil.example" }, { uv: false }]) {
      const issued = await env.post("/registration/options", {});
      expect((await env.post("/registration/verify", { ceremony: issued.body.ceremony, credential: registration(issued.body.options.challenge, key, opts) })).status).toBe(403);
    }
    const issued = await env.post("/registration/options", {}); env.advance(120_001);
    expect((await env.post("/registration/verify", { ceremony: issued.body.ceremony, credential: registration(issued.body.options.challenge, key) })).status).toBe(403);
  });
  it("uses a distinct HTTPS tailnet RP, accepts cross-device credentials, and rejects forged/replayed responses", async () => {
    const env = await setup("tailscale"); const key = keys();
    const issued = await env.post("/registration/options", {});
    expect(issued.body.options.rp.id).toBe(tailRP);
    expect(issued.body.options.authenticatorSelection).toMatchObject({ userVerification: "required" });
    expect(issued.body.options.authenticatorSelection.authenticatorAttachment).toBeUndefined();
    expect(await env.post("/registration/verify", { ceremony: issued.body.ceremony,
      credential: registration(issued.body.options.challenge, key, { from: tailOrigin, rp: tailRP }) })).toMatchObject({ status: 200, body: { userVerified: true } });
    expect(JSON.parse(fs.readFileSync(env.storePath, "utf8")).rpID).toBe(tailRP);
    const login = await env.post("/authentication/options", {});
    expect(login.body.options.rpId).toBe(tailRP);
    expect((await env.post("/authentication/verify", { ceremony: "fake", credential: assertion(login.body.options.challenge, key, { from: tailOrigin, rp: tailRP }) })).status).toBe(403);
    const body = { ceremony: login.body.ceremony, credential: assertion(login.body.options.challenge, key, { from: tailOrigin, rp: tailRP }) };
    expect(await env.post("/authentication/verify", body)).toMatchObject({ status: 200, body: { humanVerification: "VERIFIED", userVerified: true } });
    expect((await env.post("/authentication/verify", body)).status).toBe(403);
    const counterReplay = await env.post("/authentication/options", {});
    expect((await env.post("/authentication/verify", { ceremony: counterReplay.body.ceremony,
      credential: assertion(counterReplay.body.options.challenge, key, { from: tailOrigin, rp: tailRP }) })).status).toBe(403);
    const local = await env.post("/authentication/options", {});
    expect((await env.post("/authentication/verify", { ceremony: local.body.ceremony,
      credential: assertion(local.body.options.challenge, key, { from: origin, rp: rpID }) })).status).toBe(403);
    const wrongUV = await env.post("/authentication/options", {});
    expect((await env.post("/authentication/verify", { ceremony: wrongUV.body.ceremony,
      credential: assertion(wrongUV.body.options.challenge, key, { from: tailOrigin, rp: tailRP, uv: false }) })).status).toBe(403);
    const expired = await env.post("/authentication/options", {}); env.advance(120_001);
    expect((await env.post("/authentication/verify", { ceremony: expired.body.ceremony,
      credential: assertion(expired.body.options.challenge, key, { from: tailOrigin, rp: tailRP }) })).status).toBe(403);
    expect((await env.post("/authentication/options", {}, origin)).status).toBe(403);
  });
  it("does not reuse the legacy localhost credential file for the tailnet RP", async () => {
    const local = await setup(); await enroll(local);
    const tail = await setup("tailscale");
    fs.copyFileSync(local.storePath, tail.storePath);
    expect((await tail.post("/authentication/options", {})).status).not.toBe(200);
    expect((await tail.post("/registration/options", {})).status).not.toBe(200);
  });
});
