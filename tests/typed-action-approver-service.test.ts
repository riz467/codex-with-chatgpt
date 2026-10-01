import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApproverService, type ApproverConfig } from '../src/approver-service/server.js';
import { ApproverStore } from '../src/approver-service/storage.js';
import { actionBindingFields, typedActionApprovalSigningBytes, type TypedActionApprovalRequest } from '../src/typed-action-approval/contract.js';
import { verifyTypedActionApproval } from '../src/typed-action-approval/verifier.js';
import { approvalSigningBytes } from '../src/human-approval/contract.js';
import { verifySignedApproval } from '../src/human-approval/verifier.js';
import { authenticator } from './fixtures/webauthn-simulator.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rp = 'ai-approver.tail2f618d.ts.net', origin = `https://${rp}`;
const config: ApproverConfig = { rp_id: rp, origin, key_id: 'test', db_path: '/var/lib/ai-approver/a.db', signing_key_path: '/var/lib/ai-approver/a.key', port: 48768 };
const base = Date.parse('2026-10-01T12:00:00.000Z'), time = (d = 0) => new Date(base + d).toISOString();
const nonce = () => randomBytes(32).toString('base64url'), hash = () => randomBytes(32).toString('hex');
const payload = (): TypedActionApprovalRequest => ({ schemaVersion: 1, type: 'AI_WORKSPACE_TYPED_ACTION_APPROVAL_REQUEST',
  approvalRequestId: randomUUID(), actionId: randomUUID(), actionKind: 'RestartService', targetId: randomUUID(), requestHash: hash(),
  attemptId: randomUUID(), attemptHash: hash(), attemptSequence: 1, independentReviewEvidenceHash: hash(), policySha256: hash(),
  targetGeneration: 4, maintenanceWindowId: randomUUID(), issuedAt: time(), expiresAt: time(240_000), jti: nonce() });
const donePayload = () => ({ schema_version: 1, type: 'AI_WORKSPACE_DONE_APPROVAL_REQUEST', request_id: `req-${randomBytes(16).toString('hex')}`,
  task_id: 'rpc-' + 'a'.repeat(32), run_id: 'auto-' + 'a'.repeat(32), authoritative_review_id: 'review-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  review_evidence_hash: 'a'.repeat(64), bundle_manifest_sha256: 'b'.repeat(64), canonical_goal_sha256: 'c'.repeat(64),
  issued_at: time(), expires_at: time(240_000), nonce: nonce() });
const root = '/api/typed-action-approval-requests', auth = '/api/webauthn/typed-action', evidence = '/api/typed-action-approval-evidence';
describe('CT700 typed approval isolation', () => {
  const servers: Server[] = [], stores: ApproverStore[] = [], dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
    stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  });
  async function setup(windowEnabled = true) {
    let clock = base;
    let window = { startsAt: time(-60_000), expiresAt: time(600_000) };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct700-typed-')); dirs.push(dir);
    const file = path.join(dir, 'test.db'), store = new ApproverStore(file); stores.push(store);
    const key = generateKeyPairSync('ed25519'), keys = new Map([['test', key.publicKey]]);
    const app = createApproverService(config, store, key.privateKey, () => clock, windowEnabled ? () => window : undefined);
    const server = createServer(app).listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(r => server.once('listening', r));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('listener');
    const call = (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const r = request({ hostname: '127.0.0.1', port: address.port, method, path: route,
        headers: { Host: rp, Origin: origin, 'Content-Type': 'application/json', ...headers } }, res => {
        let text = ''; res.on('data', c => { text += c; }); res.on('end', () => {
          let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode!, body: value });
        });
      }); r.on('error', reject); r.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const device = authenticator(), token = store.openEnrollment(clock);
    const registration = await call('POST', '/enrollment/options', { token });
    expect((await call('POST', '/enrollment/verify', { token, ceremony: registration.body.ceremony,
      credential: device.registration(registration.body.options.challenge, origin, rp) })).status).toBe(201);
    const options = async (p: TypedActionApprovalRequest) => (await call('POST', `${auth}/options`, { approvalRequestId: p.approvalRequestId })).body;
    const assertion = (p: TypedActionApprovalRequest, o: any, count = 1, uv = true, org = origin, rpid = rp) => ({
      approvalRequestId: p.approvalRequestId, ceremony: o.ceremony, credential: device.assertion(o.options.challenge, org, rpid, count, uv) });
    const context = (p: TypedActionApprovalRequest) => ({ ...Object.fromEntries(actionBindingFields.map(f => [f, p[f]])),
      independentReviewResult: 'PASS', reviewIsCurrent: true, requestIsCurrent: true, policyIsCurrent: true, maintenanceWindowValid: true,
      maintenanceWindowStartsAt: window.startsAt, maintenanceWindowExpiresAt: window.expiresAt });
    return { call, store, file, keys, key, device, options, assertion, context, clock: (n: number) => { clock = n; }, window: (w: typeof window) => { window = w; } };
  }
  it('stores immutable canonical pending requests, strict IDs and read-only evidence', async () => {
    const x = await setup(), p = payload();
    expect((await x.call('POST', root, p)).status).toBe(201);
    expect((await x.call('GET', `${root}/${p.approvalRequestId}`)).body).toEqual({ payload: p, state: 'PENDING' });
    expect((await x.call('GET', `${evidence}/${p.approvalRequestId}`)).status).toBe(404);
    expect((await x.call('GET', `${evidence}/invalid`)).status).toBe(404);
    expect((await x.call('POST', `${evidence}/${p.approvalRequestId}`, {})).status).toBe(404);
    expect((await x.call('POST', root, { ...p, jti: nonce() })).status).toBe(409);
    expect((await x.call('POST', root, { ...p, approvalRequestId: randomUUID() })).status).toBe(409);
    expect(() => x.store.db.prepare('UPDATE typed_action_approval_requests SET request_hash=?').run(hash())).toThrow();
    expect(x.store.request(p.approvalRequestId)).toBeNull();
  });
  it.each([{}, { command: 'x' }, { path: '/x' }, { ref: 'main' }, { url: 'https://example.org' }, { actionKind: 'Arbitrary' },
    { expiresAt: time() }, { issuedAt: time(30_001) }, { expiresAt: time(300_001) }, { issuedAt: 'invalid' }, { maintenanceWindowId: 'invalid' }])('rejects invalid proposal %j', async delta => {
    const x = await setup(); expect((await x.call('POST', root, Object.keys(delta).length ? { ...payload(), ...delta } : {})).status).toBe(400);
  });
  it('fails closed for invalid clocks and untrusted or incompatible windows', async () => {
    const x = await setup(false); expect((await x.call('POST', root, payload())).status).toBe(400);
    const y = await setup();
    for (const n of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) { y.clock(n); expect((await y.call('POST', root, payload())).status).toBe(400); }
    y.clock(base); y.window({ startsAt: time(1), expiresAt: time(600_000) }); expect((await y.call('POST', root, payload())).status).toBe(400);
    y.window({ startsAt: time(-1), expiresAt: time(100_000) }); expect((await y.call('POST', root, payload())).status).toBe(400);
  });
  it('requires pending requests and exact browser Origin/Host', async () => {
    const x = await setup(), p = payload();
    expect((await x.call('POST', `${auth}/options`, { approvalRequestId: p.approvalRequestId })).status).toBe(403);
    await x.call('POST', root, p);
    for (const headers of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }, { Origin: '' }]) {
      expect((await x.call('POST', `${auth}/options`, { approvalRequestId: p.approvalRequestId }, headers)).status).toBe(403);
    }
    const o = await x.options(p); expect(o.options.userVerification).toBe('required'); expect(o.options.rpId).toBe(rp);
    x.clock(base + 240_000); expect((await x.call('POST', `${auth}/options`, { approvalRequestId: p.approvalRequestId })).status).toBe(403);
  });
  it('signs stored bindings only after UV, verifies all bindings, and rejects second approval/replay', async () => {
    const x = await setup(), p = payload(); await x.call('POST', root, p); const o = await x.options(p), body = x.assertion(p, o);
    expect((await x.call('POST', `${auth}/verify`, { ...body, payload: { ...p, requestHash: hash() } })).status).toBe(400);
    expect((await x.call('POST', `${auth}/verify`, body)).status).toBe(201);
    const e = (await x.call('GET', `${evidence}/${p.approvalRequestId}`)).body;
    expect(e.payload).toEqual(p); expect(verifyTypedActionApproval(e, x.context(p), x.keys, base).valid).toBe(true);
    for (const f of actionBindingFields) {
      const changed = typeof p[f] === 'number' ? 99 : f.endsWith('Id') ? randomUUID() : f === 'actionKind' ? 'AppUpgrade' : hash();
      expect(verifyTypedActionApproval({ ...e, payload: { ...p, [f]: changed } }, x.context(p), x.keys, base).valid).toBe(false);
      expect(verifyTypedActionApproval(e, { ...x.context(p), [f]: changed }, x.keys, base).valid).toBe(false);
    }
    expect((await x.call('POST', `${auth}/verify`, body)).status).toBe(403);
    expect((await x.call('POST', `${auth}/options`, { approvalRequestId: p.approvalRequestId })).status).toBe(403);
    expect(Object.keys(e).sort()).toEqual(['approverKeyId', 'payload', 'schemaVersion', 'signature', 'signatureAlgorithm', 'type']);
  });
  it.each(['uv', 'origin', 'rp', 'challenge', 'credential', 'disabled', 'expired', 'clock', 'window', 'consumed-jti', 'malformed'])('rejects %s at verification and consumes ceremony', async failure => {
    const x = await setup(), p = payload(); await x.call('POST', root, p); const o = await x.options(p);
    const body = x.assertion(p, o, 1, failure !== 'uv', failure === 'origin' ? 'https://evil.example' : origin, failure === 'rp' ? 'evil.example' : rp);
    if (failure === 'challenge') body.credential = x.device.assertion('wrong', origin, rp);
    if (failure === 'credential') body.credential = authenticator().assertion(o.options.challenge, origin, rp);
    if (failure === 'disabled') x.store.disableCredential(x.device.id, base);
    if (failure === 'expired') x.clock(base + 120_000);
    if (failure === 'clock') x.clock(NaN);
    if (failure === 'window') x.window({ startsAt: time(), expiresAt: time(1) });
    if (failure === 'consumed-jti') x.store.consumeJti(p.jti, base);
    if (failure === 'malformed') { x.store.db.exec('DROP TRIGGER typed_action_payload_immutable'); x.store.db.prepare("UPDATE typed_action_approval_requests SET canonical_payload='{}'").run(); }
    expect((await x.call('POST', `${auth}/verify`, body)).status).toBe(403);
    x.clock(base); expect((await x.call('POST', `${auth}/verify`, body)).status).toBe(403);
    expect((await x.call('GET', `${evidence}/${p.approvalRequestId}`)).status).toBe(404);
  });
  it('binds ceremonies to request and type; reserves nonce across both domains', async () => {
    const x = await setup(), p = payload(), p2 = payload(), d = donePayload();
    expect((await x.call('POST', root, d)).status).toBe(400); expect((await x.call('POST', '/api/approval-requests', p)).status).toBe(400);
    await x.call('POST', root, p); await x.call('POST', root, p2); await x.call('POST', '/api/approval-requests', d);
    expect((await x.call('POST', root, { ...payload(), jti: d.nonce })).status).toBe(409);
    expect((await x.call('POST', '/api/approval-requests', { ...donePayload(), nonce: p.jti })).status).toBe(409);
    const t = await x.options(p), done = (await x.call('POST', '/api/webauthn/authentication/options', { request_id: d.request_id })).body;
    expect((await x.call('POST', `${auth}/verify`, { ...x.assertion(p, t), approvalRequestId: p2.approvalRequestId })).status).toBe(403);
    expect((await x.call('POST', `${auth}/verify`, { approvalRequestId: p.approvalRequestId, ceremony: done.ceremony,
      credential: x.device.assertion(done.options.challenge, origin, rp) })).status).toBe(403);
    expect((await x.call('POST', '/api/webauthn/authentication/verify', { request_id: d.request_id, ceremony: t.ceremony,
      credential: x.device.assertion(t.options.challenge, origin, rp) })).status).toBe(403);
  });
  it('isolates actual DONE/Typed signatures with the same key and strict verifiers', async () => {
    const x = await setup(), p = payload(), d = donePayload(); await x.call('POST', root, p); await x.call('POST', '/api/approval-requests', d);
    expect((await x.call('POST', `${auth}/verify`, x.assertion(p, await x.options(p)))).status).toBe(201);
    const o = (await x.call('POST', '/api/webauthn/authentication/options', { request_id: d.request_id })).body;
    expect((await x.call('POST', '/api/webauthn/authentication/verify', { request_id: d.request_id, ceremony: o.ceremony,
      credential: x.device.assertion(o.options.challenge, origin, rp, 2) })).status).toBe(201);
    const t = (await x.call('GET', `${evidence}/${p.approvalRequestId}`)).body, done = (await x.call('GET', `/api/approval-evidence/${d.request_id}`)).body;
    const dc = { task_id: d.task_id, run_id: d.run_id, authoritative_review_id: d.authoritative_review_id, review_evidence_hash: d.review_evidence_hash,
      bundle_manifest_sha256: d.bundle_manifest_sha256, canonical_goal_sha256: d.canonical_goal_sha256,
      current_review_id: d.authoritative_review_id, current_review_evidence_hash: d.review_evidence_hash, review_result: 'PASS', review_is_current: true, bundle_integrity_valid: true };
    expect(verifySignedApproval(done, dc, x.keys, base).valid).toBe(true);
    expect(verifyTypedActionApproval(done, x.context(p), x.keys, base).valid).toBe(false);
    expect(verifySignedApproval(t, dc, x.keys, base).valid).toBe(false);
    expect(verify(null, typedActionApprovalSigningBytes(t), x.key.publicKey, Buffer.from(done.signature, 'base64url'))).toBe(false);
    expect(verify(null, approvalSigningBytes(done), x.key.publicKey, Buffer.from(t.signature, 'base64url'))).toBe(false);
  });
  it('concurrent shared-credential authentication allows exactly one counter update and rejects rollback', async () => {
    const x = await setup(), p = payload(), d = donePayload(); await x.call('POST', root, p); await x.call('POST', '/api/approval-requests', d);
    const t = await x.options(p), o = (await x.call('POST', '/api/webauthn/authentication/options', { request_id: d.request_id })).body;
    const results = await Promise.all([x.call('POST', `${auth}/verify`, x.assertion(p, t)),
      x.call('POST', '/api/webauthn/authentication/verify', { request_id: d.request_id, ceremony: o.ceremony, credential: x.device.assertion(o.options.challenge, origin, rp, 1) })]);
    expect(results.map(r => r.status).sort()).toEqual([201, 403]); expect(x.store.credential(x.device.id)?.counter).toBe(1);
    const p2 = payload(); await x.call('POST', root, p2);
    expect((await x.call('POST', `${auth}/verify`, x.assertion(p2, await x.options(p2), 1))).status).toBe(403);
    expect((await x.call('POST', `${auth}/verify`, x.assertion(p2, await x.options(p2), 0))).status).toBe(403);
  });
  it('CAS rejects a stale credential even for zero counters, before invoking the signer', async () => {
    const x = await setup(), p = payload(); await x.call('POST', root, p);
    const c = x.store.credential(x.device.id)!;
    x.store.db.prepare('UPDATE webauthn_credentials SET authentication_revision=authentication_revision+1').run();
    let signed = false;
    expect(x.store.approveTyped(p.approvalRequestId, c, 0, () => { signed = true; throw Error('sign'); }, base)).toBe(false);
    expect(signed).toBe(false);
  });
  it('persists one-use ceremonies, evidence, credential and migration across connections; rejects foreign/partial schema', async () => {
    const x = await setup(), p = payload(); await x.call('POST', root, p); const o = await x.options(p);
    const other = new ApproverStore(x.file);
    try { expect(other.consumeTypedAuthentication(p.approvalRequestId, o.ceremony, base)?.challenge).toBe(o.options.challenge);
      expect(x.store.consumeTypedAuthentication(p.approvalRequestId, o.ceremony, base)).toBeNull();
      expect(other.credential(x.device.id)).toEqual(x.store.credential(x.device.id));
    } finally { other.close(); }
    const bad = path.join(path.dirname(x.file), 'foreign.db'), db = new DatabaseSync(bad); db.exec('CREATE TABLE foreign_data(id TEXT)'); db.close();
    expect(() => new ApproverStore(bad)).toThrow('FOREIGN_APPROVER_SCHEMA');
  });
  it('migrates the legacy database without losing DONE evidence, requests or credentials', async () => {
    const x = await setup(), d = donePayload(); await x.call('POST', '/api/approval-requests', d);
    const o = (await x.call('POST', '/api/webauthn/authentication/options', { request_id: d.request_id })).body;
    expect((await x.call('POST', '/api/webauthn/authentication/verify', { request_id: d.request_id, ceremony: o.ceremony,
      credential: x.device.assertion(o.options.challenge, origin, rp) })).status).toBe(201);
    const before = x.store.evidence(d.request_id), requestBefore = x.store.request(d.request_id);
    x.store.db.exec(`DROP TABLE typed_action_approval_evidence; DROP TABLE typed_action_approval_requests;
      ALTER TABLE webauthn_credentials DROP COLUMN authentication_revision;`);
    const upgraded = new ApproverStore(x.file);
    try {
      expect(upgraded.evidence(d.request_id)).toEqual(before); expect(upgraded.request(d.request_id)).toEqual(requestBefore);
      expect(upgraded.credential(x.device.id)).toMatchObject({ counter: 1, revision: 0, enabled: true });
      expect(upgraded.createTypedRequest(payload(), base)).toBe(true);
    } finally { upgraded.close(); }
  });
  it('zero-counter concurrent snapshots have exactly one CAS winner across SQLite connections', async () => {
    const x = await setup(), p = payload(), q = payload(); await x.call('POST', root, p); await x.call('POST', root, q);
    const second = new ApproverStore(x.file);
    try {
      const c1 = x.store.credential(x.device.id)!, c2 = second.credential(x.device.id)!;
      const issue = (p: TypedActionApprovalRequest) => {
        const e = { schemaVersion: 1 as const, type: 'AI_WORKSPACE_TYPED_ACTION_APPROVAL' as const, payload: p,
          approverKeyId: 'test', signatureAlgorithm: 'Ed25519' as const, signature: Buffer.alloc(64).toString('base64url') };
        return { ...e, signature: sign(null, typedActionApprovalSigningBytes(e), x.key.privateKey).toString('base64url') };
      };
      expect(x.store.approveTyped(p.approvalRequestId, c1, 0, issue, base)).toBe(true);
      expect(second.approveTyped(q.approvalRequestId, c2, 0, () => { throw Error('must not sign'); }, base)).toBe(false);
      expect(second.typedEvidence(p.approvalRequestId)?.payload).toEqual(p);
      expect(second.typedEvidence(q.approvalRequestId)).toBeNull();
    } finally { second.close(); }
  });
  it('rejects replaced ceremonies and expired requests, and presents immutable human confirmation fields', async () => {
    const x = await setup(), p = payload(); await x.call('POST', root, p);
    const old = await x.options(p); await x.options(p);
    expect((await x.call('POST', `${auth}/verify`, x.assertion(p, old))).status).toBe(403);
    const fresh = await x.options(p); x.clock(base + 240_000);
    expect((await x.call('POST', `${auth}/verify`, x.assertion(p, fresh))).status).toBe(403);
    expect((await x.call('GET', `/approve-typed-action/${p.approvalRequestId}`)).status).toBe(200);
    expect((await x.call('GET', '/approve-typed-action/invalid')).status).toBe(404);
    const js = (await x.call('GET', '/app.js')).body;
    for (const field of actionBindingFields) expect(js).toContain(`payload.${field}`);
    expect(js).toContain('payload.expiresAt'); expect(js).toContain('row.textContent'); expect(js).not.toContain('innerHTML');
  });
  it('rejects partial typed schema and corruption without repairing the database', async () => {
    const x = await setup(); x.store.db.exec('DROP TABLE typed_action_approval_evidence');
    expect(() => new ApproverStore(x.file)).toThrow('INVALID_APPROVER_DATABASE');
    expect(x.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='typed_action_approval_evidence'").get()).toBeUndefined();
    const bad = path.join(path.dirname(x.file), 'corrupt.db'); fs.writeFileSync(bad, 'not a sqlite database');
    expect(() => new ApproverStore(bad)).toThrow(); expect(fs.readFileSync(bad, 'utf8')).toBe('not a sqlite database');
  });
});
