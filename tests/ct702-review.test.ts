import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../src/typed-action-approval/contract.js';
import { bindActionAttempt, hashActionRequest } from '../src/mcp/typed-actions.js';
import { verifyIndependentReview } from '../src/typed-action-review/verifier.js';
import { freezeCandidate, hash, limits } from '../src/review-service/material.js';
import { ReviewStore } from '../src/review-service/store.js';
import { createReviewRuntime } from '../src/review-service/runtime.js';
import { boundedReviewer, fixtureProfile, type Provider } from '../src/review-service/provider.js';
import { createReviewServer } from '../src/review-service/server.js';
import { loadProductionConfig, productionConfigSchema, validateMetadata } from '../src/review-service/hardening.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });
function candidate(actionId = randomUUID(), attemptSequence = 1) {
  const request = { schemaVersion: 1, actionId, kind: 'RestartService', target: { kind: 'service', id: randomUUID() },
    preconditions: { targetGeneration: 1, policySha256: 'a'.repeat(64), maintenanceWindowId: randomUUID(), recheck: 'immediately-before-mutation-under-exclusive-fence' },
    timeout: { preflightMs: 1000, executionMs: 60000, verificationMs: 1000, onExpiry: 'stop-and-reconcile' },
    rollback: { mode: 'none', onFailure: 'block-and-reconcile' }, retry: { automaticMutationRetries: 0, recovery: 'new-request-fresh-preflight-and-new-approval' },
    retryOf: attemptSequence === 1 ? null : { actionId: randomUUID(), requestHash: 'a'.repeat(64), receiptHash: 'b'.repeat(64), attemptId: randomUUID(), attemptHash: 'c'.repeat(64), attemptSequence: attemptSequence - 1 },
    risk: 'elevated', approval: { human: 'required', independentReview: 'required', binding: 'request-hash-and-attempt', destructive: 'not-applicable', reboot: 'not-applicable' },
    reboot: 'forbidden', expected: { generation: 1, serviceState: 'running', configurationSha256: 'd'.repeat(64) }, desired: { serviceState: 'running' } };
  const requestText = canonicalJson(request), requestHash = hashActionRequest(request);
  const attempt = { schemaVersion: 1, actionId, attemptId: randomUUID(), sequence: attemptSequence, requestHash,
    createdAt: '2026-10-01T00:00:00.000Z', approvalIdentity: 'typed-action-attempt-sha256-v1' }, attemptText = canonicalJson(attempt);
  return { binding: { actionId, actionKind: 'RestartService' as const, targetId: request.target.id, requestHash,
    attemptId: attempt.attemptId, attemptSequence, attemptHash: bindActionAttempt(attempt, request).attemptHash, reviewId: randomUUID() },
    files: [{ path: 'request.json', base64: Buffer.from(requestText).toString('base64') },
      { path: 'attempt.json', base64: Buffer.from(attemptText).toString('base64') },
      { path: 'evidence.txt', base64: Buffer.from('Untrusted candidate evidence, independently reviewed by fixture.').toString('base64') }] };
}
function fixture(provider: Provider | undefined = { profile: fixtureProfile, call: async () => '{"result":"PASS","reason":"fixture"}' }, afterCommit?: () => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ct702-test-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'review.db'), key = generateKeyPairSync('ed25519');
  let store = new ReviewStore(file, { initialize: true, afterCommit });
  cleanups.push(() => store.close());
  const compose = () => createReviewRuntime({ store, privateKey: key.privateKey, keyId: 'fixture', provider });
  let runtime = compose();
  return { file, key, get store() { return store; }, get runtime() { return runtime; },
    restart() { store.close(); store = new ReviewStore(file); runtime = compose(); } };
}
function nextCandidate(previous: ReturnType<typeof candidate>) {
  const c = candidate(randomUUID(), previous.binding.attemptSequence + 1);
  const source = JSON.parse(Buffer.from(c.files[0].base64, 'base64').toString());
  source.target.id = previous.binding.targetId;
  source.retryOf = { actionId: previous.binding.actionId, requestHash: previous.binding.requestHash, receiptHash: 'b'.repeat(64),
    attemptId: previous.binding.attemptId, attemptHash: previous.binding.attemptHash, attemptSequence: previous.binding.attemptSequence };
  const requestHash = hashActionRequest(source);
  const attempt = JSON.parse(Buffer.from(c.files[1].base64, 'base64').toString()); attempt.requestHash = requestHash;
  c.files[0].base64 = Buffer.from(canonicalJson(source)).toString('base64');
  c.files[1].base64 = Buffer.from(canonicalJson(attempt)).toString('base64');
  Object.assign(c.binding, { targetId: source.target.id, requestHash, attemptHash: bindActionAttempt(attempt, source).attemptHash });
  return c;
}

describe('CT702 frozen material authority', () => {
  it.each(['PASS', 'integrity', 'current', 'model', 'policy', 'localPath', 'url', 'reviewText', 'provider'])('rejects caller authority field %s', field => {
    expect(() => freezeCandidate({ ...candidate(), [field]: true })).toThrow();
  });
  it.each(['actionId', 'targetId', 'requestHash', 'attemptHash', 'attemptId', 'attemptSequence', 'actionKind'])('recomputes %s binding', field => {
    const input = candidate();
    Object.assign(input.binding, { [field]: field.endsWith('Hash') ? 'a'.repeat(64) : field === 'attemptSequence' ? 3 : field === 'actionKind' ? 'AppUpgrade' : randomUUID() });
    expect(() => freezeCandidate(input)).toThrow('SOURCE_BINDING_MISMATCH');
  });
  it.each(['../x', '/etc/x', 'a/../x', 'a\\b', 'C:x', 'a//b', 'a/.', 'nul.txt', 'a.', 'a/COM1', 'a:stream', ''])('rejects nonportable path %s', p => {
    const input = candidate(); input.files.push({ path: p, base64: '' }); expect(() => freezeCandidate(input)).toThrow();
  });
  it('rejects duplicates, link semantics, noncanonical encoding and missing source', () => {
    const c = candidate();
    for (const f of [c.files[0], { ...c.files[0], path: 'REQUEST.json' }, { path: 'linked', base64: '', symlink: 'target' },
      { path: 'linked', base64: '', type: 'reparse' }, { path: 'invalid', base64: 'YQ' }]) {
      expect(() => freezeCandidate({ ...c, files: [...c.files, f] })).toThrow();
    }
    expect(() => freezeCandidate({ ...c, files: c.files.slice(1) })).toThrow('BINDING_SOURCE_MISSING');
    expect(() => freezeCandidate({ ...c, files: [...c.files, { path: 'evidence.txt/child', base64: '' }] })).toThrow('INVALID_OR_DUPLICATE_SOURCE');
  });
  it('enforces exact total bytes and count bounds and canonical material order', () => {
    const c = candidate(); c.files[2].base64 = '';
    const bindingSize = c.files.reduce((n, f) => n + Buffer.from(f.base64, 'base64').length, 0);
    c.files[2].base64 = Buffer.alloc(limits.bytes - bindingSize).toString('base64');
    expect(freezeCandidate(c).files.reduce((n, f) => n + f.bytes.length, 0)).toBe(limits.bytes);
    c.files[2].base64 = Buffer.alloc(limits.bytes - bindingSize + 1).toString('base64');
    expect(() => freezeCandidate(c)).toThrow('MATERIAL_TOO_LARGE');
    c.files[2].base64 = '';
    while (c.files.length < limits.files) c.files.push({ path: `f${c.files.length}`, base64: '' });
    const m = freezeCandidate(c); expect(freezeCandidate({ ...c, files: [...c.files].reverse() }).root).toBe(m.root);
    c.files.push({ path: 'extra', base64: '' }); expect(() => freezeCandidate(c)).toThrow();
  });
});

describe('CT702 durable review chronology', () => {
  it.each(['PASS', 'FAIL', 'NEEDS_WORK'] as const)('signs historical %s only after result durability', async result => {
    const f = fixture({ profile: fixtureProfile, call: async () => JSON.stringify({ result, reason: 'fixture' }) });
    const c = candidate(), id = { reviewId: c.binding.reviewId };
    const sign = vi.spyOn(f.store, 'saveSignature').mockImplementation((reviewId, envelope) => {
      expect(f.store.state(reviewId)).toBe('RESULT_DURABLE');
      const db = new DatabaseSync(f.file); expect(db.prepare('SELECT body FROM results WHERE review_id=?').get(reviewId)).toBeTruthy(); db.close();
      return original(reviewId, envelope);
    });
    const original = ReviewStore.prototype.saveSignature.bind(f.store);
    const s = await f.runtime.submit(c), evidence = f.runtime.evidence(id);
    expect(s.state).toBe('SIGNED_PENDING_PUBLICATION'); expect(s.result).toBe(result); expect(sign).toHaveBeenCalledTimes(1);
    expect(s.history.map(e => e.state)).toEqual(['REVIEW_PENDING', 'MATERIAL_FIXED', 'REVIEW_RUNNING', 'RESULT_DURABLE', 'SIGNED_PENDING_PUBLICATION']);
    expect(JSON.stringify(s)).not.toMatch(/production.current|reviewIsCurrent|integrity.*true/i);
    const context = f.store.result(id.reviewId).snapshot.context;
    expect(verifyIndependentReview(evidence.envelope, context, new Map([['fixture', f.key.publicKey]]), Date.now()).valid).toBe(true);
    f.restart(); expect(f.runtime.evidence(id)).toEqual(evidence);
    expect(await f.runtime.submit(c)).toEqual(s);
    expect(f.runtime.evidence(id).envelope).toEqual(evidence.envelope);
  });
  it('preserves acknowledged, invalidated and superseded history, never revives an old PASS', async () => {
    const f = fixture(), c = candidate(), id = { reviewId: c.binding.reviewId };
    const s = await f.runtime.submit(c);
    const ack = { ...id, expectedSequence: s.sequence, acknowledgementId: randomUUID() };
    const acknowledged = f.runtime.acknowledge(ack);
    expect(f.runtime.acknowledge(ack)).toEqual(acknowledged);
    const invalidation = { ...id, expectedSequence: acknowledged.sequence, acknowledgementId: randomUUID() };
    const pending = f.runtime.invalidate(invalidation); expect(f.runtime.invalidate(invalidation)).toEqual(pending);
    expect(pending.state).toBe('INVALIDATION_PENDING');
    f.restart(); expect(f.runtime.status(id)).toEqual(pending);
    const receipt = { ...id, expectedSequence: pending.sequence, intentHash: pending.pendingInvalidation!.intentHash,
      replacementReviewId: null, acknowledgementId: randomUUID() };
    const invalid = f.runtime.acknowledgeInvalidation(receipt);
    expect(invalid.state).toBe('INVALIDATED'); expect(f.runtime.acknowledgeInvalidation(receipt)).toEqual(invalid);
    expect(f.runtime.invalidate(invalidation)).toEqual(invalid);
    expect(() => f.runtime.acknowledge(ack)).toThrow();
    expect((await f.runtime.submit(c)).state).toBe('INVALIDATED');
    const next = nextCandidate(c); const second = await f.runtime.submit(next);
    const last = nextCandidate(next); await f.runtime.submit(last);
    expect(f.runtime.status({ reviewId: next.binding.reviewId }).state).toBe('SUPERSEDED');
    expect(() => f.runtime.acknowledge({ reviewId: next.binding.reviewId, expectedSequence: second.sequence, acknowledgementId: randomUUID() })).toThrow();
    expect((await f.runtime.submit(next)).state).toBe('SUPERSEDED');
    await expect(f.runtime.submit(candidate(c.binding.actionId, 1))).rejects.toThrow('ATTEMPT_ROLLBACK');
    f.restart(); expect(f.runtime.status(id)).toEqual(invalid);
    expect(f.runtime.acknowledgeInvalidation(receipt)).toEqual(invalid);
  });
  it('keeps acknowledged predecessor pending until exact CT701 supersession acknowledgement', async () => {
    const f = fixture(), c = candidate(), id = { reviewId: c.binding.reviewId };
    const initial = await f.runtime.submit(c);
    f.runtime.acknowledge({ ...id, expectedSequence: initial.sequence, acknowledgementId: randomUUID() });
    const next = nextCandidate(c), replacement = await f.runtime.submit(next);
    const pending = f.runtime.status(id);
    expect(pending.state).toBe('SUPERSESSION_PENDING');
    expect(pending.pendingInvalidation).toEqual({ kind: 'SUPERSESSION_PENDING', sequence: pending.sequence,
      intentHash: hash(pending.history.at(-1)!.detail as string), replacementReviewId: next.binding.reviewId });
    expect(pending.history.some(e => e.state === 'SUPERSEDED')).toBe(false);
    expect(await f.runtime.submit(next)).toEqual(replacement);
    expect(() => f.runtime.acknowledge({ ...id, expectedSequence: pending.sequence, acknowledgementId: randomUUID() })).toThrow();
    await expect(f.runtime.submit(nextCandidate(c))).rejects.toThrow('PREDECESSOR_SUPERSEDED');
    const receipt = { ...id, expectedSequence: pending.sequence, intentHash: pending.pendingInvalidation!.intentHash,
      replacementReviewId: next.binding.reviewId, acknowledgementId: randomUUID() };
    for (const delta of [{ expectedSequence: initial.sequence }, { intentHash: '0'.repeat(64) },
      { replacementReviewId: null }, { replacementReviewId: randomUUID() }, { reviewId: next.binding.reviewId }]) {
      expect(() => f.runtime.acknowledgeInvalidation({ ...receipt, ...delta })).toThrow('STALE_INVALIDATION_ACK');
    }
    // Publication of B and local supersession of B by C cannot erase A's intent.
    const nextId = { reviewId: next.binding.reviewId };
    f.runtime.acknowledge({ ...nextId, expectedSequence: replacement.sequence, acknowledgementId: randomUUID() });
    await f.runtime.submit(nextCandidate(next));
    expect(f.runtime.status(id)).toEqual(pending);
    f.restart(); expect(f.runtime.status(id)).toEqual(pending);
    const terminal = f.runtime.acknowledgeInvalidation(receipt);
    expect(terminal.state).toBe('SUPERSEDED'); expect(terminal.sequence).toBeGreaterThan(pending.sequence as number);
    expect(f.runtime.acknowledgeInvalidation(receipt)).toEqual(terminal);
    expect(() => f.runtime.acknowledgeInvalidation({ ...receipt, acknowledgementId: randomUUID() })).toThrow();
    expect((await f.runtime.submit(c)).state).toBe('SUPERSEDED');
    const db = new DatabaseSync(f.file), seqs = db.prepare('SELECT seq FROM events ORDER BY seq').all().map(e => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); db.close();
  });
  it('publishing a replacement preserves an unresolved explicit predecessor invalidation', async () => {
    const f = fixture(), c = candidate(), id = { reviewId: c.binding.reviewId };
    const s = await f.runtime.submit(c);
    const published = f.runtime.acknowledge({ ...id, expectedSequence: s.sequence, acknowledgementId: randomUUID() });
    const pending = f.runtime.invalidate({ ...id, expectedSequence: published.sequence, acknowledgementId: randomUUID() });
    const next = nextCandidate(c), replacement = await f.runtime.submit(next);
    f.runtime.acknowledge({ reviewId: next.binding.reviewId, expectedSequence: replacement.sequence, acknowledgementId: randomUUID() });
    expect(f.runtime.status(id)).toEqual(pending);
  });
  it.each(['publication-first', 'supersession-first'])('serializes publication/supersession CAS: %s', async order => {
    const f = fixture(), c = candidate(), id = { reviewId: c.binding.reviewId };
    const s = await f.runtime.submit(c), next = nextCandidate(c);
    const other = new ReviewStore(f.file);
    try {
      const peer = createReviewRuntime({ store: other, privateKey: f.key.privateKey, keyId: 'fixture' });
      const ack = { ...id, expectedSequence: s.sequence, acknowledgementId: randomUUID() };
      if (order === 'publication-first') {
        peer.acknowledge(ack); f.store.accept(freezeCandidate(next));
        expect(f.runtime.status(id).state).toBe('SUPERSESSION_PENDING');
      } else {
        f.store.accept(freezeCandidate(next)); expect(() => peer.acknowledge(ack)).toThrow('STALE_PUBLICATION_ACK');
        expect(f.runtime.status(id).state).toBe('SUPERSEDED');
      }
    } finally { other.close(); }
  });
  it('concurrent worker publication ack and supersession have one serialized outcome', async () => {
    const f = fixture(), c = candidate(), id = { reviewId: c.binding.reviewId };
    const s = await f.runtime.submit(c), next = nextCandidate(c), barrier = new SharedArrayBuffer(4);
    const workers: Worker[] = [], ready: Promise<void>[] = [], outcomes: Promise<string>[] = [];
    for (const mode of ['publication', 'supersession']) {
      const worker = new Worker(`
        require('tsx/cjs');
        const {parentPort,workerData:w}=require('node:worker_threads');
        const {ReviewStore}=require(w.storeModule);
        const {createReviewRuntime}=require(w.runtimeModule);
        const {freezeCandidate}=require(w.materialModule);
        const store=new ReviewStore(w.file);
        const runtime=createReviewRuntime({store,privateKey:w.key,keyId:'fixture'});
        parentPort.postMessage('ready'); Atomics.wait(new Int32Array(w.barrier),0,0);
        try {
          if(w.mode==='publication') runtime.acknowledge(w.ack);
          else store.accept(freezeCandidate(w.next));
          parentPort.postMessage('committed');
        } catch(e) { parentPort.postMessage(e.message); }
        finally {store.close();}
      `, { eval: true, workerData: { mode, file: f.file, key: f.key.privateKey, barrier, next,
        ack: { ...id, expectedSequence: s.sequence, acknowledgementId: randomUUID() },
        storeModule: path.resolve('src/review-service/store.ts'), runtimeModule: path.resolve('src/review-service/runtime.ts'),
        materialModule: path.resolve('src/review-service/material.ts') } });
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => { worker.on('message', value => { if (value === 'ready') resolve(); }); worker.once('error', reject); }));
      outcomes.push(new Promise((resolve, reject) => { worker.on('message', value => { if (value !== 'ready') resolve(value); }); worker.once('error', reject); }));
    }
    try {
      await Promise.all(ready); Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      const [ack, supersession] = await Promise.all(outcomes);
      expect([ack, supersession]).toContain('committed');
      for (const result of [ack, supersession]) expect(result === 'committed' || /locked|STALE_PUBLICATION_ACK/.test(result)).toBe(true);
      const states = f.runtime.status(id).history.map(e => e.state);
      expect(states.includes('PUBLICATION_ACKNOWLEDGED') && states.includes('SUPERSEDED')).toBe(false);
      expect(f.runtime.status(id).state).toBe(supersession === 'committed'
        ? ack === 'committed' ? 'SUPERSESSION_PENDING' : 'SUPERSEDED' : 'PUBLICATION_ACKNOWLEDGED');
    } finally { await Promise.all(workers.map(w => w.terminate())); }
  });
  it.each(['intent', 'receipt'])('reconciles uncertain invalidation %s commit without automatic retry', async stage => {
    let fail = false;
    const f = fixture(undefined, () => { if (fail) throw Error('lost response'); });
    const c = candidate(), id = { reviewId: c.binding.reviewId }, s = await f.runtime.submit(c);
    const published = f.runtime.acknowledge({ ...id, expectedSequence: s.sequence, acknowledgementId: randomUUID() });
    const intent = { ...id, expectedSequence: published.sequence, acknowledgementId: randomUUID() };
    if (stage === 'intent') {
      fail = true; expect(() => f.runtime.invalidate(intent)).toThrow('RECONCILE_REQUIRED');
      expect(() => f.runtime.status(id)).toThrow('RECONCILE_REQUIRED'); f.restart();
    } else f.runtime.invalidate(intent);
    const pending = f.runtime.invalidate(intent);
    expect(pending.state).toBe('INVALIDATION_PENDING');
    const receipt = { ...id, expectedSequence: pending.sequence, intentHash: pending.pendingInvalidation!.intentHash,
      replacementReviewId: null, acknowledgementId: randomUUID() };
    if (stage === 'receipt') {
      fail = true; expect(() => f.runtime.acknowledgeInvalidation(receipt)).toThrow('RECONCILE_REQUIRED');
      expect(() => f.runtime.status(id)).toThrow('RECONCILE_REQUIRED'); f.restart();
    }
    const invalid = f.runtime.acknowledgeInvalidation(receipt);
    expect(invalid.state).toBe('INVALIDATED'); expect(f.runtime.acknowledgeInvalidation(receipt)).toEqual(invalid);
    expect((await f.runtime.submit(c)).state).toBe('INVALIDATED');
  });
  it('reconciles uncertain replacement acceptance without losing or duplicating pending supersession', async () => {
    let fail = false;
    const f = fixture(undefined, () => { if (fail) throw Error('lost response'); });
    const c = candidate(), id = { reviewId: c.binding.reviewId }, s = await f.runtime.submit(c);
    f.runtime.acknowledge({ ...id, expectedSequence: s.sequence, acknowledgementId: randomUUID() });
    const next = nextCandidate(c); fail = true;
    await expect(f.runtime.submit(next)).rejects.toThrow('RECONCILE_REQUIRED');
    expect(() => f.runtime.status(id)).toThrow('RECONCILE_REQUIRED');
    f.restart(); const pending = f.runtime.status(id);
    expect(pending.state).toBe('SUPERSESSION_PENDING');
    expect(pending.pendingInvalidation!.replacementReviewId).toBe(next.binding.reviewId);
    await f.runtime.submit(next); expect(f.runtime.status(id)).toEqual(pending);
    expect(pending.history.filter(e => e.state === 'SUPERSESSION_PENDING')).toHaveLength(1);
  });
  it('SQL forbids local terminal transition of acknowledged history and mismatched pending receipts', async () => {
    const f = fixture(), c = candidate(), id = { reviewId: c.binding.reviewId }, s = await f.runtime.submit(c);
    const published = f.runtime.acknowledge({ ...id, expectedSequence: s.sequence, acknowledgementId: randomUUID() });
    const db = new DatabaseSync(f.file);
    try {
      const insert = db.prepare('INSERT INTO events(review_id,state,detail,operation_id) VALUES(?,?,?,?)');
      for (const state of ['INVALIDATED', 'SUPERSEDED']) expect(() => insert.run(id.reviewId, state, '{}', randomUUID())).toThrow('INVALID_TRANSITION');
      f.runtime.invalidate({ ...id, expectedSequence: published.sequence, acknowledgementId: randomUUID() });
      for (const state of ['INVALIDATED', 'SUPERSEDED']) expect(() => insert.run(id.reviewId, state, '{}', randomUUID())).toThrow('INVALID_TRANSITION');
    } finally { db.close(); }
  });
  it('rejects conflicting replacement and reused attempt identity', async () => {
    const f = fixture(), c = candidate(); await f.runtime.submit(c);
    const changed = structuredClone(c); changed.files[2].base64 = Buffer.from('other').toString('base64');
    await expect(f.runtime.submit(changed)).rejects.toThrow('CONFLICTING_REPLACEMENT');
    await expect(f.runtime.submit({ ...c, binding: { ...c.binding, reviewId: randomUUID() } })).rejects.toThrow();
    expect(() => f.runtime.status({ reviewId: c.binding.reviewId, current: true })).toThrow();
  });
  it('binds retry predecessors and refuses a later sibling of a superseded review', async () => {
    const f = fixture(), c = candidate(); await f.runtime.submit(c);
    await expect(f.runtime.submit(candidate(randomUUID(), 2))).rejects.toThrow('UNKNOWN_PREDECESSOR');
    const next = nextCandidate(c); await f.runtime.submit(next);
    await expect(f.runtime.submit(nextCandidate(c))).rejects.toThrow('PREDECESSOR_SUPERSEDED');
  });
  it('rolls back failed acceptance atomically without partial content or history', async () => {
    const f = fixture(), c = candidate();
    const event = vi.spyOn(f.store, 'event').mockImplementation(() => { throw Error('injected write failure'); });
    await expect(f.runtime.submit(c)).rejects.toThrow('injected write failure'); event.mockRestore();
    const db = new DatabaseSync(f.file);
    for (const table of ['blobs', 'materials', 'reviews', 'events']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    db.close(); expect((await f.runtime.submit(c)).state).toBe('SIGNED_PENDING_PUBLICATION');
  });
  it('detects tampered durable result and historical signature after schema-preserving edits', async () => {
    const f = fixture(), c = candidate(); await f.runtime.submit(c);
    const db = new DatabaseSync(f.file);
    const signatureTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='signatures_no_update'").get()!.sql as string;
    const envelope = f.store.signature(c.binding.reviewId); envelope.signature = Buffer.alloc(64).toString('base64url');
    db.exec('DROP TRIGGER signatures_no_update'); db.prepare('UPDATE signatures SET body=?').run(canonicalJson(envelope)); db.exec(signatureTrigger);
    expect(() => f.runtime.evidence({ reviewId: c.binding.reviewId })).toThrow('HISTORICAL_SIGNATURE_TAMPER');
    const resultTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='results_no_update'").get()!.sql as string;
    const result = f.store.result(c.binding.reviewId); result.report.reason = 'tampered';
    db.exec('DROP TRIGGER results_no_update'); db.prepare('UPDATE results SET body=?').run(canonicalJson(result)); db.exec(resultTrigger); db.close();
    expect(() => new ReviewStore(f.file)).toThrow('RESULT_TAMPER');
  });
  it('does not sign when result commit is uncertain; reconciles exact duplicate after reopen', async () => {
    let commits = 0;
    const f = fixture(undefined, () => { if (++commits === 3) throw Error('lost commit response'); });
    const c = candidate(); await expect(f.runtime.submit(c)).rejects.toThrow('RECONCILE_REQUIRED');
    expect(() => f.runtime.status({ reviewId: c.binding.reviewId })).toThrow('RECONCILE_REQUIRED');
    const db = new DatabaseSync(f.file);
    expect(db.prepare('SELECT count(*) AS n FROM results').get()?.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM signatures').get()?.n).toBe(0); db.close();
    f.restart(); expect((await f.runtime.submit(c)).state).toBe('SIGNED_PENDING_PUBLICATION');
  });
  it('uncertain signature commit returns no envelope and never resigns an exact duplicate', async () => {
    let commits = 0;
    const f = fixture(undefined, () => { if (++commits === 4) throw Error('lost response'); });
    const c = candidate(); await expect(f.runtime.submit(c)).rejects.toThrow('RECONCILE_REQUIRED');
    f.restart(); const before = f.runtime.evidence({ reviewId: c.binding.reviewId });
    await f.runtime.submit(c); expect(f.runtime.evidence({ reviewId: c.binding.reviewId })).toEqual(before);
  });
  it('does not replay interrupted provider calls and supports explicit invalidation', async () => {
    const f = fixture(), c = candidate(); f.store.accept(freezeCandidate(c));
    f.store.mutate(() => f.store.event(c.binding.reviewId, 'REVIEW_RUNNING'));
    f.restart(); await expect(f.runtime.submit(c)).rejects.toThrow('RECONCILE_REQUIRED');
    const s = f.runtime.status({ reviewId: c.binding.reviewId });
    expect(f.runtime.invalidate({ reviewId: c.binding.reviewId, expectedSequence: s.sequence, acknowledgementId: randomUUID() }).state).toBe('INVALIDATED');
  });
  it('fences in-flight review completion after supersession', async () => {
    let release!: (s: string) => void;
    const f = fixture({ profile: fixtureProfile, call: () => new Promise(resolve => { release = resolve; }) });
    const c = candidate(), pending = f.runtime.submit(c); await Promise.resolve();
    const next = nextCandidate(c); f.store.accept(freezeCandidate(next));
    release('{"result":"PASS","reason":"late"}'); expect((await pending).state).toBe('SUPERSEDED');
    expect(f.runtime.evidence({ reviewId: c.binding.reviewId }).envelope).toBeNull();
  });
  it('forbids UPDATE/DELETE and illegal chronology in SQLite itself', async () => {
    const f = fixture(), c = candidate(); await f.runtime.submit(c); const db = new DatabaseSync(f.file);
    for (const table of ['blobs', 'materials', 'reviews', 'events', 'results', 'signatures']) {
      const col = String(db.prepare(`PRAGMA table_info(${table})`).get()!.name);
      expect(() => db.exec(`UPDATE ${table} SET ${col}=${col}`)).toThrow('IMMUTABLE_HISTORY');
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('IMMUTABLE_HISTORY');
    }
    expect(() => db.prepare('INSERT INTO events(review_id,state,detail) VALUES(?,?,?)').run(c.binding.reviewId, 'REVIEW_RUNNING', '')).toThrow(); db.close();
  });
  it.each(['schema', 'version', 'previous-version', 'content', 'manifest'])('fails startup closed on %s tamper without repair', async kind => {
    const f = fixture(), c = candidate(); await f.runtime.submit(c);
    const db = new DatabaseSync(f.file);
    if (kind === 'schema') db.exec('CREATE TABLE unexpected(x TEXT)');
    if (kind === 'version') db.exec('PRAGMA user_version=1');
    if (kind === 'previous-version') db.exec('PRAGMA user_version=7021');
    if (kind === 'content' || kind === 'manifest') {
      const table = kind === 'content' ? 'blobs' : 'materials';
      const trigger = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(`${table}_no_update`)!.sql as string;
      db.exec(`DROP TRIGGER ${table}_no_update`);
      db.exec(kind === 'content' ? "UPDATE blobs SET bytes=x'61'" : "UPDATE materials SET manifest_hash='bad'");
      db.exec(trigger);
    }
    const version = db.prepare('PRAGMA user_version').get(); db.close();
    expect(() => new ReviewStore(f.file)).toThrow();
    const check = new DatabaseSync(f.file); expect(check.prepare('PRAGMA user_version').get()).toEqual(version); check.close();
  });
});

describe('CT702 bounded provider and service', () => {
  it('defaults to deny-all with signed NEEDS_WORK', async () => {
    const f = fixture(); const runtime = createReviewRuntime({ store: f.store, privateKey: f.key.privateKey, keyId: 'fixture' });
    expect((await runtime.submit(candidate())).result).toBe('NEEDS_WORK');
  });
  it.each(['timeout', 'failure', 'malformed', 'oversize', 'unknown-field'])('fails closed for provider %s', async mode => {
    const call = vi.fn(async () => {
      if (mode === 'timeout') return new Promise<string>(() => {});
      if (mode === 'failure') throw Error('unavailable');
      if (mode === 'oversize') return 'x'.repeat(4097);
      if (mode === 'unknown-field') return '{"result":"PASS","reason":"x","current":true}';
      return '{"result":"PASS"}';
    });
    const review = boundedReviewer({ profile: { ...fixtureProfile, timeoutMs: 5 }, call });
    expect((await review(freezeCandidate(candidate()))).result).toBe('NEEDS_WORK'); expect(call).toHaveBeenCalledTimes(1);
    if (mode === 'timeout') await expect(review(freezeCandidate(candidate()))).rejects.toThrow('PROVIDER_UNAVAILABLE');
  });
  it.each([{ model: 'unknown' }, { provider: 'external' }, { endpoint: 'https://example.test' }, { maxCalls: 2 }, { promptHash: 'a'.repeat(64) }])('rejects unknown provider profile %j', fields => {
    expect(() => boundedReviewer({ profile: { ...fixtureProfile, ...fields } as any, call: async () => '' })).toThrow();
  });
  it('provider sees only frozen bytes and cannot substitute source via mutation', async () => {
    const c = candidate(), captured = freezeCandidate(c);
    const f = fixture({ profile: fixtureProfile, call: async packet => {
      expect(JSON.parse(packet).root).toBe(captured.root); c.files[2].base64 = ''; return '{"result":"FAIL","reason":"independent"}';
    } });
    const s = await f.runtime.submit(c); expect(s.materialRoot).toBe(captured.root); expect(s.result).toBe('FAIL');
  });
  it('production peer denial ignores headers; invalidation acknowledgement is a separate capability', async () => {
    const f = fixture();
    const test = async (trusted: boolean) => {
      const server = createReviewServer(f.runtime, trusted ? () => ({ identity: 'fixture', capabilities: ['submit', 'status', 'evidence', 'acknowledge', 'invalidate'] }) : undefined);
      server.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
      const port = (server.address() as { port: number }).port;
      const send = (route: string, body: unknown) => new Promise<number>(resolve => {
        const req = request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trusted-Peer': 'true', Host: 'localhost', Origin: 'http://localhost' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.end(JSON.stringify(body));
      });
      try {
        expect(await send('/v1/reviews/submit', candidate())).toBe(trusted ? 200 : 403);
        expect(await send('/v1/reviews/acknowledge-invalidation', {})).toBe(403);
        for (const route of ['/sign', '/admin', '/sql', '/filesystem', '/provider', '/shell', '/v1/reviews/current']) expect(await send(route, {})).toBe(trusted ? 404 : 403);
        if (trusted) expect(await send('/v1/reviews/submit', { ...candidate(), provider: 'external' })).toBe(400);
      } finally { await new Promise<void>(r => server.close(() => r())); }
    };
    await test(false); await test(true);
    expect(Object.keys(f.runtime).sort()).toEqual(['acknowledge', 'acknowledgeInvalidation', 'evidence', 'invalidate', 'status', 'submit']);
  });
});

describe('CT702 production hardening', () => {
  it('validates fixed paths, identity, and deny-all profile', () => {
    const cfg = { version: 1, uid: 702, user: 'ct702-review', listen: '127.0.0.1', port: 7020,
      database: '/var/lib/ct702-review/review.db', signingKey: '/var/lib/ct702-review/signing.key', provider: 'deny-all', peerAuthorization: 'deny-all', keyId: 'fixture' };
    expect(productionConfigSchema.parse(cfg)).toEqual(cfg);
    for (const change of [{ uid: 0 }, { listen: '0.0.0.0' }, { database: '/tmp/review.db' }, { signingKey: '/tmp/key' },
      { provider: 'fixture' }, { module: 'evil.js' }, { peerAuthorization: true }]) expect(() => productionConfigSchema.parse({ ...cfg, ...change })).toThrow();
    if (process.platform !== 'linux') expect(() => loadProductionConfig()).toThrow('UNPRIVILEGED_LINUX_REQUIRED');
  });
  it('rejects unsafe ownership, modes, links and nonregular files', () => {
    const stat = { uid: 702, mode: 0o600, nlink: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    expect(() => validateMetadata(stat, 702, false, true)).not.toThrow();
    for (const changed of [{ uid: 0 }, { mode: 0o640 }, { mode: 0o666 }, { nlink: 2 }, { isSymbolicLink: () => true }, { isFile: () => false }]) {
      expect(() => validateMetadata({ ...stat, ...changed }, 702, false, true)).toThrow();
    }
  });
});
