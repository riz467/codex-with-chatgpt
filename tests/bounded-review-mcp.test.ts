import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { BoundedTasks, type Worker } from "../src/mcp/bounded-task.js";
import { filterScopes } from "../src/auth/store.js";
import { REVIEW_ROOT } from "../src/mcp/local-gateway.js";

// All requests go through a real loopback MCP endpoint and its bearer-token middleware.
// Only the worker is mocked; no OpenCode, Codex or shared bridge is invoked.
let root: string, repo: string, bridge: Bridge, tasks: BoundedTasks;
let reviewer: Client, reader: Client, impostor: Client, starter: Client;
const mock: Worker = async () => ({ worker: "opencode", session_id: "ses_isolated", execution_id: `msg_${randomUUID().replaceAll("-", "")}`,
  provider: "mock", model: "mock", usage: null, state: "completed", tools: 0,
  output: JSON.stringify({ edits: [{ path: "README.md", old_text: "Old heading.", new_text: "Reviewed heading." }] }) });

function git(...args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
function data(r: Awaited<ReturnType<Client["callTool"]>>) {
  const text = (r.content as { text: string }[])[0]?.text;
  return JSON.parse(text ?? "null") as Record<string, unknown>;
}
async function connect(clientId: string, scopes: string[], target = bridge) {
  const token = target.authStore.issueTokens({ clientId, scopes }).accessToken;
  const client = new Client({ name: "isolated-review-test", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${target.localBaseUrl()}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}`, "x-client-id": "c2c_client_test_reviewer" } } }));
  return client;
}
async function pending() {
  const args = { repo: "autonomous-fixture", goal: "Replace the heading only", edit_paths: ["README.md"],
    acceptance_criteria: ["New heading exists"], task_kind: "text_change", execution_profile: "tracked_utf8_text", worker: "opencode",
    codex: { allowed: false, max_calls: 0 }, max_revisions: 1, timeout_ms: 60000 };
  const started = await starter.callTool({ name: "start_bounded_opencode_task", arguments: args });
  expect(started.isError).not.toBe(true);
  const id = data(started).task_id as string;
  for (let i = 0; i < 100; i++) {
    const current = data(await reader.callTool({ name: "get_bounded_task", arguments: { task_id: id } }));
    if (current.state === "REVIEW_PENDING") {
      const listed = await reader.callTool({ name: "list_bounded_artifacts", arguments: { task_id: id, revision: 1 } });
      expect(listed.isError).not.toBe(true);
      const artifact = data(listed);
      for (const file of artifact.files as { name: string }[]) {
        const page = await reader.callTool({ name: "read_bounded_artifact", arguments: { task_id: id, revision: 1, name: file.name, offset: 0 } });
        expect(page.isError).not.toBe(true);
        expect(data(page)).toMatchObject({ task_id: id, revision: 1, file_sha256: (file as { sha256: string }).sha256, offset: 0 });
      }
      return { review_id: `review-${randomUUID()}`, task_id: id, revision: 1,
        contract_sha256: artifact.contract_sha256 as string, manifest_sha256: artifact.manifest_sha256 as string,
        reviewer: "chatgpt", verdict: "PASS", findings: [] as string[] };
    }
    if (current.state === "ESCALATE") throw new Error(JSON.stringify(current));
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Fixture task did not reach REVIEW_PENDING");
}
async function resetFixture() {
  // Test fixture only, after the preceding task released the repo reservation.
  fs.writeFileSync(path.join(repo, "README.md"), "Old heading.\n");
}
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-review-mcp-"));
  repo = path.join(root, "fixture"); fs.mkdirSync(repo);
  git("init", "-q"); git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "Old heading.\n");
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const approvedId = "c2c_client_test_reviewer";
  tasks = new BoundedTasks({ "autonomous-fixture": fs.realpathSync.native(repo) }, path.join(root, "ledger"), mock);
  bridge = await startBridge({ workspaceRoot: repo, port: 0, persistRuntime: false,
    authStoreFile: path.join(root, "auth.json"), boundedReviewerClientId: approvedId,
    boundedTasks: tasks });
  reviewer = await connect(approvedId, ["review.read", "orchestration.review"]);
  reader = await connect("c2c_client_reader", ["review.read"]);
  impostor = await connect("c2c_client_worker", ["review.read", "orchestration.review"]);
  starter = await connect("c2c_client_starter", ["orchestration.start"]);
}, 30000);
afterAll(async () => {
  for (const client of [reviewer, reader, impostor, starter]) if (client) await client.close();
  if (bridge) await bridge.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded reviewer via isolated authenticated MCP", () => {
  it("never adds review authority to an omitted or unsupported OAuth scope request", () => {
    expect(filterScopes(undefined)).not.toContain("orchestration.review");
    expect(filterScopes("unknown.scope")).not.toContain("orchestration.review");
    expect(filterScopes("review.read orchestration.review")).toContain("orchestration.review");
  });
  it("requires bearer token, review scope and the server-authorized client ID", async () => {
    const review = await pending();
    const deniedStart = await reader.callTool({ name: "start_bounded_opencode_task", arguments: {
      repo: "autonomous-fixture", goal: "Not authorized", edit_paths: ["README.md"], acceptance_criteria: ["No change"],
      task_kind: "text_change", execution_profile: "tracked_utf8_text", worker: "opencode",
      codex: { allowed: false, max_calls: 0 }, max_revisions: 1, timeout_ms: 60000 } });
    expect(data(deniedStart)).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
    expect(data(await starter.callTool({ name: "get_bounded_task", arguments: { task_id: review.task_id } })))
      .toMatchObject({ error: "INSUFFICIENT_SCOPE" });
    const raw = await fetch(`${bridge.localBaseUrl()}/mcp`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_bounded_chatgpt_review", arguments: review } }) });
    expect(raw.status).toBe(401);
    expect(data(await reader.callTool({ name: "submit_bounded_chatgpt_review", arguments: review }))).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
    expect(data(await impostor.callTool({ name: "submit_bounded_chatgpt_review", arguments: review }))).toMatchObject({ error: "REVIEW_CLIENT_NOT_AUTHORIZED" });
    const named = bridge.authStore.registerClient({ clientName: "c2c_client_test_reviewer",
      redirectUris: ["http://localhost:19999/callback"] });
    const namedClient = await connect(named.clientId, ["orchestration.review"]);
    try {
      expect(data(await namedClient.callTool({ name: "submit_bounded_chatgpt_review", arguments: review })))
        .toMatchObject({ error: "REVIEW_CLIENT_NOT_AUTHORIZED" });
    } finally { await namedClient.close(); }
    const forged = await impostor.callTool({ name: "submit_bounded_chatgpt_review", arguments: {
      ...review, client_id: "c2c_client_test_reviewer" } });
    expect(forged.isError).toBe(true); // strict schema: identity is never a tool argument
    expect(data(await reader.callTool({ name: "get_bounded_task", arguments: { task_id: review.task_id } })).state).toBe("REVIEW_PENDING");
    const good = await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review });
    expect(good.isError).not.toBe(true);
    expect(data(good)).toMatchObject({ state: "REVIEW_ACCEPTED", duplicate: false });
    expect(data(await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review })))
      .toMatchObject({ state: "REVIEW_ACCEPTED", duplicate: true });
    expect(data(await reader.callTool({ name: "get_bounded_task", arguments: { task_id: review.task_id } })).state).toBe("REVIEW_ACCEPTED");
    expect(tasks.acceptedSnapshot(review.task_id)).toMatchObject({
      task_id: review.task_id, contract_sha256: review.contract_sha256, manifest_sha256: review.manifest_sha256,
      review_id: review.review_id, review_result: "PASS" });
  }, 30000);

  it("refuses review return on a Review-bound bridge even with the authorized client and scope", async () => {
    await resetFixture();
    const review = await pending();
    // No runtime persistence, port 0 and a temporary auth store: the existing Review service is not touched.
    const reviewBridge = await startBridge({ workspaceRoot: REVIEW_ROOT, port: 0, persistRuntime: false,
      authStoreFile: path.join(root, "review-auth.json"), boundedReviewerClientId: "c2c_client_test_reviewer",
      boundedTasks: tasks });
    let reviewClient: Client | undefined;
    try {
      reviewClient = await connect("c2c_client_test_reviewer", ["orchestration.review"], reviewBridge);
      expect(data(await reviewClient.callTool({ name: "submit_bounded_chatgpt_review", arguments: review })))
        .toMatchObject({ error: "REVIEW_CLIENT_NOT_AUTHORIZED" });
      expect(tasks.status(review.task_id).state).toBe("REVIEW_PENDING");
      expect(data(await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review })))
        .toMatchObject({ state: "REVIEW_ACCEPTED" });
    } finally {
      if (reviewClient) await reviewClient.close();
      await reviewBridge.close();
    }
  }, 30000);

  it("denies review return without a server-owned client binding", async () => {
    await resetFixture();
    const review = await pending();
    const unbound = await startBridge({ workspaceRoot: repo, port: 0, persistRuntime: false,
      authStoreFile: path.join(root, "unbound-auth.json"), boundedReviewerClientId: "", boundedTasks: tasks });
    let client: Client | undefined;
    try {
      client = await connect("c2c_client_test_reviewer", ["orchestration.review"], unbound);
      expect(data(await client.callTool({ name: "submit_bounded_chatgpt_review", arguments: review })))
        .toMatchObject({ error: "REVIEW_CLIENT_NOT_AUTHORIZED" });
      expect(tasks.status(review.task_id).state).toBe("REVIEW_PENDING");
      expect(data(await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review })))
        .toMatchObject({ state: "REVIEW_ACCEPTED" });
    } finally {
      if (client) await client.close();
      await unbound.close();
    }
  }, 30000);

  it("rejects stale revision, foreign task and altered contract/manifest before accepting the actual review", async () => {
    await resetFixture();
    const review = await pending();
    for (const patch of [{ revision: 2 }, { task_id: `bounded-${randomUUID().replaceAll("-", "")}` },
      { contract_sha256: "0".repeat(64) }, { manifest_sha256: "f".repeat(64) }]) {
      const result = await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: { ...review, ...patch } });
      expect(result.isError).toBe(true);
    }
    expect(data(await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review }))).toMatchObject({ state: "REVIEW_ACCEPTED" });
    const changed = await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: { ...review, review_id: `review-${randomUUID()}` } });
    expect(changed.isError).toBe(true);
  }, 30000);

  it("rejects changed live diff and refuses to treat its duplicate as valid", async () => {
    await resetFixture();
    const review = await pending();
    fs.writeFileSync(path.join(repo, "README.md"), "Unreviewed edit.\n");
    const result = await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review });
    expect(result.isError).toBe(true);
    expect(data(result)).toMatchObject({ error: "REVIEWED_DIFF_CHANGED" });
    expect(data(await reader.callTool({ name: "get_bounded_task", arguments: { task_id: review.task_id } })).state).toBe("REVIEW_PENDING");
    fs.writeFileSync(path.join(repo, "README.md"), "Reviewed heading.\n");
    expect(data(await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review }))).toMatchObject({ state: "REVIEW_ACCEPTED" });
    fs.writeFileSync(path.join(repo, "README.md"), "Unreviewed edit.\n");
    expect(data(await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review })))
      .toMatchObject({ error: "REVIEWED_DIFF_CHANGED" });
  }, 30000);

  it("rejects modified stored evidence even when hashes in the review are unchanged", async () => {
    await resetFixture();
    const review = await pending();
    const evidence = path.join(root, "ledger", review.task_id, "revision-1-proposal.json");
    const original = fs.readFileSync(evidence);
    fs.writeFileSync(evidence, "{}");
    const rejected = await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review });
    expect(rejected.isError).toBe(true);
    expect(data(rejected)).toMatchObject({ error: "MANIFEST_MISMATCH" });
    expect(data(await reader.callTool({ name: "get_bounded_task", arguments: { task_id: review.task_id } })).state).toBe("REVIEW_PENDING");
    fs.writeFileSync(evidence, original);
    expect(data(await reviewer.callTool({ name: "submit_bounded_chatgpt_review", arguments: review }))).toMatchObject({ state: "REVIEW_ACCEPTED" });
  }, 30000);
});
