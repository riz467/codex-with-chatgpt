import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Collector } from "./collector.js";
import { GatewayError, safePath } from "../mcp/local-gateway.js";
import { currentApprovalCandidate, issueHumanDoneApproval, type ApprovalObservation } from "../mcp/autonomous-approval.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { startProductionBoundedTask, getProductionBoundedCampaigns, runProductionBoundedCampaigns } from "../mcp/server.js";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
// Approval is disabled in the production entrypoint until an independent
// human/AI OS trust boundary is deployed. Loopback and CSRF are not identity.
export function createDashboard(collector = new Collector(), fixtureApprovalEnabled = false, approvalObservation?: ApprovalObservation,
  startBoundedTask: typeof startProductionBoundedTask = startProductionBoundedTask, now: () => number = Date.now,
  campaigns = getProductionBoundedCampaigns) {
  const app = express();
  if (startBoundedTask === startProductionBoundedTask) runProductionBoundedCampaigns();
  app.disable("x-powered-by");
  const approvalSessions = new Map<string, { csrf: string; expires: number }>();
  const localRequest = (req: express.Request) => {
    const port = req.socket.localPort;
    const address = req.socket.remoteAddress;
    return typeof port === "number" && req.headers.host === `127.0.0.1:${port}` &&
      (address === "127.0.0.1" || address === "::ffff:127.0.0.1");
  };
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"); res.set("X-Content-Type-Options", "nosniff"); next(); });
  app.get("/api/bounded/campaigns", (req, res) => {
    if (!localRequest(req)) { res.status(403).json({ error: "LOCAL_REQUEST_REQUIRED" }); return; }
    try {
      res.json(campaigns().map(c => ({ campaign_id: c.campaign_id, state: c.state,
        current_task: c.current_task, task_ids: c.task_ids, stop_reason: c.stop_reason,
        human_action: c.human_action, impact_paths: c.impact_paths,
        started_at: "started_at" in c ? c.started_at : null,
        deadline: "deadline" in c ? c.deadline : null, authoritative_done: false })));
    } catch { res.status(503).json({ error: "CAMPAIGN_STATUS_UNAVAILABLE" }); }
  });
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/app.js", (_req, res) => res.sendFile(path.join(publicDir, "app.js")));
  app.get("/labels.js", (_req, res) => res.sendFile(path.join(publicDir, "labels.js")));
  app.get("/style.css", (_req, res) => res.sendFile(path.join(publicDir, "style.css")));
  app.get("/health.css", (_req, res) => res.sendFile(path.join(publicDir, "health.css")));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "ai-workspace-dashboard" }));
  // Static implementation capabilities, not inferred from fixtures, local state or requests.
  app.get("/api/authority-status", (_req, res) => res.json({
    local_review: "projection_only",
    local_done: "projection_only",
    independent_review_authority_connected: false,
    signed_approver_integration_connected: false,
    finalizer_connected: false,
    authoritative_done_available: false
  }));
  app.get("/api/status", async (_req, res) => res.json(await collector.snapshot()));
  app.get("/api/tasks", (_req, res) => res.json(collector.list()));
  const handle = (fn: (id: string) => unknown) => (req: express.Request, res: express.Response) => {
    try { res.json(fn(String(req.params.taskId))); }
    catch (error) { res.status(error instanceof GatewayError && error.code === "INVALID_ID" ? 400 : error instanceof GatewayError && error.code === "NOT_FOUND" ? 404 : error instanceof GatewayError && error.code === "AMBIGUOUS_TASK" ? 409 : 422).json({ error: error instanceof GatewayError ? error.code : "UNAVAILABLE" }); }
  };
  app.get("/api/tasks/:taskId", handle(id => collector.task(id)));
  app.get("/api/events/:taskId", handle(id => collector.events(id)));
  // Read-only preview: explicitly select metadata, never expose a session or write capability.
  app.get("/api/approval/candidate", (_req, res) => {
    try {
      const candidate = currentApprovalCandidate(collector.reviewRoot, approvalObservation);
      const { goal, task_id, run_id, authoritative_review_id, review_evidence_hash,
        bundle_manifest_sha256, canonical_goal_hash } = candidate;
      res.json({ goal, task_id, run_id, authoritative_review_id, review_evidence_hash,
        bundle_manifest_sha256, canonical_goal_hash, fixture_approval_enabled: fixtureApprovalEnabled });
    } catch { res.status(409).json({ error: "NO_CURRENT_ELIGIBLE_REVIEW" }); }
  });
  // Isolated fixture UI action only: no shell, retry, scope, Review or DONE write.
  // A same-user local process CAN acquire the CSRF secret; this is not provenance.
  app.get("/approval/current", (req, res) => {
    if (!fixtureApprovalEnabled) { res.status(403).json({ error: "APPROVAL_NOT_CONFIGURED" }); return; }
    if (!localRequest(req) || ![undefined, "same-origin", "none"].includes(req.headers["sec-fetch-site"] as string | undefined)) {
      res.status(403).json({ error: "LOCAL_BROWSER_REQUIRED" }); return;
    }
    try {
      const candidate = currentApprovalCandidate(collector.reviewRoot, approvalObservation);
      const session = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
      approvalSessions.set(session, { csrf, expires: Date.now() + 120_000 });
      for (const [key, value] of approvalSessions) if (value.expires <= Date.now()) approvalSessions.delete(key);
      res.cookie("final_approval_session", session, { httpOnly: true, sameSite: "strict", path: "/approval", maxAge: 120_000 });
      res.json({ ...candidate, csrf });
    } catch { res.status(409).json({ error: "NO_CURRENT_ELIGIBLE_REVIEW" }); }
  });
  app.post("/approval/final", express.json({ limit: "1kb", type: "application/json", strict: true }), (req, res) => {
    if (!fixtureApprovalEnabled) { res.status(403).json({ error: "APPROVAL_NOT_CONFIGURED" }); return; }
    const port = req.socket.localPort;
    if (!localRequest(req) || req.headers.origin !== `http://127.0.0.1:${port}` ||
        req.headers["sec-fetch-site"] !== "same-origin" || req.headers["content-type"] !== "application/json") {
      res.status(403).json({ error: "LOCAL_BROWSER_REQUIRED" }); return;
    }
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)final_approval_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    const session = cookie ? approvalSessions.get(cookie) : undefined;
    const supplied = req.headers["x-final-approval-csrf"];
    if (!session || session.expires <= Date.now() || typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(session.csrf), Buffer.from(supplied))) {
      res.status(403).json({ error: "APPROVAL_SESSION_REQUIRED" }); return;
    }
    approvalSessions.delete(cookie!);
    try {
      const result = issueHumanDoneApproval(req.body, collector.reviewRoot, approvalObservation);
      res.clearCookie("final_approval_session", { path: "/approval" });
      res.status(201).json(result);
    } catch { res.status(409).json({ error: "APPROVAL_REJECTED" }); }
  });
  // Local browser CSRF is a request boundary, not proof of user identity.
  const boundedSessions = new Map<string, { csrf: string; expires: number }>();
  const boundedBrowser = (req: express.Request, post: boolean) => {
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    return localRequest(req) && req.headers["sec-fetch-site"] === "same-origin" &&
      (post ? req.headers.origin === origin && req.headers["content-type"] === "application/json" :
        (req.headers.origin === undefined || req.headers.origin === origin));
  };
  app.get("/api/bounded/start-session", (req, res) => {
    if (!boundedBrowser(req, false)) { res.status(403).json({ error: "LOCAL_BROWSER_REQUIRED" }); return; }
    const session = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
    const current = now();
    for (const [key, value] of boundedSessions) if (value.expires <= current) boundedSessions.delete(key);
    boundedSessions.set(session, { csrf, expires: current + 120_000 });
    res.cookie("bounded_start_session", session, { httpOnly: true, sameSite: "strict", path: "/api/bounded", maxAge: 120_000 });
    res.set("X-Bounded-Start-CSRF", csrf).status(204).end();
  });
  app.post("/api/bounded/start", express.json({ limit: "16kb", type: "application/json", strict: true }), (req, res) => {
    if (!boundedBrowser(req, true)) { res.status(403).json({ error: "LOCAL_BROWSER_REQUIRED" }); return; }
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)bounded_start_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    const session = cookie ? boundedSessions.get(cookie) : undefined;
    const supplied = req.headers["x-bounded-start-csrf"];
    if (!session || session.expires <= now() || typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(session.csrf), Buffer.from(supplied))) {
      res.status(403).json({ error: "BOUNDED_SESSION_REQUIRED" }); return;
    }
    boundedSessions.delete(cookie!);
    res.clearCookie("bounded_start_session", { path: "/api/bounded" });
    const body: unknown = req.body;
    const fields = ["repo", "goal", "edit_paths", "acceptance_criteria"];
    const record = body as Record<string, unknown> | null;
    const strings = (value: unknown, maxItems: number, maxLength: number) =>
      Array.isArray(value) && value.length >= 1 && value.length <= maxItems &&
      value.every(item => typeof item === "string" && item.length >= 1 && item.length <= maxLength && item.trim().length > 0);
    const safeEditPath = (value: string) => value.length <= 240 && !/[\\:\x00-\x1f\x7f]/.test(value) &&
      value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith(".")) &&
      !value.startsWith("/");
    const profiles = {
      "codex-with-chatgpt": "tracked_typescript_dashboard",
      "codex-with-chatgpt-control-plane": "tracked_typescript_control_plane"
    } as const;
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        Object.keys(record).length !== fields.length || !fields.every(key => Object.hasOwn(record, key)) ||
        typeof record.repo !== "string" || !Object.hasOwn(profiles, record.repo) ||
        typeof record.goal !== "string" || record.goal.length < 1 || record.goal.length > 2000 || !record.goal.trim() ||
        !strings(record.edit_paths, 3, 240) || !(record.edit_paths as string[]).every(safeEditPath) ||
        !strings(record.acceptance_criteria, 6, 500)) {
      res.status(400).json({ error: "INVALID_BOUNDED_CONTRACT" }); return;
    }
    const repo = record.repo as keyof typeof profiles;
    const contract: Parameters<typeof startProductionBoundedTask>[0] = {
      repo, goal: record.goal as string, edit_paths: record.edit_paths as string[],
      acceptance_criteria: record.acceptance_criteria as string[], task_kind: "text_change",
      execution_profile: profiles[repo], worker: "opencode", codex: { allowed: false, max_calls: 0 },
      max_revisions: 3, timeout_ms: 600000
    };
    try {
      const result: unknown = startBoundedTask(contract);
      if (!result || typeof result !== "object" ||
          !/^bounded-[a-f0-9]{32}$/.test((result as { task_id?: unknown }).task_id as string) ||
          !/^[a-f0-9]{64}$/.test((result as { contract_sha256?: unknown }).contract_sha256 as string)) {
        res.status(502).json({ error: "BOUNDED_START_UNAVAILABLE" }); return;
      }
      const { task_id, contract_sha256 } = result as { task_id: string; contract_sha256: string };
      res.status(201).json({ task_id, contract_sha256 });
    } catch { res.status(502).json({ error: "BOUNDED_START_UNAVAILABLE" }); }
  });
  app.use("/api/bounded/start", (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: "INVALID_BOUNDED_CONTRACT" });
  });
  app.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Connection": "keep-alive", "Cache-Control": "no-store" });
    res.flushHeaders();
    let closed = false, busy = false, last = "";
    const emit = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const snapshot = await collector.snapshot();
        const eventsTask = snapshot.current_task ?? snapshot.latest_task;
        const events = eventsTask ? collector.events(eventsTask.task_id) : [];
        const payload = JSON.stringify({ ...snapshot, events });
        if (payload !== last) { res.write(`event: snapshot\ndata: ${payload}\n\n`); last = payload; }
      } catch { res.write("event: unavailable\ndata: {}\n\n"); }
      finally { busy = false; }
    };
    const watchers: fs.FSWatcher[] = [];
    for (const root of [...Object.values(collector.roots), collector.reviewRoot, collector.queueRoot]) {
      try {
        const dir = safePath(root, root === collector.reviewRoot ? "rpc-jobs" : root === collector.queueRoot ? "" : ".ai/tasks");
        // Windows recursive watch is opportunistic; polling is always active.
        watchers.push(fs.watch(dir, { recursive: true }, () => { void emit(); }));
      } catch { /* polling fallback */ }
    }
    const interval = setInterval(() => { void emit(); }, 3000);
    void emit();
    req.on("close", () => { closed = true; clearInterval(interval); watchers.forEach(w => w.close()); });
  });
  app.use((_req, res) => res.status(405).json({ error: "READ_ONLY" }));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(503).json({ error: "UNAVAILABLE" }));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Loopback only: no new authentication or tunnel exposure in v0.1.
  createDashboard().listen(48766, "127.0.0.1", () => console.log("Dashboard: http://127.0.0.1:48766"));
}
