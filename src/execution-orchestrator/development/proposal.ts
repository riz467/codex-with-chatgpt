import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, digestSchema, exactScopeSchema, freeze, parseStrict, scopePathSchema }
  from "../../task-contract/contract.js";
import { validateBinding } from "./contract.js";

export const PROPOSAL_DOMAIN = "RC02_DEVELOPMENT_V2_PROPOSAL_V1";
export const MAX_PROPOSAL_BYTES = 256 * 1024;
// Whole-file replacements only. These are inert UTF-8 data, never executable
// operations. Deletion, rename, patches, commands, and execution metadata have
// no representation in this phase.
const bodySchema = z.object({
  domain: z.literal(PROPOSAL_DOMAIN), attemptDigest: digestSchema,
  candidateId: z.string(), sessionId: z.string(), executionId: z.string(),
  scope: exactScopeSchema,
  files: z.array(z.object({ path: scopePathSchema, operation: z.literal("REPLACE_UTF8"),
    content: z.string().max(MAX_PROPOSAL_BYTES) }).strict()).max(20),
}).strict();
const proposalSchema = bodySchema.extend({ proposalDigest: digestSchema }).strict();

/** Content identity only. No authority and no mutation. */
export function hashProposal(input: unknown): string {
  const body = parseStrict(bodySchema, input);
  return createHash("sha256").update(`${PROPOSAL_DOMAIN}\n${canonicalJson(body)}`, "utf8").digest("hex");
}

/** Require canonical JSON on the wire. In addition to prose/trailing data this
 * rejects duplicate JSON keys (which JSON.parse alone silently discards).
 */
export function parseProposal(text: unknown, bindingInput: unknown, hostExpected: unknown) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_PROPOSAL_BYTES)
    throw new Error("Proposal response size/type rejected");
  const { binding: b } = validateBinding(bindingInput, hostExpected);
  const p = parseStrict(proposalSchema, JSON.parse(text));
  if (canonicalJson(p) !== text) throw new Error("Proposal must be canonical strict JSON");
  const { proposalDigest, ...body } = p;
  if (hashProposal(body) !== proposalDigest || p.attemptDigest !== b.attempt.digest ||
    p.candidateId !== b.attempt.candidateId || p.sessionId !== b.attempt.sessionId ||
    p.executionId !== b.attempt.executionId || canonicalJson(p.scope) !== canonicalJson(b.delegation.scope))
    throw new Error("Proposal binding mismatch");
  const seen = new Set<string>();
  for (const file of p.files) {
    if (!p.scope.includes(file.path) || seen.has(file.path.toLowerCase())) throw new Error("Proposal file scope/alias mismatch");
    seen.add(file.path.toLowerCase());
    // Avoid lossy UTF-8 mutation data (unpaired UTF-16 surrogates).
    if (Buffer.from(file.content, "utf8").toString("utf8") !== file.content) throw new Error("Invalid UTF-8 proposal content");
  }
  return freeze(p);
}
