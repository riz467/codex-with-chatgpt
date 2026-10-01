import { createPublicKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, keyIdSchema, parseStrict, sha256Schema } from '../typed-action-approval/contract.js';
import { hashReviewedEvidence, independentlyVerifiedReviewSchema, reviewInputSchema, type ReviewedEvidence } from '../typed-action-review/contract.js';
import { createIndependentReviewSigningKernel } from '../typed-action-review/signer.js';
import { verifyIndependentReview } from '../typed-action-review/verifier.js';
import { freezeCandidate, hash } from './material.js';
import { boundedReviewer, type Provider } from './provider.js';
import { ReviewStore } from './store.js';

export const lookupSchema = reviewInputSchema.pick({ reviewId: true }).strict();
export const transitionSchema = z.object({ reviewId: reviewInputSchema.shape.reviewId, expectedSequence: z.number().int().positive().safe(),
  acknowledgementId: z.string().uuid() }).strict();
export const invalidationAckSchema = transitionSchema.extend({ intentHash: sha256Schema,
  replacementReviewId: reviewInputSchema.shape.reviewId.nullable() }).strict();
/** Host-owned composition, never exposed as an RPC. Key and provider are captured once. */
export function createReviewRuntime(host: Readonly<{ store: ReviewStore; privateKey: KeyObject; keyId: string; now?: () => number; provider?: Provider }>) {
  const store = host.store, keyId = parseStrict(keyIdSchema, host.keyId), reviewer = boundedReviewer(host.provider);
  const now = host.now ?? Date.now;
  const kernel = createIndependentReviewSigningKernel({ privateKey: host.privateKey, reviewerKeyId: keyId, now,
    independentlyVerifyReview(input) {
      const row = store.row(input.reviewId);
      if (!row || row.binding !== canonicalJson(input) || store.state(row.id) !== 'RESULT_DURABLE') throw Error('NO_DURABLE_RESULT');
      const material = store.material(row);
      const durable = store.result(row.id);
      const snapshot = parseStrict(independentlyVerifiedReviewSchema, durable.snapshot);
      if (snapshot.evidence.reviewBundle.sha256 !== material.root || snapshot.evidence.manifest.sha256 !== material.manifestHash ||
          snapshot.evidence.review.reportSha256 !== hash(canonicalJson(durable.report)) ||
          snapshot.evidence.integrity.reportSha256 !== hash(canonicalJson(durable.integrity))) throw Error('DURABLE_RESULT_TAMPER');
      return snapshot;
    } });
  const keys = new Map([[keyId, createPublicKey(host.privateKey)]]);
  const historicalEnvelope = (id: string) => {
    const envelope = store.signature(id);
    if (!envelope) return null;
    const durable = store.result(id);
    const clock = Date.parse(envelope?.payload?.issuedAt);
    if (!durable || !verifyIndependentReview(envelope, durable.snapshot.context, keys, clock).valid) throw Error('HISTORICAL_SIGNATURE_TAMPER');
    return envelope;
  };
  for (const id of store.reviewIds()) historicalEnvelope(id);
  const status = (input: unknown) => {
    const { reviewId } = parseStrict(lookupSchema, input), row = store.row(reviewId);
    if (!row) throw Error('NOT_FOUND');
    store.material(row);
    const history = store.history(reviewId);
    const last = history.at(-1)!;
    const pendingInvalidation = ['INVALIDATION_PENDING', 'SUPERSESSION_PENDING'].includes(String(last.state))
      ? { kind: last.state, sequence: last.seq, intentHash: hash(last.detail as string),
        replacementReviewId: JSON.parse(last.detail as string).replacementReviewId as string | null } : null;
    return { reviewId, materialRoot: row.root, state: history.at(-1)!.state, sequence: history.at(-1)!.seq,
      result: store.result(reviewId)?.report.result ?? null, pendingInvalidation, history };
  };
  const signDurable = (reviewId: string) => {
    if (store.state(reviewId) !== 'RESULT_DURABLE') return;
    const row = store.row(reviewId)!;
    const result = kernel.reviewAndSign(JSON.parse(row.binding));
    if (result.state !== 'SIGNED') throw Error('SIGNING_REJECTED');
    store.saveSignature(reviewId, result.envelope);
  };
  return Object.freeze({
    async submit(input: unknown) {
      const candidate = freezeCandidate(input);
      const id = candidate.binding.reviewId;
      store.accept(candidate);
      // Never automatically repeat a call whose process may have died mid-review.
      if (store.state(id) === 'REVIEW_RUNNING') throw Error('RECONCILE_REQUIRED');
      if (store.state(id) === 'MATERIAL_FIXED') {
        store.mutate(() => store.event(id, 'REVIEW_RUNNING'));
        const material = store.material(store.row(id)!);
        const computed = await reviewer(material);
        if (store.state(id) !== 'REVIEW_RUNNING') return status({ reviewId: id });
        const chronology = store.history(id);
        const report = { ...computed, reviewId: id, materialRoot: material.root,
          materialFixedSequence: chronology.find(e => e.state === 'MATERIAL_FIXED')!.seq,
          reviewRunningSequence: chronology.find(e => e.state === 'REVIEW_RUNNING')!.seq };
        const integrity = { version: 1, root: material.root, manifestHash: material.manifestHash, result: 'VERIFIED' };
        const evidence: ReviewedEvidence = { schemaVersion: 1, type: 'AI_WORKSPACE_TYPED_ACTION_REVIEWED_EVIDENCE', ...material.binding,
          reviewBundle: { sha256: material.root }, manifest: { sha256: material.manifestHash },
          integrity: { result: 'VERIFIED', reportSha256: hash(canonicalJson(integrity)) },
          review: { result: report.result, reportSha256: hash(canonicalJson(report)) } };
        const evidenceHash = hashReviewedEvidence(evidence);
        const snapshot = { evidence, context: { ...material.binding, expectedReviewEvidenceHash: evidenceHash,
          expectedBundleManifestSha256: material.manifestHash, expectedReviewerKeyId: keyId, expectedResult: report.result,
          // Kernel-local snapshot consistency only; never returned as production currentness.
          currentReviewId: id, reviewIsCurrent: true, bundleIntegrityVerified: true } };
        store.saveResult(id, { report, integrity, snapshot }, evidenceHash);
      }
      signDurable(id);
      return status({ reviewId: id });
    },
    status,
    evidence(input: unknown) {
      const s = status(input), envelope = historicalEnvelope(s.reviewId);
      return { ...s, envelope: envelope ?? null };
    },
    acknowledge(input: unknown) {
      const t = parseStrict(transitionSchema, input);
      store.mutate(() => {
        const history = store.history(t.reviewId), last = history.at(-1);
        const detail = canonicalJson(t);
        if (last?.state === 'PUBLICATION_ACKNOWLEDGED' && last.detail === detail) return;
        if (last?.seq !== t.expectedSequence || last.state !== 'SIGNED_PENDING_PUBLICATION') throw Error('STALE_PUBLICATION_ACK');
        store.event(t.reviewId, 'PUBLICATION_ACKNOWLEDGED', detail, t.acknowledgementId);
      });
      return status({ reviewId: t.reviewId });
    },
    invalidate(input: unknown) {
      const t = parseStrict(transitionSchema, input);
      store.mutate(() => {
        const history = store.history(t.reviewId), last = history.at(-1), detail = canonicalJson({ ...t, replacementReviewId: null });
        // Reconcile the original intent even if its exact acknowledgement has
        // since committed. No event is rewritten and no state is reactivated.
        if (history.some(e => ['INVALIDATION_PENDING', 'INVALIDATED'].includes(String(e.state)) && e.detail === detail)) return;
        if (last?.seq !== t.expectedSequence || ['INVALIDATED', 'SUPERSEDED', 'INVALIDATION_PENDING', 'SUPERSESSION_PENDING'].includes(String(last.state))) throw Error('STALE_INVALIDATION');
        store.event(t.reviewId, last.state === 'PUBLICATION_ACKNOWLEDGED' ? 'INVALIDATION_PENDING' : 'INVALIDATED', detail, t.acknowledgementId);
      });
      return status({ reviewId: t.reviewId });
    },
    // Only a future CT701-authenticated peer receives this capability. This is
    // an exact durable-admission receipt, never a local currentness decision.
    acknowledgeInvalidation(input: unknown) {
      const t = parseStrict(invalidationAckSchema, input);
      store.mutate(() => {
        const history = store.history(t.reviewId), last = history.at(-1);
        const pending = history.find(e => e.seq === t.expectedSequence && ['INVALIDATION_PENDING', 'SUPERSESSION_PENDING'].includes(String(e.state)));
        if (!pending || hash(pending.detail as string) !== t.intentHash ||
            JSON.parse(pending.detail as string).replacementReviewId !== t.replacementReviewId) throw Error('STALE_INVALIDATION_ACK');
        const terminal = pending.state === 'SUPERSESSION_PENDING' ? 'SUPERSEDED' : 'INVALIDATED';
        const detail = canonicalJson({ ...t, intent: pending.detail });
        if (last?.state === terminal && last.detail === detail) return;
        if (last?.seq !== t.expectedSequence || last.state !== pending.state) throw Error('STALE_INVALIDATION_ACK');
        store.event(t.reviewId, terminal, detail, t.acknowledgementId);
      });
      return status({ reviewId: t.reviewId });
    },
  });
}
export type ReviewRuntime = ReturnType<typeof createReviewRuntime>;
