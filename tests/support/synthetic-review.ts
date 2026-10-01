import path from "node:path";
import { createHash } from "node:crypto";
import { assertScratch, type Scratch } from "./scratch.js";
import { getReviewProfile } from "../../src/mcp/review-profiles.js";
import type { ReviewEvidence } from "../../src/mcp/review-structural.js";
import type { ApprovalObservation, DoneApproval } from "../../src/mcp/autonomous-approval.js";
import type { OrchestrationReadDependencies } from "../../src/mcp/local-gateway.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Minimal byte-integrity fixture, not a structural/semantic approval fixture. */
export function writeSyntheticReview(scratch: Scratch, reviewRoot = path.join(scratch.root, "review")) {
  assertScratch(scratch);
  const root = scratch.resolve(reviewRoot); // Fail closed before the first mkdir/write.
  const bundle = "reviews/rc01-synthetic";
  const taskId = `rpc-${"a".repeat(32)}`;
  const workspace = scratch.resolve("source");
  const goal = "Document the synthetic regression fixture";
  const evidence = {
    "plan.md": `${goal}\n`,
    "status.json": JSON.stringify({ task_id: taskId, goal, phase: "REVIEWING" }) + "\n",
  };
  const manifest = JSON.stringify({ version: 1, files: Object.entries(evidence).map(([file, content]) => ({
    path: file, size: Buffer.byteLength(content), sha256: hash(content),
  })) }) + "\n";
  const metadata = JSON.stringify({ version: 1, task_id: taskId, source_workspace: workspace,
    canonical_goal_sha256: hash(goal), manifest_sha256: hash(manifest) }) + "\n";
  scratch.write(path.join(workspace, "README.md"), `${goal}\n`);
  for (const [name, content] of Object.entries({ ...evidence, "manifest.json": manifest, "review-bundle.json": metadata })) {
    scratch.write(path.join(root, bundle, name), content);
  }
  // No CURRENT_REVIEW pointer: callers must pass both bundle and root explicitly.
  return Object.freeze({ root, bundle, taskId, workspace });
}

const policyProfiles = {
  text: "autonomous-generic-text-fixture",
  code: "autonomous-generic-code-fixture",
  missing: "autonomous-generic-missing-fixture",
  policy: "autonomous-review-negative-fixture",
  approval: "autonomous-semantic-accepted-fixture",
} as const;
export type SyntheticReviewKind = keyof typeof policyProfiles;

/** Policy-binding fixture: trusted workspace strings are METADATA-ONLY identities.
 * All filesystem targets, including the observed source status, belong to this scratch.
 */
export function writePolicyReview(scratch: Scratch, kind: SyntheticReviewKind, reviewRoot = path.join(scratch.root, "review")) {
  assertScratch(scratch);
  const root = scratch.resolve(reviewRoot); // Must reject before source or pointer creation too.
  const sourceRoot = scratch.resolve("source");
  const repoKey = policyProfiles[kind];
  const profile = getReviewProfile(repoKey);
  const workspaceIdentity = profile.workspace; // Never use as a filesystem target.
  const taskId = `rpc-${"c".repeat(32)}`, runId = `auto-${taskId.slice(4)}`;
  const reviewId = "review-12345678-1234-4234-8234-123456789abc";
  const bundle = "reviews/rc01-synthetic", bundleRoot = path.join(root, bundle);
  const head = "d".repeat(40), sessionId = "ses_rc01_execution";
  const code = kind === "code" || kind === "approval";
  const changedPath = code ? "src/timeout.ts" : kind === "policy" ? "docs/document-map.md" : "docs/change.md";
  const goal = code ? "Change timeout 30,000 ms → 60,000 ms" : "Document the synthetic regression fixture";
  // Generic code uses a deliberately wrong 45s change for the semantic regression.
  const observed = kind === "code" ? 45000 : 60000;
  const oldText = code ? "export const timeout = 30000;" : "Original documentation.";
  const newText = code ? `export const timeout = ${observed};` : "Updated synthetic documentation.";
  const sourceText = `${newText}\n`, sourceHash = hash(sourceText);
  const paths = [changedPath], allowedHash = hash(JSON.stringify(paths)), goalHash = hash(goal);
  const json = (value: unknown) => JSON.stringify(value) + "\n";
  const status = { task_id: taskId, state: "READY_FOR_REVIEW", approval_required: false,
    goal, baseline_head: head, verify_completed: true, verify_exit_code: 0,
    coordinator_audit_complete: true, codex_attempts: 1, unexpected_changes: [],
    edit_paths: paths, allowed_paths: paths, edits: [{ path: changedPath, new_text: newText }],
    expected_sha256: { [changedPath]: sourceHash } };
  const diff = `diff --git a/${changedPath} b/${changedPath}\n--- a/${changedPath}\n+++ b/${changedPath}\n@@ -1 +1 @@\n-${oldText}\n+${newText}\n`;
  const gitStatus = ` M ${changedPath}\n`;
  const seal = { task_id: taskId, head, git_diff_sha256: hash(diff), git_status_sha256: hash(gitStatus),
    allowed_paths: paths, allowed_change_set_sha256: allowedHash, allowed_files: [{ path: changedPath, sha256: sourceHash }] };
  const evidence: Record<string, string> = {
    "status.json": json(status), "audit/review-seal.json": json(seal),
    "source-git-diff.patch": diff, "source-git-status.txt": gitStatus,
    "plan.md": `${goal}\n`, "research.md": "Synthetic review research.\n",
    "decisions.md": "Use the bounded synthetic change.\n", "execution.md": "One synthetic execution.\n",
    "verification.md": "Synthetic verification passed.\n",
    "audit/coordinator-actions.jsonl": ["research.started", "research.completed", "codex.started", "codex.completed",
      "proposal.validated", "proposal.applied", "verify.started", "verify.completed"].map(action => json({ action })).join(""),
  };
  if (code) evidence["audit/autonomous-tests.json"] = json({ result: "PASS", task_id: taskId, paths,
    source_sha256: sourceHash, test_kind: kind === "code" ? "powershell-parse" : "git-timeout-mock", observed_timeout_ms: observed });
  // The missing-evidence profile deliberately requires one additional, absent file.
  const manifest = json({ version: 1, files: Object.entries(evidence).map(([file, content]) => ({
    path: file, size: Buffer.byteLength(content), sha256: hash(content),
  })) });
  const manifestHash = hash(manifest);
  const metadata = { version: 1, task_id: taskId, source_workspace: workspaceIdentity, source_head: head,
    review_seal_status: "VALID", canonical_goal_sha256: goalHash, allowed_change_set_sha256: allowedHash,
    manifest_sha256: manifestHash };
  const resultRef = `rpc-jobs/${reviewId}/result.json`;
  const result = json({ task_id: taskId, review_job_id: reviewId, bundle_id: bundle,
    evidence_ref: resultRef, canonical_goal_sha256: goalHash, manifest_sha256: manifestHash,
    review_result: "PASS", structural_result: "PASS", semantic_result: "PASS", integrity_valid: true, done_eligible: true,
    semantic_review: { reviewed_manifest_sha256: manifestHash } });
  const reviewHash = hash(result);
  const runRef = `rpc-jobs/${runId}/autonomous-run.json`;
  const authorityRef = `rpc-jobs/authoritative/${taskId}.json`;
  const sourceStatus = path.join(sourceRoot, `.ai/tasks/${taskId}/status.json`);
  const write = (ref: string, content: string) => scratch.write(path.join(root, ref), content);
  scratch.write(path.join(sourceRoot, changedPath), sourceText);
  scratch.write(sourceStatus, evidence["status.json"]);
  for (const [name, content] of Object.entries({ ...evidence, "manifest.json": manifest, "review-bundle.json": json(metadata) })) {
    write(`${bundle}/${name}`, content);
  }
  write(resultRef, result);
  write(runRef, json({ task_id: taskId, baseline_head: head, goal_sha256: goalHash,
    codex_invocation_count: 1, review_bundle: bundleRoot, session_id: sessionId, phase: "HUMAN_FINAL_APPROVAL",
    review_job_id: reviewId, review_evidence_ref: resultRef, review_evidence_sha256: reviewHash }));
  write(`rpc-jobs/${runId}/decision-history.jsonl`, ["PLAN_CHANGE", "EXECUTE_WITH_CODEX", "READY_FOR_REVIEW"].map((decision, i) =>
    json({ decision, run_id: runId, sequence: i + 1, session_id: sessionId })).join(""));
  write(authorityRef, json({ task_id: taskId, review_job_id: reviewId, bundle_id: bundle,
    manifest_sha256: manifestHash, canonical_goal_sha256: goalHash, evidence_sha256: reviewHash }));
  write("CURRENT_REVIEW.json", json({ task_id: taskId, source_workspace: workspaceIdentity,
    review_bundle: bundle, canonical_goal_sha256: goalHash }));
  const observation: ApprovalObservation = Object.freeze({
    readSourceStatus(workspace: string, task: string) {
      if (workspace !== workspaceIdentity || task !== taskId) throw new Error("Unexpected synthetic source identity");
      return scratch.read(sourceStatus); // Ignore metadata as a path; read only the minted allocation.
    },
  });
  const approval: DoneApproval = { task_id: taskId, review_result: "PASS", done_approved: true,
    authoritative_review_id: reviewId, review_evidence_hash: reviewHash, bundle_manifest_sha256: manifestHash };
  return Object.freeze({ root, sourceRoot, sourceStatus, workspaceIdentity, repoKey, profile, taskId, runId,
    reviewId, bundle, bundleRoot, head, goalHash, resultRef, runRef, authorityRef, approval, observation,
    request: { action: "FINAL_DONE_APPROVAL", task_id: taskId, run_id: runId, authoritative_review_id: reviewId } });
}

/** Read back generated bytes, rather than trusting the builder's in-memory objects. */
export function syntheticReviewEvidence(scratch: Scratch, fixture: ReturnType<typeof writePolicyReview>): ReviewEvidence {
  assertScratch(scratch);
  const read = (ref: string) => scratch.read(path.join(fixture.root, ref)).toString("utf8");
  const evidence = new Map<string, string>();
  const manifest = JSON.parse(read(`${fixture.bundle}/manifest.json`));
  for (const { path: ref } of manifest.files) evidence.set(ref, read(`${fixture.bundle}/${ref}`));
  evidence.set("manifest.json", read(`${fixture.bundle}/manifest.json`));
  return { taskId: fixture.taskId, head: fixture.head, workspace: fixture.workspaceIdentity, bundle: fixture.bundleRoot,
    metadata: JSON.parse(read(`${fixture.bundle}/review-bundle.json`)), status: JSON.parse(evidence.get("status.json")!),
    seal: JSON.parse(evidence.get("audit/review-seal.json")!), manifest, evidence,
    autoRun: JSON.parse(read(fixture.runRef)), decisions: read(`rpc-jobs/${fixture.runId}/decision-history.jsonl`)
      .split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

/** Minimal completed ledger + published evidence, with no Git repository or engine execution. */
export function writeCompletedTask(scratch: Scratch, locations: { repo?: string; config?: string; review?: string } = {}) {
  assertScratch(scratch);
  // Validate ALL roots before the first mutation, including roots not hosting this task.
  const repoRoot = scratch.resolve(locations.repo ?? "completed/pve-doc");
  const configRoot = scratch.resolve(locations.config ?? "completed/config");
  const reviewRoot = scratch.resolve(locations.review ?? "completed/review");
  const taskId = "rpc-rc01-completed-task", bundle = "reviews/rc01-completed";
  const workspaceIdentity = "C:\\work\\pve-doc"; // Metadata-only identity; never a filesystem target.
  const integratedCommit = hash("RC-01 synthetic integrated commit").slice(0, 40);
  const completedAt = "2026-01-02T03:04:05.000Z", changedPaths = ["docs/synthetic-change.md"];
  const json = (value: unknown) => JSON.stringify(value) + "\n";
  const status = { task_id: taskId, state: "DONE", message: "Synthetic integrated completion",
    edits: changedPaths.map(file => ({ path: file })), verify_completed: true, verify_exit_code: 0,
    last_updated: completedAt, state_transition_history: [{ from: "READY_FOR_REVIEW", to: "DONE", timestamp: completedAt }] };
  const evidence = { "status.json": json(status), "verification.md": "Synthetic verification: PASS (exit 0).\n" };
  const manifest = json({ version: 1, files: Object.entries(evidence).map(([file, content]) => ({
    path: file, size: Buffer.byteLength(content), sha256: hash(content),
  })) });
  const manifestHash = hash(manifest);
  const taskRoot = path.join(repoRoot, `.ai/tasks/${taskId}`);
  const statusFile = path.join(taskRoot, "status.json"), decisionFile = path.join(taskRoot, "review-decision.json");
  const integrationFile = path.join(taskRoot, "integration-completion.json");
  const bound = { task_id: taskId, new_state: "DONE", review_result: "PASS", done_approved: true,
    review_bundle: bundle, manifest_sha256: manifestHash, completion_mode: "post_integration" };
  scratch.write(statusFile, json(status));
  scratch.write(decisionFile, json({ ...bound, reviewed_at: completedAt }));
  scratch.write(integrationFile, json({ ...bound, integrated_commit: integratedCommit, completed_at: completedAt }));
  scratch.write(path.join(configRoot, ".keep"), "");
  scratch.write(path.join(reviewRoot, "rpc-jobs/.keep"), ""); // Deliberately no registered job.
  for (const [name, content] of Object.entries({ ...evidence, "manifest.json": manifest,
    "review-bundle.json": json({ version: 1, task_id: taskId, source_workspace: workspaceIdentity, manifest_sha256: manifestHash }) })) {
    scratch.write(path.join(reviewRoot, bundle, name), content);
  }
  const reads: OrchestrationReadDependencies = Object.freeze({ reviewRoot,
    repoRoots: Object.freeze({ "pve-doc": repoRoot, "ai-orchestration-config": configRoot }) });
  return Object.freeze({ taskId, bundle, reviewRoot, repoRoot, configRoot, taskRoot, statusFile, decisionFile,
    integrationFile, workspaceIdentity, integratedCommit, completedAt, changedPaths, reads });
}
