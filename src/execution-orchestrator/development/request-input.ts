import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, freeze, parseStrict } from "../../task-contract/contract.js";
import { validateBinding } from "./contract.js";

export const GOAL_INPUT_DOMAIN = "RC02_DEVELOPMENT_V2_GOAL_INPUT_V1";
export const ACCEPTANCE_INPUT_DOMAIN = "RC02_DEVELOPMENT_V2_ACCEPTANCE_INPUT_V1";

// Limits are UTF-16 code units, not locale-dependent characters. No trimming,
// newline conversion, Unicode normalization, or item sorting is performed.
export const developmentGoalInputSchema = z.object({
  version: z.literal(1), text: z.string().min(1).max(32768),
}).strict();
export const developmentAcceptanceInputSchema = z.object({
  version: z.literal(1), items: z.array(z.string().min(1).max(4096)).min(1).max(64),
}).strict();
const rawInputSchema = z.object({
  goal: developmentGoalInputSchema, acceptanceCriteria: developmentAcceptanceInputSchema,
}).strict();
const hash = (domain: string, input: unknown) => createHash("sha256")
  .update(`${domain}\n${canonicalJson(input)}`, "utf8").digest("hex");

export function hashDevelopmentGoal(input: unknown): string {
  return hash(GOAL_INPUT_DOMAIN, parseStrict(developmentGoalInputSchema, input));
}

export function hashDevelopmentAcceptanceCriteria(input: unknown): string {
  return hash(ACCEPTANCE_INPUT_DOMAIN, parseStrict(developmentAcceptanceInputSchema, input));
}

/** hostExpected must originate independently from protected host input.
 * Content identity authenticates neither that source nor authority. The existing
 * request wire/hash domain is unchanged; inputSnapshotDigest is not interpreted.
 */
export function validateRequestInputs(rawInput: unknown, bindingInput: unknown, hostExpected: unknown) {
  const { binding } = validateBinding(bindingInput, hostExpected);
  const inputs = parseStrict(rawInputSchema, rawInput);
  if (hashDevelopmentGoal(inputs.goal) !== binding.request.goalDigest)
    throw new Error("Development goal digest mismatch");
  if (hashDevelopmentAcceptanceCriteria(inputs.acceptanceCriteria) !== binding.request.acceptanceCriteriaDigest)
    throw new Error("Development acceptance criteria digest mismatch");
  return freeze({ kind: "REQUEST_INPUT_BINDING_ONLY" as const, inputs, binding });
}

declare const requestInputBrand: unique symbol;
export interface RequestInputHandle {
  readonly kind: "REQUEST_INPUT_HANDLE_ONLY";
  readonly [requestInputBrand]: true;
}
const prepared = new WeakMap<RequestInputHandle, ReturnType<typeof validateRequestInputs>>();

/** Process-local identity only, never approval, authorization, or a dispatch
 * permit. No serialization/recovery API exists. After loss, a future trusted
 * host must explicitly revalidate its durably stored ORIGINAL human request;
 * persistence and post-dispatch unknown outcomes are outside this contract.
 */
export function prepareRequestInputHandle(rawInput: unknown, bindingInput: unknown, hostExpected: unknown): RequestInputHandle {
  const validated = validateRequestInputs(rawInput, bindingInput, hostExpected);
  const handle = Object.freeze({ kind: "REQUEST_INPUT_HANDLE_ONLY" as const }) as RequestInputHandle;
  prepared.set(handle, validated);
  return handle;
}

/** Consumers must inspect the actual handle against their independently bound
 * attempt. A kind string, cloned object, or truthy handle proves no authority.
 */
export function inspectRequestInputHandle(handle: unknown, bindingInput: unknown, hostExpected: unknown) {
  if (typeof handle !== "object" || handle === null) throw new Error("Unrecognized request input handle");
  const validated = prepared.get(handle as RequestInputHandle);
  if (!validated) throw new Error("Unrecognized request input handle");
  const { binding } = validateBinding(bindingInput, hostExpected);
  if (canonicalJson(validated.binding) !== canonicalJson(binding)) throw new Error("Request input handle binding mismatch");
  return validated;
}
