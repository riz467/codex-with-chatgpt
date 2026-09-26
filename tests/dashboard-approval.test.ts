import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDashboard } from "../src/dashboard/server.js";
import { Collector } from "../src/dashboard/collector.js";
import { REPOS, REVIEW_ROOT } from "../src/mcp/local-gateway.js";
import { consumeHumanApproval } from "../src/mcp/autonomous-approval.js";

const fixtureId = "4b089f56be4c411db2689c3889860815";
function approvalFixture() {
  const source = path.join(REVIEW_ROOT, "rpc-jobs", `auto-${fixtureId}`, "autonomous-run.json");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-approval-"));
  const run = JSON.parse(fs.readFileSync(source, "utf8"));
  const bundle = path.relative(REVIEW_ROOT, run.review_bundle).replaceAll(path.sep, "/");
  const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
  const put = (ref: string, value: unknown) => { const file = path.join(root, ref);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  fs.cpSync(run.review_bundle, path.join(root, bundle), { recursive: true });
  const status = JSON.parse(fs.readFileSync(path.join(root, bundle, "status.json"), "utf8"));
  const goalHash = hash(status.goal);
  const meta = JSON.parse(fs.readFileSync(path.join(root, bundle, "review-bundle.json"), "utf8"));
  meta.canonical_goal_sha256 = goalHash; put(`${bundle}/review-bundle.json`, meta);
  const reviewId = "review-12345678-1234-4234-8234-123456789abc";
  const oldReview = JSON.parse(fs.readFileSync(path.join(REVIEW_ROOT, run.review_evidence_ref), "utf8"));
  put(`rpc-jobs/${reviewId}/result.json`, { ...oldReview, review_job_id: reviewId,
    evidence_ref: `rpc-jobs/${reviewId}/result.json`, canonical_goal_sha256: goalHash });
  const reviewHash = hash(fs.readFileSync(path.join(root, `rpc-jobs/${reviewId}/result.json`)));
  run.review_job_id = reviewId; run.review_evidence_sha256 = reviewHash; run.review_bundle = path.join(root, bundle);
  put(`rpc-jobs/auto-${fixtureId}/autonomous-run.json`, run);
  const taskId = `rpc-${fixtureId}`;
  put("CURRENT_REVIEW.json", { task_id: taskId, source_workspace: meta.source_workspace,
    review_bundle: bundle, canonical_goal_sha256: goalHash });
  put(`rpc-jobs/authoritative/${taskId}.json`, { task_id: taskId, review_job_id: reviewId, bundle_id: bundle,
    manifest_sha256: meta.manifest_sha256, canonical_goal_sha256: goalHash, evidence_sha256: reviewHash });
  return { root, taskId, runId: `auto-${fixtureId}`, reviewId, reviewHash, manifestHash: meta.manifest_sha256 };
}

describe("local human final approval endpoint", () => {
  it("defaults to no approval endpoint even on localhost", async () => {
    const server = createDashboard().listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
      const base = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${base}/approval/current`)).status).toBe(403);
      expect((await fetch(`${base}/approval/final`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "FINAL_DONE_APPROVAL" }) })).status).toBe(403);
    } finally { server.close(); }
  });
  it.skipIf(process.platform !== "win32" || !fs.existsSync(path.join(REVIEW_ROOT, "rpc-jobs", `auto-${fixtureId}`)))(
    "requires local browser session, exact current Review and a single manual action; never completes task", async () => {
      const fixture = approvalFixture();
      const app = createDashboard(new Collector(REPOS, fixture.root), true);
      const server = app.listen(0, "127.0.0.1");
      try {
        await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
        const address = server.address(); if (!address || typeof address === "string") throw new Error("no loopback listener");
        const base = `http://127.0.0.1:${address.port}`;
        const candidate = await fetch(`${base}/approval/current`, { headers: { "Sec-Fetch-Site": "same-origin" } });
        expect(candidate.status).toBe(200);
        const data = await candidate.json();
        expect(data).toMatchObject({ task_id: fixture.taskId, run_id: fixture.runId, authoritative_review_id: fixture.reviewId });
        expect(data).not.toHaveProperty("approval_nonce");
        const cookie = candidate.headers.get("set-cookie")?.split(";")[0];
        const request = { action: "FINAL_DONE_APPROVAL", task_id: fixture.taskId, run_id: fixture.runId,
          authoritative_review_id: fixture.reviewId };
        const post = (body: unknown, extras: Record<string, string> = {}) => fetch(`${base}/approval/final`, { method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", Origin: base,
            Cookie: cookie ?? "", "X-Final-Approval-CSRF": data.csrf, ...extras }, body: JSON.stringify(body) });
        expect((await post(request, { Origin: "http://evil.invalid" })).status).toBe(403);
        expect((await post(request, { "X-Final-Approval-CSRF": "0".repeat(64) })).status).toBe(403);
        expect((await post({ ...request, authoritative_review_id: "review-ffffffff-ffff-4fff-8fff-ffffffffffff" })).status).toBe(409);
        const renewed = await fetch(`${base}/approval/current`, { headers: { "Sec-Fetch-Site": "same-origin" } });
        const token = await renewed.json(), renewedCookie = renewed.headers.get("set-cookie")?.split(";")[0];
        const approved = await post(request, { Cookie: renewedCookie ?? "", "X-Final-Approval-CSRF": token.csrf });
        expect(approved.status).toBe(201);
        expect(await approved.json()).toMatchObject({ task_id: fixture.taskId, approved: true });
        expect((await post(request, { Cookie: renewedCookie ?? "", "X-Final-Approval-CSRF": token.csrf })).status).toBe(403);
        const approval = { task_id: fixture.taskId, review_result: "PASS" as const, done_approved: true as const,
          review_evidence_hash: fixture.reviewHash, bundle_manifest_sha256: fixture.manifestHash, authoritative_review_id: fixture.reviewId };
        consumeHumanApproval(fixture.root, fixture.taskId, approval);
        expect(() => consumeHumanApproval(fixture.root, fixture.taskId, approval)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
        expect(fs.existsSync(path.join("C:\\work\\autonomous-semantic-accepted-fixture", ".ai", "tasks", fixture.taskId, "review-decision.json"))).toBe(false);
      } finally { server.close(); }
    });
});
