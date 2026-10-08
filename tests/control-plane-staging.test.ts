import { test, expect } from "vitest";
import { request } from "node:http";
import { createControlPlaneStaging } from "../src/bridge/control-plane-staging.js";

for (const role of ["gateway", "dashboard"] as const) {
  test(`${role} exposes only GET/HEAD health, with dispatch and authority closed`, async () => {
    const server = createControlPlaneStaging(role).listen(0, "127.0.0.1");
    try {
      await new Promise<void>(resolve => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      const url = `http://127.0.0.1:${address.port}`;
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(`${url}/health`, { method });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        if (method === "GET") expect(await response.json()).toEqual({
          ok: true, service: `ai-linux-${role}-staging`, dispatch: "CLOSED", authority: "NONE"
        });
        else expect(await response.text()).toBe("");
      }
      for (const route of ["/", "/health/", "/health?start=1", "/HEALTH", "/%68ealth", "/app.js", "/events", "/api/status",
        "/api/bounded/campaigns", "/api/bounded/start-session", "/api/bounded/start", "/approval/current",
        "/approval/final", "/api/authority-status", "/mcp", "/oauth/token", "/admin/pairing", "/admin/tunnel/start",
        "/admin/revoke-all", "/admin/shutdown", "/unknown"]) {
        for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
          const response = await fetch(`${url}${route}`, { method });
          expect(response.status, `${method} ${route}`).toBe(503);
          if (method !== "HEAD") expect(await response.json()).toEqual({ error: "CONTROL_PLANE_STAGING_ONLY" });
        }
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        expect((await fetch(`${url}/health`, { method })).status).toBe(503);
      }
      for (const method of ["GET", "HEAD"]) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const req = request({ hostname: "127.0.0.1", port: address.port, method,
            path: "http://example.invalid/health" }, response => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          });
          req.once("error", reject);
          req.end();
        });
        expect(status).toBe(503);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
