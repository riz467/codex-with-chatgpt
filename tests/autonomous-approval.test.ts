import { describe, expect, it } from "vitest";
import { validateDoneApproval, currentApprovalCandidate, issueHumanDoneApproval, consumeHumanApproval } from "../src/mcp/autonomous-approval.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { REVIEW_ROOT } from "../src/mcp/local-gateway.js";

const historical = {
  task_id: "rpc-4b089f56be4c411db2689c3889860815", review_result: "PASS",
  review_evidence_hash: "a".repeat(64), bundle_manifest_sha256: "b".repeat(64),
  authoritative_review_id: "review-b1afa4c5-7b70-4e3b-b38d-542b7efbc750", done_approved: true,
} as const;
describe("explicit autonomous DONE gate", () => {
  it("rejects historical wrong PASS and any unbound/stale review", () => {
    expect(() => validateDoneApproval(historical, "autonomous-semantic-accepted-fixture")).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    expect(() => validateDoneApproval({ ...historical, task_id: "rpc-b8dfd6682b04447f97aaf5272e3ac4be" },
      "autonomous-semantic-no-behavior-fixture")).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
  });
  it("does not infer human approval from prose or truthy values", () => {
    for (const input of ["approved", { ...historical, done_approved: "true" }, { ...historical, done_approved: false },
      { ...historical, extra: "approved" }, { ...historical, review_result: "NEEDS_WORK" },
      { ...historical, review_evidence_hash: "0".repeat(64) }]) {
      expect(() => validateDoneApproval(input, "autonomous-semantic-accepted-fixture")).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    }
  });
  it("accepts only a current exact two-phase PASS in an isolated copy, then rejects supersession", () => {
    const original = path.join(REVIEW_ROOT, "rpc-jobs", "auto-4b089f56be4c411db2689c3889860815", "autonomous-run.json");
    if (!fs.existsSync(original)) return; // historical fixture is optional on non-Windows CI
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-fixture-"));
    const run = JSON.parse(fs.readFileSync(original, "utf8"));
    const bundle = path.relative(REVIEW_ROOT, run.review_bundle).replaceAll(path.sep, "/");
    const oldReview = JSON.parse(fs.readFileSync(path.join(REVIEW_ROOT, run.review_evidence_ref), "utf8"));
    const reviewId = "review-12345678-1234-4234-8234-123456789abc";
    const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
    const goalHash = hash(JSON.parse(fs.readFileSync(path.join(run.review_bundle, "status.json"), "utf8")).goal);
    const write = (ref: string, value: unknown) => {
      const file = path.join(root, ref); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value));
    };
    fs.cpSync(run.review_bundle, path.join(root, bundle), { recursive: true });
    const meta = JSON.parse(fs.readFileSync(path.join(root, bundle, "review-bundle.json"), "utf8"));
    meta.canonical_goal_sha256 = goalHash; write(`${bundle}/review-bundle.json`, meta);
    const review = { ...oldReview, review_job_id: reviewId, evidence_ref: `rpc-jobs/${reviewId}/result.json`, canonical_goal_sha256: goalHash };
    write(`rpc-jobs/${reviewId}/result.json`, review);
    const reviewHash = hash(fs.readFileSync(path.join(root, `rpc-jobs/${reviewId}/result.json`)));
    run.review_job_id = reviewId; run.review_evidence_sha256 = reviewHash; run.review_bundle = path.join(root, bundle);
    write("rpc-jobs/auto-4b089f56be4c411db2689c3889860815/autonomous-run.json", run);
    write("CURRENT_REVIEW.json", { task_id: historical.task_id, source_workspace: meta.source_workspace,
      review_bundle: bundle, canonical_goal_sha256: goalHash });
    const authority = { task_id: historical.task_id, review_job_id: reviewId, bundle_id: bundle,
      manifest_sha256: meta.manifest_sha256, canonical_goal_sha256: goalHash, evidence_sha256: reviewHash };
    write(`rpc-jobs/authoritative/${historical.task_id}.json`, authority);
    const approval = { ...historical, authoritative_review_id: reviewId, review_evidence_hash: reviewHash,
      bundle_manifest_sha256: meta.manifest_sha256 };
    expect(validateDoneApproval(approval, "autonomous-semantic-accepted-fixture", root)).toMatchObject({ review_id: reviewId });
    const candidate = currentApprovalCandidate(root);
    expect(candidate).toMatchObject({ task_id: historical.task_id, run_id: "auto-4b089f56be4c411db2689c3889860815",
      canonical_goal_hash: goalHash, authoritative_review_id: reviewId });
    const request = { action: "FINAL_DONE_APPROVAL", task_id: historical.task_id, run_id: candidate.run_id,
      authoritative_review_id: reviewId };
    expect(() => issueHumanDoneApproval({ ...request, arbitrary: "path" }, root)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    expect(issueHumanDoneApproval(request, root)).toMatchObject({ approved: true, task_id: historical.task_id });
    const approvalDir = path.join(root, "rpc-jobs", "human-approvals", historical.task_id);
    const current = JSON.parse(fs.readFileSync(path.join(approvalDir, "current.json"), "utf8"));
    expect(current).toMatchObject({ run_id: candidate.run_id, canonical_goal_hash: goalHash,
      authoritative_review_id: reviewId, review_evidence_hash: reviewHash, done_approved: true });
    expect(current.approval_nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(() => issueHumanDoneApproval(request, root)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    write(`rpc-jobs/authoritative/${historical.task_id}.json`, { ...authority, review_job_id: "review-ffffffff-ffff-4fff-8fff-ffffffffffff" });
    expect(() => validateDoneApproval(approval, "autonomous-semantic-accepted-fixture", root)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    expect(() => currentApprovalCandidate(root)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    // Even a previously issued local approval is unusable after the Review pointer moves.
    expect(() => issueHumanDoneApproval(request, root)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    expect(() => consumeHumanApproval(root, historical.task_id, approval)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    write(`rpc-jobs/authoritative/${historical.task_id}.json`, authority);
    consumeHumanApproval(root, historical.task_id, approval);
    expect(() => consumeHumanApproval(root, historical.task_id, approval)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    // Preserve the test copy for diagnosis; never touch the original audit result.
  });
});
