import { z } from "zod";
import { canonicalJson } from "../task-contract/contract.js";
import { nativeHash, nativeBlocked } from "./native-admission.js";
import { nativeWorkerInputSchema, type NativeWorkerInput } from "./native-worker.js";

export const FIXED_NATIVE_PROPOSER_INSTRUCTION = "HOST FIXED COUNTER_JSON_V1. Produce JSON DATA only, no tools, commands, code, authorization or approvals. Return the exact response schema from the host envelope. Change counter 0 to counter 1. No additional fields or prose.";
export const FIXED_NATIVE_REVIEWER_INSTRUCTION = "HOST INDEPENDENT COUNTER_JSON_V1 REVIEW. Evaluate the complete before/after DATA against the human criterion: the sole counter changes from 0 to 1 with no additional fields. Return PASS only when that criterion is met, otherwise NEEDS_WORK. No tools, code, commands, authorization or approvals. Return only the exact JSON response schema from the host envelope. This is advisory semantic review, not FAST or arbitrary-code isolation evidence.";

/** Public fixed DATA preparation, not an authenticated worker or transport permit. */
export function prepareFixedNativeData(input: unknown) {
  const i = nativeWorkerInputSchema.parse(input), inputDigest = nativeHash(canonicalJson(i));
  const response = { version: 1, taskId: i.taskId, role: i.role, inputDigest,
    ...(i.role === "proposer" ? { proposal: { counter: 1 } } : { review: "PASS_OR_NEEDS_WORK" }) };
  return { input: i, inputDigest, system: i.role === "proposer" ? FIXED_NATIVE_PROPOSER_INSTRUCTION : FIXED_NATIVE_REVIEWER_INSTRUCTION,
    user: canonicalJson({ domain: "HOST_FIXED_COUNTER_DATA_V1", goal: "Change the sole JSON counter from 0 to 1",
      before: i.request, after: i.candidate, responseSchema: response, fastOsProof: "NOT_CLAIMED", authority: "NONE" }) };
}
export function parseFixedNativeResponse(input: NativeWorkerInput, text: string) {
  try {
    if (Buffer.byteLength(text, "utf8") > 4096) throw nativeBlocked();
    const p = prepareFixedNativeData(input);
    const base = z.object({ version: z.literal(1), taskId: z.literal(input.taskId), role: z.literal(input.role), inputDigest: z.literal(p.inputDigest) });
    return input.role === "proposer" ? base.extend({ proposal: z.object({ counter: z.literal(1) }).strict() }).strict().parse(JSON.parse(text)) :
      base.extend({ review: z.enum(["PASS", "NEEDS_WORK"]) }).strict().parse(JSON.parse(text));
  } catch { throw nativeBlocked(); }
}
