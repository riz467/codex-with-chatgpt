import { z } from 'zod';
import { domainHash, immutable, parseStrict, sha256Schema } from '../typed-action-approval/contract.js';
import { executionPermitPayloadSchema } from '../typed-action-finalizer/contract.js';

export const handoffSchema = executionPermitPayloadSchema.extend({
  handoffId: z.string().uuid(), barrierId: z.string().uuid(), fencingToken: z.number().int().positive().safe(),
  permitEvidenceHash: sha256Schema,
}).strict();
export type Handoff = z.infer<typeof handoffSchema>;
export const custodyReceiptSchema = z.object({
  handoffId: z.string().uuid(), handoffHash: sha256Schema, attemptHash: sha256Schema,
  targetId: z.string().uuid(), fencingToken: z.number().int().positive().safe(), state: z.literal('CUSTODY_DURABLE'),
}).strict();
export type CustodyReceipt = z.infer<typeof custodyReceiptSchema>;
export const hashHandoff = (value: Handoff) => domainHash('PROTECTED_EXECUTION_HANDOFF_V1', parseStrict(handoffSchema, value));
const live = new WeakSet<object>();
/** Internal host composition seam. The ledger calls this only after a known COMMIT.
 * Wire JSON, stored evidence and receipt retrieval never call this constructor. */
export function mintLiveHandoff(value: Handoff): Readonly<Handoff> {
  const result = immutable(parseStrict(handoffSchema, value)); live.add(result); return result;
}
export function claimLiveHandoff(value: Readonly<Handoff>): Handoff {
  if (!live.delete(value)) throw Error('LIVE_HANDOFF_REQUIRED');
  return parseStrict(handoffSchema, value);
}
export function verifyCustody(input: unknown, handoff: Handoff): CustodyReceipt {
  const receipt = parseStrict(custodyReceiptSchema, input);
  if (receipt.handoffId !== handoff.handoffId || receipt.handoffHash !== hashHandoff(handoff) ||
    receipt.attemptHash !== handoff.attemptHash || receipt.targetId !== handoff.targetId || receipt.fencingToken !== handoff.fencingToken) throw Error('CUSTODY_RECEIPT_MISMATCH');
  return receipt;
}
