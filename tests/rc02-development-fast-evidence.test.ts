import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/task-contract/contract.js";
import { fastEvidenceSchema, parseFastSummary, MAX_FAST_OUTPUT_BYTES } from "../src/execution-orchestrator/development/fast-evidence.js";
import { passSummary } from "./rc02-development-e0-fixture.js";

describe("E0 strict trusted FAST summary", () => {
  const wire = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
  it("accepts only a complete final strict PASS summary", () => {
    const summary = passSummary();
    expect(parseFastSummary(Buffer.concat([Buffer.from("earlier untrusted test output\n"), wire(summary)]), Buffer.alloc(0), 0)).toEqual(summary);
  });
  it.each([
    { effective_profile: "FULL_REQUIRED", escalation_required: true }, { requested_profile: "REVIEW" },
    { result: "FAIL" }, { pass: false }, { escalation_required: true }, { extra: "authority" },
    { commands: [{ executable: "git", argv: [], status: 1 }] }, { out_of_scope_paths: ["secret"] },
  ])("rejects non-PASS field combination %j", override => {
    expect(() => parseFastSummary(wire({ ...passSummary(), ...override }), Buffer.alloc(0), 0)).toThrow();
  });
  it("rejects exit failure, timeout/null, trailing text, duplicate keys, invalid UTF8 and oversized logs", () => {
    const bytes = wire(passSummary());
    for (const status of [1, 2, null]) expect(() => parseFastSummary(bytes, Buffer.alloc(0), status)).toThrow();
    for (const output of [Buffer.concat([bytes, Buffer.from("later\n")]), bytes.subarray(0, -1),
      Buffer.from(JSON.stringify(passSummary()).replace('"pass":true', '"pass":false,"pass":true') + "\n"),
      Buffer.concat([Buffer.from([0xff]), bytes]), Buffer.alloc(MAX_FAST_OUTPUT_BYTES + 1)])
      expect(() => parseFastSummary(output, Buffer.alloc(0), 0)).toThrow();
    expect(() => parseFastSummary(bytes, Buffer.alloc(MAX_FAST_OUTPUT_BYTES + 1), 0)).toThrow();
  });
  it("strict evidence rejects raw logs and missing runtime identity", () => {
    expect(() => fastEvidenceSchema.parse({ stdout: "raw logs", result: "PASS" })).toThrow();
    expect(canonicalJson(passSummary())).not.toContain("evidenceDigest");
  });
});
