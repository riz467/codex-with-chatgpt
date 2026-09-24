import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { REVIEW_ROOT } from "../src/mcp/local-gateway.js";
import { workspaceOverview } from "../src/mcp/workspace-info.js";

const available = process.platform === "win32" && fs.existsSync(REVIEW_ROOT);
const pointer = path.join(REVIEW_ROOT, "CURRENT_REVIEW.json");
const digest = () => createHash("sha256").update(fs.readFileSync(pointer)).digest("hex");

describe("fixed review workspace", () => {
  it.skipIf(!available)("returns review identity without Git and tolerates Git metadata errors", () => {
    const workspace = new Workspace(REVIEW_ROOT);
    const info = workspaceOverview(workspace);
    expect(info).toMatchObject({ workspaceRoot: REVIEW_ROOT, workspaceId: workspace.id, readOnly: true,
      directoryExists: true, currentReviewExists: fs.existsSync(pointer), git: { isRepo: false, branch: null, commit: null, available: false } });
    const errors: unknown[] = [];
    const unavailable = workspaceOverview(workspace, () => { throw new Error("Git unavailable"); }, (error) => errors.push(error));
    expect(unavailable.git).toMatchObject({ isRepo: false, branch: null, commit: null, available: false });
    expect(errors).toHaveLength(1);
  });

  it.skipIf(!available || !fs.existsSync(pointer))("reads CURRENT_REVIEW through authenticated MCP, rejects traversal and leaves evidence untouched", async () => {
    const before = digest();
    const bridge = await startBridge({ workspaceRoot: REVIEW_ROOT, port: 0, persistRuntime: false,
      authStoreFile: path.join(os.tmpdir(), `c2c-review-auth-${randomUUID()}.json`) });
    const token = bridge.authStore.issueTokens({ clientId: "review-info-test", scopes: ["workspace.read", "review.read"] });
    const client = new Client({ name: "review-info-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
      }));
      const info = await client.callTool({ name: "workspace_info", arguments: {} });
      expect(info.isError).not.toBe(true);
      expect(info.structuredContent).toMatchObject({ workspaceRoot: REVIEW_ROOT, readOnly: true, directoryExists: true,
        currentReviewExists: true, git: { isRepo: false } });
      const current = await client.callTool({ name: "read_file", arguments: { path: "CURRENT_REVIEW.json" } });
      expect(current.isError).not.toBe(true);
      expect((current.structuredContent as { content: string }).content).toContain("review_bundle");
      for (const requested of ["../ai-orchestration-config/README.md", "C:\\work\\ai-orchestration-config\\README.md"]) {
        const denied = await client.callTool({ name: "read_file", arguments: { path: requested } });
        expect(denied.isError).toBe(true);
      }
    } finally {
      await client.close();
      await bridge.close();
    }
    expect(digest()).toBe(before);
  });
});
