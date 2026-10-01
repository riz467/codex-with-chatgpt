// Disposable offline fixture, never shipped in the production runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

let networkAttempts = 0;
const deny = () => { networkAttempts++; throw Error('NETWORK_FORBIDDEN'); };
net.Socket.prototype.connect = deny; net.Server.prototype.listen = deny;
dns.lookup = deny; dns.resolve = deny; dgram.createSocket = deny; globalThis.fetch = deny;
syncBuiltinESMExports();
const { verifyPackage, sha256 } = await import('./package/ct702-package-integrity.mjs');
const root = path.resolve('package'), expected = process.argv[2];
const manifest = verifyPackage(root, expected);
const { ReviewStore } = await import('./package/runtime/review-service/store.js');
const { createReviewRuntime } = await import('./package/runtime/review-service/runtime.js');
const { fixtureProfile } = await import('./package/runtime/review-service/provider.js');
const { canonicalJson } = await import('./package/runtime/typed-action-approval/contract.js');
const { hashActionRequest, bindActionAttempt } = await import('./package/runtime/mcp/typed-actions.js');
const { verifyIndependentReview } = await import('./package/runtime/typed-action-review/verifier.js');
const sourceRequest = { schemaVersion: 1, actionId: randomUUID(), kind: 'RestartService', target: { kind: 'service', id: randomUUID() },
  preconditions: { targetGeneration: 1, policySha256: 'a'.repeat(64), maintenanceWindowId: randomUUID(), recheck: 'immediately-before-mutation-under-exclusive-fence' },
  timeout: { preflightMs: 1000, executionMs: 60000, verificationMs: 1000, onExpiry: 'stop-and-reconcile' },
  rollback: { mode: 'none', onFailure: 'block-and-reconcile' }, retry: { automaticMutationRetries: 0, recovery: 'new-request-fresh-preflight-and-new-approval' },
  retryOf: null, risk: 'elevated', approval: { human: 'required', independentReview: 'required', binding: 'request-hash-and-attempt', destructive: 'not-applicable', reboot: 'not-applicable' },
  reboot: 'forbidden', expected: { generation: 1, serviceState: 'running', configurationSha256: 'b'.repeat(64) }, desired: { serviceState: 'running' } };
const requestBytes = canonicalJson(sourceRequest), requestHash = hashActionRequest(sourceRequest);
const attempt = { schemaVersion: 1, actionId: sourceRequest.actionId, attemptId: randomUUID(), sequence: 1, requestHash,
  createdAt: '2026-10-01T00:00:00.000Z', approvalIdentity: 'typed-action-attempt-sha256-v1' }, attemptBytes = canonicalJson(attempt);
const input = { binding: { actionId: sourceRequest.actionId, actionKind: sourceRequest.kind, targetId: sourceRequest.target.id,
  requestHash, attemptId: attempt.attemptId, attemptSequence: attempt.sequence, attemptHash: bindActionAttempt(attempt, sourceRequest).attemptHash, reviewId: randomUUID() },
  files: [['request.json', requestBytes], ['attempt.json', attemptBytes], ['evidence.txt', 'offline fixture']].map(([path, text]) => ({ path, base64: Buffer.from(text).toString('base64') })) };
const key = generateKeyPairSync('ed25519'); // Ephemeral fixture-only key; never exported.
const file = path.resolve('fixture.db');
let store = new ReviewStore(file, { initialize: true });
const host = () => ({ store, privateKey: key.privateKey, keyId: 'fixture', provider: { profile: fixtureProfile,
  call: async () => '{"result":"PASS","reason":"deterministic offline fixture"}' } });
try {
  let runtime = createReviewRuntime(host());
  const pending = await runtime.submit(input), id = { reviewId: input.binding.reviewId };
  assert.equal(pending.state, 'SIGNED_PENDING_PUBLICATION'); assert.equal(pending.result, 'PASS');
  const signed = runtime.evidence(id);
  assert.equal(verifyIndependentReview(signed.envelope, store.result(id.reviewId).snapshot.context, new Map([['fixture', key.publicKey]]), Date.now()).valid, true);
  store.close(); store = new ReviewStore(file); runtime = createReviewRuntime(host());
  assert.deepEqual(runtime.evidence(id), signed); assert.deepEqual(await runtime.submit(input), pending);
  const ack = runtime.acknowledge({ ...id, expectedSequence: pending.sequence, acknowledgementId: randomUUID() });
  const invalid = runtime.invalidate({ ...id, expectedSequence: ack.sequence, acknowledgementId: randomUUID() });
  assert.equal(invalid.state, 'INVALIDATION_PENDING');
  store.close(); store = new ReviewStore(file); runtime = createReviewRuntime(host());
  assert.deepEqual(await runtime.submit(input), invalid);
  const receipt = { ...id, expectedSequence: invalid.sequence, intentHash: invalid.pendingInvalidation.intentHash,
    replacementReviewId: null, acknowledgementId: randomUUID() };
  assert.throws(() => runtime.acknowledgeInvalidation({ ...receipt, expectedSequence: ack.sequence }), /STALE_INVALIDATION_ACK/);
  const terminal = runtime.acknowledgeInvalidation(receipt);
  assert.equal(terminal.state, 'INVALIDATED');
  store.close(); store = new ReviewStore(file); runtime = createReviewRuntime(host());
  assert.deepEqual(runtime.acknowledgeInvalidation(receipt), terminal);
  assert.deepEqual(await runtime.submit(input), terminal);
  assert.equal(runtime.evidence(id).envelope.signature, signed.envelope.signature);
  function replacement(previous) {
    const source = JSON.parse(Buffer.from(previous.files[0].base64, 'base64').toString('utf8'));
    source.actionId = randomUUID();
    source.retryOf = { actionId: previous.binding.actionId, requestHash: previous.binding.requestHash,
      receiptHash: 'c'.repeat(64), attemptId: previous.binding.attemptId, attemptHash: previous.binding.attemptHash,
      attemptSequence: previous.binding.attemptSequence };
    const requestHash = hashActionRequest(source);
    const attempt = { schemaVersion: 1, actionId: source.actionId, attemptId: randomUUID(), sequence: previous.binding.attemptSequence + 1,
      requestHash, createdAt: '2026-10-01T00:00:00.000Z', approvalIdentity: 'typed-action-attempt-sha256-v1' };
    return { binding: { actionId: source.actionId, actionKind: source.kind, targetId: source.target.id, requestHash,
      attemptId: attempt.attemptId, attemptSequence: attempt.sequence, attemptHash: bindActionAttempt(attempt, source).attemptHash, reviewId: randomUUID() },
      files: [['request.json', canonicalJson(source)], ['attempt.json', canonicalJson(attempt)], ['evidence.txt', 'replacement fixture']]
        .map(([path, text]) => ({ path, base64: Buffer.from(text).toString('base64') })) };
  }
  const second = replacement(input), secondSigned = await runtime.submit(second);
  runtime.acknowledge({ reviewId: second.binding.reviewId, expectedSequence: secondSigned.sequence, acknowledgementId: randomUUID() });
  const third = replacement(second), thirdSigned = await runtime.submit(third);
  const secondId = { reviewId: second.binding.reviewId }, supersession = runtime.status(secondId);
  assert.equal(supersession.state, 'SUPERSESSION_PENDING');
  runtime.acknowledge({ reviewId: third.binding.reviewId, expectedSequence: thirdSigned.sequence, acknowledgementId: randomUUID() });
  store.close(); store = new ReviewStore(file); runtime = createReviewRuntime(host());
  assert.deepEqual(runtime.status(secondId), supersession);
  const supersessionReceipt = { ...secondId, expectedSequence: supersession.sequence,
    intentHash: supersession.pendingInvalidation.intentHash, replacementReviewId: third.binding.reviewId, acknowledgementId: randomUUID() };
  assert.throws(() => runtime.acknowledgeInvalidation({ ...supersessionReceipt, replacementReviewId: null }), /STALE_INVALIDATION_ACK/);
  const superseded = runtime.acknowledgeInvalidation(supersessionReceipt);
  assert.equal(superseded.state, 'SUPERSEDED');
  assert.deepEqual(runtime.acknowledgeInvalidation(supersessionReceipt), superseded);
  assert.deepEqual(await runtime.submit(second), superseded);
  const target = path.join(root, 'runtime/review-service/runtime.js'), original = fs.readFileSync(target);
  fs.unlinkSync(target); assert.throws(() => verifyPackage(root, expected), /INVENTORY/);
  fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\n// tamper')])); assert.throws(() => verifyPackage(root, expected), /INVENTORY/);
  fs.writeFileSync(target, original);
  const manifestPath = path.join(root, 'manifest.json'), raw = fs.readFileSync(manifestPath);
  fs.appendFileSync(manifestPath, '\n'); assert.throws(() => verifyPackage(root, expected), /MANIFEST_HASH/);
  fs.writeFileSync(manifestPath, raw); verifyPackage(root, expected);
  assert.equal(networkAttempts, 0);
  console.log(`CT702 clean-room PASS: ${Object.keys(manifest.files).length} files; load/freeze/sign/verify/restart/publication-ack/pending-invalidation/pending-supersession/exact-CT701-ack/idempotency/missing/tamper/manifest; external network=0`);
} finally { store.close(); }
