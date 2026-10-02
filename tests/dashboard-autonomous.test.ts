import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { Collector } from "../src/dashboard/collector.js";
import { createDashboard } from "../src/dashboard/server.js";
import { reviewProfiles } from "../src/mcp/review-profiles.js";
import { createScratch, type Scratch } from "./support/scratch.js";
import { writePolicyReview } from "./support/synthetic-review.js";

describe("read-only autonomous dashboard projection", () => {
  let scratch: Scratch;
  let fixture: ReturnType<typeof writePolicyReview>;
  beforeEach(() => {
    scratch = createScratch();
    fixture = writePolicyReview(scratch, "approval");
  });
  afterEach(() => scratch?.dispose());

  function project(phase: "HUMAN_FINAL_APPROVAL" | "ESCALATE", semantic: "PASS" | "NEEDS_WORK", done = false) {
    const runFile = path.join(fixture.root, fixture.runRef);
    const run = JSON.parse(scratch.read(runFile).toString("utf8"));
    scratch.remove(runFile);
    scratch.write(runFile, JSON.stringify({ ...run, run_id: fixture.runId, repo_key: fixture.repoKey, phase,
      structural_result: "PASS", semantic_result: semantic,
      token_usage_total: { input: 17, output: 8 }, codex_usage: { input: 4, output: 2 },
      review_token_usage: { input: 9, output: 3, cache_read: 2 }, started_at: "2026-01-02T03:04:05Z" }));
    scratch.write(`${fixture.root}/rpc-jobs/${fixture.runId}/result.json`, JSON.stringify({ state: phase, review_result: semantic }));
    scratch.write(`${fixture.root}/rpc-jobs/${fixture.runId}/events.jsonl`, JSON.stringify({
      event_type: "human.final_approval_waiting", timestamp: "2026-01-02T03:04:06Z" }) + "\n");
    if (done) {
      const status = JSON.parse(scratch.read(fixture.sourceStatus).toString("utf8"));
      scratch.remove(fixture.sourceStatus);
      scratch.write(fixture.sourceStatus, JSON.stringify({ ...status, state: "DONE" }));
    }
    const queueRoot = scratch.resolve("queue");
    const roots = { "pve-doc": fixture.sourceRoot, "ai-orchestration-config": scratch.resolve("config") };
    // Only this instance receives the scratch mapping. No module or production profile mutation.
    const syntheticProfiles = { [fixture.repoKey]: { workspace: fixture.sourceRoot } };
    const collector = new Collector(roots, fixture.root, queueRoot, undefined, syntheticProfiles);
    const runs = collector.autonomousRuns(20);
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe(fixture.runId);
    return { run: runs[0], collector, syntheticProfiles };
  }

  it("projects sealed lifecycle and synthetic usage without promoting approval to DONE", () => {
    const { run } = project("HUMAN_FINAL_APPROVAL", "PASS");
    expect(run).toMatchObject({ phase: "HUMAN_FINAL_APPROVAL", actor: "HUMAN", human_action_required: true,
      done: false, review_phase: { structural: "PASS", semantic: "PASS" } });
    expect(run.usage).toMatchObject({ opencode: { input: 17, output: 8 }, codex_invocations: 1,
      review: { input: 9, output: 3, cache_read: 2 } });
    expect(run.events.some(event => event.event_type === "human.final_approval_waiting")).toBe(true);
  });
  it("shows semantic NEEDS_WORK without inferring DONE from structural PASS", () => {
    expect(project("ESCALATE", "NEEDS_WORK").run).toMatchObject({ phase: "ESCALATE", done: false,
      human_action_required: false, review_phase: { structural: "PASS", semantic: "NEEDS_WORK" } });
  });
  it("marks a run DONE only when the scratch ledger says DONE", () => {
    expect(project("HUMAN_FINAL_APPROVAL", "PASS", true).run).toMatchObject({ done: true, human_action_required: false });
  });
  it("keeps the production profile default and isolates the explicit scratch mapping to one Collector", () => {
    const { collector, syntheticProfiles } = project("HUMAN_FINAL_APPROVAL", "PASS", true);
    expect(Reflect.get(new Collector(), "autonomousReviewProfiles")).toBe(reviewProfiles);
    expect(Reflect.get(collector, "autonomousReviewProfiles")).toBe(syntheticProfiles);
    expect(Reflect.get(new Collector(), "autonomousReviewProfiles")).toBe(reviewProfiles);
    expect(reviewProfiles[fixture.repoKey].workspace).toBe(fixture.workspaceIdentity);
  });
  it("does not accept a review profile override from a public Dashboard request", async () => {
    const { collector } = project("HUMAN_FINAL_APPROVAL", "PASS", true);
    const server = createDashboard(collector).listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/status?reviewProfiles=${encodeURIComponent(JSON.stringify({ [fixture.repoKey]: { workspace: scratch.resolve("other") } }))}`,
        { headers: { "x-review-workspace": encodeURIComponent(scratch.resolve("other")) } });
      expect(response.status).toBe(200);
      expect((await response.json()).autonomous_runs).toMatchObject([{ run_id: fixture.runId, done: true }]);
      expect(Reflect.get(new Collector(), "autonomousReviewProfiles")).toBe(reviewProfiles);
    } finally { server.close(); }
  });
});
