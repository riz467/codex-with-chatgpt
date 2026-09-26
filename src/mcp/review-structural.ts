import type { ReviewProfile } from "./review-profiles.js";
import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
export type ReviewEvidence = {
  taskId: string; head: string; workspace: string; bundle: string; metadata: Row; status: Row; seal: Row;
  manifest: { files?: { path: string; sha256: string }[] }; evidence: Map<string, string>;
  autoRun: Row; decisions: Row[];
};
export function structuralVerdict(integrityValid: boolean, issues: readonly string[]) {
  const unique = [...new Set(integrityValid ? issues : ["BUNDLE_INTEGRITY_INVALID", ...issues])].slice(0, 8);
  return { review_result: unique.length ? "NEEDS_WORK" as const : "PASS" as const,
    integrity_valid: integrityValid, done_eligible: unique.length === 0,
    reason_category: unique[0] ?? "REVIEW_PASS", unresolved_issues: unique };
}
const hashPattern = /^[a-f0-9]{64}$/;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Pure, Review-owned structural checks. No source workspace writes, model calls or completion actions. */
export function evaluateStructural(input: ReviewEvidence, profile: ReviewProfile): string[] {
  const { taskId, head, workspace, bundle, metadata, status, seal, manifest, evidence, autoRun, decisions } = input;
  const issues: string[] = [];
  const required = profile.requiredEvidence;
  if (required.some((ref) => !evidence.get(ref)?.trim())) issues.push("EVIDENCE_MISSING");
  const manifestHash = metadata.manifest_sha256;
  if (metadata.task_id !== taskId || metadata.source_workspace !== workspace || metadata.source_head !== head ||
      metadata.review_seal_status !== "VALID" || typeof manifestHash !== "string" || !hashPattern.test(manifestHash)) issues.push("BASELINE_MISMATCH");
  if (status.task_id !== taskId || status.state !== "READY_FOR_REVIEW" || status.approval_required !== false) issues.push("TASK_STATE_INVALID");
  if (status.baseline_head !== head || seal.head !== head) issues.push("BASELINE_MISMATCH");
  if (typeof status.goal !== "string" || !status.goal.trim() ||
      createHash("sha256").update(status.goal, "utf8").digest("hex") !== autoRun.goal_sha256 ||
      metadata.canonical_goal_sha256 !== autoRun.goal_sha256) issues.push("BASELINE_MISMATCH");
  if (status.verify_completed !== true || status.verify_exit_code !== 0) issues.push("VERIFY_FAILED");
  if (status.coordinator_audit_complete !== true || status.codex_attempts !== 1) issues.push("AUDIT_INCOMPLETE");
  if (!Array.isArray(status.unexpected_changes) || status.unexpected_changes.length) issues.push("UNEXPECTED_CHANGE");
  const fileHash = (name: string) => manifest.files?.find((item) => item.path === name)?.sha256;
  if (seal.task_id !== taskId || seal.git_diff_sha256 !== fileHash("source-git-diff.patch") ||
      seal.git_status_sha256 !== fileHash("source-git-status.txt") ||
      !Array.isArray(seal.allowed_paths) || !equal(seal.allowed_paths, status.allowed_paths) ||
      seal.allowed_change_set_sha256 !== metadata.allowed_change_set_sha256) issues.push("SEAL_INVALID");
  const diff = evidence.get("source-git-diff.patch") ?? "";
  const diffPaths = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[1]);
  const edits = Array.isArray(status.edits) ? status.edits as Row[] : [];
  const scoped = Array.isArray(status.edit_paths) ? status.edit_paths as unknown[] : [];
  if (!diffPaths.length || diffPaths.length > profile.maxChangedFiles ||
      new Set(diffPaths).size !== diffPaths.length || !equal(diffPaths, scoped) ||
      !equal(diffPaths, edits.map((edit) => edit.path)) ||
      diffPaths.some((p) => !profile.allowedPath.test(p) || !diff.includes(` b/${p}`))) issues.push("SCOPE_MISMATCH");
  for (const p of diffPaths) {
    const expected = (status.expected_sha256 as Row | undefined)?.[p];
    const sealed = Array.isArray(seal.allowed_files) ? (seal.allowed_files as Row[]).find((row) => row.path === p)?.sha256 : undefined;
    if (typeof expected !== "string" || !hashPattern.test(expected) || expected !== sealed) issues.push("SEAL_INVALID");
  }
  const gitStatus = evidence.get("source-git-status.txt") ?? "";
  const statusPaths = gitStatus.split("\n").filter(Boolean).map((line) => line.slice(3).trim());
  if (statusPaths.some((p) => !scoped.includes(p) && !p.startsWith(`.ai/tasks/${taskId}/`)) ||
      diffPaths.some((p) => !statusPaths.includes(p))) issues.push("UNEXPECTED_CHANGE");
  const audit = evidence.get("audit/coordinator-actions.jsonl") ?? "";
  let actions: string[] = [];
  try { actions = audit.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as Row).action as string); }
  catch { issues.push("AUDIT_INCOMPLETE"); }
  for (const action of ["research.started", "research.completed", "codex.started", "codex.completed",
    "proposal.validated", "proposal.applied", "verify.started", "verify.completed"]) {
    if (!actions.includes(action)) issues.push("AUDIT_INCOMPLETE");
  }
  const autoRunId = `auto-${taskId.slice(4)}`;
  if (autoRun.task_id !== taskId || autoRun.baseline_head !== head || autoRun.codex_invocation_count !== 1 ||
      autoRun.review_bundle !== bundle || !["REVIEW_HANDOFF", "REVIEWING", "HUMAN_FINAL_APPROVAL"].includes(String(autoRun.phase)) ||
      decisions.length < 3 || !equal(decisions.slice(0, 3).map((d) => d.decision), ["PLAN_CHANGE", "EXECUTE_WITH_CODEX", "READY_FOR_REVIEW"]) ||
      decisions.some((d, i) => d.run_id !== autoRunId || d.sequence !== i + 1 || d.session_id !== autoRun.session_id)) issues.push("AUDIT_INCOMPLETE");
  if (profile.profile === "generic-code-change") {
    try {
      const record = JSON.parse(evidence.get("audit/autonomous-tests.json") ?? "") as Row;
      if (record.result !== "PASS" || record.task_id !== taskId || !equal(record.paths, diffPaths) ||
          record.source_sha256 !== (status.expected_sha256 as Row)?.[diffPaths[0]] || !profile.acceptedTestKinds?.includes(String(record.test_kind))) issues.push("VERIFY_FAILED");
    } catch { issues.push("EVIDENCE_MISSING"); }
  }
  if (profile.policyCheck && !profile.policyCheck(edits, diff)) issues.push("POLICY_VIOLATION");
  return [...new Set(issues)];
}
