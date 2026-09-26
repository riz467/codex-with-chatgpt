import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";

const tailnetRPID = "ai-workspace-win.tail2f618d.ts.net";
type Mode = "localhost" | "tailscale";
const configuration = (mode: Mode) => mode === "tailscale"
  ? { rpID: tailnetRPID, origin: `https://${tailnetRPID}`, host: tailnetRPID, file: "credential-tailscale.json" }
  : { rpID: "localhost", origin: "http://localhost:48767", host: "localhost:48767", file: "credential.json" };
const ttl = 120_000;
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
type Stored = { rpID?: string; id: string; publicKey: string; counter: number; transports?: WebAuthnCredential["transports"] };
type Pending = { challenge: string; expires: number; kind: "registration" | "authentication" };

// Only the credential ID, public key, counter and optional transport hints persist.
// This file is NOT a human-only evidence store or a security boundary against this OS principal.
export function createHumanApprover(options: { mode?: Mode; storePath?: string; now?: () => number } = {}) {
  const mode = options.mode ?? "localhost";
  const { rpID, origin, host, file } = configuration(mode);
  const storePath = options.storePath ?? path.join(process.env.LOCALAPPDATA || os.tmpdir(), "ai-workspace-human-approver-poc", file);
  const now = options.now ?? Date.now;
  const pending = new Map<string, Pending>();
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });
  const read = (): Stored | null => {
    try {
      const value = JSON.parse(fs.readFileSync(storePath, "utf8")) as Stored;
      if (typeof value.id !== "string" || typeof value.publicKey !== "string" || !Number.isSafeInteger(value.counter)) throw new Error("CORRUPT_STORE");
      // Legacy localhost-only files had no rpID field. Never accept those for the tailnet RP.
      if (value.rpID !== rpID && !(mode === "localhost" && value.rpID === undefined)) throw new Error("WRONG_RP_STORE");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const save = (credential: Stored) => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const temporary = `${storePath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(credential), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, storePath);
    } finally { try { fs.unlinkSync(temporary); } catch { /* renamed */ } }
  };
  const issue = (kind: Pending["kind"], challenge: string) => {
    for (const [id, value] of pending) if (value.expires <= now()) pending.delete(id);
    const ceremony = randomBytes(32).toString("base64url");
    pending.set(ceremony, { challenge, expires: now() + ttl, kind });
    return ceremony;
  };
  const consume = (id: unknown, kind: Pending["kind"]) => {
    if (typeof id !== "string") return null;
    const entry = pending.get(id);
    pending.delete(id); // consume even on malformed input, verification failure or expiry
    return entry?.kind === kind && entry.expires > now() ? entry.challenge : null;
  };
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/app.js", (_req, res) => res.sendFile(path.join(publicDir, "app.js")));
  app.get("/status", (_req, res) => res.json({ registered: read() !== null, mode }));
  const json = express.json({ limit: "32kb", strict: true, type: "application/json" });
  const sameOrigin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.origin !== origin || req.headers.host !== host || req.headers["content-type"] !== "application/json") {
      res.status(403).json({ error: "ORIGIN_REQUIRED" }); return;
    }
    next();
  };
  const fields = (...allowed: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.body || Array.isArray(req.body) || typeof req.body !== "object" ||
        Object.keys(req.body).some(key => !allowed.includes(key)) || allowed.some(key => !(key in req.body))) {
      res.status(400).json({ error: "INVALID_REQUEST" }); return;
    }
    next();
  };
  app.post("/registration/options", sameOrigin, json, fields(), async (_req, res) => {
    if (read()) { res.status(409).json({ error: "ALREADY_REGISTERED" }); return; }
    const options = await generateRegistrationOptions({ rpName: "AI Workspace Human Approver PoC", rpID, challenge: randomBytes(32),
      userName: "human-approver", userID: randomBytes(32), attestationType: "none",
      authenticatorSelection: { ...(mode === "localhost" ? { authenticatorAttachment: "platform" as const } : {}), residentKey: "preferred", userVerification: "required" },
      ...(mode === "localhost" ? { preferredAuthenticatorType: "localDevice" as const } : {}), timeout: ttl });
    res.json({ ceremony: issue("registration", options.challenge), options });
  });
  app.post("/registration/verify", sameOrigin, json, fields("ceremony", "credential"), async (req, res) => {
    const challenge = consume(req.body?.ceremony, "registration");
    if (!challenge || read()) { res.status(403).json({ error: "REGISTRATION_REJECTED" }); return; }
    try {
      const result = await verifyRegistrationResponse({ response: req.body.credential as RegistrationResponseJSON,
        expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      if (!result.verified || !result.registrationInfo.userVerified || result.registrationInfo.origin !== origin || result.registrationInfo.rpID !== rpID) throw new Error("INVALID_REGISTRATION");
      const c = result.registrationInfo.credential;
      save({ rpID, id: c.id, publicKey: Buffer.from(c.publicKey).toString("base64url"), counter: c.counter, transports: c.transports });
      res.json({ registered: true, userVerified: true });
    } catch { res.status(403).json({ error: "REGISTRATION_REJECTED" }); }
  });
  app.post("/authentication/options", sameOrigin, json, fields(), async (_req, res) => {
    const stored = read();
    if (!stored) { res.status(409).json({ error: "NOT_REGISTERED" }); return; }
    const options = await generateAuthenticationOptions({ rpID, challenge: randomBytes(32), userVerification: "required", timeout: ttl,
      allowCredentials: [{ id: stored.id, transports: stored.transports }] });
    res.json({ ceremony: issue("authentication", options.challenge), options });
  });
  app.post("/authentication/verify", sameOrigin, json, fields("ceremony", "credential"), async (req, res) => {
    const challenge = consume(req.body?.ceremony, "authentication");
    const stored = read();
    if (!challenge || !stored || req.body?.credential?.id !== stored.id) { res.status(403).json({ error: "AUTHENTICATION_REJECTED" }); return; }
    try {
      const result = await verifyAuthenticationResponse({ response: req.body.credential as AuthenticationResponseJSON,
        expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: stored.id, publicKey: Buffer.from(stored.publicKey, "base64url"), counter: stored.counter, transports: stored.transports } });
      if (!result.verified || !result.authenticationInfo.userVerified || result.authenticationInfo.origin !== origin || result.authenticationInfo.rpID !== rpID) throw new Error("INVALID_AUTHENTICATION");
      save({ ...stored, counter: result.authenticationInfo.newCounter });
      // No DONE write, approval token, or durable human-verification evidence is issued.
      res.json({ humanVerification: "VERIFIED", userVerified: true });
    } catch { res.status(403).json({ error: "AUTHENTICATION_REJECTED" }); }
  });
  app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: "INVALID_REQUEST" }));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.env.HUMAN_APPROVER_MODE || "localhost";
  if (mode !== "localhost" && mode !== "tailscale") throw new Error("HUMAN_APPROVER_MODE must be localhost or tailscale");
  createHumanApprover({ mode }).listen(48767, "127.0.0.1", () => console.log(`Human Approver PoC (${mode}): ${configuration(mode).origin}`));
}
