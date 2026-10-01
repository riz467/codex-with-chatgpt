import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ProtectedExecutionBridge } from '../src/protected-execution-bridge/store.js';
import { hashHandoff, mintLiveHandoff, type Handoff } from '../src/protected-execution-bridge/contract.js';
import { ir04Fixture } from './ir04-fixtures.js';
import { hash } from './typed-action-fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function setup() { const f = await ir04Fixture(cleanups); await f.issue(); return f; }
function next(h: Handoff, token = h.fencingToken + 1): Handoff {
  return { ...h, handoffId: randomUUID(), attemptId: randomUUID(), attemptHash: hash(), fencingToken: token };
}
describe('IR-04 Protected Execution Bridge custody', () => {
  it('acknowledges custody and releases currentness locks while a blocked executor retains the target fence', async () => {
    const f = await setup(); let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const observer = new ProtectedExecutionBridge({ database: new DatabaseSync(f.bridgeFile), executor: f.executor,
      now: () => Date.parse(f.permit.payload.issuedAt) });
    const authority = new DatabaseSync(f.authorityFile); authority.exec('PRAGMA busy_timeout=0');
    f.executor.execute.mockImplementationOnce(async h => {
      // Independent connection sees committed custody before invocation.
      expect(observer.receipt(h.handoffId, hashHandoff(h)).custody.state).toBe('CUSTODY_DURABLE');
      await wait; return 'VERIFIED';
    });
    let acknowledged = false;
    const pending = f.consume().then(result => { acknowledged = result.executionMayStart; return result; });
    try {
      await vi.waitFor(() => expect(acknowledged).toBe(true));
      const h = f.ledger.handoffEvidence(f.binding.attemptHash)!;
      expect(f.count('custody_receipts')).toBe(1);
      expect(f.count('barrier_resolution_acks')).toBe(1);
      expect(f.ledger.barrierResolution(h.barrierId)?.disposition).toBe('CUSTODY');
      authority.exec('BEGIN IMMEDIATE'); authority.exec('COMMIT');
      expect(() => f.invalidate()).not.toThrow();
      expect(observer.receipt(h.handoffId, hashHandoff(h)).outcome).toBe('RECONCILE_REQUIRED');
      await expect(observer.handoff(mintLiveHandoff(next(h)))).rejects.toThrow('TARGET_FENCED');
      await expect(f.bridge.reconcileTarget(h.handoffId, hashHandoff(h))).rejects.toThrow('RECONCILE_REQUIRED');
      await expect(f.bridge.handoff(mintLiveHandoff(h))).rejects.toThrow('PERMANENT_DUPLICATE');
      expect(f.executor.execute).toHaveBeenCalledOnce();
    } finally {
      finish(); await pending;
      const h = f.ledger.handoffEvidence(f.binding.attemptHash)!;
      await vi.waitFor(() => expect(observer.receipt(h.handoffId, hashHandoff(h)).outcome).toBe('VERIFIED'));
      observer.close(); authority.close();
    }
  });
  it('persists all bindings, permanent tombstone, exact receipt; denies cached JSON and replay after restart', async () => {
    const f = await setup(); expect((await f.consume()).executionMayStart).toBe(true);
    const h = f.ledger.handoffEvidence(f.binding.attemptHash)!;
    expect(h).toMatchObject({ ...f.permit.payload, fencingToken: 1 });
    expect(f.bridge.receipt(h.handoffId, hashHandoff(h))).toMatchObject({ outcome: 'VERIFIED', custody: { state: 'CUSTODY_DURABLE' } });
    await expect(f.bridge.handoff(h)).rejects.toThrow('LIVE_HANDOFF_REQUIRED');
    await expect(f.bridge.handoff(mintLiveHandoff(h))).rejects.toThrow('PERMANENT_DUPLICATE');
    f.restartBridge(); await expect(f.bridge.handoff(mintLiveHandoff(h))).rejects.toThrow('PERMANENT_DUPLICATE');
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(() => f.bridge.receipt(h.handoffId, hash())).toThrow('UNKNOWN_HANDOFF');
  });
  it('generation mismatch acquires no custody and never invokes executor', async () => {
    const f = await setup(); f.executor.generation.mockReturnValue(5);
    expect((await f.consume()).state).toBe('RECONCILE_REQUIRED'); expect(f.executor.execute).not.toHaveBeenCalled();
    const h = f.ledger.handoffEvidence(f.binding.attemptHash)!;
    expect(() => f.bridge.receipt(h.handoffId, hashHandoff(h))).toThrow('UNKNOWN_HANDOFF');
    expect(f.count('consumed_execution_identities')).toBe(3); expect((await f.consume()).executionMayStart).toBe(false);
  });
  it('same-target independent connections enforce durable exclusive fence and monotonic high-watermark', async () => {
    const f = await setup(); let finish!: () => void, start!: () => void;
    const entered = new Promise<void>(r => { start = r; }), wait = new Promise<void>(r => { finish = r; });
    f.executor.execute.mockImplementationOnce(async () => { start(); await wait; return 'VERIFIED'; });
    const other = new ProtectedExecutionBridge({ database: new DatabaseSync(f.bridgeFile), executor: f.executor, now: () => Date.parse(f.permit.payload.issuedAt) }); cleanups.push(() => other.close());
    const pending = f.consume(); await entered; const h = f.ledger.handoffEvidence(f.binding.attemptHash)!;
    await expect(other.handoff(mintLiveHandoff(next(h)))).rejects.toThrow('TARGET_FENCED');
    expect(other.receipt(h.handoffId, hashHandoff(h)).outcome).toBe('RECONCILE_REQUIRED');
    expect((await pending).executionMayStart).toBe(true); finish();
    await vi.waitFor(() => expect(other.receipt(h.handoffId, hashHandoff(h)).outcome).toBe('VERIFIED'));
    await expect(other.handoff(mintLiveHandoff(next(h, h.fencingToken)))).rejects.toThrow('TARGET_FENCED');
    await other.handoff(mintLiveHandoff(next(h))); expect(f.executor.execute).toHaveBeenCalledTimes(2);
  });
  it('unknown mutation outcome retains target fence across restart; explicit observation never redispatches', async () => {
    const f = await setup(); f.executor.execute.mockRejectedValueOnce(Error('mutation timeout'));
    expect((await f.consume()).executionMayStart).toBe(true); const h = f.ledger.handoffEvidence(f.binding.attemptHash)!;
    f.restartBridge(); expect(f.bridge.receipt(h.handoffId, hashHandoff(h)).outcome).toBe('RECONCILE_REQUIRED');
    await expect(f.bridge.handoff(mintLiveHandoff(next(h)))).rejects.toThrow('TARGET_FENCED');
    await f.bridge.reconcileTarget(h.handoffId, hashHandoff(h));
    await expect(f.bridge.handoff(mintLiveHandoff(h))).rejects.toThrow('PERMANENT_DUPLICATE');
    expect(f.executor.execute).toHaveBeenCalledOnce(); expect(f.executor.reconcile).toHaveBeenCalledOnce();
  });
  it.each(['before', 'after'])('unknown Bridge COMMIT %s write quarantines without executor invocation', async phase => {
    const f = await setup();
    if (phase === 'after') f.bridgeFault.afterCommit = () => { throw Error('lost COMMIT'); };
    else {
      const original = DatabaseSync.prototype.exec; let fired = false;
      vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        if (!fired && sql === 'COMMIT' && this.prepare('PRAGMA application_id').get()!.application_id === 1413563955) {
          fired = true; throw Error('unknown COMMIT');
        }
        return original.call(this, sql);
      });
    }
    expect((await f.consume()).state).toBe('RECONCILE_REQUIRED'); expect(f.executor.execute).not.toHaveBeenCalled();
    const h = f.ledger.handoffEvidence(f.binding.attemptHash)!;
    expect(() => f.bridge.receipt(h.handoffId, hashHandoff(h))).toThrow('RECONCILE_REQUIRED');
    f.bridgeFault.afterCommit = () => {}; f.restartBridge();
    if (phase === 'after') {
      expect(f.bridge.receipt(h.handoffId, hashHandoff(h)).outcome).toBe('RECONCILE_REQUIRED');
      await expect(f.bridge.handoff(mintLiveHandoff(h))).rejects.toThrow('PERMANENT_DUPLICATE');
      await f.reconcile();
    } else {
      expect(() => f.bridge.receipt(h.handoffId, hashHandoff(h))).toThrow('UNKNOWN_HANDOFF');
      await expect(f.reconcile()).rejects.toThrow('UNKNOWN_HANDOFF');
    }
    expect((await f.consume()).executionMayStart).toBe(false); expect(f.executor.execute).not.toHaveBeenCalled();
  });
  it('production executor defaults deny-all and old schema is rejected without repair', async () => {
    const f = await setup();
    const db = new DatabaseSync(`${f.directory}/denied.db`), denied = new ProtectedExecutionBridge({ database: db }); cleanups.push(() => denied.close());
    expect((await f.consume(h => denied.handoff(h))).state).toBe('RECONCILE_REQUIRED'); expect(f.executor.execute).not.toHaveBeenCalled();
    const malformed = new DatabaseSync(`${f.directory}/old.db`); cleanups.push(() => malformed.close()); malformed.exec('PRAGMA user_version=9');
    expect(() => new ProtectedExecutionBridge({ database: malformed })).toThrow('BRIDGE_SCHEMA_MISMATCH');
    expect(malformed.prepare('PRAGMA user_version').get()!.user_version).toBe(9);
  });
  it.each(['requestHash', 'attemptHash', 'targetId', 'fencingToken', 'handoffId'])('mismatched custody %s keeps barrier and consumption', async field => {
    const f = await setup();
    const result = await f.consume(async h => {
      const r: any = { ...await f.bridge.handoff(h) };
      r[field] = field === 'fencingToken' ? 10 : field.endsWith('Id') ? randomUUID() : hash(); return r;
    });
    expect(result.state).toBe('RECONCILE_REQUIRED'); expect(f.count('consumed_execution_identities')).toBe(3);
    expect(() => f.invalidate()).toThrow('BARRIER_HELD'); expect(f.executor.execute).toHaveBeenCalledOnce();
  });
});
