import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GatewayError, REVIEW_ROOT, safePath, verifyBundleIntegrity } from "./local-gateway.js";
import { getReviewProfile, reviewProfiles } from "./review-profiles.js";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const taskPattern = /^rpc-[a-f0-9]{32}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const runPattern = /^auto-[a-f0-9]{32}$/;
export type DoneApproval = {
  task_id: string; review_result: "PASS"; review_evidence_hash: string;
  bundle_manifest_sha256: string; authoritative_review_id: string; done_approved: true;
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
function reject(): never { throw new Error("AUTONOMOUS_APPROVAL_REJECTED"); }

/** Trusted in-process observation only; never accepted from approval input or transport config. */
export interface ApprovalObservation {
  readSourceStatus(workspace: string, taskId: string): Buffer;
}
const productionObservation: ApprovalObservation = Object.freeze({
  readSourceStatus: (workspace: string, taskId: string) =>
    fs.readFileSync(safePath(workspace, `.ai/tasks/${taskId}/status.json`)),
});

function approvalDirectory(root: string, taskId: string) { return safePath(root, `rpc-jobs/human-approvals/${taskId}`); }
function withTaskLock<T>(root: string, taskId: string, action: () => T): T {
  const lockFile = safePath(root, `rpc-jobs/review-locks/${taskId}.lock`);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let lock: number;
  try { lock = fs.openSync(lockFile, "wx"); } catch { reject(); }
  try { return action(); } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
}

/** Historical/candidate evidence validation only; not CT700 approval or completion authority. */
export function validateDoneApproval(input: unknown, repoKey: string, root = REVIEW_ROOT, observation: ApprovalObservation = productionObservation) {
  if (!input || typeof input !== "object" || Array.isArray(input)) reject();
  const approval = input as Record<string, unknown>;
  const fields = ["task_id", "review_result", "review_evidence_hash", "bundle_manifest_sha256", "authoritative_review_id", "done_approved"];
  if (Object.keys(approval).sort().join("|") !== fields.sort().join("|") ||
      typeof approval.task_id !== "string" || !taskPattern.test(approval.task_id) ||
      approval.review_result !== "PASS" || approval.done_approved !== true ||
      typeof approval.review_evidence_hash !== "string" || !shaPattern.test(approval.review_evidence_hash) ||
      typeof approval.bundle_manifest_sha256 !== "string" || !shaPattern.test(approval.bundle_manifest_sha256) ||
      typeof approval.authoritative_review_id !== "string" || !/^review-[0-9a-f-]{36}$/.test(approval.authoritative_review_id)) reject();
  const profile = getReviewProfile(repoKey);
  try {
    const taskId = approval.task_id;
    const current = read(safePath(root, "CURRENT_REVIEW.json"));
    const authoritative = read(safePath(root, `rpc-jobs/authoritative/${taskId}.json`));
    const bundle = current.review_bundle;
    if (typeof bundle !== "string" || !/^reviews\/[a-zA-Z0-9._-]+$/.test(bundle) || bundle.includes("..") ||
        current.task_id !== taskId || current.source_workspace !== profile.workspace ||
        authoritative.task_id !== taskId || authoritative.bundle_id !== bundle ||
        authoritative.review_job_id !== approval.authoritative_review_id ||
        authoritative.evidence_sha256 !== approval.review_evidence_hash ||
        authoritative.manifest_sha256 !== approval.bundle_manifest_sha256 ||
        !verifyBundleIntegrity(bundle, root).valid) reject();
    const metadata = read(safePath(root, `${bundle}/review-bundle.json`));
    const status = read(safePath(root, `${bundle}/status.json`));
    const live = JSON.parse(observation.readSourceStatus(profile.workspace, taskId).toString("utf8")) as Record<string, unknown>;
    const run = read(safePath(root, `rpc-jobs/auto-${taskId.slice(4)}/autonomous-run.json`));
    const reviewFile = safePath(root, `rpc-jobs/${approval.authoritative_review_id}/result.json`);
    const bytes = fs.readFileSync(reviewFile);
    const review = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const goalHash = typeof status.goal === "string" ? digest(status.goal) : null;
    if (digest(bytes) !== approval.review_evidence_hash || metadata.manifest_sha256 !== approval.bundle_manifest_sha256 ||
        metadata.task_id !== taskId || metadata.source_workspace !== profile.workspace ||
        metadata.canonical_goal_sha256 !== goalHash || current.canonical_goal_sha256 !== goalHash ||
        authoritative.canonical_goal_sha256 !== goalHash || review.canonical_goal_sha256 !== goalHash ||
        run.goal_sha256 !== goalHash || run.review_job_id !== approval.authoritative_review_id ||
        run.review_evidence_sha256 !== approval.review_evidence_hash || run.phase !== "HUMAN_FINAL_APPROVAL" ||
        run.review_bundle !== path.join(root, bundle.replaceAll("/", path.sep)) ||
        status.task_id !== taskId || live.task_id !== taskId || live.state !== "READY_FOR_REVIEW" ||
        digest(observation.readSourceStatus(profile.workspace, taskId)) !==
          digest(fs.readFileSync(safePath(root, `${bundle}/status.json`))) ||
        review.task_id !== taskId || review.review_job_id !== approval.authoritative_review_id ||
        review.bundle_id !== bundle || review.manifest_sha256 !== approval.bundle_manifest_sha256 ||
        review.review_result !== "PASS" || review.structural_result !== "PASS" || review.semantic_result !== "PASS" ||
        review.integrity_valid !== true || review.done_eligible !== true ||
        review.semantic_review === null || typeof review.semantic_review !== "object" ||
        (review.semantic_review as Record<string, unknown>).reviewed_manifest_sha256 !== approval.bundle_manifest_sha256) reject();
    return { task_id: taskId, repo: profile.workspace, bundle, review_id: approval.authoritative_review_id };
  } catch { reject(); }
}

/** Read-only historical candidate inspection; CURRENT_REVIEW does not confer RC-02 currentness authority. */
export function currentApprovalCandidate(root = REVIEW_ROOT, observation: ApprovalObservation = productionObservation) {
  try {
    const pointer = read(safePath(root, "CURRENT_REVIEW.json"));
    const taskId = pointer.task_id;
    if (typeof taskId !== "string" || !taskPattern.test(taskId)) reject();
    const matches = Object.entries(reviewProfiles).filter(([, profile]) => profile.workspace === pointer.source_workspace);
    if (matches.length !== 1) reject();
    const authority = read(safePath(root, `rpc-jobs/authoritative/${taskId}.json`));
    const approval = { task_id: taskId, review_result: "PASS" as const,
      review_evidence_hash: authority.evidence_sha256, bundle_manifest_sha256: authority.manifest_sha256,
      authoritative_review_id: authority.review_job_id, done_approved: true as const };
    validateDoneApproval(approval, matches[0][0], root, observation);
    const runId = `auto-${taskId.slice(4)}`;
    const status = read(safePath(root, `${pointer.review_bundle}/status.json`));
    return { ...approval, run_id: runId, canonical_goal_hash: authority.canonical_goal_sha256 as string,
      goal: status.goal as string, repo: matches[0][0] };
  } catch { reject(); }
}

/** Dashboard-only write. No model or MCP route invokes this function. */
export function issueHumanDoneApproval(input: unknown, root = REVIEW_ROOT, observation: ApprovalObservation = productionObservation) {
  if (!input || typeof input !== "object" || Array.isArray(input)) reject();
  const request = input as Record<string, unknown>;
  if (Object.keys(request).sort().join("|") !== ["action", "authoritative_review_id", "run_id", "task_id"].sort().join("|") ||
      request.action !== "FINAL_DONE_APPROVAL" || typeof request.task_id !== "string" || !taskPattern.test(request.task_id) ||
      typeof request.run_id !== "string" || !runPattern.test(request.run_id) ||
      typeof request.authoritative_review_id !== "string") reject();
  return withTaskLock(root, request.task_id, () => {
    const current = currentApprovalCandidate(root, observation);
    if (current.task_id !== request.task_id || current.run_id !== request.run_id ||
        current.authoritative_review_id !== request.authoritative_review_id) reject();
    const dir = approvalDirectory(root, current.task_id);
    fs.mkdirSync(dir, { recursive: true });
    const currentFile = safePath(root, `rpc-jobs/human-approvals/${current.task_id}/current.json`);
    if (fs.existsSync(currentFile)) {
      const previous = read(currentFile);
      if (previous.authoritative_review_id === current.authoritative_review_id &&
          previous.review_evidence_hash === current.review_evidence_hash) reject(); // no duplicate approval/nonce
    }
    const { repo: _repo, goal: _goal, ...bound } = current;
    const record = { ...bound, approved_at: new Date().toISOString(), approval_nonce: randomBytes(32).toString("hex") };
    const auditText = JSON.stringify(record);
    const auditFile = safePath(root, `rpc-jobs/human-approvals/${current.task_id}/audit.jsonl`);
    const fd = fs.openSync(auditFile, "a");
    try { fs.writeSync(fd, auditText + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const staged = safePath(root, `rpc-jobs/human-approvals/${current.task_id}/${randomUUID()}.tmp`);
    fs.writeFileSync(staged, JSON.stringify({ ...record, audit_sha256: digest(auditText) }), { flag: "wx" });
    fs.renameSync(staged, currentFile);
    return { task_id: current.task_id, run_id: current.run_id, authoritative_review_id: current.authoritative_review_id,
      approved_at: record.approved_at, approved: true as const }; // nonce and hash never enter HTTP/SSE
  });
}

export function consumeHumanApproval(root: string, taskId: string, expected: DoneApproval, observation: ApprovalObservation = productionObservation) {
  const candidate = currentApprovalCandidate(root, observation);
  if (candidate.task_id !== taskId || Object.entries(expected).some(([key, value]) => candidate[key as keyof typeof candidate] !== value)) reject();
  const dir = approvalDirectory(root, taskId);
  const record = read(safePath(dir, "current.json"));
  const nonce = record.approval_nonce;
  if (typeof nonce !== "string" || !shaPattern.test(nonce) ||
      record.run_id !== `auto-${taskId.slice(4)}` || record.canonical_goal_hash !==
        read(safePath(root, "CURRENT_REVIEW.json")).canonical_goal_sha256 ||
      Object.entries(expected).some(([key, value]) => record[key] !== value) ||
      typeof record.approved_at !== "string" || !Number.isFinite(Date.parse(record.approved_at)) ||
      typeof record.audit_sha256 !== "string" || !shaPattern.test(record.audit_sha256)) reject();
  const auditFile = safePath(dir, "audit.jsonl");
  if (!fs.existsSync(auditFile) || fs.statSync(auditFile).size > 65536 ||
      !fs.readFileSync(auditFile, "utf8").split("\n").some(line => line && digest(line) === record.audit_sha256 &&
        JSON.stringify(JSON.parse(line)) === JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "audit_sha256"))))) reject();
  const consumed = safePath(dir, `consumed-${nonce}.json`);
  let fd: number;
  try { fd = fs.openSync(consumed, "wx"); } catch { reject(); }
  try { fs.writeSync(fd, JSON.stringify({ task_id: taskId, approval_nonce: nonce, consumed_at: new Date().toISOString() })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

/** Compatibility endpoint: reject before reading production Review or consuming local approval. */
export function completeCurrentAutonomous(_input: unknown): never {
  throw new GatewayError("LEGACY_COMPLETION_DISABLED", "Legacy autonomous authoritative completion is disabled; Dashboard-local approval is not CT700 Human Approval. An RC-02 bound request is required.");
}
