import { createServer, type IncomingMessage } from 'node:http';
import { limits } from './material.js';
import type { ReviewRuntime } from './runtime.js';

export const reviewPort = 7020;
export type Peer = Readonly<{ identity: string; capabilities: readonly ('submit' | 'status' | 'evidence' | 'acknowledge' | 'invalidate' | 'acknowledgeInvalidation')[] }>;
/** This callback must come from authenticated host composition, never a caller header or IP. */
export function createReviewServer(runtime: ReviewRuntime, authenticate: (request: IncomingMessage) => Peer | null = () => null) {
  const routes = new Map<string, keyof ReviewRuntime>([
    ['/v1/reviews/submit', 'submit'], ['/v1/reviews/status', 'status'], ['/v1/reviews/evidence', 'evidence'],
    ['/v1/reviews/acknowledge', 'acknowledge'], ['/v1/reviews/invalidate', 'invalidate'],
    ['/v1/reviews/acknowledge-invalidation', 'acknowledgeInvalidation'],
  ]);
  let active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    try {
      const peer = authenticate(req);
      if (!peer?.identity) { res.writeHead(403).end('{"error":"DENIED"}'); return; }
      const method = routes.get(req.url ?? '');
      if (req.method !== 'POST' || !method) { res.writeHead(404).end('{"error":"NOT_FOUND"}'); return; }
      if (!peer.capabilities.includes(method)) { res.writeHead(403).end('{"error":"DENIED"}'); return; }
      if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) { res.writeHead(415).end(); return; }
      if (active >= 4) { res.writeHead(503).end('{"error":"BUSY"}'); return; }
      active++;
      try {
        let size = 0; const chunks: Buffer[] = [];
        const max = method === 'submit' ? limits.wireBytes : 2048;
        for await (const chunk of req) { size += chunk.length; if (size > max) throw Error('BODY_LIMIT'); chunks.push(Buffer.from(chunk)); }
        const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        const result = await runtime[method](input);
        res.end(JSON.stringify(result));
      } finally { active--; }
    } catch (error) {
      const unavailable = error instanceof Error && error.message === 'RECONCILE_REQUIRED';
      res.writeHead(unavailable ? 503 : 400).end(JSON.stringify({ error: unavailable ? 'RECONCILE_REQUIRED' : 'REQUEST_REJECTED' }));
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.timeout = 15000;
  server.maxHeadersCount = 32; server.maxConnections = 16;
  return server;
}
