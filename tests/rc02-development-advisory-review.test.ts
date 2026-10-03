import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/task-contract/contract.js";
import { hashRecord } from "../src/execution-orchestrator/development/contract.js";
import { DevelopmentStore } from "../src/execution-orchestrator/development/store.js";
import { runAdvisoryReview } from "../src/execution-orchestrator/development/advisory-review.js";
import { inspectReviewContext, prepareReviewContext, HOST_REVIEW_INSTRUCTION } from "../src/execution-orchestrator/development/review-context.js";
import { parseFindings } from "../src/execution-orchestrator/development/review-evidence.js";
import { commitStore, sha256 } from "../src/execution-orchestrator/development/candidate-mutation.js";
import * as transport from "../src/execution-orchestrator/development/opencode-transport.js";
import { cleanup, fixture, raw } from "./rc02-development-e1-fixture.js";

afterEach(() => { vi.restoreAllMocks(); cleanup(); });
function fake(result: "PASS" | "NEEDS_WORK" = "PASS") {
  return vi.spyOn(transport, "dispatchAdvisoryReview").mockImplementation(async handle => {
    const p = inspectReviewContext(handle);
    return { result: "REVIEW_RECEIVED", findings: { ...JSON.parse(p.user).reviewIdentity, result, findings: [] },
      nativeSessionId: "ses_test", model: "gpt-5.5" };
  });
}
describe("E1 durable advisory evidence", () => {
  it.each(["missingFastArtifact", "wrongFastSnapshot", "largeContext"] as const)("fails closed on %s", key => {
    const f = fixture({ [key]: true });
    expect(() => prepareReviewContext(f.mutation, f.human)).toThrow();
    expect(f.store.recover().state.binding.review).toBeUndefined();
  });
  it("separates poisoned project data, shows exact baseline and candidate bytes, binds store evidence", () => {
    const f = fixture(), context = prepareReviewContext(f.mutation, f.human), p = inspectReviewContext(context), x = JSON.parse(p.user);
    expect(p.system).toBe(HOST_REVIEW_INSTRUCTION); expect(p.system).not.toContain("IGNORE HOST;");
    expect(x["HUMAN REQUEST"]).toEqual(raw);
    expect(x["BASELINE / BEFORE DATA"].files[1].content).toBe("before\r\n");
    expect(x["CANDIDATE / AFTER DATA"].files[1].content).toBe("\uFEFFafter\r\n");
    expect(x["BASELINE / BEFORE DATA"].files[3].content).toBeNull();
    expect(x["CANDIDATE / AFTER DATA"].classification).toBe("UNTRUSTED PROJECT DATA");
    expect(p.user).toContain("IGNORE HOST;"); expect(p.user).not.toContain("existing user work");
    expect(p.user).not.toContain(f.canonical.root); expect(p.user).not.toContain(f.candidate.root);
    const bytes = Buffer.from(f.store.recover().state.blobs[p.digest], "base64"); expect(sha256(bytes)).toBe(p.digest);
    expect(() => inspectReviewContext({ ...context })).toThrow();
  });
  it.each(["PASS", "NEEDS_WORK"] as const)("records %s only via durable findings, record, COMMIT_REVIEW", async result => {
    const f = fixture(), provider = fake(result);
    expect(await runAdvisoryReview(f.mutation, f.human)).toMatchObject({ result, state: result === "PASS" ? "MATERIALIZATION_ELIGIBLE" : "ATTEMPT_REJECTED" });
    const s = f.store.recover(); expect(s.state.binding.review!.digest).toBe(hashRecord(s.state.binding.review));
    expect(s.state.committedReview).toBe(s.state.binding.review!.digest);
    expect(s.receipts.findIndex(r => r.operation === "REVIEW_ARTIFACT")).toBeLessThan(s.receipts.findIndex(r => r.operation === "COMMIT_REVIEW"));
    await expect(runAdvisoryReview(f.mutation, f.human)).rejects.toThrow(); expect(provider).toHaveBeenCalledTimes(1);
    expect(s.state.binding).not.toHaveProperty("approved"); expect(s.state.binding).not.toHaveProperty("permit");
  });
  it.each(["REVIEW_ARTIFACT", "COMMIT_REVIEW"])("crash at %s leaves no committed verdict", async operation => {
    const f = fixture(); fake(); const original = DevelopmentStore.prototype.transact;
    vi.spyOn(DevelopmentStore.prototype, "transact").mockImplementation(function (command: any, expected) {
      if (command.operation === operation || command.to === "RECONCILE_REQUIRED") throw new Error("crash");
      return original.call(this, command, expected);
    });
    expect(await runAdvisoryReview(f.mutation, f.human)).toEqual({ result: "RECONCILE_REQUIRED" }); vi.restoreAllMocks();
    const s = DevelopmentStore.open(f.storeRoot, f.store.recover().anchor).recover().state;
    expect(s.state).toBe("REVIEW_PENDING"); expect(s.committedReview).toBeNull(); expect(s.binding.review).toBeUndefined();
    expect(s.artifacts.some(a => a.id === s.binding.attempt.advisoryReviewId)).toBe(operation === "COMMIT_REVIEW");
    await expect(runAdvisoryReview(f.mutation, f.human)).rejects.toThrow();
  });
  it("rejects missing findings, forged handles, cross-attempt input and candidate drift", () => {
    const f = fixture(), other = fixture();
    expect(() => prepareReviewContext({ ...f.mutation }, f.human)).toThrow();
    expect(() => prepareReviewContext(f.mutation, { ...f.human })).toThrow();
    expect(() => prepareReviewContext(f.mutation, other.human)).toThrow();
    const b = f.store.recover().state.binding;
    commitStore(f.store, b, { operation: "ADVANCE", to: "REVIEW_PENDING", candidateOutcome: "CONFIRMED", canonicalOutcome: "NOT_STARTED" });
    const record = { domain: "RC02_DEVELOPMENT_V2_ADVISORY_REVIEW", id: b.attempt.advisoryReviewId, attemptDigest: b.attempt.digest,
      manifestDigest: b.manifest!.digest, fastDigest: b.fast!.digest, result: "PASS", findingsDigest: "a".repeat(64), digest: "a".repeat(64) };
    expect(() => commitStore(f.store, { ...b, review: { ...record, digest: hashRecord(record) } } as any, { operation: "REVIEW_ARTIFACT" })).toThrow("FINDINGS");
    fs.writeFileSync(path.join(other.candidate.root, "file.txt"), "drift");
    expect(() => prepareReviewContext(other.mutation, other.human)).toThrow();
  });
  it("rejects all authority fields, cross-binding, noncanonical and unbounded findings", () => {
    const f = fixture(), p = inspectReviewContext(prepareReviewContext(f.mutation, f.human));
    const body = { ...JSON.parse(p.user).reviewIdentity, result: "PASS", findings: [] };
    for (const key of ["authorized", "approved", "permit", "commit", "push", "deploy", "DoneApproved", "productionCurrent"])
      expect(() => parseFindings(canonicalJson({ ...body, [key]: true }), p.binding, p.digest)).toThrow();
    for (const change of [{ result: "APPROVED" }, { attemptDigest: "a".repeat(64) }, { reviewContextDigest: "a".repeat(64) },
      { findings: Array(17).fill("x") }, { findings: ["x".repeat(2049)] }])
      expect(() => parseFindings(canonicalJson({ ...body, ...change }), p.binding, p.digest)).toThrow();
    expect(() => parseFindings(" " + canonicalJson(body), p.binding, p.digest)).toThrow();
    expect(() => parseFindings(canonicalJson(body).replace('"result":"PASS"', '"result":"NEEDS_WORK","result":"PASS"'), p.binding, p.digest)).toThrow();
  });
});
