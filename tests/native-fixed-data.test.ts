import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/task-contract/contract.js";
import { prepareFixedNativeData, parseFixedNativeResponse } from "../src/linux-development/native-fixed-data.js";
import { dispatchFixedNativeRole } from "../src/linux-development/native-host-transport.js";
import { runNativeFixedDataTurn } from "../src/execution-orchestrator/development/opencode-transport.js";
import type { HostOAuthHandle } from "../src/execution-orchestrator/development/opencode-oauth.js";
import type { NativeHostTurnCapability } from "../src/linux-development/native-credential.js";
const proposer = { version: 1 as const, task: "COUNTER_JSON_V1" as const, taskId: "20261011-0000-4000-8000-000000000001",
  role: "proposer" as const, request: { counter: 0 as const }, candidate: null, proposalSessionId: null };
const reviewer = { ...proposer, role: "reviewer" as const, candidate: { counter: 1 as const }, proposalSessionId: "ses_offlineonly" };
describe("fixed native DATA contract, not native process/authentication proof", () => {
  it("uses different independent role instructions and binds exact DATA", () => {
    const p = prepareFixedNativeData(proposer), r = prepareFixedNativeData(reviewer);
    expect(p.system).not.toBe(r.system); expect(p.inputDigest).not.toBe(r.inputDigest);
    expect(JSON.parse(r.user)).toMatchObject({ before: { counter: 0 }, after: { counter: 1 }, fastOsProof: "NOT_CLAIMED", authority: "NONE" });
  });
  it("accepts only the host-bound proposer DATA schema", () => {
    const data = { version: 1, taskId: proposer.taskId, role: proposer.role, inputDigest: prepareFixedNativeData(proposer).inputDigest, proposal: { counter: 1 } };
    expect(parseFixedNativeResponse(proposer, canonicalJson(data))).toEqual(data);
    for (const bad of [{ ...data, proposal: { counter: 2 } }, { ...data, inputDigest: "0".repeat(64) }, { ...data, command: "bad" }, { ...data, proposal: { counter: 1, token: "notallowed" } }])
      expect(() => parseFixedNativeResponse(proposer, JSON.stringify(bad))).toThrow();
  });
  it.each(["PASS", "NEEDS_WORK"])("accepts advisory review %s without FAST evidence", review => {
    const data = { version: 1, taskId: reviewer.taskId, role: reviewer.role, inputDigest: prepareFixedNativeData(reviewer).inputDigest, review };
    expect(parseFixedNativeResponse(reviewer, JSON.stringify(data))).toEqual(data);
    expect(() => parseFixedNativeResponse(reviewer, JSON.stringify({ ...data, fast: "PASS" }))).toThrow();
  });
  it.each([{}, { ...proposer, prompt: "override" }, { ...proposer, task: "OTHER" }, { ...reviewer, candidate: null }])("rejects task/prompt/data override %j", data => {
    expect(() => prepareFixedNativeData(data)).toThrow();
  });
  it("bounds output and sanitizes parse failure", () => {
    for (const text of ["{SECRET_MARKER", "x".repeat(4097)]) {
      try { parseFixedNativeResponse(proposer, text); throw new Error("expected rejection"); }
      catch (e) { expect(String(e)).not.toContain("SECRET_MARKER"); }
    }
  });
  it("serialized capability cannot call fixed native provider seam", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("forbidden"));
    try {
      const result = await runNativeFixedDataTurn(proposer, {} as HostOAuthHandle, { kind: "NATIVE_HOST_TURN_ONLY" } as NativeHostTurnCapability);
      expect(result).toEqual({ result: "FAILED_BEFORE_DISPATCH", code: "NATIVE_FIXED_DATA_BLOCKED" });
      if (process.platform !== "linux") await expect(dispatchFixedNativeRole(proposer)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
