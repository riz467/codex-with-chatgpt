import { z } from 'zod';
import { canonicalJson, idSchema, parseStrict, sha256Schema } from '../typed-action-approval/contract.js';
import { signedIndependentReviewSchema } from '../typed-action-review/contract.js';
import { reservationReceiptSchema, type ReviewReservation } from '../review-service/coordination.js';

export const reviewStatusSchema = z.object({
  reviewId: idSchema, materialRoot: sha256Schema, state: z.string(), sequence: z.number().int().positive().safe(),
  result: z.enum(['PASS', 'FAIL', 'NEEDS_WORK']).nullable(),
  pendingInvalidation: z.object({ kind: z.enum(['INVALIDATION_PENDING', 'SUPERSESSION_PENDING']),
    sequence: z.number().int().positive().safe(), intentHash: sha256Schema, replacementReviewId: idSchema.nullable() }).strict().nullable(),
  history: z.array(z.object({ seq: z.number().int().positive().safe(), state: z.string(), detail: z.string() }).strict()).max(9),
}).strict();
export const reviewEvidenceSchema = reviewStatusSchema.extend({ envelope: signedIndependentReviewSchema.nullable() }).strict();
export function checkHistory(s: z.infer<typeof reviewStatusSchema>) {
  if (!s.history.length || s.history.at(-1)!.seq !== s.sequence || s.history.at(-1)!.state !== s.state ||
    s.history.some((e, i) => i > 0 && e.seq <= s.history[i - 1].seq)) throw Error('SEQUENCE_GAP');
  const prefix = ['REVIEW_PENDING', 'MATERIAL_FIXED', 'REVIEW_RUNNING', 'RESULT_DURABLE', 'SIGNED_PENDING_PUBLICATION'];
  if (prefix.some((state, i) => s.history[i]?.state !== state)) throw Error('CHRONOLOGY_MISMATCH');
}
export function checkReservation(input: unknown, expected: ReviewReservation) {
  const receipt = parseStrict(reservationReceiptSchema, input);
  if (canonicalJson(receipt) !== canonicalJson({ ...expected, state: 'HELD', pendingInvalidation: null })) throw Error('READINESS_REJECTED');
  return receipt;
}
