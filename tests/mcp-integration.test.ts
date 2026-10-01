import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git, isolateStateDir } from "./helpers.js";
import { CloudflaredQuickTunnel } from "../src/tunnel/cloudflared.js";
import { createScratch, type Scratch } from "./support/scratch.js";
import { writeCompletedTask } from "./support/synthetic-review.js";
import { writeResearchRepos } from "./support/synthetic-repos.js";

let root: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;
let stateDir: string;
let researchScratch: Scratch;
let researchFixture: ReturnType<typeof writeResearchRepos>;

type ToolResponse = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolResponse): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: ToolResponse): T {
  return JSON.parse(textOf(result)) as T;
}

function structuredJsonOf<T = Record<string, unknown>>(result: ToolResponse): T {
  const parsed = jsonOf<T>(result);
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function expectToolOutputSchema(
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  name: string,
  properties: string[]
): void {
  const schema = tools.find((tool) => tool.name === name)?.outputSchema as
    | { type?: string; properties?: Record<string, unknown> }
    | undefined;
  expect(schema?.type).toBe("object");
  expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(properties));
}

describe("RC-01_B2 synthetic completed ledger over MCP", () => {
  let scratch: Scratch;
  let fixture: ReturnType<typeof writeCompletedTask>;
  let bridge: Bridge | undefined;
  let client: Client | undefined;
  beforeEach(async () => {
    scratch = createScratch();
    fixture = writeCompletedTask(scratch);
    bridge = await startBridge({ workspaceRoot: fixture.reviewRoot, port: 0, persistRuntime: false,
      authStoreFile: scratch.resolve("auth/store.json"), tunnelProvider: new CloudflaredQuickTunnel() }, fixture.reads);
    const token = bridge.authStore.issueTokens({ clientId: "rc01-completed-reader", scopes: ["review.read"] });
    client = new Client({ name: "rc01-completed-reader", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
    }));
  });
  afterEach(async () => {
    try { await client?.close(); } finally {
      try { await bridge?.close(); } finally { client = undefined; bridge = undefined; scratch?.dispose(); }
    }
  });
  const call = (name: string, args: Record<string, unknown> = { task_id: fixture.taskId }) => client!.callTool({ name, arguments: args });

  it("reads a generated completed task through task_id without filesystem writes or production reads", async () => {
    const reads = vi.spyOn(fs, "readFileSync");
    const writes = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "appendFileSync"), vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs, "rmSync"), vi.spyOn(fs, "unlinkSync"), vi.spyOn(fs, "renameSync")];
    try {
      const status = await call("get_orchestration_status");
      expect(status.isError ?? false).toBe(false);
      expect(structuredJsonOf(status)).toMatchObject({ task_id: fixture.taskId, repo: "pve-doc", job_id: null,
        mode: "change", state: "DONE", process: "not_running", result_category: "DONE" });
      const result = await call("get_orchestration_result");
      expect(result.isError ?? false).toBe(false);
      expect(structuredJsonOf(result)).toMatchObject({ task_id: fixture.taskId, repo: "pve-doc", job_id: null,
        mode: "change", state: "DONE", result_category: "DONE", review_result: "PASS", done_approved: true,
        completion_mode: "post_integration", integrated_commit: fixture.integratedCommit, completed_at: fixture.completedAt,
        published: true, changed_paths: fixture.changedPaths, verification: { completed: true, exit_code: 0 } });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(reads.mock.calls.length).toBeGreaterThan(0);
      for (const [file] of reads.mock.calls) expect(() => scratch.resolve(String(file))).not.toThrow();
    } finally { reads.mockRestore(); for (const write of writes) write.mockRestore(); }
  });

  it("keeps public schemas unchanged and rejects caller roots, repo paths and malformed IDs", async () => {
    const tools = (await client!.listTools()).tools;
    for (const name of ["get_orchestration_status", "get_orchestration_result"]) {
      const schema = tools.find(tool => tool.name === name)!.inputSchema;
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["id", "job_id", "task_id"]);
      expect(schema.additionalProperties).toBe(false);
      for (const args of [{ task_id: "../escape" }, { task_id: "rpc-" }, { id: fixture.taskId, task_id: fixture.taskId },
        { task_id: fixture.taskId, repo: "unknown" }, { task_id: fixture.taskId, repo: fixture.repoRoot },
        { task_id: fixture.taskId, repo: fixture.workspaceIdentity }, { task_id: fixture.taskId, root: fixture.reviewRoot },
        { task_id: fixture.taskId, repoRoots: fixture.reads.repoRoots }, { task_id: fixture.taskId, readRoots: fixture.reads.repoRoots },
        { task_id: fixture.taskId, orchestrationReads: fixture.reads }]) {
        expect((await call(name, args)).isError).toBe(true);
      }
      expect((await call(name)).isError ?? false).toBe(false);
    }
  });

  it("fails closed for unknown and duplicate ledger tasks", async () => {
    for (const name of ["get_orchestration_status", "get_orchestration_result"]) {
      const missing = await call(name, { task_id: "rpc-rc01-unknown" });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("NOT_FOUND");
    }
    scratch.write(path.join(fixture.configRoot, `.ai/tasks/${fixture.taskId}/status.json`), scratch.read(fixture.statusFile));
    for (const name of ["get_orchestration_status", "get_orchestration_result"]) {
      const duplicate = await call(name);
      expect(duplicate.isError).toBe(true);
      expect(textOf(duplicate)).toContain("AMBIGUOUS_TASK");
    }
  });

  it.each(["decisionFile", "integrationFile"] as const)("refuses DONE results without %s", async field => {
    scratch.remove(fixture[field]);
    const result = await call("get_orchestration_result");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("INVALID_EVIDENCE");
  });

  it("never reports a tampered bundle as published", async () => {
    const evidence = path.join(fixture.reviewRoot, fixture.bundle, "verification.md");
    scratch.remove(evidence);
    scratch.write(evidence, "tampered\n");
    const result = await call("get_orchestration_result");
    expect(result.isError ?? false).toBe(false);
    expect(structuredJsonOf(result)).toMatchObject({ state: "DONE", published: false, review_bundle: null });
  });
});

describe("MCP tools over Streamable HTTP", () => {
beforeAll(async () => {
  researchScratch = createScratch();
  researchFixture = writeResearchRepos(researchScratch);
  stateDir = isolateStateDir();
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  }, undefined, researchFixture.roots);
  const tokens = bridge.authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read", "review.read", "orchestration.start"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  researchFixture.disposeEscape();
  researchScratch.dispose();
  cleanup(root);
});

  it("lists read-only and bounded local gateway tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "complete_autonomous_orchestration",
      "complete_integrated_orchestration",
      "complete_orchestration",
      "continue_bounded_opencode_task",
      "execution_output",
      "execution_summary",
      "get_bounded_task",
      "get_orchestration_approval",
      "get_orchestration_result",
      "get_orchestration_retry_plan",
      "get_orchestration_status",
      "git_diff",
      "git_status",
      "list_bounded_artifacts",
      "list_directory",
      "read_bounded_artifact",
      "read_file",
      "read_repo_file",
      "retry_orchestration",
      "search_repo",
      "search_workspace",
      "start_bounded_opencode_task",
      "start_orchestration",
      "start_test_job",
      "submit_bounded_chatgpt_review",
      "test_status",
      "verify_bundle_integrity",
      "workspace_info",
    ]);
    // no write tools in V1
    for (const forbidden of ["write_file", "delete_file", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }

    expectToolOutputSchema(tools, "workspace_info", ["workspaceId", "workspaceName", "projectType", "git"]);
    expectToolOutputSchema(tools, "list_directory", ["path", "entries", "total", "hasMore"]);
    expectToolOutputSchema(tools, "read_file", ["path", "content", "startLine", "endLine", "nextStartLine"]);
    expectToolOutputSchema(tools, "search_workspace", ["matches", "matchCount", "truncated", "engine"]);
    expectToolOutputSchema(tools, "search_repo", ["repo", "matches", "totalFiles", "truncated"]);
    expectToolOutputSchema(tools, "read_repo_file", ["repo", "path", "startLine", "endLine", "content"]);
    expectToolOutputSchema(tools, "get_orchestration_status", ["state", "result_category", "stop_reason_category", "stop_reason_summary", "human_action_required", "recommended_next_action"]);
    expectToolOutputSchema(tools, "get_orchestration_result", ["state", "stop_reason_category", "stop_reason_summary", "human_action_required", "recommended_next_action"]);
    const retrySchema = tools.find((tool) => tool.name === "retry_orchestration")?.inputSchema as
      { properties?: Record<string, unknown>; additionalProperties?: boolean } | undefined;
    expect(Object.keys(retrySchema?.properties ?? {})).toEqual(["id", "retry_reason"]);
    expect(retrySchema?.additionalProperties).toBe(false);
    const injected = await client.callTool({ name: "retry_orchestration", arguments: { id: "unissued", command: "git push", edit_paths: ["README.md"] } });
    expect(injected.isError).toBe(true);
    expectToolOutputSchema(tools, "git_status", ["isRepo", "branch", "staged", "unstaged", "untracked", "hidden"]);
    expectToolOutputSchema(tools, "git_diff", ["isRepo", "mode", "diff", "hasMore", "nextOffset"]);
    expectToolOutputSchema(tools, "test_status", ["available", "tests", "outputAvailable", "outputId"]);
    expectToolOutputSchema(tools, "execution_summary", ["records"]);
    expectToolOutputSchema(tools, "execution_output", ["action", "items", "text"]);
    const start = tools.find((tool) => tool.name === "start_orchestration")?.inputSchema as { required?: string[]; properties?: Record<string, { enum?: string[] }> };
    expect(start.required).toEqual(expect.arrayContaining(["repo", "mode", "goal"]));
    expect(start.properties?.mode?.enum).toEqual(["read_only", "change", "autonomous"]);
    expect(start.properties).toHaveProperty("edit_paths");
    expect(start.required).not.toContain("edit_paths");
  });

  it("documents git_diff pagination with its output field names", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "git_diff")?.description;
    expect(description).toContain("hasMore");
    expect(description).toContain("nextOffset");
    expect(description).not.toContain("has_more");
    expect(description).not.toContain("next_offset");
  });
  it("refuses completion without explicit PASS and human approval", async () => {
    for (const name of ["complete_orchestration", "complete_integrated_orchestration"]) {
      for (const args of [
        { task_id: "test-1", review_result: "NEEDS_WORK", done_approved: true },
        { task_id: "test-1", review_result: "PASS", done_approved: false },
        { task_id: "../test-1", review_result: "PASS", done_approved: true },
        { task_id: "test-1", review_result: "PASS", done_approved: true, repo: "C:\\work\\pve-doc" },
      ]) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
      }
    }
  });

  it("rejects edit_paths for read_only and unsafe paths for change before launch", async () => {
    const base = { name: "start_orchestration" };
    for (const arguments_ of [
      { repo: "ai-orchestration-config", mode: "read_only", goal: "inspect", edit_paths: ["README.md"] },
      { repo: "ai-orchestration-config", mode: "change", goal: "edit", edit_paths: ["../outside"] },
      { repo: "unknown", mode: "change", goal: "edit", edit_paths: ["README.md"] },
    ]) {
      const result = await client.callTool({ ...base, arguments: arguments_ });
      expect(result.isError).toBe(true);
    }
  });

  it("searches and reads an allowlisted repo over MCP without accepting caller paths", async () => {
    const schemas = (await client.listTools()).tools;
    expect(Object.keys(schemas.find(tool => tool.name === "search_repo")!.inputSchema.properties ?? {}).sort())
      .toEqual(["max_results", "query", "repo"]);
    expect(Object.keys(schemas.find(tool => tool.name === "read_repo_file")!.inputSchema.properties ?? {}).sort())
      .toEqual(["end_line", "path", "repo", "start_line"]);
    const search = await client.callTool({ name: "search_repo", arguments: { repo: "pve-doc", query: "AI-Workspace", max_results: 2 } });
    const found = structuredJsonOf<{ matches: { path: string; line: number }[] }>(search);
    expect(found.matches.length).toBeGreaterThan(0);
    expect(found.matches.every(match => !path.isAbsolute(match.path))).toBe(true);
    const first = found.matches[0];
    const read = await client.callTool({ name: "read_repo_file", arguments: { repo: "pve-doc", path: first.path,
      start_line: first.line, end_line: first.line } });
    expect(structuredJsonOf<{ content: string }>(read).content.toLowerCase()).toContain("ai-workspace");
    for (const request of [
      { name: "search_repo", arguments: { repo: "unknown", query: "AI-Workspace" } },
      { name: "read_repo_file", arguments: { repo: "pve-doc", path: "../outside" } },
      { name: "read_repo_file", arguments: { repo: "pve-doc", path: "C:\\work\\pve-doc\\00_overview.md" } },
    ]) expect((await client.callTool(request)).isError).toBe(true);
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = structuredJsonOf<{ workspaceId: string; projectType: string; frameworks: string[]; git: { isRepo: boolean; branch: string } }>(result);
    expect(info.workspaceId).toBe(bridge.workspace.id);
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = structuredJsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = structuredJsonOf<{ entries: { path: string }[] }>(result);
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = structuredJsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = structuredJsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("git_diff shows the change", async () => {
    const result = await client.callTool({ name: "git_diff", arguments: { mode: "unstaged" } });
    const diff = structuredJsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = structuredJsonOf<{ hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged", max_bytes: 4096 } })
    );
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = structuredJsonOf<{ offset: number; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", max_bytes: 4096, offset: first.nextOffset },
      })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("execution_summary and test_status read harness records", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_test1",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records[0].taskId).toBe("c2c_test1");

    const status = structuredJsonOf<{ available: boolean; tests: string; outputAvailable: boolean; outputId: number | null }>(
      await client.callTool({ name: "test_status", arguments: {} })
    );
    expect(status.available).toBe(true);
    expect(status.tests).toBe("27 passed");
    expect(status.outputAvailable).toBe(false);
    expect(status.outputId).toBeNull();
  });

  it("skips invalid persisted records when reporting execution status", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_valid_before_invalid",
      iteration: 2,
      changedFiles: 0,
      tests: "31 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    fs.appendFileSync(
      path.join(stateDir, "executions", `${bridge.workspace.id}.jsonl`),
      JSON.stringify({
        taskId: "c2c_invalid",
        iteration: null,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      }) + "\n"
    );

    const statusResult = await client.callTool({ name: "test_status", arguments: {} });
    expect(statusResult.isError ?? false).toBe(false);
    const status = structuredJsonOf<{ taskId: string; iteration: number }>(statusResult);
    expect(status.taskId).toBe("c2c_valid_before_invalid");
    expect(status.iteration).toBe(2);

    const summaryResult = await client.callTool({ name: "execution_summary", arguments: { limit: 1 } });
    expect(summaryResult.isError ?? false).toBe(false);
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(summaryResult);
    expect(summary.records.map((record) => record.taskId)).toEqual(["c2c_valid_before_invalid"]);
  });

  it("execution_output lists readable items and refuses restricted bodies", async () => {
    const readable = saveExecutionOutput(bridge.workspace.id, {
      command: "pnpm test",
      raw: "FAIL src/a.test.ts\nAssertionError: expected true",
      exitCode: 1,
    });
    const hidden = saveExecutionOutput(bridge.workspace.id, {
      command: "print-key",
      raw: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
      exitCode: 0,
    });
    const listResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    const list = structuredJsonOf<{
      action: "list";
      items: { id: number; status: string; command: string; text?: string }[];
    }>(listResult);
    expect(list.action).toBe("list");
    expect(list.items.some((item) => item.id === readable.id && item.status === "readable")).toBe(true);
    expect(list.items.some((item) => item.id === hidden.id && item.status === "restricted")).toBe(true);
    expect(list.items.every((item) => item.text === undefined)).toBe(true);

    const readResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: readable.id },
    });
    const body = structuredJsonOf<{ action: "read"; text: string }>(readResult);
    expect(body.action).toBe("read");
    expect(body.text).toContain("AssertionError");

    const denied = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: hidden.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("OUTPUT_RESTRICTED");
    expect(textOf(denied)).not.toContain("BEGIN RSA");

    const missing = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: 999999 },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });

  it("enforces scopes per tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    const outputDenied = await limitedClient.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    expect(outputDenied.isError).toBe(true);
    expect(textOf(outputDenied)).toContain("INSUFFICIENT_SCOPE");
    for (const [name, args] of [
      ["start_test_job", {}],
      ["start_orchestration", { repo: "pve-doc", mode: "read_only", goal: "inspect" }],
      ["get_orchestration_status", { id: "unissued" }],
      ["get_orchestration_result", { id: "unissued" }],
      ["get_orchestration_approval", { id: "unissued" }],
      ["get_orchestration_retry_plan", { id: "unissued" }],
      ["retry_orchestration", { id: "unissued" }],
      ["verify_bundle_integrity", {}],
    ] as const) {
      const gatewayDenied = await limitedClient.callTool({ name, arguments: args });
      expect(gatewayDenied.isError).toBe(true);
      expect(textOf(gatewayDenied)).toContain("INSUFFICIENT_SCOPE");
    }
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    await limitedClient.close();
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", path: "src" },
      })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });
});
