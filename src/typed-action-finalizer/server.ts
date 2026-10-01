import express, { type ErrorRequestHandler } from "express";
import { createServer } from "node:http";
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, timingSafeEqual, type KeyObject } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { hashTypedActionApproval, immutable, idSchema, jtiSchema, keyIdSchema, parseStrict, sha256Schema } from "../typed-action-approval/contract.js";
import { finalizerInputSchema, hashExecutionPermit, type FinalizerInput } from "./contract.js";
import { createTypedActionPermitSigningKernel } from "./signer.js";
import { LedgerOutcomeUnknownError, reconciliationCategories, TypedActionFinalizerStore } from "./storage.js";
import type { ReviewReservation, BarrierResolution } from '../review-service/coordination.js';
import type { Handoff, CustodyReceipt } from '../protected-execution-bridge/contract.js';
import { consumeWithReadiness } from './execution-coordinator.js';

/** v1 is isolated loopback only. These fixed paths are CT701-owned bootstrap
 * configuration, never HTTP selectors. Deployment/authentication is a later phase. */
export const finalizerServiceConfigSchema = z.object({
  host: z.literal("127.0.0.1"), port: z.number().int().min(0).max(65535),
  databasePath: z.literal("/var/lib/ct701-typed-action-finalizer/ledger.sqlite"),
  signingKeyPath: z.literal("/etc/ct701-typed-action-finalizer/signing-key.pem"),
  finalizerKeyId: keyIdSchema,
  trustedHumanKeyPath: z.literal("/etc/ct701-typed-action-finalizer/ct700-public.pem"),
  trustedHumanKeyId: keyIdSchema,
  bridgeTokenPath: z.literal("/etc/ct701-typed-action-finalizer/bridge-token"),
  trustedContextProvider: z.object({ kind: z.enum(["host-injected", "deny-all"]) }).strict(),
}).strict();
export type FinalizerServiceConfig = z.infer<typeof finalizerServiceConfigSchema>;
export const finalizationBodySchema = finalizerInputSchema.pick({ boundRequest: true, boundAttempt: true, humanApproval: true }).strict();
const identityBodySchema = z.object({ permitJti: jtiSchema, attemptHash: sha256Schema }).strict();
const reconcileBodySchema = identityBodySchema.extend({ category: z.enum(reconciliationCategories) }).strict();
export type ContextIdentity = Readonly<{
  actionId: string; targetId: string; requestHash: string; attemptId: string; attemptHash: string;
  approvalRequestId?: string; humanApprovalJti: string; humanApprovalEvidenceHash: string;
}>;
export interface TrustedContextProvider {
  /** Host must fence independently maintained request/review/policy/generation
   * state through this entire operation, including the live bridge handoff. */
  withFence<T>(identity: ContextIdentity, operation: () => Promise<T>): Promise<T>;
  finalization(identity: ContextIdentity): Pick<FinalizerInput, "humanContext" | "independentReview" | "policyContext">;
  execution(identity: ContextIdentity): unknown;
  readiness?(identity: ContextIdentity, barrierId: string): ReviewReservation;
  acquireReadiness?(reservation: ReviewReservation): Promise<unknown>;
  resolveReadiness?(resolution: BarrierResolution): Promise<unknown>;
}
export interface IsolatedExecutionBridge {
  /** Live, in-process one-shot notification under the provider fence. No JSON
   * response/evidence can invoke this. v1 must not invoke any real adapter. */
  handoff(permit: Readonly<Handoff>): CustodyReceipt | Promise<CustodyReceipt>;
}
export type FinalizerServiceDependencies = {
  privateKey?: KeyObject; humanPublicKey?: KeyObject; databasePath?: string;
  bridgeToken?: string; provider?: TrustedContextProvider; bridge?: IsolatedExecutionBridge; now?: () => number;
};

function readHostFile(path: string, secret: boolean): Buffer {
  // Refuse symlinks (including ancestors), non-regular files and Unix secret
  // files not owned by this uid or readable by group/others. Windows ACLs remain
  // a host bootstrap responsibility; tests inject ephemeral KeyObjects.
  for (let p = resolve(path); ; p = dirname(p)) {
    if (lstatSync(p).isSymbolicLink()) throw new Error("Symlink bootstrap path");
    if (dirname(p) === p) break;
  }
  if (realpathSync(path) !== resolve(path)) throw new Error("Noncanonical bootstrap path");
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (secret && process.platform !== "win32"
      && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Unsafe bootstrap file");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** DI is a trusted embedding/test seam, never populated from request data. */
export function createFinalizerService(rawConfig: unknown, host: FinalizerServiceDependencies = {}) {
  const config = parseStrict(finalizerServiceConfigSchema, rawConfig);
  const provider = host.provider ?? (config.trustedContextProvider.kind === "deny-all" ? {
    async withFence<T>(_identity: ContextIdentity, _operation: () => Promise<T>): Promise<T> { throw new Error("Provider unavailable"); },
    finalization(): never { throw new Error("Provider unavailable"); }, execution(): never { throw new Error("Provider unavailable"); },
  } : undefined);
  if (!provider) throw new Error("Host-owned trusted context provider required");
  const privateKey = host.privateKey ?? createPrivateKey(readHostFile(config.signingKeyPath, true));
  const humanKey = host.humanPublicKey ?? createPublicKey(readHostFile(config.trustedHumanKeyPath, false));
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519"
    || humanKey.type !== "public" || humanKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 keys required");
  const token = host.bridgeToken ?? readHostFile(config.bridgeTokenPath, true).toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error("Strong bridge token required");
  const now = host.now ?? Date.now;
  const db = new DatabaseSync(host.databasePath ?? config.databasePath);
  let store: TypedActionFinalizerStore;
  try { store = new TypedActionFinalizerStore({ database: db, trustedFinalizerKeys: new Map([[config.finalizerKeyId, createPublicKey(privateKey)]]), now }); }
  catch (error) { db.close(); throw error; }
  const kernel = createTypedActionPermitSigningKernel({ store, privateKey, finalizerKeyId: config.finalizerKeyId,
    trustedHumanKeys: new Map([[config.trustedHumanKeyId, humanKey]]), now });
  // Unknown durable outcomes latch the process closed, including evidence
  // retrieval. Recovery requires a healthy ledger and host reconciliation.
  let quarantined = false;
  const app = express();
  app.disable("x-powered-by"); app.disable("etag");
  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (req.headers.origin || Object.keys(req.query).length) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
    if (quarantined) { res.status(503).json({ state: "RECONCILE_REQUIRED", executionMayStart: false }); return; }
    if (req.method === "POST" && !req.is("application/json")) { res.status(415).json({ error: "JSON_REQUIRED" }); return; }
    next();
  });
  app.use(express.json({ limit: "64kb", strict: true, inflate: false }));
  app.get("/health", (_req, res) => { res.json({ status: "ok", boundary: "isolated-loopback" }); });
  app.post("/api/typed-action-finalizations", async (req, res) => {
    const input = parseStrict(finalizationBodySchema, req.body);
    const p = input.humanApproval.payload;
    const identity = immutable({ actionId: input.boundRequest.request.actionId, targetId: input.boundRequest.request.target.id,
      requestHash: input.boundRequest.requestHash, attemptId: input.boundAttempt.attempt.attemptId, attemptHash: input.boundAttempt.attemptHash,
      approvalRequestId: p.approvalRequestId, humanApprovalJti: p.jti, humanApprovalEvidenceHash: hashTypedActionApproval(input.humanApproval) });
    const result = await provider.withFence(identity, async () => {
      const snapshot = provider.finalization(identity);
      const issuedAt = now();
      const expiresAt = Math.min(issuedAt + 60_000, Date.parse(p.expiresAt),
        Date.parse(snapshot.independentReview.expiresAt), Date.parse(snapshot.policyContext.maintenanceWindowExpiresAt));
      return kernel.finalizeAndSignTypedAction({ ...input, humanContext: snapshot.humanContext,
        independentReview: snapshot.independentReview, policyContext: snapshot.policyContext,
        issuance: { permitId: randomUUID(), jti: randomBytes(32).toString("base64url"),
          issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() } });
    });
    if (result.state === "REJECTED") { res.status(409).json(result); return; }
    res.status(201).json({ permitId: result.envelope.payload.permitId, permitJti: result.envelope.payload.jti,
      evidenceId: hashExecutionPermit(result.envelope) });
  });
  app.get("/api/typed-action-permits/:id", (req, res) => {
    const row = store.permitById(parseStrict(idSchema, req.params.id));
    if (!row) { res.status(404).json({ error: "NOT_FOUND" }); return; }
    res.json({ evidenceId: hashExecutionPermit(row.envelope), envelope: row.envelope, state: row.state });
  });
  app.post("/api/typed-action-permits/:id/:operation", async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.status(401).json({ error: "BRIDGE_REQUIRED" }); return; }
    const operation = req.params.operation;
    if (!["consume", "reconcile", "execution-verified"].includes(operation)) { res.status(404).json({ error: "NOT_FOUND" }); return; }
    const body = parseStrict(operation === "reconcile" ? reconcileBodySchema : identityBodySchema, req.body);
    const row = store.permitById(parseStrict(idSchema, req.params.id));
    if (!row) { res.status(404).json({ error: "NOT_FOUND" }); return; }
    const p = row.envelope.payload;
    if (body.permitJti !== p.jti || body.attemptHash !== p.attemptHash) { res.status(409).json({ state: "REJECTED", executionMayStart: false }); return; }
    const ids = { permitJti: p.jti, attemptHash: p.attemptHash };
    if (operation === "reconcile") {
      store.recordConsumedReconciliation(ids, parseStrict(reconcileBodySchema, req.body).category);
      res.json({ state: "RECONCILE_REQUIRED", executionMayStart: false }); return;
    }
    if (operation === "execution-verified") {
      store.recordVerifiedExecution(ids); res.json({ recorded: true }); return;
    }
    if (row.state !== "VERIFIED_NOT_CONSUMED" || !host.bridge) {
      res.status(409).json({ state: row.state === "RECONCILE_REQUIRED" ? row.state : "REJECTED", executionMayStart: false }); return;
    }
    const identity = immutable({ actionId: p.actionId, targetId: p.targetId, requestHash: p.requestHash,
      attemptId: p.attemptId, attemptHash: p.attemptHash, humanApprovalJti: p.humanApprovalJti, humanApprovalEvidenceHash: p.humanApprovalEvidenceHash });
    let decision;
    try {
      decision = await provider.withFence(identity, async () => {
        return consumeWithReadiness({ store, provider, bridge: host.bridge! }, row.envelope, identity);
      });
    } catch (error) {
      if (error instanceof LedgerOutcomeUnknownError) throw error;
      // The outer authority fence can fail after custody (expiry, poisoned fence,
      // or unknown authority COMMIT). Never report a retryable pre-consume denial.
      const persisted = store.permit(p.jti);
      if (persisted?.state === 'CONSUMED_FOR_EXECUTION' || persisted?.state === 'RECONCILE_REQUIRED') {
        try { store.recordReconciliation(ids, 'GATE_RECHECK_FAILED'); }
        catch { throw new LedgerOutcomeUnknownError(ids, false); }
        decision = { state: 'RECONCILE_REQUIRED', executionMayStart: false };
      } else throw error;
    }
    // Deliberately omit the gate's permit payload: this is a notification of a
    // completed live handoff, not a portable execution capability.
    res.status(decision.executionMayStart ? 200 : 409).json({ state: decision.state, executionMayStart: decision.executionMayStart });
  });
  app.use((_req, res) => { res.status(404).json({ error: "NOT_FOUND" }); });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof LedgerOutcomeUnknownError) {
      quarantined = true; res.status(503).json({ state: "RECONCILE_REQUIRED", executionMayStart: false }); return;
    }
    res.status(error?.type === "entity.too.large" ? 413 : 400).json({ error: "REQUEST_REJECTED", executionMayStart: false });
  };
  app.use(errorHandler);
  const server = createServer(app);
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return Object.freeze({
    async listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Listener unavailable");
      return address.port;
    },
    async close(): Promise<void> {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  });
}
