import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseStrict } from "../task-contract/contract.js";

export const requestSchema = z.object({ fixture: z.literal("COUNTER_V1"), taskId: z.string().uuid(), before: z.literal(0) }).strict();
export const proposalSchema = z.object({ operation: z.literal("SET_COUNTER"), value: z.literal(1) }).strict();
export const roleSchema = z.enum(["proposer", "reviewer"]);
export type Role = z.infer<typeof roleSchema>;
export const receiptSchema = z.object({ kind: z.literal("FIXED_FIXTURE_NOT_AI"), role: roleSchema,
  taskId: z.string().uuid(), sessionId: z.string().uuid(), pid: z.number().int().positive(),
  proposal: proposalSchema.optional(), review: z.enum(["PASS", "NEEDS_WORK"]).optional() }).strict();

/** Fixed data transformation only. No generated code, shell, filesystem, provider or tools. */
export function evaluateFixture(role: Role, input: unknown) {
  const common = { kind: "FIXED_FIXTURE_NOT_AI" as const, role, sessionId: randomUUID(), pid: process.pid };
  if (role === "proposer") {
    const request = parseStrict(requestSchema, input);
    return receiptSchema.parse({ ...common, taskId: request.taskId, proposal: { operation: "SET_COUNTER", value: 1 } });
  }
  const data = parseStrict(z.object({ request: requestSchema, candidate: z.object({ counter: z.number().int() }).strict() }).strict(), input);
  return receiptSchema.parse({ ...common, taskId: data.request.taskId, review: data.candidate.counter === 1 ? "PASS" : "NEEDS_WORK" });
}
