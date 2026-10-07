import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApproverStore } from '../src/approver-service/storage.js';
import { createProductionApprover } from '../src/approver-service/production.js';
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
  afterEach(async () => {
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
    const register = async (p: TrustedTypedActionPresentation) => { authorized = p; return peer('POST', '/api/typed-action-presentations', p); };
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
  it('rejects an unverified body even with a valid host record; no header authority', async () => {
    const x = await setup(); const p = fixture();
    expect((await x.peer('POST', '/api/typed-action-presentations', p)).status).toBe(403);
    x.authorize(p);
    expect((await x.gateway('POST', '/api/typed-action-presentations', p, { Origin: '', Host: 'untrusted' })).status).toBe(201);
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
    expect((await x.peer('POST', '/api/typed-action-presentations', altered)).status).toBe(403);
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
});
