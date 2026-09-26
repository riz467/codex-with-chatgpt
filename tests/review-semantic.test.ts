import { describe, expect, it } from "vitest";
import { validateSemantic } from "../src/mcp/semantic-session.js";
import { finalSemanticVerdict, shouldStartSemantic, semanticPacket, requireSemanticProfile } from "../src/mcp/review-semantic.js";
import { getReviewProfile } from "../src/mcp/review-profiles.js";
const task = "rpc-" + "a".repeat(32), bundle = "reviews/fixed", exe = "ses_execution123", review = "ses_review123";
const good = { review_result: "PASS" as const, reason_category: "GOAL_SATISFIED", summary: "One change with runtime evidence", evidence_refs: [1, 6, 8], unresolved_issues: [] };
const structural = { review_result: "PASS", integrity_valid: true };
const goal = "Change timeout 30,000 ms → 60,000 ms";
const profile = getReviewProfile("autonomous-semantic-accepted-fixture");
const decide = (d = good, observed = 60000, kind = "git-timeout-mock") =>
  finalSemanticVerdict(structural, d, task, bundle, task, bundle, exe, review, [1, 6, 8], profile, { test_kind: kind, observed_timeout_ms: observed }, goal);
describe("two independent Review phases", () => {
  it("starts semantic only after structural PASS and integrity VALID", () => {
    expect(shouldStartSemantic(true, structural)).toBe(true);
    expect(shouldStartSemantic(true, { review_result: "NEEDS_WORK", integrity_valid: true })).toBe(false);
    expect(shouldStartSemantic(true, { review_result: "PASS", integrity_valid: false })).toBe(false);
    expect(shouldStartSemantic(false, structural)).toBe(false);
    expect(requireSemanticProfile({ ...structural, review_result: "PASS", reason_category: "REVIEW_PASS", unresolved_issues: [], done_eligible: true }, false))
      .toMatchObject({ review_result: "NEEDS_WORK", done_eligible: false });
  });
  it("two PASS results require sealed behavioral observation matching Review requirement", () => {
    expect(decide()).toMatchObject({ review_result: "PASS", done_eligible: true });
    expect(decide(good, 45000)).toMatchObject({ review_result: "NEEDS_WORK", reason_category: "GOAL_NOT_SATISFIED", done_eligible: false });
    expect(decide(good, 60000, "typescript-parse")).toMatchObject({ review_result: "NEEDS_WORK", reason_category: "TEST_COVERAGE_INSUFFICIENT" });
    expect(decide({ ...good, review_result: "NEEDS_WORK", reason_category: "BEHAVIOR_MISMATCH", unresolved_issues: ["wrong value"] })).toMatchObject({ review_result: "NEEDS_WORK", done_eligible: false });
    expect(finalSemanticVerdict(structural, good, task, bundle, task, bundle, exe, review, [1, 6, 8], profile,
      { test_kind: "git-timeout-mock", observed_timeout_ms: 45000 }, "Change timeout from 30_000 to exactly 60_000 milliseconds"))
      .toMatchObject({ review_result: "NEEDS_WORK", reason_category: "GOAL_NOT_SATISFIED" });
    expect(finalSemanticVerdict(structural, good, task, bundle, task, bundle, exe, review, [1, 6, 8], profile,
      { test_kind: "git-timeout-mock", observed_timeout_ms: 60000 }, "Improve timeout behavior"))
      .toMatchObject({ review_result: "NEEDS_WORK", reason_category: "REQUIREMENT_AMBIGUOUS" });
  });
  it("rejects mismatched task/bundle/session and wrong refs", () => {
    for (const [taskID, bundleID, sessionID, refs] of [["rpc-other", bundle, review, [1]], [task, "reviews/other", review, [1]],
      [task, bundle, exe, [1]], [task, bundle, review, [404]]] as const) {
      expect(() => finalSemanticVerdict(structural, good, task, bundle, taskID, bundleID, exe, sessionID, refs, profile,
        { test_kind: "git-timeout-mock", observed_timeout_ms: 60000 }, goal)).toThrow("SEMANTIC_BINDING_INVALID");
    }
  });
  it("rejects malformed decision, metadata, bad refs and spurious PASS claims", () => {
    expect(validateSemantic(JSON.stringify(good), [1, 6, 8])).toEqual(good);
    for (const invalid of ["not json", JSON.stringify({ ...good, evidence_refs: [99] }), JSON.stringify({ ...good, reason_category: "NONE" }),
      JSON.stringify({ ...good, task_id: task }), JSON.stringify({ ...good, unresolved_issues: ["unresolved"] })]) {
      expect(() => validateSemantic(invalid, [1, 6, 8])).toThrow("SEMANTIC_RESULT_INVALID");
    }
  });
  it("builds a bounded sealed-evidence prompt without execution session or logs", () => {
    const profile = getReviewProfile("autonomous-semantic-accepted-fixture");
    const evidence = new Map([["source-git-diff.patch", "diff --git a/x b/x"], ["plan.md", "plan"], ["research.md", "research"],
      ["decisions.md", "decisions"], ["verification.md", "verify"]]);
    const { prompt, refs } = semanticPacket({ goal: "test goal", edit_paths: ["x"], baseline_head: "abc" }, { manifest_sha256: "hash" }, evidence, profile);
    expect(refs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(prompt).toContain("original goal");
    expect(prompt).not.toContain("60000");
    expect(prompt).not.toMatch(/session_id|stdout|stderr|command_history/);
  });
});
