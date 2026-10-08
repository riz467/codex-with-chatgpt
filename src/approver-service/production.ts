import express from 'express';
import { request as httpRequest } from 'node:http';
import type * as https from 'node:https';
import { createHash, randomBytes, timingSafeEqual, X509Certificate, type KeyObject } from 'node:crypto';
import { createApproverService, type ApproverConfig } from './server.js';
import { ApproverStore } from './storage.js';
import { denyAllPresentationVerifier, parsePresentation, sameRequest, type TrustedTypedActionPresentationVerifier } from './presentation.js';
import { idSchema } from '../typed-action-approval/contract.js';

export const humanPort = 48768;
export const peerPort = 48769;
/** Compile host-owned TLS material offline; peer authorization belongs to the later verified server factory. */
export function compileCt700PeerMtlsOptions(hostConfig: unknown): https.ServerOptions {
  const invalid = () => { throw Error('INVALID_CT700_PEER_MTLS_CONFIG'); };
  if (hostConfig === null || typeof hostConfig !== 'object' ||
      Object.getPrototypeOf(hostConfig) !== Object.prototype) return invalid();
  const fields = ['serverCertificate', 'serverPrivateKey', 'trustedClientCa',
    'expectedClientSpkiSha256', 'expectedUriSanRole'] as const;
  const keys = Reflect.ownKeys(hostConfig);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key as typeof fields[number])))
    return invalid();
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(hostConfig, field);
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
    values[field] = descriptor.value;
  }
  const material = (value: unknown): string | Buffer => {
    if (Buffer.isBuffer(value) && value.length > 0 && value.length <= 64 * 1024) return Buffer.from(value);
    if (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 64 * 1024) return value;
    return invalid();
  };
  if (typeof values.expectedClientSpkiSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(values.expectedClientSpkiSha256) ||
      typeof values.expectedUriSanRole !== 'string' ||
      !/^urn:[a-z0-9][a-z0-9-]{0,30}[a-z0-9]:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[a-z0-9]+(?:[.-][a-z0-9]+)*)*$/.test(values.expectedUriSanRole))
    return invalid();
  return Object.freeze({ minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', requestCert: true,
    rejectUnauthorized: true, ca: material(values.trustedClientCa),
    cert: material(values.serverCertificate), key: material(values.serverPrivateKey) });
}

/** Offline identity constraints only. This does not verify a TLS client chain or socket authorization;
 * Stage 2B-2b must supply verified TLS peer authentication before using this predicate.
 */
export function validateCt701InboundPeerIdentity(
  leafDer: unknown, settings: unknown,
): boolean {
  try {
    if (!Buffer.isBuffer(leafDer) || leafDer.length === 0 || leafDer.length > 64 * 1024 ||
        !settings || typeof settings !== 'object' || Array.isArray(settings) ||
        Reflect.ownKeys(settings).length !== 2 ||
        !Reflect.ownKeys(settings).includes('expectedClientSpkiSha256') ||
        !Reflect.ownKeys(settings).includes('expectedUriSanRole')) throw Error();
    const values = settings as Record<string, unknown>;
    const pin = Object.getOwnPropertyDescriptor(values, 'expectedClientSpkiSha256');
    const role = Object.getOwnPropertyDescriptor(values, 'expectedUriSanRole');
    if (!pin || !role || !('value' in pin) || !('value' in role) ||
        typeof pin.value !== 'string' || !/^[0-9a-f]{64}$/.test(pin.value) ||
        typeof role.value !== 'string' ||
        !/^urn:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[a-z0-9]+(?:[.-][a-z0-9]+)*)*$/.test(role.value)) throw Error();
    const certificate = new X509Certificate(leafDer);
    // Reject DER with trailing data even if the X.509 parser accepts the first certificate.
    if (!certificate.raw.equals(leafDer) || certificate.subjectAltName !== `URI:${role.value}` ||
        !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.2')) throw Error();
    const from = Date.parse(certificate.validFrom), to = Date.parse(certificate.validTo), now = Date.now();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > now || to < now || from > to) throw Error();
    const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
    return timingSafeEqual(createHash('sha256').update(spki).digest(), Buffer.from(pin.value, 'hex'));
  } catch {
    return false;
  }
}

/** No config switch/module loader enables peer authority. Reviewed host composition only. */
export function createProductionApprover(config: ApproverConfig, store: ApproverStore, key: KeyObject,
  verifier: TrustedTypedActionPresentationVerifier = denyAllPresentationVerifier, now = Date.now) {
  if (config.port !== humanPort || store.profile !== 'production') throw Error('INVALID_PRODUCTION_CONFIGURATION');
  const human = createApproverService(config, store, key, now, undefined, 'human-production');
  const credential = randomBytes(32);
  const requireLocalPrincipal: express.RequestHandler = (req, res, next) => {
    const supplied = req.get('X-CT700-Local-Principal');
    const wellFormed = typeof supplied === 'string' && /^[0-9a-f]{64}$/.test(supplied);
    const candidate = Buffer.from(wellFormed ? supplied : '00'.repeat(32), 'hex');
    if (!timingSafeEqual(candidate, credential) || !wellFormed) {
      res.status(403).json({ error: 'UNTRUSTED_PEER' }); return;
    }
    next();
  };
  const peer = express(); peer.disable('x-powered-by'); peer.disable('trust proxy');
  peer.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  peer.post('/api/typed-action-presentations', requireLocalPrincipal, express.json({ limit: '32kb', strict: true }), (req, res) => {
    try {
      const verified = verifier.verifyRegistration(req.body);
      if (!verified) { res.status(403).json({ error: 'UNTRUSTED_PEER' }); return; }
      const p = parsePresentation(verified), candidate = parsePresentation(req.body);
      if (!sameRequest(p, candidate)) { res.status(403).json({ error: 'BINDING_MISMATCH' }); return; }
      if (!store.registerPresentation(p, now())) { res.status(409).json({ error: 'REJECTED' }); return; }
      res.status(201).json({ approvalRequestId: p.request.approvalRequestId, presentationHash: p.presentationHash });
    } catch { res.status(403).json({ error: 'REJECTED' }); }
  });
  for (const operation of ['status', 'evidence'] as const) {
    peer.get(`/api/typed-action-${operation}/:id`, requireLocalPrincipal, (req, res) => {
      const id = String(req.params.id);
      try {
        if (!idSchema.safeParse(id).success || !verifier.authorizeLookup({ operation, approvalRequestId: id })) {
          res.status(403).json({ error: 'UNTRUSTED_PEER' }); return;
        }
        const record = store.presentation(id);
        const value = operation === 'evidence' ? store.typedEvidence(id) : record && {
          approvalRequestId: id, presentationHash: record.presentation.presentationHash,
          state: record.state, approvalState: store.typedRequest(id)?.state, current: !!store.currentPresentation(id, now()),
        };
        if (!value) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
        res.json(value);
      } catch { res.status(403).json({ error: 'REJECTED' }); }
    });
  }
  peer.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  peer.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: 'INVALID_REQUEST' }));
  const gateway = express(); gateway.disable('x-powered-by'); gateway.disable('trust proxy');
  gateway.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  gateway.use((req, res, next) => {
    const post = req.method === 'POST' && req.originalUrl === '/api/typed-action-presentations';
    const lookup = req.method === 'GET' && /^\/api\/typed-action-(?:status|evidence)\/([^/?#]+)$/.exec(req.originalUrl);
    if (!post && (!lookup || !idSchema.safeParse(lookup[1]).success)) {
      res.status(404).json({ error: 'NOT_FOUND' }); return;
    }
    if (post) { express.json({ limit: '32kb', strict: true, type: 'application/json' })(req, res, next); return; }
    next();
  });
  gateway.use((req, res) => {
    let body: string | undefined;
    if (req.method === 'POST') {
      if (!req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        res.status(400).json({ error: 'INVALID_REQUEST' }); return;
      }
      body = JSON.stringify(req.body);
      if (Buffer.byteLength(body) > 32 * 1024) { res.status(400).json({ error: 'INVALID_REQUEST' }); return; }
    }
    let done = false;
    let outgoing: ReturnType<typeof httpRequest> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (status: number, value: object) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (!res.headersSent && !res.destroyed) res.status(status).json(value);
    };
    const fail = () => { finish(502, { error: 'BAD_GATEWAY' }); outgoing?.destroy(); };
    outgoing = httpRequest({ hostname: '127.0.0.1', port: peerPort, method: req.method,
      path: req.originalUrl, agent: false,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
        'X-CT700-Local-Principal': credential.toString('hex') } }, upstream => {
      const allowed = req.method === 'POST' ? [201, 400, 403, 409] : [200, 403, 404];
      if (!allowed.includes(upstream.statusCode ?? 0) || !/^application\/json(?:\s*;|$)/i.test(String(upstream.headers['content-type'] ?? ''))) {
        fail(); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      upstream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) { fail(); return; }
        chunks.push(chunk);
      });
      upstream.on('end', () => {
        if (done) return;
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(); return; }
          finish(upstream.statusCode!, value);
        } catch { fail(); }
      });
      upstream.on('aborted', fail);
      upstream.on('error', fail);
      upstream.on('close', () => { if (!upstream.complete) fail(); });
    });
    timer = setTimeout(fail, 1000);
    outgoing.on('error', fail);
    req.on('aborted', () => outgoing?.destroy());
    outgoing.end(body);
  });
  gateway.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(400).json({ error: 'INVALID_REQUEST' }));
  return { human, peer, gateway };
}