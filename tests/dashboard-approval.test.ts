import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createDashboard } from "../src/dashboard/server.js";
import { Collector } from "../src/dashboard/collector.js";
import { consumeHumanApproval } from "../src/mcp/autonomous-approval.js";
import { createScratch } from "./support/scratch.js";
import { writePolicyReview } from "./support/synthetic-review.js";

function approvalFixture() {
  const scratch = createScratch();
  const fixture = writePolicyReview(scratch, "approval");
  const collector = new Collector({ "pve-doc": scratch.resolve("repos/pve-doc"),
    "ai-orchestration-config": scratch.resolve("repos/config") }, fixture.root, scratch.resolve("queue"));
  return { scratch, fixture, collector };
}

describe("local human final approval endpoint", () => {
  it("keeps the Dashboard source renderer declaration", () => {
    const source = fs.readFileSync(new URL("../src/dashboard/public/app.js", import.meta.url), "utf8");
    expect(source).toContain("function renderSource(task, current) {");
  });
  it("exposes only static, fail-closed authority capabilities regardless of fixture approval or request input", async () => {
    const expected = {
      local_review: "projection_only", local_done: "projection_only",
      independent_review_authority_connected: false, signed_approver_integration_connected: false,
      finalizer_connected: false, authoritative_done_available: false
    };
    for (const fixtureApprovalEnabled of [false, true]) {
      const server = createDashboard(undefined, fixtureApprovalEnabled).listen(0, "127.0.0.1");
      try {
        await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
        const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
        const base = `http://127.0.0.1:${address.port}/api/authority-status`;
        for (const url of [base, `${base}?connected=true&fixture_approval_enabled=true`]) {
          const response = await fetch(url);
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("set-cookie")).toBeNull();
          expect(await response.json()).toEqual(expected);
        }
        expect((await fetch(base, { method: "POST" })).status).toBe(405);
      } finally { server.close(); }
    }
    const source = fs.readFileSync(new URL("../src/dashboard/public/app.js", import.meta.url), "utf8");
    expect(source).toContain("fetch('/api/authority-status'");
    expect(source).toContain("section.id = 'authority-status'");
  });
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
  it(
    "previews validated metadata in production without enabling approval writes", async () => {
      const { scratch, fixture, collector } = approvalFixture();
      const server = createDashboard(collector, false, fixture.observation).listen(0, "127.0.0.1");
      try {
        await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
        const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
        const base = `http://127.0.0.1:${address.port}`;
        const preview = await fetch(`${base}/api/approval/candidate`);
        expect(preview.status).toBe(200);
        expect(preview.headers.get("set-cookie")).toBeNull();
        const data = await preview.json();
        expect(data).toMatchObject({ task_id: fixture.taskId, run_id: fixture.runId,
          authoritative_review_id: fixture.reviewId, fixture_approval_enabled: false });
        for (const key of ["csrf", "approval_nonce", "session", "signing_evidence"]) expect(data).not.toHaveProperty(key);
        expect((await fetch(`${base}/approval/current`)).status).toBe(403);
        expect((await fetch(`${base}/approval/final`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "FINAL_DONE_APPROVAL", task_id: fixture.taskId, run_id: fixture.runId,
            authoritative_review_id: fixture.reviewId }) })).status).toBe(403);
        scratch.remove(path.join(fixture.root, "CURRENT_REVIEW.json"));
        scratch.write(path.join(fixture.root, "CURRENT_REVIEW.json"), JSON.stringify({ task_id: "rpc-stale" }));
        const stale = await fetch(`${base}/api/approval/candidate`);
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({ error: "NO_CURRENT_ELIGIBLE_REVIEW" });
      } finally { server.close(); scratch.dispose(); }
    });
  it(
    "requires local browser session, exact current Review and a single manual action; never completes task", async () => {
      const { scratch, fixture, collector } = approvalFixture();
      const app = createDashboard(collector, true, fixture.observation);
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
        const approval = fixture.approval;
        consumeHumanApproval(fixture.root, fixture.taskId, approval, fixture.observation);
        expect(() => consumeHumanApproval(fixture.root, fixture.taskId, approval, fixture.observation)).toThrow("AUTONOMOUS_APPROVAL_REJECTED");
        expect(fs.existsSync(path.join(fixture.sourceRoot, ".ai", "tasks", fixture.taskId, "review-decision.json"))).toBe(false);
      } finally { server.close(); scratch.dispose(); }
    });
});
