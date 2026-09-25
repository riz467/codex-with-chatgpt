import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Collector } from "./collector.js";
import { GatewayError, safePath } from "../mcp/local-gateway.js";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
export function createDashboard(collector = new Collector()) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"); res.set("X-Content-Type-Options", "nosniff"); next(); });
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/app.js", (_req, res) => res.sendFile(path.join(publicDir, "app.js")));
  app.get("/style.css", (_req, res) => res.sendFile(path.join(publicDir, "style.css")));
  app.get("/api/status", async (_req, res) => res.json(await collector.snapshot()));
  app.get("/api/tasks", (_req, res) => res.json(collector.list()));
  const handle = (fn: (id: string) => unknown) => (req: express.Request, res: express.Response) => {
    try { res.json(fn(String(req.params.taskId))); }
    catch (error) { res.status(error instanceof GatewayError && error.code === "INVALID_ID" ? 400 : error instanceof GatewayError && error.code === "NOT_FOUND" ? 404 : error instanceof GatewayError && error.code === "AMBIGUOUS_TASK" ? 409 : 422).json({ error: error instanceof GatewayError ? error.code : "UNAVAILABLE" }); }
  };
  app.get("/api/tasks/:taskId", handle(id => collector.task(id)));
  app.get("/api/events/:taskId", handle(id => collector.events(id)));
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
