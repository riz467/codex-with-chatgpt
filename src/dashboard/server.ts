import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Collector } from "./collector.js";
import { GatewayError, safePath } from "../mcp/local-gateway.js";
import { currentApprovalCandidate, issueHumanDoneApproval } from "../mcp/autonomous-approval.js";
import { randomBytes, timingSafeEqual } from "node:crypto";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
// Approval is disabled in the production entrypoint until an independent
// human/AI OS trust boundary is deployed. Loopback and CSRF are not identity.
export function createDashboard(collector = new Collector(), fixtureApprovalEnabled = false) {
  const app = express();
  app.disable("x-powered-by");
  const approvalSessions = new Map<string, { csrf: string; expires: number }>();
  const localRequest = (req: express.Request) => {
    const port = req.socket.localPort;
    const address = req.socket.remoteAddress;
    return typeof port === "number" && req.headers.host === `127.0.0.1:${port}` &&
      (address === "127.0.0.1" || address === "::ffff:127.0.0.1");
  };
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"); res.set("X-Content-Type-Options", "nosniff"); next(); });
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/app.js", (_req, res) => res.sendFile(path.join(publicDir, "app.js")));
  app.get("/labels.js", (_req, res) => res.sendFile(path.join(publicDir, "labels.js")));
  app.get("/style.css", (_req, res) => res.sendFile(path.join(publicDir, "style.css")));
  app.get("/health.css", (_req, res) => res.sendFile(path.join(publicDir, "health.css")));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "ai-workspace-dashboard" }));
  app.get("/api/status", async (_req, res) => res.json(await collector.snapshot()));
  app.get("/api/tasks", (_req, res) => res.json(collector.list()));
  const handle = (fn: (id: string) => unknown) => (req: express.Request, res: express.Response) => {
    try { res.json(fn(String(req.params.taskId))); }
    catch (error) { res.status(error instanceof GatewayError && error.code === "INVALID_ID" ? 400 : error instanceof GatewayError && error.code === "NOT_FOUND" ? 404 : error instanceof GatewayError && error.code === "AMBIGUOUS_TASK" ? 409 : 422).json({ error: error instanceof GatewayError ? error.code : "UNAVAILABLE" }); }
  };
  app.get("/api/tasks/:taskId", handle(id => collector.task(id)));
  app.get("/api/events/:taskId", handle(id => collector.events(id)));
  // Isolated fixture UI action only: no shell, retry, scope, Review or DONE write.
  // A same-user local process CAN acquire the CSRF secret; this is not provenance.
  app.get("/approval/current", (req, res) => {
    if (!fixtureApprovalEnabled) { res.status(403).json({ error: "APPROVAL_NOT_CONFIGURED" }); return; }
    if (!localRequest(req) || ![undefined, "same-origin", "none"].includes(req.headers["sec-fetch-site"] as string | undefined)) {
      res.status(403).json({ error: "LOCAL_BROWSER_REQUIRED" }); return;
    }
    try {
      const candidate = currentApprovalCandidate(collector.reviewRoot);
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
      const result = issueHumanDoneApproval(req.body, collector.reviewRoot);
      res.clearCookie("final_approval_session", { path: "/approval" });
      res.status(201).json(result);
    } catch { res.status(409).json({ error: "APPROVAL_REJECTED" }); }
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
