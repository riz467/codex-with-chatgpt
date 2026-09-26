// One-shot local Bridge fixture, never a production connector or user approval.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../../src/bridge/server.js";
import { REVIEW_ROOT } from "../../src/mcp/local-gateway.js";
import { completeCurrentAutonomous, issueHumanDoneApproval } from "../../src/mcp/autonomous-approval.js";

const repo = "autonomous-campaign-gateway-fixture";
const auth = path.join(os.tmpdir(), `autonomous-campaign-auth-${randomUUID()}.json`);
const bridge = await startBridge({ workspaceRoot: `C:\\work\\${repo}`, port: 0, persistRuntime: false, authStoreFile: auth });
const token = bridge.authStore.issueTokens({ clientId: "autonomous-campaign-fixture", scopes: ["orchestration.start", "review.read"] });
const client = new Client({ name: "autonomous-campaign-fixture", version: "1" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError || !response.structuredContent) throw new Error(`MCP_${name}_FAILED: ${JSON.stringify(response.content)}`);
    return response.structuredContent as Record<string, unknown>;
  };
  const started = await call("start_orchestration", { mode: "autonomous", repo,
    goal: "In src/workspace/git.ts, change only the Git subprocess timeout from 30_000 to exactly 60_000 milliseconds. The required runtime behavior is that runGit passes 60000 to spawnSync as its timeout option; preserve other behavior." });
  if (typeof started.run_id !== "string" || typeof started.task_id !== "string") throw new Error("MCP_START_INVALID");
  console.log("MCP started:", started);
  const deadline = Date.now() + 360000;
  let status: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    status = await call("get_orchestration_status", { id: started.run_id });
    if (["HUMAN_FINAL_APPROVAL", "ESCALATE", "DONE_CANDIDATE_NO_CHANGE"].includes(String(status.state))) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  console.log("MCP status:", JSON.stringify(status));
  const result = await call("get_orchestration_result", { id: started.task_id });
  console.log("MCP result:", JSON.stringify(result));
  if (status?.state !== "HUMAN_FINAL_APPROVAL" || result.review_phase == null ||
      (result.review_phase as Record<string, unknown>).structural !== "PASS" ||
      (result.review_phase as Record<string, unknown>).semantic !== "PASS") throw new Error("MCP_AUTONOMOUS_NOT_APPROVABLE");
  const authority = JSON.parse(fs.readFileSync(path.join(REVIEW_ROOT, "rpc-jobs", "authoritative", `${started.task_id}.json`), "utf8"));
  // Synthetic fixture approval; this is not a real user's approval.
  const approval = { task_id: started.task_id, review_result: "PASS", review_evidence_hash: authority.evidence_sha256,
    bundle_manifest_sha256: authority.manifest_sha256, authoritative_review_id: authority.review_job_id, done_approved: true };
  console.log("Fixture approval:", issueHumanDoneApproval({ action: "FINAL_DONE_APPROVAL", task_id: started.task_id,
    run_id: started.run_id, authoritative_review_id: authority.review_job_id }));
  console.log("Fixture completion:", completeCurrentAutonomous(approval));
  console.log("MCP DONE:", JSON.stringify(await call("get_orchestration_status", { id: started.run_id })));
} finally {
  await client.close(); await bridge.close();
  try { fs.unlinkSync(auth); } catch { /* local temporary auth */ }
}
