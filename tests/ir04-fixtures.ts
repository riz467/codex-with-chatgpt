import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { actionBindingFields, canonicalJson, hashTypedActionApproval } from '../src/typed-action-approval/contract.js';
import { ReviewStore } from '../src/review-service/store.js';
import { createReviewRuntime } from '../src/review-service/runtime.js';
import { fixtureProfile } from '../src/review-service/provider.js';
import { TrustedContextStore } from '../src/typed-action-finalizer/trusted-context-storage.js';
import { createTrustedContextProvider } from '../src/typed-action-finalizer/trusted-context.js';
import { TypedActionFinalizerStore } from '../src/typed-action-finalizer/storage.js';
import { createTypedActionPermitSigningKernel } from '../src/typed-action-finalizer/signer.js';
import { ProtectedExecutionBridge } from '../src/protected-execution-bridge/store.js';
import type { Handoff } from '../src/protected-execution-bridge/contract.js';
import { consumeWithReadiness, reconcileExecutionObligation } from '../src/typed-action-finalizer/execution-coordinator.js';
import { fixture, now } from './typed-action-fixtures.js';

export async function ir04Fixture(cleanups: (() => void)[]) {
  const f = fixture(), directory = mkdtempSync(path.join(tmpdir(), 'ir04-'));
  const handles: { close(): void }[] = [];
  cleanups.push(() => { for (const handle of handles.reverse()) { try { handle.close(); } catch { /* already reopened */ } } rmSync(directory, { recursive: true, force: true }); });
  const key = generateKeyPairSync('ed25519'), reviewFile = path.join(directory, 'review.db');
  const reviewFault = { afterCommit: () => {} };
  let reviewStore = new ReviewStore(reviewFile, { initialize: true, afterCommit: () => reviewFault.afterCommit() }); handles.push(reviewStore);
  const composeReview = () => createReviewRuntime({ store: reviewStore, privateKey: key.privateKey, keyId: 'ct702-test',
    now: () => now - 20_000, provider: { profile: fixtureProfile, call: async () => '{"result":"PASS","reason":"offline"}' } });
  let runtime = composeReview();
  const binding = { actionId: f.input.boundRequest.request.actionId, actionKind: 'RestartService' as const,
    targetId: f.input.boundRequest.request.target.id, requestHash: f.input.boundRequest.requestHash,
    attemptId: f.input.boundAttempt.attempt.attemptId, attemptHash: f.input.boundAttempt.attemptHash, attemptSequence: 1, reviewId: randomUUID() };
  const candidate = { binding, files: [
    { path: 'request.json', base64: Buffer.from(canonicalJson(f.input.boundRequest.request)).toString('base64') },
    { path: 'attempt.json', base64: Buffer.from(canonicalJson(f.input.boundAttempt.attempt)).toString('base64') },
    { path: 'evidence.txt', base64: Buffer.from('independent offline fixture evidence').toString('base64') },
  ] };
  await runtime.submit(candidate);
  const evidence = runtime.evidence({ reviewId: binding.reviewId }).envelope;
  f.humanContext.independentReviewEvidenceHash = evidence.payload.reviewEvidenceHash;
  f.input.independentReview.independentReviewEvidenceHash = evidence.payload.reviewEvidenceHash;
  f.input.independentReview.expiresAt = evidence.payload.expiresAt;
  f.input.humanApproval = f.signApproval({ ...f.approval, payload: { ...f.approval.payload, independentReviewEvidenceHash: evidence.payload.reviewEvidenceHash } });
  const request = { ...Object.fromEntries(actionBindingFields.map(k => [k, f.humanContext[k]])), attemptCreatedAt: f.input.boundAttempt.attempt.createdAt };
  const { isCurrent: _c, requestIsCurrent: _r, ...policy } = f.input.policyContext;
  const hostSnapshot = { request: { current: true, body: request }, policy: { current: true, body: policy }, generation: 4,
    reviewContext: reviewStore.result(binding.reviewId).snapshot.context };
  const ingestor = { currentAuthority: () => hostSnapshot, now: () => now, trustedReviewKeys: new Map([['ct702-test', key.publicKey]]), trustedHumanKeys: f.humanKeys };
  const peer = {
    evidence: vi.fn((x: unknown) => runtime.evidence(x)), reserve: vi.fn((x: unknown) => runtime.reserve(x)),
    acknowledge: vi.fn((x: unknown) => runtime.acknowledge(x)), acknowledgeInvalidation: vi.fn((x: unknown) => runtime.acknowledgeInvalidation(x)),
    resolveBarrier: vi.fn((x: unknown) => runtime.resolveBarrier(x)),
  };
  const authorityFile = path.join(directory, 'authority.db'), ledgerFile = path.join(directory, 'ledger.db'), bridgeFile = path.join(directory, 'bridge.db');
  let authorityDb: DatabaseSync, authority: TrustedContextStore, provider: ReturnType<typeof createTrustedContextProvider>;
  const openAuthority = () => {
    authorityDb = new DatabaseSync(authorityFile);
    authority = new TrustedContextStore({ database: authorityDb, ingestor, reviewPeer: peer }); handles.push(authority);
    provider = createTrustedContextProvider({ store: authority, trustedHumanKeys: f.humanKeys, now: () => now, reviewPeer: peer });
  }; openAuthority();
  let ledgerDb: DatabaseSync, ledger: TypedActionFinalizerStore;
  const openLedger = () => { ledgerDb = new DatabaseSync(ledgerFile); ledger = new TypedActionFinalizerStore({ database: ledgerDb, trustedFinalizerKeys: f.finalizerKeys, now: () => now }); handles.push(ledger); }; openLedger();
  const executor = { generation: vi.fn(() => 4), execute: vi.fn(async (_handoff: Readonly<Handoff>) => 'VERIFIED' as const),
    reconcile: vi.fn(async () => ({ terminal: true as const, evidenceHash: 'd'.repeat(64) })) };
  let bridge: ProtectedExecutionBridge;
  const bridgeFault = { afterCommit: () => {} };
  const openBridge = () => { bridge = new ProtectedExecutionBridge({ database: new DatabaseSync(bridgeFile), executor, now: () => now, afterCommit: () => bridgeFault.afterCommit() }); handles.push(bridge); }; openBridge();
  const identity = { actionId: binding.actionId, targetId: binding.targetId, requestHash: binding.requestHash, attemptId: binding.attemptId, attemptHash: binding.attemptHash };
  const contextIdentity = { ...identity, humanApprovalJti: f.input.humanApproval.payload.jti, humanApprovalEvidenceHash: hashTypedActionApproval(f.input.humanApproval) };
  let permit: any;
  const adopt = () => authority.adoptIndependentReview({ identity, evidence });
  const issue = async () => {
    await adopt(); authority.registerHumanApproval({ identity, evidence: f.input.humanApproval });
    return provider.withFence(contextIdentity, async () => {
      const kernel = createTypedActionPermitSigningKernel({ store: ledger, privateKey: f.finalizer.privateKey, finalizerKeyId: 'ct701-test', trustedHumanKeys: f.humanKeys, now: () => now });
      const result = kernel.finalizeAndSignTypedAction({ ...f.input, ...provider.finalization(contextIdentity) });
      if (result.state !== 'VERIFIED_NOT_CONSUMED') throw Error('fixture issuance failed');
      permit = result.envelope; return permit;
    });
  };
  return { ...f, directory, peer, candidate, binding, evidence, identity, contextIdentity, executor, bridgeFault, reviewFault, hostSnapshot, ingestor, authorityFile, ledgerFile, bridgeFile, reviewFile,
    get authority() { return authority; }, get authorityDb() { return authorityDb; }, get ledger() { return ledger; }, get ledgerDb() { return ledgerDb; },
    get runtime() { return runtime; }, get reviewStore() { return reviewStore; }, get provider() { return provider; }, get bridge() { return bridge; }, get permit() { return permit; },
    adopt, issue,
    consume: (handoff = (h: any) => bridge.handoff(h)) => provider.withFence(contextIdentity, () => consumeWithReadiness({ store: ledger, provider, bridge: { handoff } }, permit, contextIdentity)),
    invalidate() { const s = runtime.status({ reviewId: binding.reviewId }); return runtime.invalidate({ reviewId: binding.reviewId, expectedSequence: s.sequence, acknowledgementId: randomUUID() }); },
    reconcile: () => reconcileExecutionObligation({ authority, ledger, peer, custody: (id, hash) => bridge.receipt(id, hash).custody }, permit),
    restartAuthority() { authority.close(); openAuthority(); }, restartLedger() { ledger.close(); openLedger(); }, restartBridge() { bridge.close(); openBridge(); },
    restartReview() { reviewStore.close(); reviewStore = new ReviewStore(reviewFile, { afterCommit: () => reviewFault.afterCommit() }); handles.push(reviewStore); runtime = composeReview(); },
    count: (table: string) => Number(ledgerDb.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
    reviewState: () => authorityDb.prepare('SELECT state FROM reviews WHERE attempt_hash=?').get(binding.attemptHash)?.state,
  };
}
