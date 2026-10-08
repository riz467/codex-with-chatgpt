import { afterEach, beforeEach, describe, it, expect } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { CloudflaredQuickTunnel } from "../src/tunnel/cloudflared.js";
import { Workspace } from "../src/workspace/manager.js";
import { isReviewWorkspace, workspaceOverview } from "../src/mcp/workspace-info.js";
import { createScratch, type Scratch } from "./support/scratch.js";
import { writePolicyReview } from "./support/synthetic-review.js";

let scratch: Scratch;
let fixture: ReturnType<typeof writePolicyReview>;
beforeEach(() => {
  scratch = createScratch();
  fixture = writePolicyReview(scratch, "approval");
  // Real Git must stop here rather than discover the enclosing checkout's .git.
  // This is deliberately unavailable metadata, not a synthetic Git repository.
  scratch.write(path.join(fixture.root, ".git"), "gitdir: ./missing-synthetic-git\n");
});
afterEach(() => scratch?.dispose());

describe("fixed review workspace identity with a trusted in-process expected root", () => {
  it("returns read-only review identity and tolerates Git errors without consulting a live review", () => {
    const workspace = new Workspace(fixture.root);
    const info = workspaceOverview(workspace, undefined, undefined, fixture.root);
    expect(isReviewWorkspace(workspace)).toBe(false);
    expect(isReviewWorkspace(workspace, fixture.root)).toBe(true);
    expect(info).toMatchObject({ workspaceId: workspace.id, git: { isRepo: false, branch: null, commit: null } });
    expect(info).toMatchObject({ workspaceRoot: fixture.root, readOnly: true,
      directoryExists: true, currentReviewExists: true, git: { available: false } });
    const errors: unknown[] = [];
    const unavailable = workspaceOverview(workspace, () => { throw new Error("Git unavailable"); }, error => errors.push(error), fixture.root);
    expect(unavailable.git).toMatchObject({ isRepo: false, branch: null, commit: null });
    expect(errors).toHaveLength(1);
    const pointer = path.join(fixture.root, "CURRENT_REVIEW.json");
    scratch.remove(pointer);
    const absent = workspaceOverview(workspace, undefined, undefined, fixture.root);
    expect(absent).toMatchObject({ readOnly: true, currentReviewExists: false });
  });

  it("does not promote a scratch-local pointer to the production review identity", () => {
    const workspace = new Workspace(fixture.root);
    expect(workspaceOverview(workspace)).not.toHaveProperty("readOnly");
    expect(workspaceOverview(workspace)).not.toHaveProperty("currentReviewExists");
    expect(isReviewWorkspace(workspace, fixture.sourceRoot)).toBe(false);
  });

  it("reads the scratch pointer through authenticated MCP, rejects traversal and grants no completion capability", async () => {
    const pointer = path.join(fixture.root, "CURRENT_REVIEW.json");
    const digest = () => createHash("sha256").update(scratch.read(pointer)).digest("hex");
    const before = digest();
    const bridge = await startBridge({ workspaceRoot: fixture.root, port: 0, persistRuntime: false,
      authStoreFile: scratch.resolve("auth/store.json"), tunnelProvider: new CloudflaredQuickTunnel() });
    const client = new Client({ name: "review-info-test", version: "1" });
    try {
      const token = bridge.authStore.issueTokens({ clientId: "review-info-test", scopes: ["workspace.read", "review.read"] });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
      }));
      const info = await client.callTool({ name: "workspace_info", arguments: {} });
      expect(info.isError).not.toBe(true);
      expect(info.structuredContent).toMatchObject({ workspaceId: bridge.workspace.id, git: { isRepo: false } });
      expect(info.structuredContent).not.toHaveProperty("readOnly");
      const tools = (await client.listTools()).tools;
      for (const name of ["workspace_info", "complete_autonomous_orchestration", "verify_bundle_integrity"]) {
        const properties = tools.find(tool => tool.name === name)!.inputSchema.properties;
        for (const forbidden of ["root", "expectedReviewRoot", "observation", "readSourceStatus"]) {
          expect(properties).not.toHaveProperty(forbidden);
        }
      }
      const current = await client.callTool({ name: "read_file", arguments: { path: "CURRENT_REVIEW.json" } });
      expect(current.isError).not.toBe(true);
      expect((current.structuredContent as { content: string }).content).toContain("review_bundle");
      for (const requested of ["../source/README.md", "C:\\work\\ai-orchestration-config\\README.md"]) {
        const denied = await client.callTool({ name: "read_file", arguments: { path: requested } });
        expect(denied.isError).toBe(true);
      }
      for (const name of ["complete_orchestration", "complete_integrated_orchestration", "complete_autonomous_orchestration"]) {
        const args = name === "complete_autonomous_orchestration" ? fixture.approval :
          { task_id: fixture.taskId, review_result: "PASS", done_approved: true };
        const denied = await client.callTool({ name, arguments: args });
        expect(denied.isError).toBe(true);
        expect(denied.content).toEqual([expect.objectContaining({ text: expect.stringContaining("INSUFFICIENT_SCOPE") })]);
      }
    } finally {
      try { await client.close(); } finally { await bridge.close(); }
    }
    expect(digest()).toBe(before);
  });
});
