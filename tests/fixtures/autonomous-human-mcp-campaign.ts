// One-shot local fixture. The HTTP click is a synthetic *fixture* user action,
// never a claimed production human approval.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../../src/bridge/server.js";
import { createDashboard } from "../../src/dashboard/server.js";
import { REVIEW_ROOT } from "../../src/mcp/local-gateway.js";

const repo = process.env.CONSOLIDATION_CAMPAIGN === "1" ? "autonomous-consolidation-success2-fixture" : "autonomous-campaign-human-fixture";
const auth = path.join(os.tmpdir(), `human-campaign-auth-${randomUUID()}.json`);
const bridge = await startBridge({ workspaceRoot: `C:\\work\\${repo}`, port: 0, persistRuntime: false, authStoreFile: auth });
const dashboard = createDashboard(undefined, true).listen(0, "127.0.0.1");
const token = bridge.authStore.issueTokens({ clientId: "human-campaign-fixture", scopes: ["orchestration.start", "review.read"] });
const client = new Client({ name: "human-campaign-fixture", version: "1" });
try {
  await new Promise<void>((resolve, reject) => { dashboard.once("listening", resolve); dashboard.once("error", reject); });
  const address = dashboard.address(); if (!address || typeof address === "string") throw new Error("DASHBOARD_NOT_LOCAL");
  const base = `http://127.0.0.1:${address.port}`;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } } }));
  const call = async (name: string, args: Record<string, unknown>, errorExpected = false) => {
    const result = await client.callTool({ name, arguments: args });
    if (!!result.isError !== errorExpected) throw new Error(`${name} unexpected response: ${JSON.stringify(result.content)}`);
    return result.structuredContent as Record<string, unknown>;
  };
  const started = await call("start_orchestration", { mode: "autonomous", repo,
    goal: "In src/workspace/git.ts, change only the Git subprocess timeout from 30_000 to exactly 60_000 milliseconds. The required runtime behavior is that runGit passes 60000 to spawnSync as its timeout option; preserve other behavior." });
  console.log("Started:", started);
  if (typeof started.run_id !== "string" || typeof started.task_id !== "string") throw new Error("MCP_START_INVALID");
  const deadline = Date.now() + 360000;
  let status: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    status = await call("get_orchestration_status", { id: started.run_id });
    if (["HUMAN_FINAL_APPROVAL", "ESCALATE"].includes(String(status.state))) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  console.log("Review:", status);
  if (status?.state !== "HUMAN_FINAL_APPROVAL" || (status.review_phase as Record<string, unknown>)?.semantic !== "PASS") throw new Error("REVIEW_NOT_APPROVABLE");
  const authority = JSON.parse(fs.readFileSync(path.join(REVIEW_ROOT, "rpc-jobs", "authoritative", `${started.task_id}.json`), "utf8"));
  const approval = { task_id: started.task_id, review_result: "PASS", done_approved: true,
    review_evidence_hash: authority.evidence_sha256, bundle_manifest_sha256: authority.manifest_sha256,
    authoritative_review_id: authority.review_job_id };
  await call("complete_autonomous_orchestration", approval, true); // caller boolean alone cannot complete
  const candidate = await fetch(`${base}/approval/current`, { headers: { "Sec-Fetch-Site": "same-origin" } });
  if (!candidate.ok) throw new Error(`DASHBOARD_APPROVAL_UNAVAILABLE_${candidate.status}`);
  const view = await candidate.json();
  if (view.task_id !== started.task_id || view.authoritative_review_id !== authority.review_job_id) throw new Error("DASHBOARD_BINDING_INVALID");
  const cookie = candidate.headers.get("set-cookie")?.split(";")[0] ?? "";
  const response = await fetch(`${base}/approval/final`, { method: "POST", headers: { "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin", Origin: base, Cookie: cookie, "X-Final-Approval-CSRF": view.csrf },
    body: JSON.stringify({ action: "FINAL_DONE_APPROVAL", task_id: started.task_id, run_id: started.run_id,
      authoritative_review_id: authority.review_job_id }) });
  if (response.status !== 201) throw new Error(`DASHBOARD_APPROVAL_REJECTED_${response.status}`);
  console.log("Fixture UI approval:", await response.json());
  console.log("MCP Complete:", await call("complete_autonomous_orchestration", approval));
  await call("complete_autonomous_orchestration", approval, true); // nonce consumed / DONE already reached
  const done = await call("get_orchestration_result", { id: started.run_id });
  console.log("MCP DONE:", done);
  if (done.state !== "DONE" || done.done_state !== "DONE") throw new Error("DONE_LEDGER_MISSING");
} finally {
  await client.close(); dashboard.close(); await bridge.close();
  try { fs.unlinkSync(auth); } catch { /* local auth */ }
}
