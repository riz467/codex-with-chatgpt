import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJson } from "../task-contract/contract.js";
import { admitFixedNative, digestSchema, nativeBlocked, nativeHash, NATIVE_ROOTS, taskIdSchema } from "./native-admission.js";
import { joinFixedNativeCgroup } from "./native-launcher.js";

export const nativeRoleSchema = z.enum(["proposer", "reviewer"]);
export type NativeRole = z.infer<typeof nativeRoleSchema>;
/** Serializable DATA only. Handles, credentials, code, paths and prompts never cross this boundary. */
export const nativeWorkerInputSchema = z.object({ version: z.literal(1), task: z.literal("COUNTER_JSON_V1"),
  taskId: taskIdSchema, role: nativeRoleSchema, request: z.object({ counter: z.literal(0) }).strict(),
  candidate: z.object({ counter: z.literal(1) }).strict().nullable(), proposalSessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/).nullable() }).strict()
  .superRefine((i, ctx) => { if ((i.role === "proposer" && (i.candidate !== null || i.proposalSessionId !== null)) ||
    (i.role === "reviewer" && (i.candidate === null || i.proposalSessionId === null))) ctx.addIssue({ code: "custom", message: "FIXED_ROLE_DATA" }); });
export type NativeWorkerInput = z.infer<typeof nativeWorkerInputSchema>;
export const nativeTransportResultSchema = z.object({ version: z.literal(1), role: nativeRoleSchema,
  sessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/), proposal: z.object({ counter: z.literal(1) }).strict().nullable(),
  review: z.enum(["PASS", "NEEDS_WORK"]).nullable() }).strict();
export type NativeTransportResult = z.infer<typeof nativeTransportResultSchema>;
export interface NativeWorkerTransport {
  /** Host seam must establish genuine private canonical/request/store handles per role,
   * read authenticated credentials itself and use existing low-level proposal/review transport.
   * It must not treat this DATA as an opaque-handle serialization or FAST OS proof. */
  dispatchFixedNativeRole(input: Readonly<NativeWorkerInput>): Promise<NativeTransportResult>;
}
export const nativeWorkerOutputSchema = nativeTransportResultSchema.extend({ taskId: taskIdSchema,
  inputDigest: digestSchema, pid: z.number().int().positive() }).strict();
export type NativeWorkerOutput = z.infer<typeof nativeWorkerOutputSchema>;

/** Offline injectable contract only; successful values do not prove Linux containment or provider execution. */
export async function evaluateNativeWorkerData(input: unknown, transport: NativeWorkerTransport, pid: number): Promise<NativeWorkerOutput> {
  const i = nativeWorkerInputSchema.parse(input);
  const inputDigest = nativeHash(canonicalJson(i));
  Object.freeze(i.request); if (i.candidate) Object.freeze(i.candidate);
  const r = nativeTransportResultSchema.parse(await transport.dispatchFixedNativeRole(Object.freeze(i)));
  if (r.role !== i.role || r.sessionId === i.proposalSessionId ||
    (i.role === "proposer" && (!r.proposal || r.review !== null)) ||
    (i.role === "reviewer" && (r.proposal !== null || r.review === null))) throw nativeBlocked();
  return nativeWorkerOutputSchema.parse({ ...r, taskId: i.taskId, inputDigest, pid });
}

async function main() {
  if (process.argv.length !== 3) throw nativeBlocked();
  const role = nativeRoleSchema.parse(process.argv[2]);
  // No provider/module loading until this process has joined the delegated role group.
  joinFixedNativeCgroup(role);
  const auth = admitFixedNative();
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk); size += b.length;
    if (size > 4096) throw nativeBlocked();
    chunks.push(b);
  }
  const input = nativeWorkerInputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (input.role !== role || input.taskId !== auth.taskId) throw nativeBlocked();
  const { claimFixedNativeWorkerTurn } = await import("./native-receipt.js");
  claimFixedNativeWorkerTurn(input, auth);
  // Fixed root-pinned host integration only; there is no user-configurable module path.
  const modulePath = `${NATIVE_ROOTS.runtime}/dist/linux-development/native-host-transport.js`;
  const host = await import(modulePath) as Partial<NativeWorkerTransport>;
  if (typeof host.dispatchFixedNativeRole !== "function") throw nativeBlocked();
  const result = await evaluateNativeWorkerData(input, host as NativeWorkerTransport, process.pid);
  process.stdout.write(canonicalJson(result));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(() => { fs.writeSync(2, "NATIVE_WORKER_BLOCKED\n"); process.exitCode = 2; });
}
