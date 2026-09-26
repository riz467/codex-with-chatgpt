import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { REVIEW_ROOT } from "../src/mcp/local-gateway.js";
import { evaluateStructural, structuralVerdict, type ReviewEvidence } from "../src/mcp/review-structural.js";
import { getReviewProfile } from "../src/mcp/review-profiles.js";
import { finalSemanticVerdict } from "../src/mcp/review-semantic.js";

const runs = {
  text: ["autonomous-generic-text-fixture", "7352e2177e93484cb01fca3bad2b2345"],
  code: ["autonomous-generic-code-fixture", "c6b1dc6020b64e4da18c1d6d8f938bd5"],
  missing: ["autonomous-generic-missing-fixture", "a35752a32fec4a75a8ffb75cfcab6c9e"],
  policy: ["autonomous-review-negative-fixture", "dcd04f5ba75a4f63842ce47b18b424e3"],
} as const;
function snapshot(which: keyof typeof runs) {
  const [key, id] = runs[which];
  const profile = getReviewProfile(key);
  const taskId = `rpc-${id}`;
  const autoRun = JSON.parse(fs.readFileSync(path.join(REVIEW_ROOT, "rpc-jobs", `auto-${id}`, "autonomous-run.json"), "utf8"));
  const bundle = autoRun.review_bundle as string;
  const read = (file: string) => fs.readFileSync(path.join(bundle, file), "utf8").replaceAll("\r\n", "\n");
  const evidence = new Map<string, string>();
  for (const ref of profile.requiredEvidence) if (fs.existsSync(path.join(bundle, ref))) evidence.set(ref, read(ref));
  const input: ReviewEvidence = {
    taskId, head: autoRun.baseline_head, workspace: profile.workspace, bundle,
    metadata: JSON.parse(read("review-bundle.json")), status: JSON.parse(read("status.json")),
    seal: JSON.parse(read("audit/review-seal.json")), manifest: JSON.parse(read("manifest.json")), evidence,
    autoRun, decisions: fs.readFileSync(path.join(REVIEW_ROOT, "rpc-jobs", `auto-${id}`, "decision-history.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
  return { input, profile };
}
const available = process.platform === "win32" && fs.existsSync(path.join(REVIEW_ROOT, "rpc-jobs", `auto-${runs.code[1]}`));
describe.skipIf(!available)("generic structural review on published immutable fixture evidence", () => {
  it("generic text and code PASS with sealed test evidence", () => {
    for (const kind of ["text", "code"] as const) {
      const { input, profile } = snapshot(kind);
      // Historical bundles predate canonical-goal binding and must not be approvable.
      expect(evaluateStructural(input, profile)).toContain("BASELINE_MISMATCH");
      input.metadata.canonical_goal_sha256 = createHash("sha256").update(input.status.goal as string).digest("hex");
      expect(evaluateStructural(input, profile)).toEqual([]);
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
    const generic = getReviewProfile(runs.text[0]);
    expect(evaluateStructural(input, { ...generic, workspace: input.workspace })).not.toContain("POLICY_VIOLATION");
    expect(evaluateStructural(input, getReviewProfile(runs.policy[0]))).toContain("POLICY_VIOLATION");
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
describe.skipIf(!available)("wrong-change goal authority regression", () => {
  it("a structurally valid 45s edit cannot satisfy a 30s → 60s sealed goal", () => {
    const { input } = snapshot("code");
    // Build the decision input from a real sealed code-diff shape, without mutating historical evidence.
    const goal = "Change timeout 30,000 ms → 60,000 ms";
    input.status.goal = goal;
    input.autoRun.goal_sha256 = createHash("sha256").update(goal).digest("hex");
    input.metadata.canonical_goal_sha256 = input.autoRun.goal_sha256;
    expect(evaluateStructural(input, getReviewProfile(runs.code[0]))).toEqual([]);
    const decision = { review_result: "PASS" as const, reason_category: "GOAL_SATISFIED", summary: "claimed pass", evidence_refs: [1], unresolved_issues: [] };
    expect(finalSemanticVerdict({ review_result: "PASS", integrity_valid: true }, decision, input.taskId, "reviews/fixture",
      input.taskId, "reviews/fixture", "ses_execution123", "ses_review123", [1], getReviewProfile("autonomous-semantic-accepted-fixture"),
      { test_kind: "git-timeout-mock", observed_timeout_ms: 45000 }, goal))
      .toMatchObject({ review_result: "NEEDS_WORK", reason_category: "GOAL_NOT_SATISFIED", done_eligible: false });
  });
});
