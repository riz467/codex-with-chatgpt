import express from 'express';
import { request as httpRequest } from 'node:http';
import type { KeyObject } from 'node:crypto';
import { createApproverService, type ApproverConfig } from './server.js';
import { ApproverStore } from './storage.js';
import { denyAllPresentationVerifier, parsePresentation, sameRequest, type TrustedTypedActionPresentationVerifier } from './presentation.js';
import { idSchema } from '../typed-action-approval/contract.js';

export const humanPort = 48768;
export const peerPort = 48769;
/** No config switch/module loader enables peer authority. Reviewed host composition only. */
export function createProductionApprover(config: ApproverConfig, store: ApproverStore, key: KeyObject,
  verifier: TrustedTypedActionPresentationVerifier = denyAllPresentationVerifier, now = Date.now) {
  if (config.port !== humanPort || store.profile !== 'production') throw Error('INVALID_PRODUCTION_CONFIGURATION');
  const human = createApproverService(config, store, key, now, undefined, 'human-production');
  const peer = express(); peer.disable('x-powered-by'); peer.disable('trust proxy');
  peer.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  peer.post('/api/typed-action-presentations', express.json({ limit: '32kb', strict: true }), (req, res) => {
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
    peer.get(`/api/typed-action-${operation}/:id`, (req, res) => {
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
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, upstream => {
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