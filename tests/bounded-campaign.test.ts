import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BoundedTasks, type Contract, type Worker } from "../src/mcp/bounded-task.js";
import { BoundedCampaigns } from "../src/mcp/bounded-campaign.js";
import { createBoundedLifecycleController, recoverFailedBoundedWorkspace } from "../src/mcp/server.js";
import { prepareBoundedCommit, commitBoundedPatch, getBoundedCommitStatus } from "../src/mcp/typed-actions.js";
import type { semanticSession } from "../src/mcp/semantic-session.js";
import type { Workspace } from "../src/workspace/manager.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture(needsWork: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-campaign-")); roots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "core.autocrlf", "false");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@local.invalid");
  fs.writeFileSync(path.join(repo, "demo.txt"), "value 0\n");
  git("add", "."); git("commit", "-qm", "seed"); const head = git("rev-parse", "HEAD");
  let proposals = 0, reviews = 0, finalizations = 0;
  const worker: Worker = async (_repo, prompt) => {
    const input = JSON.parse(prompt.slice(prompt.indexOf("Contract: ") + 10));
    proposals++;
    return { worker: "opencode", session_id: `ses_fixture${proposals}`, execution_id: `msg_fixture${proposals}`,
      provider: "fixture", model: "fixture", tools: 0, usage: null, state: "completed", output: JSON.stringify({ edits: [{
        path: "demo.txt", expected_sha256: input.current[0].sha256, start_line: 1, delete_count: 1, new_text: `value ${proposals}\n`,
      }] }) };
  };
  const reviewer: typeof semanticSession = async () => {
    reviews++; const pass = reviews > needsWork;
    return { decision: { review_result: pass ? "PASS" : "NEEDS_WORK", reason_category: pass ? "GOAL_SATISFIED" : "BEHAVIOR_MISMATCH",
      summary: "Fixture independent decision", evidence_refs: [1, 2, 3, 4], unresolved_issues: pass ? [] : ["Improve fixture behavior"] },
      session_id: `ses_review${reviews}`, reviewer_profile: "fixture", reviewer_agent_sha256: "a".repeat(64), model: null, provider: null, usage: null };
  };
  const tasks = new BoundedTasks({ fixture: fs.realpathSync.native(repo) }, path.join(root, "tasks"), worker);
  const commitRoot = path.join(root, "commit"); fs.mkdirSync(commitRoot);
  const lifecycle = () => createBoundedLifecycleController(tasks, repo, id => {
    prepareBoundedCommit(tasks, id, commitRoot); commitBoundedPatch(tasks, id, commitRoot, repo); finalizations++;
  }, reviewer);
  const controller = lifecycle();
  const recover = (id: string) => tasks.withRecoveryLock(id, task => {
    if (!tasks.verifiedExhaustedWorkspaceDiff(id)) throw new Error("RECOVERY_PROOF_MISSING");
    recoverFailedBoundedWorkspace(tasks, { root: repo } as Workspace, task, repo);
  });
  const committed = (id: string) => getBoundedCommitStatus(tasks, id, commitRoot).state === "COMMITTED";
  const campaigns = new BoundedCampaigns(path.join(root, "campaigns"), tasks, controller, recover, committed);
  const contract: Contract = { repo: "fixture", goal: "Improve fixture", edit_paths: ["demo.txt"], acceptance_criteria: ["Improved"],
    task_kind: "text_change", execution_profile: "tracked_utf8_text", worker: "opencode", codex: { allowed: false, max_calls: 0 },
    max_revisions: 3, timeout_ms: 600000 };
  return { root, repo, git, head, tasks, campaigns, contract, lifecycle, recover, committed,
    counts: () => ({ proposals, reviews, finalizations }) };
}
async function complete(campaigns: BoundedCampaigns, id: string) {
  for (let i = 0; i < 60; i++) {
    campaigns.tick(id);
    const c = campaigns.status(id);
    if (["COMMITTED", "STOPPED"].includes(c.state)) return c;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Fixture campaign did not settle");
}
it.each([0, 1, 3])("finishes a real Git fixture with %i NEEDS_WORK decisions without manual resume", async count => {
  const f = fixture(count), started = f.campaigns.start(f.contract);
  const result = await complete(f.campaigns, started.task_id);
  expect(result.state, JSON.stringify(result)).toBe("COMMITTED");
  expect(result.task_ids).toHaveLength(count === 3 ? 2 : 1);
  expect(f.git("rev-list", "--count", `${f.head}..HEAD`)).toBe("1");
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.counts()).toEqual({ proposals: count + 1, reviews: count + 1, finalizations: 1 });
  if (count === 3) expect(f.tasks.status(result.task_ids[1]).feedback.join(" ")).toContain("Replan");
}, 60000);
it("bounds repeated failure across tasks and restores only the proved fixture diff", async () => {
  const f = fixture(100), started = f.campaigns.start(f.contract);
  const result = await complete(f.campaigns, started.task_id);
  expect(result).toMatchObject({ state: "STOPPED", stop_reason: "CAMPAIGN_ATTEMPT_BUDGET_EXHAUSTED" });
  expect(result.task_ids).toHaveLength(2);
  expect(f.counts()).toEqual({ proposals: 6, reviews: 6, finalizations: 0 });
  expect(f.git("rev-parse", "HEAD")).toBe(f.head);
  expect(f.git("status", "--porcelain")).toBe("");
}, 60000);
it("rebuilds a committed campaign from disk without a second proposal or commit", async () => {
  const f = fixture(0), started = f.campaigns.start(f.contract);
  expect((await complete(f.campaigns, started.task_id)).state).toBe("COMMITTED");
  const restarted = new BoundedCampaigns(path.join(f.root, "campaigns"), f.tasks, f.lifecycle(), f.recover, f.committed);
  restarted.tick(started.task_id);
  expect(restarted.status(started.task_id).state).toBe("COMMITTED");
  expect(f.counts()).toEqual({ proposals: 1, reviews: 1, finalizations: 1 });
}, 30000);
it("restarts at durable pending review without rerunning the worker", async () => {
  const f = fixture(0);
  const idle = new BoundedCampaigns(path.join(f.root, "campaigns"), f.tasks,
    { lifecycleRunning: new Set(), runBoundedLifecycle: () => false }, f.recover, f.committed);
  const started = idle.start(f.contract);
  await f.tasks.execute(started.task_id);
  expect(f.tasks.status(started.task_id).state).toBe("REVIEW_PENDING");
  const restarted = new BoundedCampaigns(path.join(f.root, "campaigns"), f.tasks, f.lifecycle(), f.recover, f.committed);
  expect((await complete(restarted, started.task_id)).state).toBe("COMMITTED");
  expect(f.counts()).toEqual({ proposals: 1, reviews: 1, finalizations: 1 });
}, 30000);
