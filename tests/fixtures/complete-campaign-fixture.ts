// One-shot isolated fixture verification. Never call this with a production task.
import fs from "node:fs";
import path from "node:path";
import { REVIEW_ROOT } from "../../src/mcp/local-gateway.js";
import { completeCurrentAutonomous, issueHumanDoneApproval, validateDoneApproval } from "../../src/mcp/autonomous-approval.js";

const task_id = "rpc-bbb519ff91a84ada9cee4bc5119e59b0";
const repo = "autonomous-campaign-recovered-fixture";
const authority = JSON.parse(fs.readFileSync(path.join(REVIEW_ROOT, "rpc-jobs", "authoritative", `${task_id}.json`), "utf8"));
const approval = { task_id, review_result: "PASS", review_evidence_hash: authority.evidence_sha256,
  bundle_manifest_sha256: authority.manifest_sha256, authoritative_review_id: authority.review_job_id, done_approved: true };
const rejects = (input: unknown, name: string) => {
  try { validateDoneApproval(input, repo); throw new Error(`UNSAFE_ACCEPT: ${name}`); }
  catch (error) { if ((error as Error).message !== "AUTONOMOUS_APPROVAL_REJECTED") throw error; }
};
rejects({ ...approval, done_approved: false }, "no approval");
rejects({ ...approval, authoritative_review_id: "review-b1afa4c5-7b70-4e3b-b38d-542b7efbc750" }, "old PASS");
rejects({ ...approval, review_evidence_hash: "0".repeat(64) }, "stale hash");
rejects({ ...approval, bundle_manifest_sha256: "0".repeat(64) }, "other manifest");
rejects({ ...approval, task_id: "rpc-" + "0".repeat(32) }, "other task");
console.log("PASS: pre-PASS/old review/manifest/task/approval mismatches rejected");
console.log("PASS: current authority", validateDoneApproval(approval, repo).review_id);
console.log("FIXTURE UI simulation:", issueHumanDoneApproval({ action: "FINAL_DONE_APPROVAL", task_id,
  run_id: `auto-${task_id.slice(4)}`, authoritative_review_id: authority.review_job_id }));
console.log("FIXTURE DONE:", completeCurrentAutonomous(approval));
