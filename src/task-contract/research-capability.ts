import { z } from "zod";
import { freeze, identifierSchema, parseStrict } from "./contract.js";

// Opaque catalog/inventory selectors, never paths, refs, URLs or command strings.
const repo = { repoId: identifierSchema };
export const researchOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("ReadCatalogFile"), ...repo, evidenceId: identifierSchema }).strict(),
  z.object({ operation: z.literal("ObserveStatus"), ...repo }).strict(),
  z.object({ operation: z.literal("ReadHead"), ...repo }).strict(),
  z.object({ operation: z.literal("ReadBoundedHistory"), ...repo, approvedRangeId: identifierSchema }).strict(),
  z.object({ operation: z.literal("ReadBoundedDiff"), ...repo, approvedComparisonId: identifierSchema }).strict(),
  z.object({ operation: z.literal("ReadTrackedBlob"), ...repo,
    approvedObjectId: identifierSchema, approvedPathId: identifierSchema }).strict(),
]);
export type ResearchOperation = z.infer<typeof researchOperationSchema>;

/** Contract representation only. A future host must resolve selectors through its
 * own local inventory and enforce read-only fixed argv, path safety and budgets.
 * Parsing does not prove selector ownership, execute Git or grant a capability. */
export function parseResearchOperation(input: unknown) {
  return freeze(parseStrict(researchOperationSchema, input));
}
