import express from "express";

// Import no production bootstrap: staging must not load credentials or start campaigns.
export function createControlPlaneStaging(service: "gateway" | "dashboard") {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res) => {
    res.set("Cache-Control", "no-store");
    if ((req.method === "GET" || req.method === "HEAD") && req.url === "/health") {
      res.json({ ok: true, service: `ai-linux-${service}-staging`, dispatch: "CLOSED", authority: "NONE" });
      return;
    }
    res.status(503).json({ error: "CONTROL_PLANE_STAGING_ONLY" });
  });
  return app;
}
