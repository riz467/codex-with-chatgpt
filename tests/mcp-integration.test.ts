import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { boundedFinalizationRoot, createMcpServer, recoverFailedBoundedWorkspace } from "../src/mcp/server.js";
import { BoundedTasks, headWorktreeBaselineSha } from "../src/mcp/bounded-task.js";
import { prepareBoundedCommit, commitBoundedPatch } from "../src/mcp/typed-actions.js";
import type { Workspace } from "../src/workspace/manager.js";
import type { Logger } from "../src/logger/index.js";
import { canonicalJson } from "../src/task-contract/contract.js";
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
import { DevelopmentStore } from "../src/execution-orchestrator/development/store.js";

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
        mode: "change", state: "DONE", process: "not_running", result_category: "LEGACY_LOCAL_DONE", authoritative_done: false });
      const result = await call("get_orchestration_result");
      expect(result.isError ?? false).toBe(false);
      expect(structuredJsonOf(result)).toMatchObject({ task_id: fixture.taskId, repo: "pve-doc", job_id: null,
        mode: "change", state: "DONE", result_category: "LEGACY_LOCAL_DONE", authoritative_done: false, review_result: "PASS", done_approved: true,
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

describe("RC-02 request-only startup over MCP", () => {
  it("rejects invalid inputs without creating a child and fixes two distinct clean-repo attempts", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const state = isolateStateDir();
    const cleanRoot = makeTmpDir("rc02-clean");
    makeGitRepo(cleanRoot);
    let cleanBridge: Bridge | undefined;
    let cleanClient: Client | undefined;
    try {
      cleanBridge = await startBridge({ workspaceRoot: cleanRoot, port: 0, persistRuntime: false,
        authStoreFile: path.join(state, "rc02-auth.json") });
      const tokens = cleanBridge.authStore.issueTokens({ clientId: "rc02-starter", scopes: ["orchestration.start"] });
      cleanClient = new Client({ name: "rc02-starter", version: "1" });
      await cleanClient.connect(new StreamableHTTPClientTransport(new URL(`${cleanBridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
      }));
      const parent = path.join(state, "rc02-development-v2");
      const children = () => fs.existsSync(parent) ? fs.readdirSync(parent) : [];
      const valid = { goal: "Update index", edit_paths: ["src/index.ts"], acceptance_criteria: ["Index updated"] };
      for (const args of [
        { ...valid, extra: "authority" },
        { ...valid, authority: "approve" },
        { ...valid, edit_paths: ["../escape"] },
        { ...valid, edit_paths: ["src/index.ts", "SRC/INDEX.ts"] },
      ]) {
        const rejected = await cleanClient.callTool({ name: "start_rc02_development_task", arguments: args });
        expect(rejected.isError).toBe(true);
        expect(children()).toEqual([]);
      }
      const starts = [];
      for (let i = 0; i < 2; i++) {
        const result = await cleanClient.callTool({ name: "start_rc02_development_task", arguments: valid });
        expect(result.isError ?? false).toBe(false);
        const started = structuredJsonOf<{ state: string; delegation_id: string; delegation_digest: string;
          request_id: string; request_digest: string; attempt_id: string; attempt_digest: string;
          store_anchor: string; authority: string; execution_started: boolean }>(result);
        expect(Object.keys(started).sort()).toEqual(["attempt_digest", "attempt_id", "authority",
          "delegation_digest", "delegation_id", "execution_started", "request_digest", "request_id",
          "state", "store_anchor"]);
        expect(started).toMatchObject({ state: "ATTEMPT_FIXED", authority: "none", execution_started: false });
        const recovered = await DevelopmentStore.open(path.join(parent, started.request_id), started.store_anchor).recover();
        expect(recovered.state.state).toBe("ATTEMPT_FIXED");
        starts.push(started);
      }
      expect(children()).toHaveLength(2);
      for (const key of ["delegation_id", "request_id", "attempt_id", "store_anchor"] as const) {
        expect(starts[0][key]).not.toBe(starts[1][key]);
      }
    } finally {
      try { await cleanClient?.close(); } finally {
        try { await cleanBridge?.close(); } finally {
          cleanup(cleanRoot);
          if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
          else process.env.C2C_STATE_DIR = previousStateDir;
        }
      }
    }
  });
});

describe("bounded PASS finalization routing", () => {
  const bridgeRoot = "C:\\work\\codex-with-chatgpt";
  it("maps all three eligible durable repos from the fixed Execution Bridge root", () => {
    expect(boundedFinalizationRoot(bridgeRoot, "autonomous-fixture"))
      .toBe("C:\\work\\bounded-review-live-fixture");
    expect(boundedFinalizationRoot(bridgeRoot, "codex-with-chatgpt"))
      .toBe(bridgeRoot);
    expect(boundedFinalizationRoot(bridgeRoot, "codex-with-chatgpt-control-plane"))
      .toBe(bridgeRoot);
  });

  it("rejects unknown repos and all three eligible repos from non-Bridge workspace roots", () => {
    expect(boundedFinalizationRoot(bridgeRoot, "unknown")).toBeNull();
    for (const root of ["C:\\work\\bounded-review-live-fixture", "C:\\work\\other",
      "C:\\work\\codex-with-chatgpt-extra"]) {
      for (const repo of ["autonomous-fixture", "codex-with-chatgpt", "codex-with-chatgpt-control-plane"]) {
        expect(boundedFinalizationRoot(root, repo)).toBeNull();
      }
    }
  });
});

describe("bounded raw diff finalization regression", () => {
  it("commits exactly the reviewed patch ending in blank Git context bytes", async () => {
    const repo = makeTmpDir("bounded-raw-diff");
    const state = makeTmpDir("bounded-raw-state");
    try {
      makeGitRepo(repo);
      git(repo, "config", "core.autocrlf", "false");
      write(repo, "context.txt", "Old text.\nKeep context.\n\n\n");
      git(repo, "add", "context.txt");
      git(repo, "commit", "-m", "blank context baseline");
      const worker: ConstructorParameters<typeof BoundedTasks>[2] = async () => ({
        worker: "opencode", session_id: "ses_raw_context", execution_id: "msg_raw_context",
        provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
        output: JSON.stringify({ edits: [{ path: "context.txt", old_text: "Old text.", new_text: "Reviewed text." }] }),
      });
      const store = path.join(state, "tasks");
      const repoRoot = fs.realpathSync.native(repo);
      const tasks = new BoundedTasks({ fixture: repoRoot }, store, worker);
      const started = tasks.start({ repo: "fixture", goal: "Update tracked context text",
        edit_paths: ["context.txt"], acceptance_criteria: ["Preserve exact diff bytes"],
        task_kind: "text_change", execution_profile: "tracked_utf8_text", worker: "opencode",
        codex: { allowed: false, max_calls: 0 }, max_revisions: 1, timeout_ms: 600000 });
      const revision = await tasks.execute(started.task_id);
      expect(revision.state).toBe("REVIEW_PENDING");
      const raw = execFileSync("git", ["-C", repoRoot, "diff", "--binary", "HEAD"]);
      const artifact = fs.readFileSync(path.join(store, started.task_id, "revision-1-diff.patch"));
      expect(raw.subarray(-4).toString()).toBe(" \n \n");
      expect(artifact.equals(raw)).toBe(true);
      expect(tasks.submitReview({ review_id: `review-${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`,
        task_id: started.task_id, revision: 1, contract_sha256: started.contract_sha256,
        manifest_sha256: revision.manifest_sha256, reviewer: "chatgpt", verdict: "PASS", findings: [] }).state)
        .toBe("REVIEW_ACCEPTED");
      expect(prepareBoundedCommit(tasks, started.task_id, state).state).toBe("PREPARED");
      expect(commitBoundedPatch(tasks, started.task_id, state, repoRoot))
        .toMatchObject({ state: "COMMITTED", authoritative_done: false });
      const committedPatch = execFileSync("git", ["-C", repoRoot, "show", "--format=", "--binary", "HEAD"]);
      expect(committedPatch.equals(artifact)).toBe(true);
    } finally {
      cleanup(repo);
      cleanup(state);
    }
  });
});

describe("bounded PREPARED over the fixed execution MCP workspace", () => {
  const taskId = `bounded-${"a".repeat(32)}`;
  const reviewId = `review-${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
  const contract = "1".repeat(64);
  const manifest = "2".repeat(64);
  const bytes = Buffer.from("reviewed diff\n".repeat(900));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const name = "revision-1-diff.patch";
  let previousState: string | undefined;
  let storage: string;
  let localClient: Client;
  let localServer: ReturnType<typeof createMcpServer>;
  let task: Record<string, any>;
  let snapshot: Record<string, unknown>;
  let listing: Record<string, any>;
  let pages: (offset: number) => Record<string, unknown>;
  let statusSpy: ReturnType<typeof vi.spyOn>;
  let snapshotSpy: ReturnType<typeof vi.spyOn>;
  let artifactsSpy: ReturnType<typeof vi.spyOn>;
  let pageSpy: ReturnType<typeof vi.spyOn>;
  const receiptFile = () => path.join(storage, "bounded-prepared-v1", `${taskId}.json`);
  const call = (name: string, args: Record<string, unknown> = { task_id: taskId }) =>
    localClient.callTool({ name, arguments: args });
  const rejected = async (name: string) => expect((await call(name)).isError).toBe(true);

  beforeEach(async () => {
    previousState = process.env.C2C_STATE_DIR;
    storage = isolateStateDir();
    task = { task_id: taskId, state: "REVIEW_ACCEPTED", contract_sha256: contract,
      contract: { edit_paths: ["src/mcp/server.ts", "tests/mcp-integration.test.ts"] },
      baseline_head: "f".repeat(40), baseline: { "src/mcp/server.ts": "3".repeat(64),
        "tests/mcp-integration.test.ts": "4".repeat(64) },
      revisions: [{ revision: 1, manifest_sha256: manifest, review: {
        task_id: taskId, revision: 1, review_id: reviewId, reviewer: "chatgpt", verdict: "PASS",
        contract_sha256: contract, manifest_sha256: manifest } }] };
    snapshot = { task_id: taskId, revision: 1, review_id: reviewId, reviewer: "chatgpt", review_result: "PASS",
      contract_sha256: contract, manifest_sha256: manifest, diff_sha256: digest };
    listing = { task_id: taskId, revision: 1, contract_sha256: contract, manifest_sha256: manifest,
      files: [{ name: "other.log", sha256: "5".repeat(64), size: 1 },
        { name, sha256: digest, size: bytes.length }] };
    pages = (offset) => { const end = Math.min(offset + 8192, bytes.length); return {
      manifest_sha256: manifest, file_sha256: digest, offset,
      next_offset: end === bytes.length ? null : end,
      content_base64: bytes.subarray(offset, end).toString("base64") }; };
    statusSpy = vi.spyOn(BoundedTasks.prototype, "status").mockImplementation(() => task as any);
    snapshotSpy = vi.spyOn(BoundedTasks.prototype, "localCommitSnapshot").mockImplementation(() => snapshot as any);
    artifactsSpy = vi.spyOn(BoundedTasks.prototype, "artifacts").mockImplementation(() => listing as any);
    pageSpy = vi.spyOn(BoundedTasks.prototype, "readArtifact")
      .mockImplementation((_id, _revision, _name, offset) => pages(offset) as any);
    localServer = createMcpServer({ workspace: { root: "C:\\work\\codex-with-chatgpt" } as Workspace,
      logger: {} as Logger });
    localClient = new Client({ name: "prepared-integration", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await localServer.connect(serverTransport);
    await localClient.connect(clientTransport);
  });
  afterEach(async () => {
    try { await localClient.close(); await localServer.close(); } finally {
      vi.restoreAllMocks();
      cleanup(storage);
      if (previousState === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousState;
    }
  });

  it("seals a multi-page diff once, remains idempotent and never changes the repo", async () => {
    const before = fs.readFileSync(path.resolve("src/mcp/server.ts"));
    const first = await call("prepare_bounded_commit");
    expect(first.isError ?? false).toBe(false);
    const receipt = structuredJsonOf<any>(first);
    expect(receipt).toMatchObject({ task_id: taskId, revision: 1, review_id: reviewId, reviewer: "chatgpt",
      contract_sha256: contract, manifest_sha256: manifest, diff_sha256: digest,
      artifact: { name, size: bytes.length, sha256: digest }, state: "PREPARED", authoritative_done: false });
    expect(receipt.edit_paths).toEqual(["src/mcp/server.ts", "tests/mcp-integration.test.ts"]);
    expect(fs.existsSync(receiptFile())).toBe(true);
    expect(fs.readFileSync(receiptFile(), "utf8")).not.toContain("reviewed diff");
    for (const tool of ["prepare_bounded_commit", "get_bounded_commit_status", "prepare_bounded_commit"]) {
      const result = await call(tool);
      expect(result.isError ?? false).toBe(false);
      expect(structuredJsonOf(result)).toEqual(receipt);
    }
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalled();
    expect(artifactsSpy).toHaveBeenCalled();
    expect(pageSpy.mock.calls.some(([, , , offset]) => offset === 8192)).toBe(true);
    expect(fs.readFileSync(path.resolve("src/mcp/server.ts"))).toEqual(before);
  });

  it("keeps status read-only and rejects extra input fields", async () => {
    expect(structuredJsonOf(await call("get_bounded_commit_status"))).toEqual({
      task_id: taskId, state: "NOT_PREPARED", authoritative_done: false });
    expect(snapshotSpy).not.toHaveBeenCalled();
    for (const tool of ["prepare_bounded_commit", "get_bounded_commit_status"]) {
      expect((await call(tool, { task_id: taskId, repo: "other" })).isError).toBe(true);
    }
  });

  it("rejects missing snapshot bindings and mismatched PASS review records", async () => {
    for (const [key, value] of [["task_id", `bounded-${"b".repeat(32)}`],
      ["review_result", "NEEDS_WORK"], ["diff_sha256", "0".repeat(64)]] as const) {
      snapshot[key] = value;
      await rejected("prepare_bounded_commit");
      expect(fs.existsSync(receiptFile())).toBe(false);
      snapshot[key] = key === "task_id" ? taskId : key === "review_result" ? "PASS" : digest;
    }
    for (const [key, value] of [["task_id", `bounded-${"b".repeat(32)}`],
      ["revision", 2], ["contract_sha256", "0".repeat(64)],
      ["manifest_sha256", "0".repeat(64)]] as const) {
      task.revisions[0].review[key] = value;
      await rejected("prepare_bounded_commit");
      task.revisions[0].review[key] = key === "task_id" ? taskId :
        key === "revision" ? 1 : key === "contract_sha256" ? contract : manifest;
    }
    expect(fs.existsSync(receiptFile())).toBe(false);
  });

  it("rejects mismatched listings, duplicate diffs and invalid artifact metadata", async () => {
    for (const [key, value] of [["task_id", "wrong"], ["revision", 2],
      ["contract_sha256", "0".repeat(64)], ["manifest_sha256", "0".repeat(64)]] as const) {
      const original = listing[key];
      listing[key] = value;
      await rejected("prepare_bounded_commit");
      listing[key] = original;
    }
    listing.files.push({ ...listing.files[1] });
    await rejected("prepare_bounded_commit");
    listing.files.pop();
    for (const size of [0, Number.MAX_SAFE_INTEGER + 1]) {
      listing.files[1].size = size;
      await rejected("prepare_bounded_commit");
    }
    expect(fs.existsSync(receiptFile())).toBe(false);
  });

  it("rejects malformed, noncontiguous and modified pages without writing PREPARED", async () => {
    const valid = pages;
    for (const corrupt of [
      (page: any) => ({ ...page, content_base64: "!!!!" }),
      (page: any) => ({ ...page, offset: page.offset + 1 }),
      (page: any) => ({ ...page, next_offset: null }),
      (page: any) => ({ ...page, manifest_sha256: "0".repeat(64) }),
      (page: any) => ({ ...page, file_sha256: "0".repeat(64) }),
      (page: any) => ({ ...page, content_base64: Buffer.from("x").toString("base64") }),
    ]) {
      pages = (offset) => corrupt(valid(offset));
      await rejected("prepare_bounded_commit");
      expect(fs.existsSync(receiptFile())).toBe(false);
    }
  });

  it("fails closed for tampered, conflicting and stale sealed receipts", async () => {
    expect((await call("prepare_bounded_commit")).isError ?? false).toBe(false);
    const original = fs.readFileSync(receiptFile(), "utf8");
    const sealed = JSON.parse(original);
    sealed.receipt.authoritative_done = true;
    fs.writeFileSync(receiptFile(), JSON.stringify(sealed));
    await rejected("prepare_bounded_commit");
    await rejected("get_bounded_commit_status");
    fs.writeFileSync(receiptFile(), original);
    const conflicting = JSON.parse(original);
    conflicting.receipt.baseline_head = "e".repeat(40);
    conflicting.seal = createHash("sha256").update(canonicalJson(conflicting.receipt)).digest("hex");
    fs.writeFileSync(receiptFile(), JSON.stringify(conflicting));
    await rejected("prepare_bounded_commit");
    await rejected("get_bounded_commit_status");
    fs.writeFileSync(receiptFile(), original);
    task.revisions[0].review.review_id = `review-${"9".repeat(36)}`;
    await rejected("prepare_bounded_commit");
    await rejected("get_bounded_commit_status");
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it("revalidates the artifact on both tools without consulting the snapshot again", async () => {
    expect((await call("prepare_bounded_commit")).isError ?? false).toBe(false);
    listing.files[1].sha256 = "0".repeat(64);
    await rejected("get_bounded_commit_status");
    await rejected("prepare_bounded_commit");
    listing.files[1].sha256 = digest;
    pages = (offset) => ({ ...{
      manifest_sha256: manifest, file_sha256: digest, offset,
      next_offset: offset + 8192 >= bytes.length ? null : offset + 8192,
      content_base64: Buffer.alloc(Math.min(8192, bytes.length - offset), 120).toString("base64") } });
    await rejected("get_bounded_commit_status");
    await rejected("prepare_bounded_commit");
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });
  it("reconciles reviewer-less receipts only for the latest ChatGPT PASS", async () => {
    expect((await call("prepare_bounded_commit")).isError ?? false).toBe(false);
    const record = JSON.parse(fs.readFileSync(receiptFile(), "utf8"));
    delete record.receipt.reviewer;
    record.seal = createHash("sha256").update(canonicalJson(record.receipt)).digest("hex");
    fs.writeFileSync(receiptFile(), JSON.stringify(record));
    expect(structuredJsonOf(await call("get_bounded_commit_status"))).toEqual(record.receipt);
    expect(structuredJsonOf(await call("prepare_bounded_commit"))).toEqual(record.receipt);
    task.revisions[0].review.reviewer = "opencode-semantic";
    await rejected("get_bounded_commit_status");
    await rejected("prepare_bounded_commit");
  });

  it("binds semantic reviewer and rejects a sealed reviewer mismatch", async () => {
    task.revisions[0].review.reviewer = "opencode-semantic";
    snapshot.reviewer = "opencode-semantic";
    const result = await call("prepare_bounded_commit");
    expect(result.isError ?? false).toBe(false);
    expect(structuredJsonOf<any>(result)).toMatchObject({ reviewer: "opencode-semantic", state: "PREPARED", authoritative_done: false });
    const record = JSON.parse(fs.readFileSync(receiptFile(), "utf8"));
    record.receipt.reviewer = "chatgpt";
    record.seal = createHash("sha256").update(canonicalJson(record.receipt)).digest("hex");
    fs.writeFileSync(receiptFile(), JSON.stringify(record));
    await rejected("get_bounded_commit_status");
    await rejected("prepare_bounded_commit");
  });

});

describe("bounded semantic lifecycle over MCP", () => {
  const taskId = `bounded-${"b".repeat(32)}`;
  const hash = "1".repeat(64);
  const diff = Buffer.from("diff --git a/demo.txt b/demo.txt\n+change\n");
  const diffHash = createHash("sha256").update(diff).digest("hex");
  const input = { repo: "autonomous-fixture", goal: "Change demo", edit_paths: ["demo.txt"],
    acceptance_criteria: ["Changed"], task_kind: "text_change", execution_profile: "tracked_utf8_text",
    worker: "opencode", codex: { allowed: false, max_calls: 0 }, max_revisions: 3, timeout_ms: 600000 };
  let server: ReturnType<typeof createMcpServer>;
  let localClient: Client;
  let task: any;
  let execute: ReturnType<typeof vi.fn>;
  let reviewer: ReturnType<typeof vi.fn>;
  let finalizer: ReturnType<typeof vi.fn>;
  let diagnostic: ReturnType<typeof vi.fn>;
  let submitReview: ReturnType<typeof vi.fn>;
  let release: (() => void) | undefined;
  const call = (name: string, arguments_: Record<string, unknown>) =>
    localClient.callTool({ name, arguments: arguments_ });
  const settled = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(condition()).toBe(true);
  };
  beforeEach(async () => {
    task = { task_id: taskId, state: "RUNNING", contract_sha256: hash, contract: input,
      revisions: [] as any[] };
    execute = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      const revision = task.revisions.length + 1;
      task.revisions.push({ revision, manifest_sha256: hash,
        worker: { session_id: `session-${revision}`, execution_id: `execution-${revision}` },
        verify: { passed: true } });
      task.state = "REVIEW_PENDING";
    });
    reviewer = vi.fn(async () => ({ decision: { review_result: "PASS", unresolved_issues: [] } }));
    finalizer = vi.fn();
    diagnostic = vi.fn();
    submitReview = vi.fn((review: any) => {
      task.revisions.at(-1).review = review;
      task.state = review.verdict === "PASS" ? "REVIEW_ACCEPTED" : "RUNNING";
      return { state: task.state };
    });
    const tasks = { start: vi.fn(() => ({ task_id: taskId, state: "RUNNING" })),
      executing: vi.fn(() => false), execute, status: vi.fn(() => task),
      artifacts: vi.fn((_id: string, revision: number) => ({ files: [{ name: `revision-${revision}-diff.patch`,
        size: diff.length, sha256: diffHash }] })),
      readArtifact: vi.fn((_id: string, _revision: number, _name: string, offset: number) => ({
        offset, manifest_sha256: hash, file_sha256: diffHash, next_offset: null,
        content_base64: diff.toString("base64") })),
      recordSemanticReviewDiagnostic: diagnostic,
      submitReview };
    server = createMcpServer({ workspace: { root: "C:\\work\\bounded-review-live-fixture" } as Workspace,
      logger: {} as Logger, boundedTasks: tasks as unknown as BoundedTasks,
      boundedSemanticReviewer: reviewer, boundedFinalizer: finalizer });
    localClient = new Client({ name: "semantic-lifecycle", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await localClient.connect(clientTransport);
  });
  afterEach(async () => { release?.(); await localClient.close(); await server.close(); });

  it("reviews a started task with numeric evidence refs and locally finalizes PASS", async () => {
    expect((await call("start_bounded_opencode_task", input)).isError ?? false).toBe(false);
    await settled(() => !!release);
    release!();
    await settled(() => finalizer.mock.calls.length === 1);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer.mock.calls[0][0]).toContain("execution-1");
    expect(reviewer.mock.calls[0][0]).toContain("[2] Verified diff");
    expect(reviewer.mock.calls[0].slice(1)).toEqual(["session-1", [1, 2, 3]]);
    expect(task.revisions[0].review).toMatchObject({ reviewer: "opencode-semantic", verdict: "PASS",
      contract_sha256: hash, manifest_sha256: hash, findings: [] });
    expect(finalizer).toHaveBeenCalledWith(taskId);
    expect(task.state).toBe("REVIEW_ACCEPTED");
    expect(submitReview).toHaveBeenCalledTimes(1);
    expect(diagnostic).not.toHaveBeenCalled();
    expect(task).not.toHaveProperty("authoritative_done", true);
  });

  it("maps unresolved issues to NEEDS_WORK and runs the next revision without resume", async () => {
    reviewer.mockResolvedValueOnce({ decision: { review_result: "NEEDS_WORK", unresolved_issues: ["Fix coverage"] } });
    await call("start_bounded_opencode_task", input);
    await settled(() => !!release);
    release!();
    await settled(() => execute.mock.calls.length === 2);
    expect(task.revisions[0].review).toMatchObject({ verdict: "NEEDS_WORK", findings: ["Fix coverage"] });
    expect(finalizer).not.toHaveBeenCalled();
    await settled(() => !!release);
    release!();
    await settled(() => finalizer.mock.calls.length === 1);
    expect(task.revisions).toHaveLength(2);
    expect(reviewer.mock.calls[1].slice(1)).toEqual(["session-2", [1, 2, 3]]);
    expect(submitReview).toHaveBeenCalledTimes(2);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it.each([
    { decision: "PASS" },
    { decision: { review_result: "DONE", unresolved_issues: [] } },
    { decision: { review_result: "PASS", unresolved_issues: ["Unresolved"] } },
  ])("does not finalize invalid semantic decisions: %j", async (decision) => {
    reviewer.mockResolvedValue(decision);
    await call("start_bounded_opencode_task", input);
    await settled(() => !!release);
    release!();
    await settled(() => reviewer.mock.calls.length === 1);
    await settled(() => diagnostic.mock.calls.length === 1);
    expect(diagnostic).toHaveBeenCalledWith({ task_id: taskId, revision: 1,
      manifest_sha256: hash, phase: "SEMANTIC_REVIEW", error_code: "SEMANTIC_REVIEW_INVALID" });
    expect(task.state).toBe("REVIEW_PENDING");
    expect(task.revisions[0].review).toBeUndefined();
    expect(submitReview).not.toHaveBeenCalled();
    expect(finalizer).not.toHaveBeenCalled();
  });

  it.each([
    { name: "TimeoutError", code: "SEMANTIC_REVIEW_TIMEOUT", message: "Reviewer unavailable", expected: "SEMANTIC_REVIEW_TIMEOUT" },
    { name: "Error", code: undefined, message: "SEMANTIC_TIMEOUT", expected: "SEMANTIC_REVIEW_TIMEOUT" },
    { name: "Error", code: "REVIEWER_UNAVAILABLE", message: "Reviewer unavailable", expected: "SEMANTIC_REVIEW_FAILED" },
  ])("records reviewer failure $message without submitting a review", async ({ name, code, message, expected }) => {
    const failure = Object.assign(new Error(message), { name, code });
    reviewer.mockRejectedValueOnce(failure);
    await call("start_bounded_opencode_task", input);
    await settled(() => !!release);
    release!();
    await settled(() => diagnostic.mock.calls.length === 1);
    expect(diagnostic).toHaveBeenCalledWith({ task_id: taskId, revision: 1,
      manifest_sha256: hash, phase: "SEMANTIC_REVIEW", error_code: expected });
    expect(task.state).toBe("REVIEW_PENDING");
    expect(task.revisions[0].review).toBeUndefined();
    expect(submitReview).not.toHaveBeenCalled();
    expect(finalizer).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps command and approval authority outside the lifecycle tools", async () => {
    const tools = (await localClient.listTools()).tools;
    const start = tools.find((tool) => tool.name === "start_bounded_opencode_task")!;
    expect(Object.keys(start.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(input).sort());
    for (const extra of [{ command: "git push" }, { deploy: true }, { passkey: true },
      { done_approved: true }, { production_approval: true }]) {
      expect((await call("start_bounded_opencode_task", { ...input, ...extra })).isError).toBe(true);
    }
    expect((await call("continue_bounded_opencode_task", { task_id: taskId, command: "deploy" })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(finalizer).not.toHaveBeenCalled();
  });
});

describe("bounded EOL baseline regression", () => {
  const name = "eol.txt";
  const input = { repo: "fixture", goal: "Update EOL fixture", edit_paths: [name],
    acceptance_criteria: ["Preserve the committed baseline"], task_kind: "text_change" as const,
    execution_profile: "tracked_utf8_text" as const, worker: "opencode" as const,
    codex: { allowed: false, max_calls: 0 }, max_revisions: 1, timeout_ms: 600000 };

  it("rejects a manually CRLF-mutated tracked file even when Git status hides it", () => {
    const repo = makeTmpDir("bounded-hidden-crlf");
    const state = makeTmpDir("bounded-hidden-crlf-state");
    try {
      makeGitRepo(repo);
      git(repo, "config", "core.autocrlf", "false");
      write(repo, name, "first\nsecond\n");
      git(repo, "add", name);
      git(repo, "commit", "-m", "LF baseline");
      git(repo, "update-index", "--assume-unchanged", "--", name);
      const file = path.join(repo, name);
      fs.writeFileSync(file, "first\r\nsecond\r\n");
      expect(git(repo, "status", "--porcelain").trim()).toBe("");
      expect(headWorktreeBaselineSha(repo, name, file)).toBeNull();
      const tasks = new BoundedTasks({ fixture: repo }, path.join(state, "tasks"),
        async () => { throw new Error("Worker must not run"); });
      let failure: unknown;
      try { tasks.start(input); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "DIRTY_REPO" });
    } finally {
      cleanup(repo);
      cleanup(state);
    }
  });

  it("uses raw HEAD bytes as the baseline for a clean Git CRLF checkout", () => {
    const repo = makeTmpDir("bounded-git-crlf");
    const state = makeTmpDir("bounded-git-crlf-state");
    try {
      makeGitRepo(repo);
      git(repo, "config", "core.autocrlf", "false");
      write(repo, name, "first\nsecond\n");
      git(repo, "add", name);
      git(repo, "commit", "-m", "LF baseline");
      const headBytes = execFileSync("git", ["-C", repo, "show", `HEAD:${name}`]);
      const headSha = createHash("sha256").update(headBytes).digest("hex");
      git(repo, "config", "core.autocrlf", "true");
      const file = path.join(repo, name);
      fs.unlinkSync(file);
      git(repo, "checkout", "HEAD", "--", name);
      expect(fs.readFileSync(file).toString()).toBe("first\r\nsecond\r\n");
      expect(git(repo, "status", "--porcelain").trim()).toBe("");
      expect(headWorktreeBaselineSha(repo, name, file)).toBe(headSha);
      const tasks = new BoundedTasks({ fixture: repo }, path.join(state, "tasks"),
        async () => { throw new Error("Worker must not run"); });
      const started = tasks.start(input);
      expect(tasks.status(started.task_id)).toMatchObject({ state: "RUNNING", baseline: { [name]: headSha } });
    } finally {
      cleanup(repo);
      cleanup(state);
    }
  });
});

describe("failed bounded workspace recovery", () => {
  const taskId = `bounded-${"c".repeat(32)}`;
  let fixtureRoot: string;
  let workspace: Workspace;
  let task: ReturnType<BoundedTasks["status"]>;
  let executing: ReturnType<typeof vi.fn>;
  const recover = () => recoverFailedBoundedWorkspace({ executing } as unknown as BoundedTasks,
    workspace, task, fixtureRoot);
  const reject = () => {
    try {
      recover();
      throw new Error("Recovery unexpectedly succeeded");
    } catch (error) {
      expect(error).toMatchObject({ code: "RECOVERY_NOT_ALLOWED" });
    }
  };

  beforeEach(() => {
    fixtureRoot = makeTmpDir("bounded-recovery");
    makeGitRepo(fixtureRoot);
    git(fixtureRoot, "config", "core.autocrlf", "false");
    write(fixtureRoot, "recovery.txt", "baseline\n");
    write(fixtureRoot, "outside.txt", "outside baseline\n");
    git(fixtureRoot, "add", "recovery.txt", "outside.txt");
    git(fixtureRoot, "commit", "-m", "recovery baseline");
    workspace = { root: fixtureRoot } as Workspace;
    executing = vi.fn(() => false);
    task = { task_id: taskId, state: "ESCALATE", stop_reason: "VERIFY_FAILED",
      contract: { edit_paths: ["recovery.txt"] }, baseline_head: git(fixtureRoot, "rev-parse", "HEAD").trim(),
      baseline: { "recovery.txt": createHash("sha256").update(fs.readFileSync(path.join(fixtureRoot, "recovery.txt"))).digest("hex") },
      revisions: [] } as unknown as ReturnType<BoundedTasks["status"]>;
  });
  afterEach(() => cleanup(fixtureRoot));

  it.each(["VERIFY_FAILED", "VERIFY_TIMEOUT", "EXECUTION_UNKNOWN"] as const)(
    "restores only observed in-scope changes after %s with prior revision evidence", (reason) => {
    task.stop_reason = reason;
    (task.revisions as any[]).push({ revision: 1, review: { verdict: "NEEDS_WORK" } });
    const evidence = JSON.stringify(task);
    write(fixtureRoot, "recovery.txt", "failed verification\n");
    expect(recover()).toEqual({ task_id: taskId, result: "recovered" });
    expect(fs.readFileSync(path.join(fixtureRoot, "recovery.txt"), "utf8")).toBe("baseline\n");
    expect(recover()).toEqual({ task_id: taskId, result: "already_clean" });
    expect(JSON.stringify(task)).toBe(evidence);
  });

  it("recovers Git CRLF checkout bytes using a raw HEAD blob baseline", () => {
    const name = "recovery.txt";
    const file = path.join(fixtureRoot, name);
    const headBytes = execFileSync("git", ["-C", fixtureRoot, "show", `HEAD:${name}`]);
    const headSha = createHash("sha256").update(headBytes).digest("hex");
    git(fixtureRoot, "config", "core.autocrlf", "true");
    fs.unlinkSync(file);
    git(fixtureRoot, "checkout", "HEAD", "--", name);
    const checkoutBytes = fs.readFileSync(file);
    expect(checkoutBytes.toString()).toBe("baseline\r\n");
    expect(checkoutBytes.equals(headBytes)).toBe(false);
    expect(git(fixtureRoot, "status", "--porcelain").trim()).toBe("");
    task.baseline = { [name]: headSha };
    const evidence = JSON.stringify(task);
    write(fixtureRoot, name, "failed verification\n");
    expect(recover()).toEqual({ task_id: taskId, result: "recovered" });
    expect(fs.readFileSync(file)).toEqual(checkoutBytes);
    expect(git(fixtureRoot, "status", "--porcelain").trim()).toBe("");
    expect(JSON.stringify(task)).toBe(evidence);
    expect(recover()).toEqual({ task_id: taskId, result: "already_clean" });
    expect(JSON.stringify(task)).toBe(evidence);
  });

  it.each(["active", "head", "staged", "untracked", "outside"])(
    "rejects %s without restoring the in-scope change or mutating evidence", (hazard) => {
      write(fixtureRoot, "recovery.txt", "failed verification\n");
      if (hazard === "active") executing.mockReturnValue(true);
      if (hazard === "head") git(fixtureRoot, "commit", "--allow-empty", "-m", "changed HEAD");
      if (hazard === "staged") {
        write(fixtureRoot, "outside.txt", "staged change\n");
        git(fixtureRoot, "add", "outside.txt");
      }
      if (hazard === "untracked") write(fixtureRoot, "untracked.txt", "untracked\n");
      if (hazard === "outside") write(fixtureRoot, "outside.txt", "out-of-scope change\n");
      const evidence = JSON.stringify(task);
      reject();
      expect(fs.readFileSync(path.join(fixtureRoot, "recovery.txt"), "utf8")).toBe("failed verification\n");
      expect(JSON.stringify(task)).toBe(evidence);
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
      "start_rc02_development_task",
      "start_test_job",
      "submit_bounded_chatgpt_review",
      "test_status",
      "verify_bundle_integrity",
      "workspace_info",
    ]);
    expect(names).not.toContain("prepare_bounded_commit");
    expect(names).not.toContain("get_bounded_commit_status");
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
    expect(start.properties?.mode?.enum).toEqual(["read_only"]);
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
  it("refuses legacy completion even with explicit PASS and done_approved", async () => {
    for (const name of ["complete_orchestration", "complete_integrated_orchestration"]) {
      const valid = await client.callTool({ name, arguments: { task_id: "test-1", review_result: "PASS", done_approved: true } });
      expect(valid.isError).toBe(true);
      expect(textOf(valid)).toContain("LEGACY_COMPLETION_DISABLED");
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
      { repo: "ai-orchestration-config", mode: "change", goal: "edit" },
      { repo: "ai-orchestration-config", mode: "autonomous", goal: "edit" },
      { repo: "unknown", mode: "change", goal: "edit", edit_paths: ["README.md"] },
    ]) {
      const result = await client.callTool({ ...base, arguments: arguments_ });
      expect(result.isError).toBe(true);
    }
  });

  it("documents quarantined compatibility endpoints and rejects legacy retry", async () => {
    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === "start_orchestration")?.description).toMatch(/read_only inspection only/);
    expect(tools.find(t => t.name === "get_orchestration_retry_plan")?.description).toMatch(/eligibility is always false/);
    expect(tools.find(t => t.name === "retry_orchestration")?.description).toMatch(/quarantined/);
    for (const name of ["complete_orchestration", "complete_integrated_orchestration", "complete_autonomous_orchestration"]) {
      expect(tools.find(t => t.name === name)?.description).toMatch(/authoritative completion disabled/);
    }
    const retry = await client.callTool({ name: "retry_orchestration", arguments: { id: "unissued" } });
    expect(retry.isError).toBe(true);
    expect(textOf(retry)).toContain("FRESH_REQUEST_REQUIRED");
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
      ["start_rc02_development_task", { goal: "inspect", edit_paths: ["src/index.ts"], acceptance_criteria: ["No changes"] }],
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
