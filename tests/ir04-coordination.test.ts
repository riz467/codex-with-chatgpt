import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { bindActionRequest, bindActionAttempt } from '../src/mcp/typed-actions.js';
import { canonicalJson } from '../src/typed-action-approval/contract.js';
import { TrustedContextStore } from '../src/typed-action-finalizer/trusted-context-storage.js';
import { ir04Fixture } from './ir04-fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function setup(issued = false) { const f = await ir04Fixture(cleanups); if (issued) await f.issue(); return f; }
type Fixture = Awaited<ReturnType<typeof setup>>;
function reservation(f: Fixture) {
  const s = f.runtime.status({ reviewId: f.binding.reviewId });
  return { reviewId: f.binding.reviewId, expectedSequence: s.sequence,
    publicationSequence: Number(s.history.find(e => e.state === 'SIGNED_PENDING_PUBLICATION')!.seq),
    materialRoot: s.materialRoot, evidenceHash: f.evidence.payload.reviewEvidenceHash, kind: 'READINESS' as const, barrierId: randomUUID() };
}
function replacement(f: Fixture) {
  const request = structuredClone(f.input.boundRequest.request);
  request.actionId = randomUUID(); request.retryOf = { actionId: f.binding.actionId, requestHash: f.binding.requestHash,
    receiptHash: 'a'.repeat(64), attemptId: f.binding.attemptId, attemptHash: f.binding.attemptHash, attemptSequence: 1 };
  const boundRequest = bindActionRequest(request);
  const boundAttempt = bindActionAttempt({ ...f.input.boundAttempt.attempt, actionId: request.actionId,
    attemptId: randomUUID(), sequence: 2, requestHash: boundRequest.requestHash }, request);
  const binding = { ...f.binding, actionId: request.actionId, requestHash: boundRequest.requestHash,
    attemptId: boundAttempt.attempt.attemptId, attemptHash: boundAttempt.attemptHash, attemptSequence: 2, reviewId: randomUUID() };
  return { binding, files: [{ path: 'request.json', base64: Buffer.from(canonicalJson(request)).toString('base64') },
    { path: 'attempt.json', base64: Buffer.from(canonicalJson(boundAttempt.attempt)).toString('base64') }, f.candidate.files[2]] };
}

describe('IR-04 publication/revocation coordinator', () => {
  it('activates only at CT701 durable COMMIT, before exact publication ACK', async () => {
    const f = await setup(); expect(f.reviewState()).toBeUndefined();
    f.peer.acknowledge.mockImplementation(x => {
      const independent = new DatabaseSync(f.authorityFile);
      expect(independent.prepare('SELECT state FROM reviews').get()!.state).toBe('current');
      expect(independent.prepare('SELECT count(*) n FROM coordination_commits').get()!.n).toBe(1); independent.close();
      expect(f.runtime.status({ reviewId: f.binding.reviewId }).state).toBe('SIGNED_PENDING_PUBLICATION');
      return f.runtime.acknowledge(x);
    });
    await f.adopt(); expect(f.reviewState()).toBe('current'); expect(f.peer.acknowledge).toHaveBeenCalledOnce();
  });
  it('publication ACK loss preserves activation; restart reconciles exact original UUID', async () => {
    const f = await setup();
    f.peer.acknowledge.mockImplementationOnce(x => { f.runtime.acknowledge(x); throw Error('response lost'); });
    await expect(f.adopt()).rejects.toThrow('response lost'); expect(f.reviewState()).toBe('current');
    const original = f.peer.acknowledge.mock.calls[0][0];
    f.restartAuthority(); f.restartReview();
    await f.authority.reconcileReviewAcknowledgement(f.binding.reviewId, 'PUBLICATION');
    expect(f.peer.acknowledge.mock.calls[1][0]).toEqual(original);
    expect(f.authorityDb.prepare('SELECT count(*) n FROM coordination_acks').get()!.n).toBe(1);
  });
  it('unknown activation COMMIT keeps publication reservation and sends no ACK', async () => {
    const f = await setup(); const original = f.authorityDb.exec.bind(f.authorityDb); let fired = false;
    vi.spyOn(f.authorityDb, 'exec').mockImplementation(sql => {
      const activate = sql === 'COMMIT' && !fired && Number(f.authorityDb.prepare('SELECT count(*) n FROM coordination_commits').get()!.n) === 1;
      original(sql); if (activate) { fired = true; throw Error('lost COMMIT'); }
    });
    await expect(f.adopt()).rejects.toThrow('RECONCILE_REQUIRED'); expect(f.peer.acknowledge).not.toHaveBeenCalled();
    expect(() => f.invalidate()).toThrow('BARRIER_HELD'); f.restartAuthority();
    await f.authority.reconcileReviewAcknowledgement(f.binding.reviewId, 'PUBLICATION'); expect(f.reviewState()).toBe('current');
  });
  it('publication reservation response loss reuses original intent after restart', async () => {
    const f = await setup(); f.peer.reserve.mockImplementationOnce(x => { f.runtime.reserve(x); throw Error('lost'); });
    await expect(f.adopt()).rejects.toThrow('lost'); expect(f.reviewState()).toBeUndefined();
    const original = f.peer.reserve.mock.calls[0][0]; f.restartAuthority(); await f.adopt();
    expect(f.peer.reserve.mock.calls[1][0]).toEqual(original); expect(f.reviewState()).toBe('current');
  });
  it('reconciles historical publication ACK after invalidation arrived without enabling readiness', async () => {
    const f = await setup(); f.peer.acknowledge.mockImplementationOnce(x => { f.runtime.acknowledge(x); throw Error('lost'); });
    await expect(f.adopt()).rejects.toThrow(); f.invalidate(); f.restartAuthority();
    await f.authority.reconcileReviewAcknowledgement(f.binding.reviewId, 'PUBLICATION');
    expect(f.reviewState()).toBe('current'); expect(() => f.runtime.reserve(reservation(f))).toThrow('READINESS_REJECTED');
    await f.authority.admitReviewInvalidation(f.binding.reviewId); expect(f.reviewState()).toBe('stale');
  });
  it.each(['before', 'after'])('unknown revocation COMMIT %s durable write sends no remote ACK', async fault => {
    const f = await setup(true); f.invalidate(); const original = f.authorityDb.exec.bind(f.authorityDb); let fired = false;
    vi.spyOn(f.authorityDb, 'exec').mockImplementation(sql => {
      const revoke = sql === 'COMMIT' && !fired && !!f.authorityDb.prepare("SELECT 1 FROM coordination_intents WHERE kind='REVOCATION'").get();
      if (revoke && fault === 'before') { fired = true; throw Error('unknown'); }
      original(sql); if (revoke) { fired = true; throw Error('unknown'); }
    });
    await expect(f.authority.admitReviewInvalidation(f.binding.reviewId)).rejects.toThrow('RECONCILE_REQUIRED');
    expect(f.peer.acknowledgeInvalidation).not.toHaveBeenCalled(); f.restartAuthority();
    expect(f.reviewState()).toBe(fault === 'before' ? 'current' : 'stale');
    await f.authority.admitReviewInvalidation(f.binding.reviewId); expect(f.reviewState()).toBe('stale');
  });
  it('pending invalidation is not revocation; CT701 COMMIT precedes terminal ACK', async () => {
    const f = await setup(true); f.invalidate(); expect(f.reviewState()).toBe('current');
    f.peer.acknowledgeInvalidation.mockImplementation(x => { expect(f.reviewState()).toBe('stale'); return f.runtime.acknowledgeInvalidation(x); });
    await f.authority.admitReviewInvalidation(f.binding.reviewId);
    expect(f.runtime.status({ reviewId: f.binding.reviewId }).state).toBe('INVALIDATED');
    await expect(f.consume()).rejects.toThrow(); expect(f.count('consumed_execution_identities')).toBe(0); expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it('invalidation ACK loss never reactivates; exact reconciliation survives restart', async () => {
    const f = await setup(true); f.invalidate();
    f.peer.acknowledgeInvalidation.mockImplementationOnce(x => { f.runtime.acknowledgeInvalidation(x); throw Error('lost'); });
    await expect(f.authority.admitReviewInvalidation(f.binding.reviewId)).rejects.toThrow('lost'); expect(f.reviewState()).toBe('stale');
    const ack = f.peer.acknowledgeInvalidation.mock.calls[0][0]; f.restartAuthority();
    await f.authority.reconcileReviewAcknowledgement(f.binding.reviewId, 'REVOCATION');
    expect(f.peer.acknowledgeInvalidation.mock.calls[1][0]).toEqual(ack);
    await expect(f.adopt()).rejects.toThrow(); expect(f.reviewState()).toBe('stale');
  });
  it('supersession commits before replacement activation without old reactivation', async () => {
    const f = await setup(true), next = replacement(f); await f.runtime.submit(next);
    expect(f.runtime.status({ reviewId: f.binding.reviewId }).state).toBe('SUPERSESSION_PENDING');
    await f.authority.admitReviewInvalidation(f.binding.reviewId); expect(f.reviewState()).toBe('superseded');
    const evidence = f.runtime.evidence({ reviewId: next.binding.reviewId }).envelope;
    Object.assign(f.hostSnapshot.request.body, { ...next.binding, independentReviewEvidenceHash: evidence.payload.reviewEvidenceHash });
    delete (f.hostSnapshot.request.body as any).reviewId;
    f.hostSnapshot.reviewContext = f.reviewStore.result(next.binding.reviewId).snapshot.context;
    const { actionId, targetId, requestHash, attemptId, attemptHash } = next.binding;
    await f.authority.adoptIndependentReview({ identity: { actionId, targetId, requestHash, attemptId, attemptHash }, evidence });
    expect(f.reviewState()).toBe('superseded');
    expect(f.authorityDb.prepare("SELECT count(*) n FROM reviews WHERE state='current'").get()!.n).toBe(1);
  });
  it.each(['signature', 'sequence-gap', 'wrong-review'])('rejects publication %s', async fault => {
    const f = await setup();
    if (fault === 'signature') f.evidence.signature = Buffer.alloc(64, 3).toString('base64url');
    else f.peer.evidence.mockImplementationOnce(x => {
      const s = structuredClone(f.runtime.evidence(x));
      if (fault === 'sequence-gap') s.history.splice(2, 1); else s.reviewId = randomUUID(); return s;
    });
    await expect(f.adopt()).rejects.toThrow(); expect(f.reviewState()).toBeUndefined(); expect(f.peer.acknowledge).not.toHaveBeenCalled();
  });
});

describe('IR-04 durable readiness / live handoff ordering', () => {
  it('acquires/resolves exact readiness; preserves identity across restart and duplicates', async () => {
    const f = await setup(true), r = reservation(f); expect(f.runtime.reserve(r).state).toBe('HELD');
    f.restartReview(); expect(f.runtime.reserve(r).state).toBe('HELD');
    expect(() => f.runtime.reserve({ ...r, barrierId: randomUUID() })).toThrow('BARRIER_HELD');
    expect(() => f.invalidate()).toThrow('BARRIER_HELD');
    await expect(f.runtime.submit(replacement(f))).rejects.toThrow('BARRIER_HELD');
    const resolution = { reservation: r, resolutionId: randomUUID(), disposition: 'ABANDONED', handoffHash: null };
    expect(f.runtime.resolveBarrier(resolution).state).toBe('RESOLVED');
    expect(f.runtime.resolveBarrier(resolution)).toEqual({ ...resolution, state: 'RESOLVED' });
    expect(() => f.runtime.resolveBarrier({ ...resolution, resolutionId: randomUUID() })).toThrow('RESOLUTION_CONFLICT');
    expect(f.runtime.reserve(r).state).toBe('RESOLVED'); f.invalidate();
  });
  it('held durable reservation does not hold a SQLite writer transaction across remote waiting', async () => {
    const f = await setup(true); f.runtime.reserve(reservation(f));
    const connection = new DatabaseSync(f.reviewFile);
    try { connection.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK'); } finally { connection.close(); }
    expect(() => f.invalidate()).toThrow('BARRIER_HELD');
  });
  it.each(['acquire', 'resolve'])('CT702 unknown %s COMMIT quarantines and exact obligation survives restart', async phase => {
    const f = await setup(true), r = reservation(f);
    const resolution = { reservation: r, resolutionId: randomUUID(), disposition: 'ABANDONED', handoffHash: null };
    if (phase === 'resolve') f.runtime.reserve(r);
    f.reviewFault.afterCommit = () => { throw Error('lost COMMIT'); };
    expect(() => phase === 'acquire' ? f.runtime.reserve(r) : f.runtime.resolveBarrier(resolution)).toThrow('RECONCILE_REQUIRED');
    expect(() => f.runtime.status({ reviewId: f.binding.reviewId })).toThrow('RECONCILE_REQUIRED');
    f.reviewFault.afterCommit = () => {}; f.restartReview();
    expect(f.runtime.reserve(r).state).toBe(phase === 'acquire' ? 'HELD' : 'RESOLVED');
    expect(f.runtime.resolveBarrier(resolution).state).toBe('RESOLVED');
  });
  it.each(['unavailable', 'acquire-response-loss', 'sequence', 'gap', 'identity', 'evidence', 'unknown-state'])('fails closed before consumption: %s', async fault => {
    const f = await setup(true);
    f.peer.reserve.mockImplementationOnce((input: any) => {
      if (fault === 'unavailable') throw Error('offline');
      const response = f.runtime.reserve(input);
      if (fault === 'acquire-response-loss') throw Error('lost');
      if (fault === 'sequence') response.expectedSequence--;
      if (fault === 'gap') response.publicationSequence += 2;
      if (fault === 'identity') response.barrierId = randomUUID();
      if (fault === 'evidence') response.evidenceHash = 'f'.repeat(64);
      if (fault === 'unknown-state') (response as any).state = 'UNKNOWN';
      return response;
    });
    expect((await f.consume()).state).toBe('RECONCILE_REQUIRED'); expect(f.count('consumed_execution_identities')).toBe(0);
    expect(f.executor.execute).not.toHaveBeenCalled(); f.restartAuthority(); f.restartLedger();
    expect((await f.consume()).state).toBe('RECONCILE_REQUIRED'); expect(f.peer.reserve).toHaveBeenCalledTimes(2); // publication + one readiness only
    await f.reconcile(); expect(f.ledger.permit(f.permit.payload.jti)!.state).toBe('RECONCILE_REQUIRED');
    expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it.each(['expectedSequence', 'publicationSequence', 'reviewId', 'materialRoot', 'evidenceHash'])('CT702 rejects wrong reservation %s', async field => {
    const f = await setup(true), r: any = reservation(f);
    r[field] = field.includes('Sequence') ? r[field] + 1 : field === 'reviewId' ? randomUUID() : 'f'.repeat(64);
    expect(() => f.runtime.reserve(r)).toThrow();
  });
  it('pending invalidation blocks new handoff without treating pending as production revocation', async () => {
    const f = await setup(true); f.invalidate(); expect((await f.consume()).state).toBe('RECONCILE_REQUIRED');
    expect(f.reviewState()).toBe('current'); expect(f.count('consumed_execution_identities')).toBe(0); expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it('pending supersession blocks new handoff', async () => {
    const f = await setup(true); await f.runtime.submit(replacement(f));
    expect((await f.consume()).state).toBe('RECONCILE_REQUIRED'); expect(f.count('consumed_execution_identities')).toBe(0); expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it('consume-before-revoke hands off exactly once, then revokes', async () => {
    const f = await setup(true); expect((await f.consume()).executionMayStart).toBe(true);
    expect(f.executor.execute).toHaveBeenCalledOnce(); f.invalidate(); await f.authority.admitReviewInvalidation(f.binding.reviewId);
    expect(f.reviewState()).toBe('stale'); expect(f.count('consumed_execution_identities')).toBe(3); await expect(f.consume()).rejects.toThrow();
  });
  it('barrier release response loss retains durable original resolution and never redispatches', async () => {
    const f = await setup(true); f.peer.resolveBarrier.mockImplementationOnce(x => { f.runtime.resolveBarrier(x); throw Error('lost'); });
    expect((await f.consume()).state).toBe('RECONCILE_REQUIRED'); const resolution = f.peer.resolveBarrier.mock.calls[0][0];
    f.restartAuthority(); f.restartLedger(); f.restartReview(); await f.reconcile();
    expect(f.peer.resolveBarrier.mock.calls[1][0]).toEqual(resolution); expect(f.executor.execute).toHaveBeenCalledOnce();
    expect((await f.consume()).executionMayStart).toBe(false);
  });
  it('handoff ACK loss keeps consumption/token; reconciliation only reads exact custody', async () => {
    const f = await setup(true);
    expect((await f.consume(async h => { await f.bridge.handoff(h); throw Error('lost custody response'); })).state).toBe('RECONCILE_REQUIRED');
    const original = f.ledger.handoffEvidence(f.binding.attemptHash); expect(() => f.invalidate()).toThrow('BARRIER_HELD');
    f.restartAuthority(); f.restartLedger(); f.restartBridge(); await f.reconcile();
    expect(f.ledger.handoffEvidence(f.binding.attemptHash)).toEqual(original); expect(f.executor.execute).toHaveBeenCalledOnce();
    expect((await f.consume()).executionMayStart).toBe(false); expect(f.count('handoffs')).toBe(1);
  });
  it('concurrent consume has one handoff; authority lock excludes independent writer during remote wait', async () => {
    const f = await setup(true), other = new TrustedContextStore({ database: new DatabaseSync(f.authorityFile), ingestor: f.ingestor, reviewPeer: f.peer }); cleanups.push(() => other.close());
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(r => { started = r; }), wait = new Promise<void>(r => { release = r; });
    f.peer.reserve.mockImplementationOnce((async (x: unknown) => { const result = f.runtime.reserve(x); started(); await wait; return result; }) as any);
    const first = f.consume(); await entered;
    await expect(f.consume()).rejects.toThrow('busy');
    await expect(other.admitReviewInvalidation(f.binding.reviewId)).rejects.toThrow(/locked/);
    const workerResult = await new Promise<string>((resolve, reject) => {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite');
        const db=new DatabaseSync(workerData); try {db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');parentPort.postMessage('unexpected');db.exec('ROLLBACK');}
        catch(e){parentPort.postMessage(e.message);}finally{db.close();}`, { eval: true, workerData: f.authorityFile });
      worker.once('message', resolve); worker.once('error', reject);
    });
    expect(workerResult).toMatch(/locked/); release(); expect((await first).executionMayStart).toBe(true);
    f.invalidate(); await other.admitReviewInvalidation(f.binding.reviewId); expect(f.executor.execute).toHaveBeenCalledOnce();
  });
  it('revocation wins a simultaneous admission before consume and consumes nothing', async () => {
    const f = await setup(true); f.invalidate();
    const revoke = f.authority.admitReviewInvalidation(f.binding.reviewId);
    await expect(f.consume()).rejects.toThrow('busy'); await revoke;
    expect(f.count('consumed_execution_identities')).toBe(0); expect(f.executor.execute).not.toHaveBeenCalled();
  });
});
