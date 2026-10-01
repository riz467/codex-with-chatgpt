import { afterEach, describe, it, expect } from "vitest";
import { verifyBundleIntegrity } from "../src/mcp/local-gateway.js";
import { evaluateStructural, structuralVerdict, type ReviewEvidence } from "../src/mcp/review-structural.js";
import { getReviewProfile } from "../src/mcp/review-profiles.js";
import { finalSemanticVerdict } from "../src/mcp/review-semantic.js";
import { createScratch, type Scratch } from "./support/scratch.js";
import { writePolicyReview, syntheticReviewEvidence, type SyntheticReviewKind } from "./support/synthetic-review.js";

const allocations: Scratch[] = [];
afterEach(() => { for (const scratch of allocations.splice(0)) scratch.dispose(); });
function snapshot(which: SyntheticReviewKind) {
  const scratch = createScratch();
  allocations.push(scratch);
  const fixture = writePolicyReview(scratch, which);
  expect(verifyBundleIntegrity(fixture.bundle, fixture.root)).toMatchObject({ valid: true, issues: [] });
  return { input: syntheticReviewEvidence(scratch, fixture), profile: fixture.profile };
}
describe("generic structural review on generated scratch evidence", () => {
  it("generic text and code PASS with sealed test evidence", () => {
    for (const kind of ["text", "code"] as const) {
      const { input, profile } = snapshot(kind);
      expect(evaluateStructural(input, profile)).toEqual([]);
      delete input.metadata.canonical_goal_sha256;
      expect(evaluateStructural(input, profile)).toContain("BASELINE_MISMATCH");
    }
  });
  it("missing required profile evidence is NEEDS_WORK", () => {
    const { input, profile } = snapshot("missing");
    expect(evaluateStructural(input, profile)).toContain("EVIDENCE_MISSING");
  });
  it("rejects seal, Verify, scope, unexpected paths, baseline and audit inconsistencies", () => {
    const { input, profile } = snapshot("text");
    input.metadata.canonical_goal_sha256 = input.autoRun.goal_sha256;
    const mutate = (change: (v: ReviewEvidence) => void) => {
      const copy: ReviewEvidence = { ...input, metadata: { ...input.metadata }, status: { ...input.status },
        seal: { ...input.seal }, evidence: new Map(input.evidence), autoRun: { ...input.autoRun }, decisions: input.decisions.slice() };
      change(copy); return evaluateStructural(copy, profile);
    };
    expect(mutate((v) => { v.seal.git_diff_sha256 = "0".repeat(64); })).toContain("SEAL_INVALID");
    expect(mutate((v) => { v.status.verify_exit_code = 1; })).toContain("VERIFY_FAILED");
    expect(mutate((v) => { v.status.edit_paths = ["outside.md"]; })).toContain("SCOPE_MISMATCH");
    expect(mutate((v) => { v.status.unexpected_changes = ["other.md"]; })).toContain("UNEXPECTED_CHANGE");
    expect(mutate((v) => { v.metadata.source_head = "0".repeat(40); })).toContain("BASELINE_MISMATCH");
    expect(mutate((v) => { v.metadata.canonical_goal_sha256 = "0".repeat(64); })).toContain("BASELINE_MISMATCH");
    expect(mutate((v) => { v.evidence.set("audit/coordinator-actions.jsonl", ""); })).toContain("AUDIT_INCOMPLETE");
    expect(mutate((v) => { v.evidence.delete("plan.md"); })).toContain("EVIDENCE_MISSING");
  });
  it("fixture policy does not run under generic text profile", () => {
    const { input } = snapshot("policy");
    input.autoRun = { ...input.autoRun, phase: "REVIEWING" };
    const generic = getReviewProfile("autonomous-generic-text-fixture");
    expect(evaluateStructural(input, { ...generic, workspace: input.workspace })).not.toContain("POLICY_VIOLATION");
    expect(evaluateStructural(input, getReviewProfile("autonomous-review-negative-fixture"))).toContain("POLICY_VIOLATION");
  });
});
describe("profile allowlist", () => {
  it("refuses unknown profile names and caller-chosen arbitrary paths", () => {
    expect(() => getReviewProfile("generic-text-change")).toThrow("UNKNOWN_REVIEW_PROFILE");
    expect(() => getReviewProfile("../../outside")).toThrow("UNKNOWN_REVIEW_PROFILE");
  });
});
describe("integrity is a precondition, not a review shortcut", () => {
  it("raw-byte failure cannot be promoted to PASS", () => {
    expect(structuralVerdict(false, [])).toMatchObject({ review_result: "NEEDS_WORK", reason_category: "BUNDLE_INTEGRITY_INVALID", done_eligible: false });
    expect(structuralVerdict(true, [])).toMatchObject({ review_result: "PASS", done_eligible: true });
  });
});
describe("wrong-change goal authority regression", () => {
  it("a structurally valid 45s edit cannot satisfy a 30s → 60s sealed goal", () => {
    const { input, profile } = snapshot("code");
    const goal = input.status.goal as string;
    expect(evaluateStructural(input, profile)).toEqual([]);
    expect(input.evidence.get("source-git-diff.patch")).toContain("+export const timeout = 45000;");
    const observed = JSON.parse(input.evidence.get("audit/autonomous-tests.json")!).observed_timeout_ms;
    const decision = { review_result: "PASS" as const, reason_category: "GOAL_SATISFIED", summary: "claimed pass", evidence_refs: [1], unresolved_issues: [] };
    expect(finalSemanticVerdict({ review_result: "PASS", integrity_valid: true }, decision, input.taskId, "reviews/fixture",
      input.taskId, "reviews/fixture", "ses_execution123", "ses_review123", [1], getReviewProfile("autonomous-semantic-accepted-fixture"),
      { test_kind: "git-timeout-mock", observed_timeout_ms: observed }, goal))
      .toMatchObject({ review_result: "NEEDS_WORK", reason_category: "GOAL_NOT_SATISFIED", done_eligible: false });
  });
});
