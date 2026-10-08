import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import { TLSSocket } from 'node:tls';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, X509Certificate } from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApproverStore } from '../src/approver-service/storage.js';
import { compileCt700PeerMtlsOptions, createCt700PeerMtlsServer, createProductionApprover, validateCt701InboundPeerIdentity } from '../src/approver-service/production.js';
import { presentationHash, type TrustedTypedActionPresentation, type TrustedTypedActionPresentationVerifier } from '../src/approver-service/presentation.js';
import { actionBindingFields, type TypedActionApprovalRequest } from '../src/typed-action-approval/contract.js';
import { verifyTypedActionApproval } from '../src/typed-action-approval/verifier.js';
import { authenticator } from './fixtures/webauthn-simulator.js';

const base = Date.parse('2026-10-01T12:00:00.000Z'), time = (n = 0) => new Date(base + n).toISOString();
const hash = () => randomBytes(32).toString('hex');
const config = { rp_id: 'human-approver-700.tail2f618d.ts.net', origin: 'https://human-approver-700.tail2f618d.ts.net',
  key_id: 'test', db_path: '/var/lib/ai-approver/approver.db', signing_key_path: '/var/lib/ai-approver/signing.key', port: 48768 };
function fixture(): TrustedTypedActionPresentation {
  const request: TypedActionApprovalRequest = { schemaVersion: 1, type: 'AI_WORKSPACE_TYPED_ACTION_APPROVAL_REQUEST',
    approvalRequestId: randomUUID(), actionId: randomUUID(), actionKind: 'RestartService', targetId: randomUUID(), requestHash: hash(),
    attemptId: randomUUID(), attemptHash: hash(), attemptSequence: 1, independentReviewEvidenceHash: hash(), policySha256: hash(),
    targetGeneration: 2, maintenanceWindowId: randomUUID(), issuedAt: time(), expiresAt: time(240_000), jti: randomBytes(32).toString('base64url') };
  const body = { schemaVersion: 1 as const, presentationId: randomUUID(), request, trustedSourceIdentity: 'fixture-ct701',
    context: { ...Object.fromEntries(actionBindingFields.map(f => [f, request[f]])), independentReviewResult: 'PASS',
      reviewIsCurrent: true, requestIsCurrent: true, policyIsCurrent: true, maintenanceWindowValid: true,
      maintenanceWindowStartsAt: time(-60_000), maintenanceWindowExpiresAt: time(600_000) } as TrustedTypedActionPresentation['context'] };
  return { ...body, presentationHash: presentationHash(body) };
}
function rehash(p: TrustedTypedActionPresentation) { const { presentationHash: _, ...body } = p; p.presentationHash = presentationHash(body); return p; }
describe('CT700 production Human / peer trust boundary', () => {
  const servers: Server[] = [], stores: ApproverStore[] = [], dirs: string[] = [];
  let currentPeer: ReturnType<typeof createProductionApprover>['peer'] | undefined;
  const fixedPeer = createServer((req, res) => {
    const peer = currentPeer;
    if (!peer) { res.writeHead(503); res.end(); return; }
    peer(req, res);
  });
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      fixedPeer.once('error', reject);
      fixedPeer.listen(48769, '127.0.0.1', () => { fixedPeer.off('error', reject); resolve(); });
    });
  });
  afterAll(async () => {
    if (fixedPeer.listening) await new Promise<void>(resolve => fixedPeer.close(() => resolve()));
  });
  afterEach(async () => {
    currentPeer = undefined;
    await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
    stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  });
  async function setup(trusted = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct700-production-')); dirs.push(dir);
    const file = path.join(dir, 'fixture.db'), store = new ApproverStore(file, 'production'); stores.push(store);
    let clock = base;
    // TEST ONLY: pinned host-owned record, never trust the submitted object itself.
    let authorized = fixture();
    const verifier: TrustedTypedActionPresentationVerifier = { verifyRegistration: () => authorized, authorizeLookup: () => true };
    const key = generateKeyPairSync('ed25519');
    const apps = createProductionApprover(config, store, key.privateKey, trusted ? verifier : undefined, () => clock);
    currentPeer = apps.peer;
    async function listen(app: typeof apps.human) {
      const server = createServer(app).listen(0, '127.0.0.1'); servers.push(server);
      await new Promise<void>(r => server.once('listening', r));
      const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('listener');
      return (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: addr.port, method, path: route,
          headers: { Host: config.rp_id, Origin: config.origin, 'Content-Type': 'application/json', ...headers } }, res => {
          let text = ''; res.on('data', c => { text += c; }); res.on('end', () => {
            let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode!, body: value });
          });
        }); req.on('error', reject); req.end(body === undefined || method === 'GET' ? undefined : JSON.stringify(body));
      });
    }
    const human = await listen(apps.human), peer = await listen(apps.peer), gateway = await listen(apps.gateway), device = authenticator();
    const identity = (p: TrustedTypedActionPresentation) => ({ approvalRequestId: p.request.approvalRequestId, presentationHash: p.presentationHash });
    const options = async (p: TrustedTypedActionPresentation) => (await human('POST', '/api/webauthn/typed-action/options', identity(p))).body;
    const assertion = (p: TrustedTypedActionPresentation, o: any, counter = 1) => ({ ...identity(p), ceremony: o.ceremony,
      credential: device.assertion(o.options.challenge, config.origin, config.rp_id, counter) });
    const enroll = async () => {
      const token = store.openEnrollment(clock);
      const o = await human('POST', '/enrollment/options', { token });
      expect((await human('POST', '/enrollment/verify', { token, ceremony: o.body.ceremony,
        credential: device.registration(o.body.options.challenge, config.origin, config.rp_id) })).status).toBe(201);
    };
    const register = async (p: TrustedTypedActionPresentation) => { authorized = p; return gateway('POST', '/api/typed-action-presentations', p); };
    const gatewayRegister = async (p: TrustedTypedActionPresentation) => { authorized = p; return gateway('POST', '/api/typed-action-presentations', p); };
    return { human, peer, gateway, store, file, key, device, register, gatewayRegister, options, assertion, enroll, identity,
      clock: (n: number) => { clock = n; }, authorize: (p: TrustedTypedActionPresentation) => { authorized = p; } };
  }
  it('has separate route inventories, no legacy or generic admin/signing/window routes', async () => {
    const x = await setup();
    const peerForbidden = ['/enroll/token', '/enrollment/options', '/enrollment/verify', '/api/webauthn/typed-action/options',
      '/api/webauthn/typed-action/verify', '/api/credentials', '/api/credentials/disable', '/enrollment/open', '/init', '/public-key', '/app.js', '/health'];
    const bothForbidden = ['/api/approval-requests', '/api/approval-evidence/id', '/api/webauthn/authentication/options',
      '/api/webauthn/authentication/verify', '/approve/id', '/sign', '/admin', '/window', '/setCurrent'];
    for (const route of peerForbidden) for (const method of ['GET', 'POST']) expect((await x.peer(method, route, {})).status).toBe(404);
    for (const route of bothForbidden) for (const method of ['GET', 'POST']) {
      expect((await x.peer(method, route, {})).status).toBe(404); expect((await x.human(method, route, {})).status).toBe(404);
    }
    expect((await x.human('POST', '/api/typed-action-presentations', fixture())).status).toBe(404);
    expect((await x.human('POST', '/api/typed-action-approval-requests', fixture().request)).status).toBe(404);
    expect((await x.human('GET', '/health')).status).toBe(200);
    await x.enroll(); expect(x.store.credentials()).toHaveLength(1);
  });
  it.each([{ PASS: true }, { current: true }, fixture()])('default peer is deny-all regardless of Origin/Host or booleans', async body => {
    const x = await setup(false);
    expect((await x.peer('POST', '/api/typed-action-presentations', body)).status).toBe(403);
    expect((await x.peer('GET', `/api/typed-action-status/${randomUUID()}`)).status).toBe(403);
  });
  it('default deny-all verifier rejects gateway registration and lookups without changing the store', async () => {
    const x = await setup(false), p = fixture(), id = p.request.approvalRequestId;
    expect((await x.gateway('POST', '/api/typed-action-presentations', p)).status).toBe(403);
    expect((await x.gateway('GET', `/api/typed-action-status/${id}`)).status).toBe(403);
    expect((await x.gateway('GET', `/api/typed-action-evidence/${id}`)).status).toBe(403);
    expect(x.store.presentation(id)).toBeNull();
    expect(x.store.typedEvidence(id)).toBeNull();
  });
  it('rejects an unverified body even with a valid host record; no header authority', async () => {
    const x = await setup(); const p = fixture();
    expect((await x.peer('POST', '/api/typed-action-presentations', p)).status).toBe(403);
    x.authorize(p);
    expect((await x.gateway('POST', '/api/typed-action-presentations', p, { Origin: '', Host: 'untrusted' })).status).toBe(201);
  });
  it('requires the composition-local principal on peer routes, not caller headers', async () => {
    const x = await setup(), p = fixture(), id = p.request.approvalRequestId;
    x.authorize(p);
    const spoof = { 'X-CT700-Local-Principal': hash(), Authorization: 'Bearer attacker' };
    expect((await x.peer('POST', '/api/typed-action-presentations', p)).status).toBe(403);
    expect((await x.peer('POST', '/api/typed-action-presentations', p, spoof)).status).toBe(403);
    for (const route of [`/api/typed-action-status/${id}`, `/api/typed-action-evidence/${id}`]) {
      expect((await x.peer('GET', route)).status).toBe(403);
      expect((await x.peer('GET', route, undefined, spoof)).status).toBe(403);
    }
    expect(x.store.presentation(id)).toBeNull();
    expect((await x.gateway('POST', '/api/typed-action-presentations', p, spoof)).status).toBe(201);
    expect((await x.gateway('GET', `/api/typed-action-status/${id}`, undefined, spoof)).body).toMatchObject({ approvalRequestId: id });
    expect((await x.gateway('GET', `/api/typed-action-evidence/${id}`, undefined, spoof)).status).toBe(404);
    expect((await x.peer('GET', `/api/typed-action-status/${id}`, undefined, spoof)).status).toBe(403);
  });
  it.each(actionBindingFields)('rejects presentation/request %s mismatch', async field => {
    const x = await setup(), p = fixture();
    (p.context as any)[field] = typeof p.context[field] === 'number' ? 90 : field.endsWith('Id') ? randomUUID() : field === 'actionKind' ? 'AppUpgrade' : hash();
    rehash(p); expect((await x.register(p)).status).toBe(403);
  });
  it.each(['future', 'expired', 'short', 'hash', 'source', 'html', 'review', 'request', 'policy'])('rejects invalid presentation %s', async failure => {
    const x = await setup(), p = fixture();
    if (failure === 'future') p.context.maintenanceWindowStartsAt = time(1);
    if (failure === 'expired') p.context.maintenanceWindowExpiresAt = time();
    if (failure === 'short') p.context.maintenanceWindowExpiresAt = time(239_999);
    if (failure === 'source') p.trustedSourceIdentity = '<script>';
    if (failure === 'html') (p as any).html = '<script>alert(1)</script>';
    if (failure === 'review') (p.context as any).reviewIsCurrent = false;
    if (failure === 'request') (p.context as any).requestIsCurrent = false;
    if (failure === 'policy') (p.context as any).policyIsCurrent = false;
    if (['future', 'expired', 'short'].includes(failure)) rehash(p);
    if (failure === 'hash') p.presentationHash = hash();
    expect((await x.register(p)).status).not.toBe(201);
  });
  it('exact duplicate is idempotent, conflict cannot replace; survives restart', async () => {
    const x = await setup(), p = fixture();
    expect((await x.gatewayRegister(p)).status).toBe(201); expect((await x.gatewayRegister(p)).status).toBe(201);
    const changed = rehash({ ...p, presentationId: randomUUID() }); expect((await x.register(changed)).status).toBe(409);
    const restarted = new ApproverStore(x.file, 'production');
    try { expect(restarted.presentation(p.request.approvalRequestId)?.presentation).toEqual(p); } finally { restarted.close(); }
    expect(() => new ApproverStore(x.file)).toThrow();
  });
  it.each(['STALE', 'SUPERSEDED'] as const)('terminal %s blocks options and cannot reactivate', async state => {
    const x = await setup(), p = fixture(); await x.enroll(); await x.gatewayRegister(p);
    expect(x.store.invalidatePresentation(p.request.approvalRequestId, hash(), state, base)).toBe(false);
    expect(x.store.invalidatePresentation(p.request.approvalRequestId, p.presentationHash, state, base)).toBe(true);
    expect((await x.human('POST', '/api/webauthn/typed-action/options', x.identity(p))).status).toBe(403);
    expect((await x.register(p)).status).toBe(409);
    expect(() => x.store.db.exec("UPDATE trusted_presentations SET state='CURRENT'")).toThrow('TERMINAL');
    const second = new ApproverStore(x.file, 'production');
    try { expect(second.currentPresentation(p.request.approvalRequestId, base)).toBeNull(); } finally { second.close(); }
  });
  it('display uses the persisted record, immutable request and safe text; options require exact displayed hash', async () => {
    const x = await setup(), p = fixture(); await x.enroll();
    expect((await x.human('POST', '/api/webauthn/typed-action/options', x.identity(p))).status).toBe(403);
    await x.gatewayRegister(p);
    const view = await x.human('GET', `/api/typed-action-approval-requests/${p.request.approvalRequestId}`);
    expect(view.body.presentation).toEqual(p); expect(view.body.payload).toEqual(p.request);
    expect((await x.human('POST', '/api/webauthn/typed-action/options', { ...x.identity(p), presentationHash: hash() })).status).toBe(403);
    expect((await x.human('POST', '/api/webauthn/typed-action/options', x.identity(p), { Origin: 'https://evil.test' })).status).toBe(403);
    const js = (await x.human('GET', '/app.js')).body;
    expect(js).toContain('row.textContent'); expect(js).not.toContain('innerHTML'); expect(js).not.toContain('/api/approval-requests');
    for (const field of actionBindingFields) expect(js).toContain(`payload.${field}`);
    for (const field of ['maintenanceWindowStartsAt', 'maintenanceWindowExpiresAt', 'independentReviewResult']) expect(js).toContain(`context.${field}`);
    expect(() => x.store.db.exec("UPDATE trusted_presentations SET body='{}'")).toThrow();
    expect(() => x.store.db.exec("UPDATE typed_action_approval_requests SET canonical_payload='{}'")).toThrow();
  });
  it.each(['STALE', 'SUPERSEDED', 'expiry', 'hash', 'disabled'] as const)('verify/signing rechecks %s during ceremony', async failure => {
    const x = await setup(), p = fixture(); await x.enroll(); await x.gatewayRegister(p);
    const o = await x.options(p), a = x.assertion(p, o);
    if (failure === 'STALE' || failure === 'SUPERSEDED') x.store.invalidatePresentation(p.request.approvalRequestId, p.presentationHash, failure, base);
    if (failure === 'expiry') x.clock(base + 240_000);
    if (failure === 'hash') a.presentationHash = hash();
    if (failure === 'disabled') x.store.disableCredential(x.device.id, base);
    expect((await x.human('POST', '/api/webauthn/typed-action/verify', a)).status).toBe(403);
    expect(x.store.typedEvidence(p.request.approvalRequestId)).toBeNull();
    expect((await x.human('POST', '/api/webauthn/typed-action/verify', a)).status).toBe(403);
  });
  it.each([0, 1])('concurrent WebAuthn counter %s has exactly one winner; signed evidence verifies and is peer-only', async counter => {
    const x = await setup(), p = fixture(), q = fixture(); await x.enroll(); await x.gatewayRegister(p); await x.gatewayRegister(q);
    const a = x.assertion(p, await x.options(p), counter), b = x.assertion(q, await x.options(q), counter);
    const outcomes = await Promise.all([a, b].map(body => x.human('POST', '/api/webauthn/typed-action/verify', body)));
    expect(outcomes.map(r => r.status).sort()).toEqual([201, 403]);
    const winner = outcomes[0].status === 201 ? p : q;
    const id = winner.request.approvalRequestId;
    const evidence = await x.gateway('GET', `/api/typed-action-evidence/${id}`);
    expect((await x.peer('GET', `/api/typed-action-evidence/${id}`)).status).toBe(403);
    expect((await x.gateway('GET', `/api/typed-action-status/${id}`)).status).toBe(200);
    expect(verifyTypedActionApproval(evidence.body, winner.context, new Map([['test', x.key.publicKey]]), base).valid).toBe(true);
    expect(x.store.credential(x.device.id)).toMatchObject({ counter, revision: 1 });
    expect((await x.human('GET', `/api/typed-action-evidence/${id}`)).status).toBe(404);
    expect((await x.human('GET', `/api/typed-action-approval-evidence/${id}`)).status).toBe(404);
    expect(() => x.store.db.exec("UPDATE typed_action_approval_evidence SET envelope='{}'")).toThrow();
    expect(() => x.store.db.exec('DELETE FROM typed_action_approval_evidence')).toThrow();
  });
  it('transaction gate blocks stale presentations before signer/counter CAS', async () => {
    const x = await setup(), p = fixture(); await x.enroll(); await x.gatewayRegister(p);
    const c = x.store.credential(x.device.id)!;
    x.store.invalidatePresentation(p.request.approvalRequestId, p.presentationHash, 'STALE', base);
    expect(x.store.approveTyped(p.request.approvalRequestId, c, 1, () => { throw Error('MUST_NOT_SIGN'); }, base)).toBe(false);
    expect(x.store.credential(x.device.id)?.revision).toBe(0);
  });
  it('supports separately enrolled main/spare authenticators with one-use invitations', async () => {
    const x = await setup(); await x.enroll();
    const spare = authenticator(), token = x.store.openEnrollment(base);
    const o = await x.human('POST', '/enrollment/options', { token });
    expect(o.body.options.excludeCredentials.map((c: any) => c.id)).toContain(x.device.id);
    const body = { token, ceremony: o.body.ceremony, credential: spare.registration(o.body.options.challenge, config.origin, config.rp_id) };
    expect((await x.human('POST', '/enrollment/verify', body)).status).toBe(201);
    expect((await x.human('POST', '/enrollment/verify', body)).status).toBe(403);
    expect(x.store.credentials()).toHaveLength(2);
  });
  it('host attestation binds approval request identity, not just action fields', async () => {
    const x = await setup(), p = fixture(); x.authorize(p);
    const altered = rehash({ ...p, request: { ...p.request, approvalRequestId: randomUUID() } });
    expect((await x.gateway('POST', '/api/typed-action-presentations', altered)).status).toBe(403);
  });
  it.each(['trigger', 'column', 'foreign', 'version', 'journal'] as const)('production startup rejects %s without repair', async failure => {
    const x = await setup();
    if (failure === 'trigger') x.store.db.exec("DROP TRIGGER typed_action_payload_immutable; CREATE TRIGGER typed_action_payload_immutable BEFORE UPDATE ON typed_action_approval_requests BEGIN SELECT 1; END;");
    if (failure === 'column') x.store.db.exec('ALTER TABLE trusted_presentations ADD COLUMN unexpected TEXT');
    if (failure === 'foreign') x.store.db.exec('CREATE TABLE foreign_data(id TEXT)');
    if (failure === 'version') x.store.db.exec('PRAGMA user_version=999');
    if (failure === 'journal') x.store.db.exec('PRAGMA journal_mode=DELETE');
    const before = JSON.stringify(x.store.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all());
    expect(() => new ApproverStore(x.file, 'production')).toThrow('INVALID_PRODUCTION');
    expect(JSON.stringify(x.store.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all())).toBe(before);
    if (failure === 'journal') expect(x.store.db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
  });
  it('rejects historical DB rather than migrating production; no credential identity mutation', async () => {
    const x = await setup(); await x.enroll();
    expect(() => x.store.db.exec("UPDATE webauthn_credentials SET public_key='other'")).toThrow();
    expect(() => x.store.db.exec('DELETE FROM webauthn_credentials')).toThrow();
    const legacy = path.join(path.dirname(x.file), 'legacy.db'); new ApproverStore(legacy).close();
    expect(() => new ApproverStore(legacy, 'production')).toThrow('INVALID_PRODUCTION');
    const malformed = path.join(path.dirname(x.file), 'bad.db'); fs.writeFileSync(malformed, 'bad');
    expect(() => new ApproverStore(malformed, 'production')).toThrow();
    expect(fs.readFileSync(malformed, 'utf8')).toBe('bad');
    const foreign = path.join(path.dirname(x.file), 'foreign.db'); const db = new DatabaseSync(foreign); db.exec('CREATE TABLE x(id)'); db.close();
    expect(() => new ApproverStore(foreign, 'production')).toThrow();
    const empty = path.join(path.dirname(x.file), 'empty.db'); fs.writeFileSync(empty, '');
    expect(() => new ApproverStore(empty, 'production')).toThrow('INVALID_PRODUCTION');
  });
  it('fixed peer dispatcher fails closed and routes only to the current peer', async () => {
    const fixed = (method: string, route: string, body?: unknown) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: 48769, method, path: route,
        headers: { Host: config.rp_id, Origin: config.origin, 'Content-Type': 'application/json' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const route = '/api/typed-action-presentations';
    expect(await fixed('GET', '/health')).toBe(503);
    let firstCalls = 0, secondCalls = 0;
    const firstHandler: NonNullable<typeof currentPeer> = (_req, res) => {
      firstCalls++; res.writeHead(201); res.end();
    };
    const secondHandler: NonNullable<typeof currentPeer> = (_req, res) => {
      secondCalls++; res.writeHead(202); res.end();
    };
    currentPeer = firstHandler;
    expect(await fixed('POST', route)).toBe(201);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
    currentPeer = undefined;
    expect(await fixed('POST', route)).toBe(503);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
    currentPeer = secondHandler;
    expect(await fixed('POST', route)).toBe(202);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });
  it('gateway forwards only three exact routes to fixed loopback without caller authority or upstream headers', async () => {
    const x = await setup();
    const app = createProductionApprover(config, x.store, x.key.privateKey).gateway;
    const server = createServer(app).listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('listener');
    const send = (method: string, route: string, body?: unknown) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, method, path: route,
        headers: { Host: 'attacker.example', Origin: 'https://attacker.example', Authorization: 'Bearer attacker',
          Cookie: 'session=attacker', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-For': '192.0.2.1',
          'X-CT700-Local-Principal': '00'.repeat(32), 'X-Custom-Identity': 'attacker',
          'Content-Type': 'application/json' } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const seen: { method: string | undefined; path: string | undefined; host: string | undefined; headers: Record<string, unknown>; body: string }[] = [];
    const previous = currentPeer;
    currentPeer = (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ method: req.method, path: req.url, host: req.headers.host, headers: req.headers,
          body: Buffer.concat(chunks).toString() });
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json', 'X-Peer-Secret': 'hidden' });
        res.end(JSON.stringify({ ok: true }));
      });
    };
    try {
      const id = randomUUID(), payload = { hello: 'peer' };
      const routes = ['/api/typed-action-presentations', `/api/typed-action-status/${id}`, `/api/typed-action-evidence/${id}`];
      for (const [index, route] of routes.entries()) {
        const reply = await send(index === 0 ? 'POST' : 'GET', route, index === 0 ? payload : undefined);
        expect(reply.status).toBe(index === 0 ? 201 : 200);
        expect(JSON.parse(reply.body)).toEqual({ ok: true });
        expect(reply.headers['cache-control']).toBe('no-store');
        expect(reply.headers['x-peer-secret']).toBeUndefined();
      }
      expect(seen.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
        { method: 'POST', path: routes[0], body: JSON.stringify(payload) },
        { method: 'GET', path: routes[1], body: '' },
        { method: 'GET', path: routes[2], body: '' },
      ]);
      for (const call of seen) {
        expect(call.host).toBe('127.0.0.1:48769');
        expect(call.headers['x-ct700-local-principal']).toMatch(/^[0-9a-f]{64}$/);
        expect(call.headers['x-ct700-local-principal']).not.toBe('00'.repeat(32));
        for (const header of ['origin', 'authorization', 'cookie', 'x-forwarded-host', 'x-forwarded-for', 'x-custom-identity'])
          expect(call.headers[header]).toBeUndefined();
      }
      for (const [method, route] of [
        ['HEAD', routes[1]], ['HEAD', routes[2]], ['POST', routes[1]], ['GET', routes[0]],
        ['GET', `${routes[1]}?x=1`], ['GET', '/api/typed-action-status/not-a-uuid'],
        ['GET', '/health'], ['POST', `${routes[0]}?x=1`],
      ]) expect((await send(method, route)).status).toBe(404);
      expect(seen).toHaveLength(3);
    } finally { currentPeer = previous; }
  });
  it.each([
    ['POST', 201], ['POST', 400], ['POST', 403], ['POST', 409],
    ['GET', 200], ['GET', 403], ['GET', 404],
  ] as const)('gateway preserves allowed peer %s %i JSON status without leaking headers', async (method, status) => {
    const x = await setup();
    const app = createProductionApprover(config, x.store, x.key.privateKey).gateway;
    const server = createServer(app).listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('listener');
    const previous = currentPeer;
    currentPeer = (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'X-Peer-Secret': 'hidden' });
      res.end(JSON.stringify({ outcome: status }));
    };
    try {
      const route = method === 'POST' ? '/api/typed-action-presentations' : `/api/typed-action-status/${randomUUID()}`;
      const reply = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: address.port, method, path: route,
          headers: { 'Content-Type': 'application/json' } }, res => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
      });
      expect(reply.status).toBe(status);
      expect(JSON.parse(reply.body)).toEqual({ outcome: status });
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['x-peer-secret']).toBeUndefined();
    } finally { currentPeer = previous; }
  });
  it.each(['malformed', 'oversized', 'non-JSON', '5xx', 'aborted', 'unavailable', 'stalled'] as const)(
    'gateway fails closed on %s upstream response', async failure => {
      const x = await setup();
      const app = createProductionApprover(config, x.store, x.key.privateKey).gateway;
      const server = createServer(app).listen(0, '127.0.0.1'); servers.push(server);
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw Error('listener');
      const previous = currentPeer;
      currentPeer = (_req, res) => {
        if (failure === 'stalled') return;
        if (failure === 'aborted') {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); res.destroy(); return;
        }
        res.writeHead(failure === '5xx' || failure === 'unavailable' ? 503 : 200,
          { 'Content-Type': failure === 'non-JSON' ? 'text/plain' : 'application/json', 'X-Peer-Secret': 'hidden' });
        res.end(failure === 'oversized' ? JSON.stringify({ data: 'x'.repeat(256 * 1024) })
          : failure === 'malformed' ? '{' : '{}');
      };
      try {
        if (failure === 'unavailable') currentPeer = undefined;
        const reply = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
          const req = request({ hostname: '127.0.0.1', port: address.port, method: 'GET',
            path: `/api/typed-action-evidence/${randomUUID()}` }, res => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
          });
          req.on('error', reject); req.end();
        });
        expect(reply.status).toBe(502);
        expect(JSON.parse(reply.body)).toEqual({ error: 'BAD_GATEWAY' });
        expect(reply.headers['cache-control']).toBe('no-store');
        expect(reply.headers['x-peer-secret']).toBeUndefined();
      } finally { currentPeer = previous; }
    });
});

// Inert, public-only DER construction: fixed public SPKI and dummy signature bytes.
// No private key, certificate signing, TLS listener or external tooling is involved.
describe('CT701 inbound offline client identity constraints (not TLS chain verification)', () => {
  const role = 'urn:ct701:client';
  const spki = Buffer.from('302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
  const pin = createHash('sha256').update(spki).digest('hex');
  const settings = { expectedClientSpkiSha256: pin, expectedUriSanRole: role };
  const tlv = (tag: number, bytes: Buffer) => Buffer.concat([Buffer.from([tag, ...(bytes.length < 128 ? [bytes.length] : [0x82, bytes.length >> 8, bytes.length & 255])]), bytes]);
  const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
  const oid = (hex: string) => tlv(0x06, Buffer.from(hex, 'hex'));
  const algorithm = seq(oid('2b6570')); // Ed25519; the signature below is deliberately not valid.
  const name = seq(tlv(0x31, seq(oid('550403'), tlv(0x0c, Buffer.from('inert offline fixture')))));
  const date = (value: string) => tlv(0x18, Buffer.from(value));
  const extension = (id: string, value: Buffer) => seq(oid(id), tlv(0x04, value));
  function certificate(options: { uris?: string[]; dns?: boolean; eku?: string; from?: string; to?: string } = {}) {
    const sans = [...(options.uris ?? [role]).map(uri => tlv(0x86, Buffer.from(uri))),
      ...(options.dns ? [tlv(0x82, Buffer.from('unexpected.example'))] : [])];
    const extensions = seq(extension('551d11', seq(...sans)),
      extension('551d25', seq(oid(options.eku ?? '2b06010505070302'))));
    const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([1])), algorithm,
      name, seq(date(options.from ?? '20200101000000Z'), date(options.to ?? '20490101000000Z')),
      name, spki, tlv(0xa3, extensions));
    return seq(tbs, algorithm, tlv(0x03, Buffer.alloc(65)));
  }
  it('accepts exactly the host pin, single URI role, clientAuth EKU and current dates', () => {
    const der = certificate();
    expect(new X509Certificate(der).subjectAltName).toBe(`URI:${role}`);
    expect(validateCt701InboundPeerIdentity(der, settings)).toBe(true);
  });
  it('rejects wrong pin or role, absent/duplicate/extra SAN, and wrong EKU', () => {
    const check = (der: Buffer, config = settings) => expect(validateCt701InboundPeerIdentity(der, config)).toBe(false);
    check(certificate(), { ...settings, expectedClientSpkiSha256: '0'.repeat(64) });
    check(certificate(), { ...settings, expectedUriSanRole: 'urn:ct701:other' });
    check(certificate({ uris: [] }));
    check(certificate({ uris: [role, role] }));
    check(certificate({ uris: [role, 'urn:ct701:other'] }));
    check(certificate({ dns: true }));
    check(certificate({ eku: '2b06010505070301' })); // serverAuth
  });
  it('rejects malformed DER, expired and not-yet-valid leaves', () => {
    for (const der of [Buffer.alloc(0), Buffer.from('not DER'), certificate().subarray(0, 40),
      Buffer.concat([certificate(), Buffer.from([0])]), certificate({ to: '20210101000000Z' }),
      certificate({ from: '20400101000000Z' })]) {
      expect(validateCt701InboundPeerIdentity(der, settings)).toBe(false);
    }
  });
  it('rejects missing, extra or malformed independently configured settings and non-DER inputs', () => {
    const der = certificate();
    for (const invalid of [null, {}, { expectedClientSpkiSha256: pin }, { expectedUriSanRole: role },
      { ...settings, extra: true }, { ...settings, expectedClientSpkiSha256: pin.toUpperCase() },
      { ...settings, expectedClientSpkiSha256: 'a' }, { ...settings, expectedUriSanRole: 'https://example.test' },
      { ...settings, expectedUriSanRole: 'urn:ct701:client,URI:urn:ct701:other' }]) {
      expect(validateCt701InboundPeerIdentity(der, invalid)).toBe(false);
    }
    expect(validateCt701InboundPeerIdentity('caller-supplied certificate', settings)).toBe(false);
  });
  it('rejects non-enumerable and symbol settings keys', () => {
    const der = certificate();
    const hidden = Object.defineProperty({ ...settings }, 'extra', { value: true });
    const symbolic = { ...settings, [Symbol('extra')]: true };
    expect(validateCt701InboundPeerIdentity(der, hidden)).toBe(false);
    expect(validateCt701InboundPeerIdentity(der, symbolic)).toBe(false);
  });
});

// Pure options compilation: dummy bytes are never parsed as certificates or used to create a server.
describe('CT700 offline peer mTLS options compiler', () => {
  const host = () => ({ serverCertificate: 'dummy cert', serverPrivateKey: 'dummy key',
    trustedClientCa: 'dummy CA', expectedClientSpkiSha256: 'a'.repeat(64), expectedUriSanRole: 'urn:ct701:client' });
  it('requires explicit CA and returns only frozen TLS 1.3 mutual-auth options, not a server', () => {
    const options = compileCt700PeerMtlsOptions(host());
    expect(options).toEqual({ minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', requestCert: true,
      rejectUnauthorized: true, ca: 'dummy CA', cert: 'dummy cert', key: 'dummy key' });
    expect(Reflect.ownKeys(options).sort()).toEqual(['ca', 'cert', 'key', 'maxVersion', 'minVersion', 'rejectUnauthorized', 'requestCert'].sort());
    expect(Object.isFrozen(options)).toBe(true);
    expect('listen' in options).toBe(false);
  });
  it('rejects missing, injected, hidden, symbolic, accessor and non-plain host settings', () => {
    const { trustedClientCa: _ca, ...withoutCa } = host();
    const hidden = Object.defineProperty(host(), 'extra', { value: true });
    const accessor = Object.defineProperty(host(), 'serverCertificate', { get: () => 'dummy cert' });
    const nonenumerable = Object.defineProperty(host(), 'trustedClientCa', { value: 'dummy CA', enumerable: false });
    for (const input of [null, [], Object.create(null), withoutCa, { ...host(), ca: 'injected' },
      { ...host(), headers: {} }, { ...host(), [Symbol('injected')]: true }, hidden, accessor, nonenumerable,
      Object.assign(Object.create({ inherited: true }), host()),
      { ...host(), trustedClientCa: '' }, { ...host(), serverPrivateKey: 'x'.repeat(65537) },
      { ...host(), serverCertificate: Buffer.alloc(0) },
      { ...host(), expectedClientSpkiSha256: 'A'.repeat(64) },
      { ...host(), expectedUriSanRole: 'https://example.test' },
      { ...host(), expectedUriSanRole: 'urn:a:client' }]) {
      expect(() => compileCt700PeerMtlsOptions(input)).toThrow('INVALID_CT700_PEER_MTLS_CONFIG');
    }
  });
  it('snapshots Buffer material without freezing the caller or the copies', () => {
    const cert = Buffer.from('cert'), key = Buffer.from('key'), ca = Buffer.from('CA');
    const options = compileCt700PeerMtlsOptions({ ...host(), serverCertificate: cert,
      serverPrivateKey: key, trustedClientCa: ca });
    cert.fill(0); key.fill(0); ca.fill(0);
    expect(options.cert).toEqual(Buffer.from('cert'));
    expect(options.key).toEqual(Buffer.from('key'));
    expect(options.ca).toEqual(Buffer.from('CA'));
    expect(options.cert).not.toBe(cert);
    expect(options.key).not.toBe(key);
    expect(options.ca).not.toBe(ca);
    expect(Object.isFrozen(options.cert)).toBe(false);
  });
});

// Offline listener inspection only: no socket is bound and no TLS handshake is simulated.
describe('CT700 offline peer mTLS server admission', () => {
  it('passes compiled options unchanged and rejects missing, unauthorized or malformed peer identity', () => {
    const host = { serverCertificate: 'dummy cert', serverPrivateKey: 'dummy key',
      trustedClientCa: 'dummy CA', expectedClientSpkiSha256: 'a'.repeat(64), expectedUriSanRole: 'urn:ct701:client' };
    const gateway = vi.fn();
    const fake = { listen: vi.fn() } as unknown as https.Server;
    const create = vi.spyOn(https, 'createServer').mockImplementation(() => fake);
    try {
      expect(createCt700PeerMtlsServer(gateway, host)).toBe(fake);
      expect(create).toHaveBeenCalledTimes(1);
      expect(fake.listen).not.toHaveBeenCalled();
      expect(create.mock.calls[0][0]).toEqual(compileCt700PeerMtlsOptions(host));
      expect(Object.isFrozen(create.mock.calls[0][0])).toBe(true);
      const listener = create.mock.calls[0][1] as (req: IncomingMessage, res: ServerResponse) => void;
      expect(listener).toBeTypeOf('function');
      const tlsSocket = (values: Record<string, unknown>) => Object.assign(Object.create(TLSSocket.prototype), values);
      const cases = [undefined, {}, tlsSocket({ authorized: false, getPeerCertificate: () => ({ raw: Buffer.from('bad DER') }) }),
        tlsSocket({ authorized: true, authorizationError: Error('rejected'), getPeerCertificate: () => ({ raw: Buffer.from('bad DER') }) }),
        tlsSocket({ authorized: true, getPeerCertificate: () => { throw Error('missing certificate'); } }),
        tlsSocket({ authorized: true, getPeerCertificate: () => ({}) }),
        tlsSocket({ authorized: true, getPeerCertificate: () => ({ raw: 'not DER' }) }),
        tlsSocket({ authorized: true, getPeerCertificate: () => ({ raw: Buffer.from('not DER') }) })];
      for (const socket of cases) {
        const res = { writeHead: vi.fn(), end: vi.fn() };
        const req = { socket, headers: { host: 'attacker.test', origin: 'https://attacker.test',
          'x-forwarded-host': 'attacker.test', 'x-ct700-local-principal': 'a'.repeat(64) } };
        listener(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        expect(res.writeHead).toHaveBeenCalledWith(403, { 'Cache-Control': 'no-store' });
        expect(res.end).toHaveBeenCalledTimes(1);
        expect(gateway).not.toHaveBeenCalled();
      }
    } finally { create.mockRestore(); }
  });
});

// Test-only, in-memory identities for a real loopback TLS handshake; not deployed credentials.
describe('CT700 offline TLS 1.3 mutual handshake', () => {
  const role = 'urn:trust-plane:domain:ct701-finalizer:transport:e0001';
  const tlv = (tag: number, bytes: Buffer) => {
    const length = bytes.length < 128 ? [bytes.length] : bytes.length < 256
      ? [0x81, bytes.length] : [0x82, bytes.length >> 8, bytes.length & 255];
    return Buffer.concat([Buffer.from([tag, ...length]), bytes]);
  };
  const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
  const oid = (hex: string) => tlv(0x06, Buffer.from(hex, 'hex'));
  const text = (value: string) => Buffer.from(value, 'ascii');
  const ed25519 = seq(oid('2b6570'));
  const name = (value: string) => seq(tlv(0x31, seq(oid('550403'), tlv(0x0c, Buffer.from(value)))));
  const generalizedTime = (value: Date) => tlv(0x18, text(value.toISOString().replace(/[-:.T]/g, '').slice(0, 14) + 'Z'));
  const extension = (id: string, value: Buffer, critical = false) => seq(oid(id),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
  const pem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

  it('admits only a signed CT701 client over TLS 1.3 before dispatch', async () => {
    const root = generateKeyPairSync('ed25519');
    const serverKey = generateKeyPairSync('ed25519');
    const clientKey = generateKeyPairSync('ed25519');
    const now = Date.now(), from = new Date(now - 86_400_000), to = new Date(now + 86_400_000);
    const issue = (serial: number, subject: string, issuer: string, publicKey: typeof root.publicKey,
      issuerKey: typeof root.privateKey, extensions: Buffer[], validFrom = from, validTo = to) => {
      const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([serial])),
        ed25519, name(issuer), seq(generalizedTime(validFrom), generalizedTime(validTo)), name(subject),
        publicKey.export({ format: 'der', type: 'spki' }) as Buffer, tlv(0xa3, seq(...extensions)));
      return new X509Certificate(seq(tbs, ed25519, tlv(0x03, Buffer.concat([Buffer.from([0]), sign(null, tbs, issuerKey)]))));
    };
    const caExtensions = [extension('551d13', seq(tlv(0x01, Buffer.from([0xff]))), true),
      extension('551d0f', tlv(0x03, Buffer.from([2, 0x04])), true)];
    const leafExtensions = (eku: string, san: Buffer) => [extension('551d13', seq(), true),
      extension('551d0f', tlv(0x03, Buffer.from([7, 0x80])), true),
      extension('551d25', seq(oid(eku))), extension('551d11', seq(san))];
    const ca = issue(1, 'CT700 test root', 'CT700 test root', root.publicKey, root.privateKey, caExtensions);
    const serverCert = issue(2, 'CT700 loopback', 'CT700 test root', serverKey.publicKey, root.privateKey,
      leafExtensions('2b06010505070301', tlv(0x87, Buffer.from([127, 0, 0, 1]))));
    const clientCert = issue(3, 'CT701 test client', 'CT700 test root', clientKey.publicKey, root.privateKey,
      leafExtensions('2b06010505070302', tlv(0x86, text(role))));
    const otherClientKey = generateKeyPairSync('ed25519');
    const wrongSpkiCert = issue(5, 'CT701 other test client', 'CT700 test root', otherClientKey.publicKey, root.privateKey,
      leafExtensions('2b06010505070302', tlv(0x86, text(role))));
    const wrongRoleCert = issue(6, 'CT701 other role test client', 'CT700 test root', clientKey.publicKey, root.privateKey,
      leafExtensions('2b06010505070302', tlv(0x86, text('urn:ct701:other'))));
    for (const [cert, issuerKey] of [[ca, root.publicKey], [serverCert, root.publicKey],
      [clientCert, root.publicKey]] as const) {
      expect(Date.parse(cert.validFrom)).toBeLessThan(Date.now());
      expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.now());
      expect(cert.verify(issuerKey)).toBe(true);
    }
    expect(ca.ca).toBe(true);
    expect(serverCert.subjectAltName).toBe('IP Address:127.0.0.1');
    expect(clientCert.subjectAltName).toBe(`URI:${role}`);
    const expiredClientCert = issue(4, 'CT701 expired test client', 'CT700 test root', clientKey.publicKey, root.privateKey,
      leafExtensions('2b06010505070302', tlv(0x86, text(role))), new Date(now - 2 * 86_400_000), from);
    expect(expiredClientCert.verify(root.publicKey)).toBe(true);
    expect(Date.parse(expiredClientCert.validTo)).toBeLessThan(Date.now());
    for (const cert of [wrongSpkiCert, wrongRoleCert]) {
      expect(cert.verify(root.publicKey)).toBe(true);
      expect(Date.parse(cert.validFrom)).toBeLessThan(Date.now());
      expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.now());
    }
    expect(wrongSpkiCert.subjectAltName).toBe(`URI:${role}`);
    expect(wrongRoleCert.subjectAltName).toBe('URI:urn:ct701:other');
    const futureClientCert = issue(7, 'CT701 future test client', 'CT700 test root', clientKey.publicKey, root.privateKey,
      leafExtensions('2b06010505070302', tlv(0x86, text(role))), new Date(now + 86_400_000), new Date(now + 2 * 86_400_000));
    const wrongEkuCert = issue(8, 'CT701 serverAuth test client', 'CT700 test root', clientKey.publicKey, root.privateKey,
      leafExtensions('2b06010505070301', tlv(0x86, text(role))));
    const duplicateSanCert = issue(9, 'CT701 duplicate SAN test client', 'CT700 test root', clientKey.publicKey, root.privateKey,
      leafExtensions('2b06010505070302', Buffer.concat([tlv(0x86, text(role)), tlv(0x86, text(role))])));
    const untrustedIssuer = generateKeyPairSync('ed25519');
    const untrustedCa = issue(10, 'CT700 untrusted issuer', 'CT700 untrusted issuer',
      untrustedIssuer.publicKey, untrustedIssuer.privateKey, caExtensions);
    const untrustedClientCert = issue(11, 'CT701 untrusted test client', 'CT700 untrusted issuer',
      clientKey.publicKey, untrustedIssuer.privateKey,
      leafExtensions('2b06010505070302', tlv(0x86, text(role))));
    for (const cert of [futureClientCert, wrongEkuCert, duplicateSanCert]) {
      expect(cert.verify(root.publicKey)).toBe(true);
      expect(cert.publicKey.export({ format: 'der', type: 'spki' })).toEqual(clientKey.publicKey.export({ format: 'der', type: 'spki' }));
    }
    expect(Date.parse(futureClientCert.validFrom)).toBeGreaterThan(Date.now());
    expect(Date.parse(wrongEkuCert.validFrom)).toBeLessThan(Date.now());
    expect(Date.parse(wrongEkuCert.validTo)).toBeGreaterThan(Date.now());
    expect(Date.parse(duplicateSanCert.validFrom)).toBeLessThan(Date.now());
    expect(Date.parse(duplicateSanCert.validTo)).toBeGreaterThan(Date.now());
    expect(untrustedCa.ca).toBe(true);
    expect(untrustedCa.verify(untrustedIssuer.publicKey)).toBe(true);
    expect(untrustedClientCert.verify(untrustedIssuer.publicKey)).toBe(true);
    expect(untrustedClientCert.verify(root.publicKey)).toBe(false);
    expect(untrustedClientCert.publicKey.export({ format: 'der', type: 'spki' })).toEqual(clientKey.publicKey.export({ format: 'der', type: 'spki' }));
    expect(untrustedClientCert.subjectAltName).toBe(`URI:${role}`);
    const caPem = pem(ca.raw), serverPem = pem(serverCert.raw), clientPem = pem(clientCert.raw);
    const serverPrivateKey = serverKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const clientPrivateKey = clientKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    let calls = 0;
    const gateway = express();
    gateway.get('/probe', (_req, res) => { calls++; res.status(200).end('ok'); });
    const listener = createCt700PeerMtlsServer(gateway, {
      serverCertificate: serverPem, serverPrivateKey, trustedClientCa: caPem,
      expectedClientSpkiSha256: createHash('sha256').update(clientKey.publicKey.export({ format: 'der', type: 'spki' })).digest('hex'),
      expectedUriSanRole: role,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve(); });
      });
      const address = listener.address();
      if (!address || typeof address === 'string') throw Error('missing loopback listener');
      const send = (options: { cert?: string; key?: string; minVersion?: 'TLSv1.2' | 'TLSv1.3'; maxVersion?: 'TLSv1.2' | 'TLSv1.3' },
        onResponse?: (response: IncomingMessage) => void) =>
        new Promise<{ status: number; protocol: string | null; body: string }>((resolve, reject) => {
          const req = https.request({ hostname: '127.0.0.1', port: address.port, path: '/probe', method: 'GET',
            ca: caPem, rejectUnauthorized: true, agent: false, minVersion: options.minVersion ?? 'TLSv1.3',
            maxVersion: options.maxVersion ?? 'TLSv1.3', cert: options.cert, key: options.key }, res => {
            onResponse?.(res);
            const protocol = (res.socket as TLSSocket).getProtocol();
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode!, protocol,
              body: Buffer.concat(chunks).toString() }));
          });
          req.setTimeout(1500, () => req.destroy(Error('TLS request timed out')));
          req.on('error', reject);
          req.end();
        });
      const expectRejectedClient = async (cert: string, key: string) => {
        let cacheControl: string | string[] | undefined;
        const reply = await send({ cert, key }, res => { cacheControl = res.headers['cache-control']; }).catch(() => null);
        if (reply) {
          expect(reply).toEqual({ status: 403, protocol: 'TLSv1.3', body: '' });
          expect(cacheControl).toBe('no-store');
        }
        expect(calls).toBe(1);
      };
      expect(await send({ cert: clientPem, key: clientPrivateKey })).toEqual({ status: 200, protocol: 'TLSv1.3', body: 'ok' });
      expect(calls).toBe(1);
      expect(await send({ cert: pem(wrongSpkiCert.raw),
        key: otherClientKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }))
        .toEqual({ status: 403, protocol: 'TLSv1.3', body: '' });
      expect(calls).toBe(1);
      expect(await send({ cert: pem(wrongRoleCert.raw), key: clientPrivateKey }))
        .toEqual({ status: 403, protocol: 'TLSv1.3', body: '' });
      expect(calls).toBe(1);
      await expectRejectedClient(pem(wrongEkuCert.raw), clientPrivateKey);
      await expectRejectedClient(pem(expiredClientCert.raw), clientPrivateKey);
      await expectRejectedClient(pem(futureClientCert.raw), clientPrivateKey);
      await expectRejectedClient(pem(untrustedClientCert.raw) + pem(untrustedCa.raw), clientPrivateKey);
      let duplicateCacheControl: string | string[] | undefined;
      expect(await send({ cert: pem(duplicateSanCert.raw), key: clientPrivateKey },
        res => { duplicateCacheControl = res.headers['cache-control']; }))
        .toEqual({ status: 403, protocol: 'TLSv1.3', body: '' });
      expect(duplicateCacheControl).toBe('no-store');
      expect(calls).toBe(1);
      await expect(send({})).rejects.toThrow();
      expect(calls).toBe(1);
      await expect(send({ cert: clientPem, key: clientPrivateKey, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' })).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  });
});
