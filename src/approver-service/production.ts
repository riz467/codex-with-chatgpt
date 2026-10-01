import express from 'express';
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
  return { human, peer };
}
