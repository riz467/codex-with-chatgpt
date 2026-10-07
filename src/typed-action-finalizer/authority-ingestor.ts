import https from "node:https";
import tls from "node:tls";
import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { parsePresentation, sameRequest, type TrustedTypedActionPresentation } from "../approver-service/presentation.js";
import { idSchema, sha256Schema, parseStrict, signedTypedActionApprovalSchema } from "../typed-action-approval/contract.js";
import type { TrustedContextStore } from "./trusted-context-storage.js";
export type { AuthorityIngestorHost, AuthorityLookup } from "./authority-ingestor-validation.js";

export interface TrustedPresentationPeer {
  registerPresentation(input: TrustedTypedActionPresentation): unknown | Promise<unknown>;
  status(id: string): unknown | Promise<unknown>;
  evidence(id: string): unknown | Promise<unknown>;
}

/** Outbound-only CT701 to CT700 transport. The host, not a caller, installs this peer. */
export function createTrustedPresentationPeerHttps(config: unknown): TrustedPresentationPeer {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid peer configuration");
  const values = config as Record<string, unknown>;
  const allowed = new Set(["endpoint", "clientCertificate", "clientKey", "ca", "expectedSpkiSha256", "expectedTransportRoleUri"]);
  if (Object.keys(values).some(key => !allowed.has(key))) throw new Error("Unknown peer configuration key");
  const credential = (value: unknown): value is string | Buffer =>
    (typeof value === "string" && value.length > 0) || (Buffer.isBuffer(value) && value.length > 0);
  if (typeof values.endpoint !== "string" || !credential(values.clientCertificate) || !credential(values.clientKey) ||
      (values.ca !== undefined && !credential(values.ca)) ||
      typeof values.expectedSpkiSha256 !== "string" || !/^[a-f0-9]{64}$/.test(values.expectedSpkiSha256) ||
      typeof values.expectedTransportRoleUri !== "string" ||
      !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s"\\]+$/.test(values.expectedTransportRoleUri))
    throw new Error("Invalid peer configuration");
  let endpoint: URL;
  try { endpoint = new URL(values.endpoint); } catch { throw new Error("Invalid peer endpoint"); }
  if (endpoint.protocol !== "https:" || endpoint.port !== "7443" || endpoint.pathname !== "/" ||
      endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
      !/^https:\/\/(?:\[[0-9a-fA-F:.]+\]|[^/?#:@]+):7443\/$/.test(values.endpoint))
    throw new Error("Peer endpoint must be an HTTPS origin on explicit port 7443");
  const pin = Buffer.from(values.expectedSpkiSha256, "hex");
  const role = values.expectedTransportRoleUri;
  const checkServerIdentity: typeof tls.checkServerIdentity = (hostname, certificate) => {
    const hostnameError = tls.checkServerIdentity(hostname, certificate);
    if (hostnameError) return hostnameError;
    try {
      if (!Buffer.isBuffer(certificate.raw)) throw new Error("Missing peer certificate DER");
      const x509 = new X509Certificate(certificate.raw);
      const san = x509.subjectAltName;
      if (!san || certificate.subjectaltname !== san || /["\\\r\n]/.test(san)) throw new Error("Invalid peer SAN");
      const entries = san.split(", ");
      if (new Set(entries).size !== entries.length || entries.some(entry => !/^(?:DNS|IP Address|URI):[^,]+$/.test(entry)))
        throw new Error("Ambiguous peer SAN");
      const uris = entries.filter(entry => entry.startsWith("URI:"));
      if (uris.length !== 1 || uris[0] !== `URI:${role}`) throw new Error("Peer transport role mismatch");
      const spki = x509.publicKey.export({ type: "spki", format: "der" });
      const actual = createHash("sha256").update(spki).digest();
      if (!timingSafeEqual(actual, pin)) throw new Error("Peer SPKI pin mismatch");
      return undefined;
    } catch (error) { return error instanceof Error ? error : new Error("Invalid peer certificate"); }
  };
  const request = (method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      const req = https.request(new URL(route, endpoint), {
        method, cert: values.clientCertificate as string | Buffer, key: values.clientKey as string | Buffer,
        ...(values.ca === undefined ? {} : { ca: values.ca as string | Buffer }),
        minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true,
        agent: false, checkServerIdentity,
        headers: { accept: "application/json", ...(payload === undefined ? {} : {
          "content-type": "application/json", "content-length": String(payload.length),
        }) },
      }, response => {
        const fail = (message: string) => { reject(new Error(message)); response.destroy(); };
        if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
          fail("Peer HTTP status rejected"); return;
        }
        const contentType = response.headers["content-type"];
        if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType) ||
            response.headers["content-encoding"] !== undefined) { fail("Peer response media type rejected"); return; }
        const length = response.headers["content-length"];
        if (length !== undefined && (typeof length !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > 1_048_576)) {
          fail("Peer response length rejected"); return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let complete = false;
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Peer response aborted")));
        response.on("close", () => { if (!complete) reject(new Error("Peer response closed")); });
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) { fail("Peer response too large"); return; }
          chunks.push(chunk);
        });
        response.on("end", () => {
          complete = true;
          if (typeof length === "string" && Number(length) !== size) { reject(new Error("Peer response length mismatch")); return; }
          try { resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
          catch { reject(new Error("Invalid peer JSON response")); }
        });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error("Peer request timed out")));
      req.end(payload);
    });
  };
  const routeFor = (id: string, kind: "status" | "evidence") => {
    // Validate before constructing a Promise or opening a connection.
    const valid = idSchema.parse(id);
    return `/api/typed-action-${kind}/${valid}`;
  };
  return Object.freeze({
    registerPresentation: (input: TrustedTypedActionPresentation) =>
      request("POST", "/api/typed-action-presentations", input),
    status: (id: string) => request("GET", routeFor(id, "status")),
    evidence: (id: string) => request("GET", routeFor(id, "evidence")),
  });
}

const receiptSchema = z.object({ approvalRequestId: idSchema, presentationHash: sha256Schema }).strict();
const statusSchema = z.object({ approvalRequestId: idSchema, presentationHash: sha256Schema,
  state: z.enum(["CURRENT", "STALE", "SUPERSEDED"]), approvalState: z.enum(["PENDING", "APPROVED"]),
  current: z.boolean() }).strict();

type BaseIngestor = Readonly<{
  adoptIndependentReview: (input: unknown) => ReturnType<TrustedContextStore["adoptIndependentReview"]>;
  registerHumanApproval: (input: unknown) => ReturnType<TrustedContextStore["registerHumanApproval"]>;
}>;
type PeerIngestor = BaseIngestor & Readonly<{
  registerTrustedPresentation: (input: unknown) => Promise<z.infer<typeof receiptSchema>>;
  collectApprovedHumanApproval: (input: unknown) => Promise<ReturnType<TrustedContextStore["registerHumanApproval"]>>;
}>;

/** Pass this narrow capability to an in-process caller, never the host/store.
 * The host installs dependencies when constructing TrustedContextStore. */
export function createTrustedAuthorityIngestor(store: TrustedContextStore): BaseIngestor;
export function createTrustedAuthorityIngestor(store: TrustedContextStore, peer: TrustedPresentationPeer): PeerIngestor;
export function createTrustedAuthorityIngestor(store: TrustedContextStore, peer?: TrustedPresentationPeer) {
  const base = {
    adoptIndependentReview: (input: unknown) => store.adoptIndependentReview(input),
    registerHumanApproval: (input: unknown) => store.registerHumanApproval(input),
  };
  if (!peer) return Object.freeze(base);
  const registerPresentation = peer.registerPresentation.bind(peer);
  const status = peer.status.bind(peer);
  const evidenceFor = peer.evidence.bind(peer);
  return Object.freeze({
    ...base,
    registerTrustedPresentation: async (input: unknown) => {
      const presentation = parsePresentation(input);
      const receipt = parseStrict(receiptSchema, await registerPresentation(presentation));
      if (receipt.approvalRequestId !== presentation.request.approvalRequestId ||
          receipt.presentationHash !== presentation.presentationHash) throw new Error("Presentation receipt mismatch");
      return receipt;
    },
    collectApprovedHumanApproval: async (input: unknown) => {
      const presentation = parsePresentation(input);
      const approvalStatus = parseStrict(statusSchema, await status(presentation.request.approvalRequestId));
      if (approvalStatus.approvalRequestId !== presentation.request.approvalRequestId ||
          approvalStatus.presentationHash !== presentation.presentationHash ||
          approvalStatus.state !== "CURRENT" || approvalStatus.approvalState !== "APPROVED" ||
          approvalStatus.current !== true) throw new Error("Presentation is not currently approved");
      const evidence = parseStrict(signedTypedActionApprovalSchema, await evidenceFor(presentation.request.approvalRequestId));
      if (!sameRequest(evidence.payload, presentation.request)) throw new Error("Approval request mismatch");
      const { actionId, targetId, requestHash, attemptId, attemptHash } = presentation.request;
      return store.registerHumanApproval({ identity: { actionId, targetId, requestHash, attemptId, attemptHash }, evidence });
    },
  });
}
