import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { CloudflaredQuickTunnel } from "../src/tunnel/cloudflared.js";
import { createScratch } from "./support/scratch.js";
import { writePolicyReview } from "./support/synthetic-review.js";
import { REVIEW_ROOT } from "../src/mcp/local-gateway.js";

describe("quarantined autonomous completion MCP compatibility contract", () => {
  it("rejects stale approval, wrong task and caller paths; scratch authority cannot complete", async () => {
    const scratch = createScratch();
    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    let client: Client | undefined;
    try {
      const fixture = writePolicyReview(scratch, "approval");
      bridge = await startBridge({ workspaceRoot: fixture.sourceRoot, port: 0, persistRuntime: false,
        authStoreFile: scratch.resolve("auth/store.json"), tunnelProvider: new CloudflaredQuickTunnel() });
      const token = bridge.authStore.issueTokens({ clientId: "autonomous-approval-test", scopes: ["orchestration.start", "review.read"] });
      client = new Client({ name: "autonomous-approval-test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } } }));
      const tools = (await client.listTools()).tools;
      const tool = tools.find(t => t.name === "complete_autonomous_orchestration");
      expect(tool).toBeDefined();
      expect(tool?.description).toContain("authoritative completion disabled");
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
        "authoritative_review_id", "bundle_manifest_sha256", "done_approved", "review_evidence_hash", "review_result", "task_id"]);
      expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["task_id", "review_evidence_hash", "bundle_manifest_sha256",
        "authoritative_review_id", "done_approved"]));
      const validScratch = fixture.approval;
      const before = scratch.read(fixture.sourceStatus);
      const reads = vi.spyOn(fs, "readFileSync");
      const writes = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "mkdirSync"), vi.spyOn(fs, "openSync")];
      try {
        const denied = await client.callTool({ name: tool!.name, arguments: validScratch });
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied.content)).toContain("LEGACY_COMPLETION_DISABLED");
        expect(reads.mock.calls.some(([file]) => String(file).toLowerCase().startsWith(REVIEW_ROOT.toLowerCase()))).toBe(false);
        for (const write of writes) expect(write).not.toHaveBeenCalled();
      } finally { reads.mockRestore(); for (const write of writes) write.mockRestore(); }
      expect(scratch.read(fixture.sourceStatus)).toEqual(before);
      const stale = { ...validScratch, review_evidence_hash: "4".repeat(64) };
      for (const approval of [validScratch, stale, { ...validScratch, done_approved: false },
        { ...validScratch, repo: fixture.sourceRoot }, { ...validScratch, root: fixture.root },
        { ...validScratch, task_id: "rpc-" + "0".repeat(32) }]) {
        expect((await client.callTool({ name: tool!.name, arguments: approval })).isError).toBe(true);
      }
      // A valid scratch-only approval does not confer production completion authority.
      expect(scratch.read(fixture.sourceStatus).length).toBeGreaterThan(0);
    } finally {
      try { await client?.close(); } finally { try { await bridge?.close(); } finally { scratch.dispose(); } }
    }
  });
});
