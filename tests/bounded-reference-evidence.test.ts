import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { BoundedTasks, type Contract, type Worker } from "../src/mcp/bounded-task.js";
import { reviewWithReferences } from "../src/mcp/bounded-semantic-review.js";
import type { semanticSession } from "../src/mcp/semantic-session.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reference-evidence-")); roots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(path.join(repo, "src/mcp"), { recursive: true });
  fs.mkdirSync(path.join(repo, "tests"));
  fs.writeFileSync(path.join(repo, "src/mcp/server.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "tests/bounded-task.test.ts"), "// test evidence\n".repeat(250));
  fs.writeFileSync(path.join(repo, "secret.txt"), "excluded");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-qm", "seed");
  const worker: Worker = async () => ({ worker: "opencode", session_id: "ses_fixture", execution_id: "msg_fixture",
    provider: "fixture", model: "fixture", tools: 0, usage: null, state: "completed",
    output: JSON.stringify({ edits: [{ path: "src/mcp/server.ts", old_text: "value = 1", new_text: "value = 2" }] }) });
  const tasks = new BoundedTasks({ fixture: fs.realpathSync.native(repo) }, path.join(root, "tasks"), worker,
    { fixture: "tracked_typescript_control_plane" }, (_repo, profile, paths) => ({ profile, paths, passed: true, tests_run: 1, checks: [] }));
  const contract: Contract = { repo: "fixture", goal: "Update value", edit_paths: ["src/mcp/server.ts"], acceptance_criteria: ["Value is two"],
    task_kind: "text_change", execution_profile: "tracked_typescript_control_plane", worker: "opencode", codex: { allowed: false, max_calls: 0 },
    max_revisions: 3, timeout_ms: 600000 };
  const started = tasks.start(contract); await tasks.execute(started.task_id);
  return { root, repo, git, tasks, id: started.task_id };
}
it("seals existing test text to baseline SHA, hashes and ranges without leaking adjacent files", async () => {
  const f = await fixture(), evidence = f.tasks.referenceEvidence(f.id, 1);
  const test = evidence.references.find(r => r.path === "tests/bounded-task.test.ts")!;
  expect(test).toMatchObject({ commit_sha: f.git("rev-parse", "HEAD"), start_line: 1, end_line: 250, total_lines: 250 });
  expect(test.file_sha256).toBe(createHash("sha256").update(test.content).digest("hex"));
  expect(evidence.references.some(r => r.path === "secret.txt")).toBe(false);
  fs.writeFileSync(path.join(f.repo, test.path), "external mutation");
  expect(f.tasks.referenceEvidence(f.id, 1)).toEqual(evidence);
  fs.appendFileSync(path.join(f.root, "tasks", f.id, "revision-1-references.json"), " ");
  expect(() => f.tasks.referenceEvidence(f.id, 1)).toThrow("MANIFEST_MISMATCH");
});
it("reacquires expanded evidence without consuming a revision and durably bounds missing evidence", async () => {
  const f = await fixture(); const prompts: string[] = [];
  const reviewer: typeof semanticSession = async prompt => {
    prompts.push(prompt);
    return { decision: { review_result: "NEEDS_WORK", reason_category: "EVIDENCE_INSUFFICIENT", summary: "Need more",
      evidence_refs: [4], unresolved_issues: ["Required test unavailable"] }, session_id: "ses_independent", reviewer_profile: "fixture",
      reviewer_agent_sha256: "0".repeat(64), model: null, provider: null, usage: null };
  };
  await expect(reviewWithReferences(f.tasks, f.id, 1, "contract", "ses_fixture", reviewer)).rejects.toThrow("SEMANTIC_EVIDENCE_EXHAUSTED");
  expect(prompts).toHaveLength(2);
  expect(prompts[1].length).toBeGreaterThan(prompts[0].length);
  expect(f.tasks.status(f.id)).toMatchObject({ state: "REVIEW_PENDING", revisions: [{ revision: 1 }] });
  await expect(reviewWithReferences(f.tasks, f.id, 1, "contract", "ses_fixture", reviewer)).rejects.toThrow("SEMANTIC_EVIDENCE_EXHAUSTED");
  expect(prompts).toHaveLength(2);
});
it("recovers one crashed review claim and reuses its sealed result after a second restart", async () => {
  const f = await fixture();
  expect(f.tasks.claimSemanticAttempt(f.id, 1, 1)).toBe(true); // controller died before result
  let calls = 0;
  const reviewer: typeof semanticSession = async () => {
    calls++;
    return { decision: { review_result: "PASS", reason_category: "GOAL_SATISFIED", summary: "Fixture satisfies goal",
      evidence_refs: [1, 2, 3, 4], unresolved_issues: [] }, session_id: "ses_independent", reviewer_profile: "fixture",
      reviewer_agent_sha256: "0".repeat(64), model: null, provider: null, usage: null };
  };
  const result = await reviewWithReferences(f.tasks, f.id, 1, "contract", "ses_fixture", reviewer);
  expect(result.decision.review_result).toBe("PASS");
  expect(await reviewWithReferences(f.tasks, f.id, 1, "contract", "ses_fixture", reviewer)).toEqual(result);
  expect(calls).toBe(1);
  const file = path.join(f.root, "tasks", f.id, "revision-1-semantic-result-2.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8")); record.result.decision.summary = "changed";
  fs.writeFileSync(file, JSON.stringify(record));
  await expect(reviewWithReferences(f.tasks, f.id, 1, "contract", "ses_fixture", reviewer)).rejects.toThrow("REVIEW_BINDING_INVALID");
});
