import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateDoneApproval, currentApprovalCandidate, issueHumanDoneApproval, consumeHumanApproval } from "../src/mcp/autonomous-approval.js";
import { createScratch, type Scratch } from "./support/scratch.js";
import { writePolicyReview } from "./support/synthetic-review.js";

let scratch: Scratch;
let fixture: ReturnType<typeof writePolicyReview>;
const json = (ref: string) => JSON.parse(scratch.read(path.join(fixture.root, ref)).toString("utf8"));
function replace(ref: string, value: unknown) {
  const file = path.join(fixture.root, ref);
  scratch.remove(file);
  scratch.write(file, JSON.stringify(value) + "\n");
}
const validate = (input: unknown = fixture.approval) => validateDoneApproval(input, fixture.repoKey, fixture.root, fixture.observation);
const candidate = () => currentApprovalCandidate(fixture.root, fixture.observation);
const issue = (input: unknown = fixture.request) => issueHumanDoneApproval(input, fixture.root, fixture.observation);
const consume = () => consumeHumanApproval(fixture.root, fixture.taskId, fixture.approval, fixture.observation);

beforeEach(() => { scratch = createScratch(); fixture = writePolicyReview(scratch, "approval"); });
afterEach(() => scratch?.dispose());

describe("explicit autonomous DONE gate on generated scratch evidence", () => {
  it("accepts only the exact current two-phase PASS", () => {
    expect(validate()).toMatchObject({ task_id: fixture.taskId, review_id: fixture.reviewId });
    expect(candidate()).toMatchObject({ task_id: fixture.taskId, run_id: fixture.runId,
      canonical_goal_hash: fixture.goalHash, authoritative_review_id: fixture.reviewId });
    // Fixed trusted path is metadata-only. The observer reads a different, scratch-local file.
    expect(() => scratch.read(fixture.workspaceIdentity)).toThrow("SCRATCH_CONTAINMENT");
    expect(JSON.parse(fixture.observation.readSourceStatus(fixture.workspaceIdentity, fixture.taskId).toString("utf8")))
      .toEqual(json(`${fixture.bundle}/status.json`));
  });

  it("rejects wrong/stale PASS and does not infer approval from prose or truthy values", () => {
    const good = fixture.approval;
    for (const input of ["approved", { ...good, task_id: `rpc-${"e".repeat(32)}` },
      { ...good, authoritative_review_id: "review-ffffffff-ffff-4fff-8fff-ffffffffffff" },
      { ...good, done_approved: "true" }, { ...good, done_approved: false }, { ...good, extra: "approved" },
      { ...good, observation: fixture.observation }, { ...good, root: fixture.root },
      { ...good, review_result: "NEEDS_WORK" }, { ...good, review_evidence_hash: "0".repeat(64) },
      { ...good, bundle_manifest_sha256: "0".repeat(64) }]) {
      expect(() => validate(input)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    }
  });

  it.each(["task_id", "source_workspace", "review_bundle", "canonical_goal_sha256"])("binds the current pointer's %s", field => {
    replace("CURRENT_REVIEW.json", { ...json("CURRENT_REVIEW.json"), [field]: "stale" });
    expect(() => validate()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
  });

  it.each(["task_id", "review_job_id", "bundle_id", "evidence_sha256", "manifest_sha256", "canonical_goal_sha256"])(
    "binds authoritative review %s", field => {
      replace(fixture.authorityRef, { ...json(fixture.authorityRef), [field]: "stale" });
      expect(() => validate()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    });

  it("rejects changed review bytes even when their JSON still claims PASS", () => {
    replace(fixture.resultRef, { ...json(fixture.resultRef), summary: "unbound new bytes" });
    expect(() => validate()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
  });

  it("rejects a changed bundle manifest", () => {
    const ref = `${fixture.bundle}/manifest.json`;
    replace(ref, { ...json(ref), files: [] });
    expect(() => validate()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
  });

  it.each(["structural_result", "semantic_result", "integrity_valid", "done_eligible", "semantic_review"])(
    "requires two-phase PASS after valid evidence hash binding (%s)", field => {
      const result = { ...json(fixture.resultRef), [field]: null };
      replace(fixture.resultRef, result);
      const hash = createHash("sha256").update(scratch.read(path.join(fixture.root, fixture.resultRef))).digest("hex");
      replace(fixture.authorityRef, { ...json(fixture.authorityRef), evidence_sha256: hash });
      replace(fixture.runRef, { ...json(fixture.runRef), review_evidence_sha256: hash });
      expect(() => validate({ ...fixture.approval, review_evidence_hash: hash })).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    });

  it("preserves source-status byte and state binding through the internal observer", () => {
    const source = JSON.parse(scratch.read(fixture.sourceStatus).toString("utf8"));
    for (const changed of [{ ...source, state: "DONE" }, { ...source, extra: "changed bytes" }]) {
      scratch.remove(fixture.sourceStatus);
      scratch.write(fixture.sourceStatus, JSON.stringify(changed));
      expect(() => validate()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    }
    const unavailable = { readSourceStatus: () => { throw new Error("Source unavailable"); } };
    expect(() => validateDoneApproval(fixture.approval, fixture.repoKey, fixture.root, unavailable)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
  });

  it("issues a bound human approval exactly once and rejects consumed approval replay", () => {
    expect(() => issue({ ...fixture.request, arbitrary: "path" })).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    expect(issue()).toMatchObject({ approved: true, task_id: fixture.taskId });
    const ref = `rpc-jobs/human-approvals/${fixture.taskId}/current.json`;
    const current = json(ref);
    expect(current).toMatchObject({ run_id: fixture.runId, canonical_goal_hash: fixture.goalHash,
      authoritative_review_id: fixture.reviewId, review_evidence_hash: fixture.approval.review_evidence_hash, done_approved: true });
    expect(current.approval_nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(() => issue()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    consume();
    expect(() => consume()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    replace(ref, current); // Replaying the same human record cannot erase nonce consumption.
    expect(() => consume()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    expect(() => issue()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
  });

  it("rejects superseded authority, including an already-issued human approval", () => {
    issue();
    const authority = json(fixture.authorityRef);
    replace(fixture.authorityRef, { ...authority, review_job_id: "review-ffffffff-ffff-4fff-8fff-ffffffffffff" });
    for (const action of [validate, candidate, issue, consume]) expect(() => action()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
    replace(fixture.authorityRef, authority);
    consume();
    expect(() => consume()).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
  });
});
