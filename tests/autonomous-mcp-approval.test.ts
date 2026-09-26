import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { REVIEW_ROOT } from "../src/mcp/local-gateway.js";

describe("fixed autonomous completion MCP contract", () => {
  it.skipIf(process.platform !== "win32" || !fs.existsSync(REVIEW_ROOT))("rejects stale approval, wrong task and caller paths", async () => {
    const auth = path.join(os.tmpdir(), `autonomous-approval-auth-${randomUUID()}.json`);
    const bridge = await startBridge({ workspaceRoot: "C:\\work\\autonomous-campaign-gateway-fixture", port: 0,
      persistRuntime: false, authStoreFile: auth });
    const token = bridge.authStore.issueTokens({ clientId: "autonomous-approval-test", scopes: ["orchestration.start", "review.read"] });
    const client = new Client({ name: "autonomous-approval-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } } }));
      const tools = (await client.listTools()).tools;
      const tool = tools.find(t => t.name === "complete_autonomous_orchestration");
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["task_id", "review_evidence_hash", "bundle_manifest_sha256",
        "authoritative_review_id", "done_approved"]));
      const previous = { task_id: "rpc-32c1d0813c5d4ee4b3a07d96ee29352e", review_result: "PASS",
        review_evidence_hash: "4".repeat(64), bundle_manifest_sha256: "6".repeat(64),
        authoritative_review_id: "review-8a4a8c33-4458-4820-8aa4-dc273c2a1954", done_approved: true };
      for (const approval of [previous, { ...previous, done_approved: false },
        { ...previous, repo: "C:\\work\\pve-doc" }, { ...previous, task_id: "rpc-" + "0".repeat(32) }]) {
        expect((await client.callTool({ name: tool!.name, arguments: approval })).isError).toBe(true);
      }
    } finally { await client.close(); await bridge.close(); try { fs.unlinkSync(auth); } catch { /* local temp */ } }
  });
});
