import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, parseStrict, digestSchema } from "../task-contract/contract.js";
import { linuxFixtureTests, validFixtureReport } from "../../scripts/verify-linux-portability-fixture.mjs";

export const qualificationProfile = "LINUX_PHASE16_13_SUITE" as const;
export const qualificationTests = linuxFixtureTests;
export const qualificationId = /^linux-qualification-[a-f0-9]{32}$/;
export const sourcePinsSchema = z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceArchiveSha256: digestSchema, runtimeCapsuleSha256: digestSchema }).strict();
export type SourcePins = z.infer<typeof sourcePinsSchema>;
export const requestSchema = z.object({ domain: z.literal("LINUX_OFFLINE_QUALIFICATION_REQUEST_V1"),
  taskId: z.string().regex(qualificationId), profile: z.literal(qualificationProfile), executorVmid: z.literal(117),
  source: sourcePinsSchema, createdAt: z.number().int().nonnegative().safe(), deadline: z.number().int().positive().safe(),
  requestSha256: digestSchema }).strict();
export type QualificationRequest = z.infer<typeof requestSchema>;
export const contentHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export function parseRequest(value: unknown): QualificationRequest {
  const request = parseStrict(requestSchema, value);
  const { requestSha256, ...body } = request;
  if (requestSha256 !== contentHash(body) || request.deadline !== request.createdAt + 900_000)
    throw new Error("QUALIFICATION_REQUEST_BINDING");
  return request;
}
const resultSchema = z.object({ domain: z.literal("LINUX_OFFLINE_QUALIFICATION_RESULT_V1"),
  taskId: z.string().regex(qualificationId), requestSha256: digestSchema, profile: z.literal(qualificationProfile),
  source: sourcePinsSchema, executorVmid: z.literal(117), platform: z.literal("linux"),
  uid: z.number().int().positive().safe(), node: z.literal("v24.16.0"), exitCode: z.literal(0),
  startedAt: z.number().int().nonnegative().safe(), finishedAt: z.number().int().nonnegative().safe(),
  isolation: z.object({ kind: z.literal("BWRAP_MINIMAL_IMAGE"), network: z.literal("UNSHARED"),
    hostHome: z.literal("NOT_MOUNTED"), hostCredentials: z.literal("NOT_MOUNTED"),
    noNewPrivileges: z.literal(true), cgroupMemoryMaxBytes: z.literal(3221225472),
    cgroupOomKill: z.literal(0), tasksMax: z.literal(128), cpuQuotaPercent: z.literal(100),
    osProbe: z.literal("PASS") }).strict(), reportRoot: z.literal("/candidate"), report: z.unknown(),
  resultSha256: digestSchema }).strict();
export type QualificationResult = z.infer<typeof resultSchema>;
/** Trusted broker custody must establish origin; hashes/these fields are NOT signatures or OS proof. */
export function parseResult(value: unknown, requestInput: unknown): QualificationResult {
  const request = parseRequest(requestInput), result = parseStrict(resultSchema, value);
  const { resultSha256, ...body } = result;
  if (Buffer.byteLength(canonicalJson(result)) > 4 * 1024 * 1024 || resultSha256 !== contentHash(body) ||
      result.taskId !== request.taskId || result.requestSha256 !== request.requestSha256 ||
      result.startedAt < request.createdAt || result.finishedAt < result.startedAt || result.finishedAt > request.deadline ||
      canonicalJson(result.source) !== canonicalJson(request.source) ||
      !validFixtureReport(result.report, result.reportRoot, qualificationTests))
    throw new Error("QUALIFICATION_RESULT_BINDING_OR_TEST_FAILURE");
  return result;
}
