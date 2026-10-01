import { z } from 'zod';
import { idSchema, sha256Schema } from '../typed-action-approval/contract.js';

const sequence = z.number().int().positive().safe();
export const reservationSchema = z.object({
  reviewId: idSchema, expectedSequence: sequence, publicationSequence: sequence,
  materialRoot: sha256Schema, evidenceHash: sha256Schema, barrierId: z.string().uuid(),
  kind: z.enum(['PUBLICATION', 'READINESS']),
}).strict();
export type ReviewReservation = z.infer<typeof reservationSchema>;
export const reservationReceiptSchema = reservationSchema.extend({
  state: z.enum(['HELD', 'RESOLVED']), pendingInvalidation: z.null(),
}).strict();
export type ReservationReceipt = z.infer<typeof reservationReceiptSchema>;
export const resolutionSchema = z.object({ reservation: reservationSchema,
  resolutionId: z.string().uuid(), disposition: z.enum(['CUSTODY', 'ABANDONED']),
  handoffHash: sha256Schema.nullable(),
}).strict();
export type BarrierResolution = z.infer<typeof resolutionSchema>;
/** Installed by the host. No HTTP header, address or per-request dependency is authority. */
export interface ReviewCoordinatorPeer {
  evidence(input: unknown): unknown | Promise<unknown>;
  reserve(input: unknown): unknown | Promise<unknown>;
  resolveBarrier(input: unknown): unknown | Promise<unknown>;
  acknowledge(input: unknown): unknown | Promise<unknown>;
  acknowledgeInvalidation(input: unknown): unknown | Promise<unknown>;
}
