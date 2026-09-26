import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { approvalRequestSchema, approvalSigningBytes, type ApprovalRequest, type SignedApproval } from "../human-approval/contract.js";
import { ApproverStore } from "./storage.js";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const idPattern = /^req-[0-9a-f]{32}$/;
export const approverConfigSchema = z.object({
  rp_id: z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/),
  origin: z.string().url(),
  key_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  db_path: z.string().startsWith("/var/lib/ai-approver/"),
  signing_key_path: z.string().startsWith("/var/lib/ai-approver/"),
  port: z.number().int().min(1024).max(65535),
}).strict().refine(v => v.origin === `https://${v.rp_id}`);
export type ApproverConfig = z.infer<typeof approverConfigSchema>;

function exactly(body: unknown, fields: string[]): body is Record<string, unknown> {
  return !!body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).length === fields.length && fields.every(key => Object.hasOwn(body, key));
}
const validTime = (request: ApprovalRequest, now: number) => {
  const issued = Date.parse(request.issued_at), expires = Date.parse(request.expires_at);
  return issued <= now + 30_000 && expires > now && expires > issued && expires - issued <= 300_000;
};

/** Dependencies are injected for isolated tests; deployment loads the private key only inside the CT. */
export function createApproverService(config: ApproverConfig, store: ApproverStore, privateKey: KeyObject, now = Date.now) {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519" ||
      approverConfigSchema.safeParse(config).success === false) throw new Error("INVALID_APPROVER_CONFIGURATION");
  const app = express(); app.disable("x-powered-by"); app.disable("trust proxy");
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store"); res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    next();
  });
  const json = express.json({ limit: "32kb", strict: true, type: "application/json" });
  const browser = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.origin !== config.origin || req.headers.host !== config.rp_id || req.headers["content-type"] !== "application/json") {
      res.status(403).json({ error: "ORIGIN_REQUIRED" }); return;
    }
    next();
  };
  const reject = (res: express.Response, code = 403) => res.status(code).json({ error: "REJECTED" });
  app.get("/health", (_req, res) => res.json({ ok: true, service: "ai-approver" }));
  app.get("/", (_req, res) => res.status(404).end());
  app.get("/app.js", (_req, res) => res.sendFile(path.join(publicDir, "app.js")));
  app.get("/approve/:id", (req, res) => {
    if (!idPattern.test(String(req.params.id)) || !store.request(String(req.params.id))) { reject(res, 404); return; }
    res.sendFile(path.join(publicDir, "index.html"));
  });
  app.get("/enroll/:token", (req, res) => {
    if (!store.enrollmentOpen(String(req.params.token), now())) { reject(res, 404); return; }
    res.sendFile(path.join(publicDir, "index.html"));
  });
  app.get("/api/approval-requests/:id", (req, res) => {
    const id = String(req.params.id);
    const item = idPattern.test(id) ? store.request(id) : null;
    if (!item) { reject(res, 404); return; }
    res.json({ payload: item.payload, state: item.state });
  });
  // AI may propose a bounded request; this route never signs or opens enrollment.
  app.post("/api/approval-requests", json, (req, res) => {
    const parsed = approvalRequestSchema.safeParse(req.body);
    if (!parsed.success || !validTime(parsed.data, now())) { reject(res, 400); return; }
    if (!store.createRequest(parsed.data, now())) { reject(res, 409); return; }
    res.status(201).json({ request_id: parsed.data.request_id, state: "PENDING" });
  });
  app.post("/api/webauthn/authentication/options", browser, json, async (req, res) => {
    if (!exactly(req.body, ["request_id"]) || typeof req.body.request_id !== "string" || !idPattern.test(req.body.request_id)) { reject(res, 400); return; }
    const credentials = store.credentials();
    if (!credentials.length) { reject(res); return; }
    const options = await generateAuthenticationOptions({ rpID: config.rp_id, challenge: randomBytes(32), userVerification: "required",
      timeout: 120_000, allowCredentials: credentials.map(c => ({ id: c.id, transports: c.transports as AuthenticatorTransportFuture[] })) });
    const ceremony = store.issueAuthentication(req.body.request_id, options.challenge, now());
    if (!ceremony) { reject(res); return; }
    res.json({ ceremony, options });
  });
  app.post("/api/webauthn/authentication/verify", browser, json, async (req, res) => {
    if (!exactly(req.body, ["request_id", "ceremony", "credential"]) || typeof req.body.request_id !== "string" ||
        typeof req.body.ceremony !== "string" || !idPattern.test(req.body.request_id)) { reject(res, 400); return; }
    const challenge = store.consumeAuthentication(req.body.request_id, req.body.ceremony, now());
    const credential = req.body.credential && typeof req.body.credential === "object" && !Array.isArray(req.body.credential) &&
      typeof (req.body.credential as Record<string, unknown>).id === "string" ?
      store.credential((req.body.credential as Record<string, string>).id) : undefined;
    if (!challenge || !credential) { reject(res); return; }
    try {
      const result = await verifyAuthenticationResponse({ response: req.body.credential as AuthenticationResponseJSON,
        expectedChallenge: challenge, expectedOrigin: config.origin, expectedRPID: config.rp_id, requireUserVerification: true,
        credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, "base64url"), counter: credential.counter,
          transports: credential.transports as AuthenticatorTransportFuture[] } });
      if (!result.verified || !result.authenticationInfo.userVerified || result.authenticationInfo.origin !== config.origin ||
          result.authenticationInfo.rpID !== config.rp_id) { reject(res); return; }
      const item = store.request(req.body.request_id);
      if (!item || item.state !== "PENDING" || !validTime(item.payload, now())) { reject(res); return; }
      const unsigned: SignedApproval = { schema_version: 1, type: "AI_WORKSPACE_DONE_APPROVAL", payload: item.payload,
        approver_key_id: config.key_id, signature_algorithm: "Ed25519", signature: "A".repeat(86) };
      const envelope: SignedApproval = { ...unsigned, signature: sign(null, approvalSigningBytes(unsigned), privateKey).toString("base64url") };
      if (!store.approve(req.body.request_id, credential, result.authenticationInfo.newCounter, envelope, now())) { reject(res); return; }
      res.status(201).json({ approved: true, request_id: req.body.request_id }); // evidence fetched separately
    } catch { reject(res); }
  });
  app.get("/api/approval-evidence/:id", (req, res) => {
    const id = String(req.params.id);
    const value = idPattern.test(id) ? store.evidence(id) : null;
    if (!value) { reject(res, 404); return; }
    res.json(value);
  });
  // Enrollment is only possible with a secret, one-use token opened by a CT-local CLI.
  app.post("/enrollment/options", browser, json, async (req, res) => {
    if (!exactly(req.body, ["token"]) || typeof req.body.token !== "string" || !store.enrollmentOpen(req.body.token, now())) { reject(res); return; }
    const options = await generateRegistrationOptions({ rpName: "AI Workspace Human Approver", rpID: config.rp_id,
      challenge: randomBytes(32), userName: "human-approver", userID: randomBytes(32), timeout: 120_000,
      attestationType: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: store.credentials().map(c => ({ id: c.id, transports: c.transports as AuthenticatorTransportFuture[] })) });
    const ceremony = store.issueEnrollment(req.body.token, options.challenge, now());
    if (!ceremony) { reject(res); return; }
    res.json({ ceremony, options });
  });
  app.post("/enrollment/verify", browser, json, async (req, res) => {
    if (!exactly(req.body, ["token", "ceremony", "credential"]) || typeof req.body.token !== "string" || typeof req.body.ceremony !== "string") { reject(res, 400); return; }
    const challenge = store.consumeEnrollment(req.body.token, req.body.ceremony, now());
    if (!challenge) { reject(res); return; }
    try {
      const result = await verifyRegistrationResponse({ response: req.body.credential as RegistrationResponseJSON,
        expectedChallenge: challenge, expectedOrigin: config.origin, expectedRPID: config.rp_id, requireUserVerification: true });
      if (!result.verified || !result.registrationInfo.userVerified || result.registrationInfo.origin !== config.origin ||
          result.registrationInfo.rpID !== config.rp_id) { reject(res); return; }
      const c = result.registrationInfo.credential;
      if (!store.register({ id: c.id, publicKey: Buffer.from(c.publicKey).toString("base64url"), counter: c.counter,
        transports: c.transports ?? [], enabled: true }, req.body.token, now())) { reject(res); return; }
      res.status(201).json({ enrolled: true });
    } catch { reject(res); }
  });
  app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: "INVALID_REQUEST" }));
  return app;
}
