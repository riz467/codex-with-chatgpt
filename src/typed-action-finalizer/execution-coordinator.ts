import { randomUUID } from 'node:crypto';
import { canonicalJson, immutable, parseStrict } from '../typed-action-approval/contract.js';
import { hashHandoff, verifyCustody } from '../protected-execution-bridge/contract.js';
import type { SignedExecutionPermit } from './contract.js';
import type { ContextIdentity, TrustedContextProvider, IsolatedExecutionBridge } from './server.js';
import { LedgerOutcomeUnknownError, type TypedActionFinalizerStore } from './storage.js';
import { checkReservation } from './coordination-validation.js';
import { reservationSchema, type ReviewCoordinatorPeer } from '../review-service/coordination.js';
import type { TrustedContextStore } from './trusted-context-storage.js';

/** Caller MUST already own provider.withFence: authority first, ledger second.
 * No finally/timeout release: a lost remote response retains its obligation. */
export async function consumeWithReadiness(host: {
  store: TypedActionFinalizerStore; provider: TrustedContextProvider; bridge: IsolatedExecutionBridge;
}, envelope: SignedExecutionPermit, identity: ContextIdentity) {
  const { store, provider, bridge } = host;
  if (!provider.readiness || !provider.acquireReadiness || !provider.resolveReadiness) throw Error('READINESS_UNAVAILABLE');
  const reservation = immutable(parseStrict(reservationSchema, provider.readiness(identity, randomUUID())));
  const ids = { permitJti: envelope.payload.jti, attemptHash: envelope.payload.attemptHash };
  let consumed = false;
  try {
    store.beginReadiness(ids, reservation);
    checkReservation(await provider.acquireReadiness(reservation), reservation);
    const result = await store.consumeForHandoff(envelope, () => provider.execution(identity));
    consumed = result.decision.executionMayStart;
    if (!result.handoff) return result.decision;
    const receipt = verifyCustody(await bridge.handoff(result.handoff), result.handoff);
    store.recordCustody(result.handoff, receipt);
    const resolution = immutable({ reservation, resolutionId: randomUUID(), disposition: 'CUSTODY' as const, handoffHash: hashHandoff(result.handoff) });
    store.recordBarrierResolution(resolution);
    if (canonicalJson(await provider.resolveReadiness(resolution)) !== canonicalJson({ ...resolution, state: 'RESOLVED' })) throw Error('RESOLUTION_ACK_MISMATCH');
    store.acknowledgeBarrierResolution(reservation.barrierId);
    return result.decision;
  } catch (error) {
    if (error instanceof LedgerOutcomeUnknownError) throw error;
    if (consumed) {
      try { store.recordConsumedReconciliation(ids, 'MUTATION_INDETERMINATE'); }
      catch { throw new LedgerOutcomeUnknownError(ids, false); }
    }
    return { state: 'RECONCILE_REQUIRED' as const, executionMayStart: false as const };
  }
}

/** Explicit recovery under the authority fence. Only repeats an exact durable
 * resolution; never consumes, allocates a token, mints a live object or dispatches. */
export async function reconcileBarrierResolution(store: TypedActionFinalizerStore, provider: TrustedContextProvider, barrierId: string) {
  const resolution = store.barrierResolution(barrierId);
  if (!resolution || !provider.resolveReadiness) throw Error('RECONCILE_REQUIRED');
  if (canonicalJson(await provider.resolveReadiness(resolution)) !== canonicalJson({ ...resolution, state: 'RESOLVED' })) throw Error('RESOLUTION_ACK_MISMATCH');
  store.acknowledgeBarrierResolution(barrierId);
}

/** Host-only, explicit restart/partition investigation. Revoked/expired authority
 * does not prevent closing historical obligations. There is no mutation retry. */
export async function reconcileExecutionObligation(host: {
  authority: TrustedContextStore; ledger: TypedActionFinalizerStore; peer: ReviewCoordinatorPeer;
  custody(handoffId: string, handoffHash: string): unknown | Promise<unknown>;
}, envelope: SignedExecutionPermit) {
  return host.authority.withFence(async () => {
    const { ledger, peer } = host, p = envelope.payload;
    const reservation = ledger.barrierObligation(p.attemptHash);
    if (!reservation) throw Error('NO_BARRIER_OBLIGATION');
    let resolution = ledger.barrierResolution(reservation.barrierId);
    if (!resolution) {
      const h = ledger.handoffEvidence(p.attemptHash);
      if (h) {
        // Read-only lookup, never bridge.handoff().
        ledger.recordCustody(h, await host.custody(h.handoffId, hashHandoff(h)));
        resolution = { reservation, resolutionId: randomUUID(), disposition: 'CUSTODY', handoffHash: hashHandoff(h) };
      } else {
        // May create only the EXACT original reservation if its first request
        // never arrived. Quarantine the permit before abandonment is durable.
        checkReservation(await peer.reserve(reservation), reservation);
        ledger.recordReconciliation({ permitJti: p.jti, attemptHash: p.attemptHash }, 'GATE_RECHECK_FAILED');
        resolution = { reservation, resolutionId: randomUUID(), disposition: 'ABANDONED', handoffHash: null };
      }
      ledger.recordBarrierResolution(resolution);
    }
    resolution = immutable(resolution);
    if (canonicalJson(await peer.resolveBarrier(resolution)) !== canonicalJson({ ...resolution, state: 'RESOLVED' })) throw Error('RESOLUTION_ACK_MISMATCH');
    ledger.acknowledgeBarrierResolution(reservation.barrierId);
  });
}
