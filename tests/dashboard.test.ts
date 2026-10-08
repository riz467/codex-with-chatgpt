import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { Collector, eventsFor, heartbeat, pipeline, readJson } from "../src/dashboard/collector.js";
import { createDashboard } from "../src/dashboard/server.js";
import { GatewayError } from "../src/mcp/local-gateway.js";
import { getStateDir } from "../src/config/paths.js";

const dirs: string[] = [];
const servers: Server[] = [];
const originalStateDir = process.env.C2C_STATE_DIR;
const originalLocalAppData = process.env.LOCALAPPDATA;
afterEach(async () => { await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r())))); servers.length = 0; for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); dirs.length = 0; if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = originalStateDir; if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = originalLocalAppData; });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-")); dirs.push(dir);
  const roots = { "pve-doc": path.join(dir, "pve"), "ai-orchestration-config": path.join(dir, "config") };
  for (const root of Object.values(roots)) fs.mkdirSync(path.join(root, ".ai", "tasks"), { recursive: true });
  const review = path.join(dir, "review"), queue = path.join(dir, "queue");
  fs.mkdirSync(path.join(review, "rpc-jobs"), { recursive: true }); fs.mkdirSync(queue);
  return { roots, review, queue, collector: new Collector(roots, review, queue) };
}
function write(root: string, task: string, data: object) {
  const dir = path.join(root, ".ai", "tasks", task); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ task_id: task, ...data }));
  return dir;
}
function queueClaim(f: ReturnType<typeof fixture>, task: string) {
  for (const dir of ["requests", "claims", "results"]) fs.mkdirSync(path.join(f.queue, dir));
  const name = `${task}-1`, request = JSON.stringify({ task_id: task, attempt: 1, kind: "orchestration", repo: f.roots["pve-doc"] });
  fs.writeFileSync(path.join(f.queue, "requests", `${name}.json`), request);
  fs.writeFileSync(path.join(f.queue, "claims", `${name}.running`), createHash("sha256").update(request).digest("hex"));
  fs.writeFileSync(path.join(f.queue, "heartbeat.json"), JSON.stringify({ pid: 42, session_id: 1, observed_utc: new Date().toISOString() }));
}
describe("dashboard read-only evidence", () => {
  it("reads DONE without a registry and derives pipeline and safe events", () => {
    const f = fixture(), task = "rpc-done";
    const dir = write(f.roots["pve-doc"], task, { state: "DONE", verify_completed: true, verify_exit_code: 0, edit_paths: ["docs/test.md", ".env"], state_transition_history: [
      { to: "PLANNING", timestamp: "2026-01-01T00:00:00Z" }, { to: "RESEARCHING", timestamp: "2026-01-01T00:01:00Z" },
      { to: "EXECUTING", timestamp: "2026-01-01T00:02:00Z" }, { to: "VERIFYING", timestamp: "2026-01-01T00:03:00Z" },
      { to: "READY_FOR_REVIEW", timestamp: "2026-01-01T00:04:00Z" }, { to: "DONE", timestamp: "2026-01-01T00:05:00Z" }] });
    fs.writeFileSync(path.join(dir, "review-decision.json"), JSON.stringify({ task_id: task, review_result: "PASS", completion_mode: "post_integration", review_bundle: "reviews/example" }));
    fs.mkdirSync(path.join(dir, "audit"));
    fs.writeFileSync(path.join(dir, "audit", "coordinator-actions.jsonl"), '{"timestamp":"2026-01-01T00:02:00Z","actor":"CODEX","action":"execute","target":"secret token","result":"credential"}\nnot json');
    const found = f.collector.task(task);
    expect(found.state).toBe("DONE"); expect(found.edit_paths).toEqual(["docs/test.md"]);
    expect(found.pipeline.Done).toBe("complete"); expect(found.review_result).toBe("PASS");
    expect(f.collector.list()).toHaveLength(1);
    expect(JSON.stringify(f.collector.events(task))).not.toMatch(/credential|secret token/);
  });
  it("reads running ledger evidence, but does not invent missing fields", () => {
    const f = fixture(); write(f.roots["pve-doc"], "rpc-running", { state: "EXECUTING", state_transition_history: [{ to: "EXECUTING", timestamp: "2026-01-01T00:00:00Z" }] });
    const task = f.collector.task("rpc-running"); expect(task.state).toBe("EXECUTING"); expect(task.pipeline.Execute).toBe("active");
    expect(task.attempt).toBeNull(); expect(task.actor).toBe("UNKNOWN"); expect(task.verification?.completed).toBe(false);
    expect(pipeline(null).Done).toBe("unknown");
  });
  it("rejects ambiguous IDs and traversal", () => {
    const f = fixture(); for (const root of Object.values(f.roots)) write(root, "rpc-duplicate", { state: "DONE" });
    expect(() => f.collector.task("rpc-duplicate")).toThrowError(GatewayError);
    expect(f.collector.list()).toEqual([]);
    expect(() => f.collector.task("../.env")).toThrowError(GatewayError);
    expect(() => f.collector.events("../secret")).toThrowError(GatewayError);
  });
  it("rejects links in a fixed evidence path and ignores secret files", () => {
    const f = fixture(), outside = path.join(path.dirname(f.review), "outside.json");
    fs.writeFileSync(outside, '{"token":"private"}');
    const file = path.join(f.roots["pve-doc"], ".ai", "tasks", "rpc-linked");
    fs.symlinkSync(path.dirname(outside), file, process.platform === "win32" ? "junction" : "dir");
    expect(() => f.collector.task("rpc-linked")).toThrow();
    expect(f.collector.list()).toEqual([]);
    expect(f.collector.task.bind(f.collector, ".npmrc")).toThrow();
  });
  it("normalizes heartbeat without asserting unverified process readiness", () => {
    const now = Date.now(); expect(heartbeat({ pid: 42, session_id: 1, observed_utc: new Date(now - 2000).toISOString() }, now)).toMatchObject({ state: "heartbeat_fresh", age_seconds: 2 });
    expect(heartbeat({ pid: 42, session_id: 1, observed_utc: new Date(now - 20000).toISOString() }, now).state).toBe("unknown");
    expect(heartbeat({ pid: "42", session_id: 1 }).pid).toBeNull();
  });
  it("keeps stopped tasks out of Current Task and exposes the latest separately", async () => {
    const f = fixture();
    for (const [index, state] of ["NEEDS_APPROVAL", "READY_FOR_REVIEW", "DONE", "BLOCKED"].entries()) {
      write(f.roots["pve-doc"], `rpc-stopped-${index}`, { state, last_updated: new Date(Date.now() - index * 1000).toISOString() });
    }
    const snapshot = await f.collector.snapshot();
    expect(snapshot.current_task).toBeNull(); expect(snapshot.latest_task?.state).toBe("NEEDS_APPROVAL");
    expect(snapshot.recent_tasks).toHaveLength(4);
    const health = snapshot.health;
    expect(health.codex_worker).toBe("unknown"); expect(health.worker_pid).toBeNull();
  });
  it("selects a correlated claimed queue item only with a fresh heartbeat, and excludes stopped ledger states", async () => {
    const f = fixture(), id = "rpc-queued";
    write(f.roots["pve-doc"], id, { state: "EXECUTING" }); queueClaim(f, id);
    expect((await f.collector.snapshot()).current_task?.task_id).toBe(id);
    expect((await f.collector.health())).toMatchObject({ codex_worker: "unknown", worker_pid: null, session_id: null, last_known_pid: 42, last_known_session: 1 });
    fs.writeFileSync(path.join(f.queue, "heartbeat.json"), JSON.stringify({ pid: 42, session_id: 1, observed_utc: new Date(Date.now() - 30000).toISOString() }));
    expect((await f.collector.snapshot()).current_task).toBeNull();
    fs.writeFileSync(path.join(f.queue, "heartbeat.json"), JSON.stringify({ pid: 42, session_id: 1, observed_utc: new Date().toISOString() }));
    write(f.roots["pve-doc"], id, { state: "NEEDS_APPROVAL" });
    expect((await f.collector.snapshot()).current_task).toBeNull();
    write(f.roots["pve-doc"], id, { state: "EXECUTING" });
    fs.writeFileSync(path.join(f.queue, "claims", `${id}-1.running`), "0".repeat(64));
    expect((await f.collector.snapshot()).current_task).toBeNull();
  });
  it("prioritizes a confirmed running job but never treats stopped state as running", async () => {
    const f = fixture(), running = write(f.roots["pve-doc"], "rpc-running", { state: "EXECUTING" });
    write(f.roots["pve-doc"], "rpc-queued", { state: "EXECUTING" }); queueClaim(f, "rpc-queued");
    const task = f.collector.task("rpc-running");
    const list = f.collector.list();
    const spy = vi.spyOn(f.collector, "list").mockReturnValue(list.map(t => t.task_id === task.task_id ? { ...t, process: "running" } : t));
    expect((await f.collector.snapshot()).current_task?.task_id).toBe("rpc-running");
    spy.mockRestore();
    write(f.roots["pve-doc"], "rpc-running", { state: "BLOCKED" });
    expect((await f.collector.snapshot()).current_task?.task_id).toBe("rpc-queued");
    expect(fs.existsSync(running)).toBe(true);
  });
  it("does not mistake approval due to insufficient evidence for waiting review", () => {
    const state = { state: "NEEDS_APPROVAL", verify_completed: false, edit_paths: ["docs/test.md"], state_transition_history: [
      { to: "PLANNING" }, { to: "RESEARCHING" }, { to: "EXECUTING" }] };
    expect(pipeline(state, "EVIDENCE_INSUFFICIENT")).toMatchObject({ Research: "complete", Scope: "complete", Plan: "complete", Execute: "complete", Verify: "incomplete", Review: "not_started", Done: "not_started" });
    expect(pipeline(state).Review).toBe("not_started");
    expect(pipeline({ ...state, state: "BLOCKED", state_transition_history: [...state.state_transition_history, { to: "VERIFYING" }] }).Verify).toBe("blocked");
  });
  it("ignores malformed and missing evidence", () => {
    const f = fixture(); const dir = path.join(f.roots["pve-doc"], ".ai", "tasks", "rpc-bad"); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "status.json"), "{");
    expect(readJson(f.roots["pve-doc"], ".ai/tasks/rpc-bad/status.json")).toBeNull();
    expect(() => f.collector.task("rpc-bad")).toThrow();
    expect(eventsFor(f.roots["pve-doc"], "rpc-missing", null)).toEqual([]);
  });
  it("serves snapshot/events SSE and disallows mutation methods", async () => {
    const f = fixture(); write(f.roots["pve-doc"], "rpc-one", { state: "DONE" });
    const server = createServer(createDashboard(f.collector)); servers.push(server);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${addr.port}`;
    const status = await (await fetch(base + "/api/status")).json() as { health: { verified_health: { codex_worker: { status: string } } } };
    expect(status.health.verified_health.codex_worker.status).toBe("unknown");
    expect(JSON.stringify(status)).not.toMatch(/CommandLine|UserSid|credential/);
    expect((await (await fetch(base + "/labels.js")).text())).toContain("確認済み");
    expect((await (await fetch(base + "/api/tasks")).json() as unknown[])).toHaveLength(1);
    expect((await fetch(base + "/api/tasks/../secret")).status).not.toBe(200);
    expect((await fetch(base + "/api/tasks/rpc-one", { method: "POST" })).status).toBe(405);
    const abort = new AbortController(); const response = await fetch(base + "/events", { signal: abort.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: snapshot"); expect(first).toContain('"current_task":null'); expect(first).toContain('"latest_task":'); expect(first).toContain('"verified_health":'); expect(first).toContain("rpc-one"); abort.abort();
  });
  it.each(["override", "default"])("projects only bound bounded-v2 evidence from the fixed state directory (%s)", async mode => {
    const f = fixture(), isolated = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-dashboard-"));
    dirs.push(isolated);
    let stateDir: string;
    if (mode === "override") {
      process.env.C2C_STATE_DIR = isolated;
      stateDir = getStateDir();
      expect(stateDir).toBe(isolated);
    } else {
      delete process.env.C2C_STATE_DIR;
      process.env.LOCALAPPDATA = isolated;
      stateDir = getStateDir();
      const relative = path.relative(isolated, stateDir);
      expect(relative).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(path.isAbsolute(relative)).toBe(false);
    }
    const taskId = `bounded-${"a".repeat(32)}`;
    const contract = { repo: "codex-with-chatgpt", goal: "  Read only \u202e<script>alert(1)</script>  ", edit_paths: ["src/dashboard/collector.ts"],
      acceptance_criteria: ["criteria private"], task_kind: "text_change", execution_profile: "tracked_typescript_dashboard",
      worker: "opencode", codex: { allowed: false, max_calls: 0 }, max_revisions: 3, timeout_ms: 600000 };
    const contract_sha256 = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
    const manifest_sha256 = "b".repeat(64);
    const revision = { revision: 1, manifest_sha256, verify: { private: "verification secret" }, files: [{ private: "file secret" }],
      worker: { worker: "opencode", session_id: "session secret", execution_id: "execution secret", provider: "provider private", model: "model private",
        usage: { private: "usage secret" }, state: "completed", tools: 4 }, review: { task_id: taskId, revision: 1, contract_sha256, manifest_sha256, reviewer: "chatgpt", verdict: "PASS" } };
    const evidence = { version: 2, task_id: taskId, state: "REVIEW_ACCEPTED", contract, contract_sha256, revisions: [revision] };
    const dir = path.join(stateDir, "bounded-v2", "tasks", taskId); fs.mkdirSync(dir, { recursive: true });
    const save = (value: unknown) => fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(value));
    save(evidence);
    expect(f.collector.boundedTask(taskId)).toEqual({ task_id: taskId, state: "REVIEW_ACCEPTED", progress_mode: "REVIEW_ACCEPTED", stop_reason_present: false,
      contract_sha256, execution_profile: "tracked_typescript_dashboard", goal: "Read only <script>alert(1)</script>", edit_paths: contract.edit_paths, latest_revision: 1,
      manifest_sha256, verification_present: true, file_count: 1, worker: "opencode", review_reviewer: "chatgpt", review_verdict: "PASS",
      latest_semantic_review_diagnostic_code: null, commit_state: null, local_commit: null, authoritative_done: false });
    expect(f.collector.boundedTasks()).toHaveLength(1);
    expect((await f.collector.snapshot()).bounded_tasks).toHaveLength(1);
    expect(JSON.stringify(f.collector.boundedTask(taskId))).not.toMatch(/secret|private|session_id|execution_id|provider|model|usage|tools|acceptance_criteria|verification secret|file secret/);
    const controlContract = { ...contract, execution_profile: "tracked_typescript_control_plane" };
    const controlHash = createHash("sha256").update(JSON.stringify(controlContract)).digest("hex");
    save({ ...evidence, contract: controlContract, contract_sha256: controlHash,
      revisions: [{ ...revision, review: { ...revision.review, contract_sha256: controlHash } }] });
    expect(f.collector.boundedTask(taskId)).toEqual({ task_id: taskId, state: "REVIEW_ACCEPTED", progress_mode: "REVIEW_ACCEPTED", stop_reason_present: false,
      contract_sha256: controlHash, execution_profile: "tracked_typescript_control_plane",
      goal: "Read only <script>alert(1)</script>", edit_paths: contract.edit_paths, latest_revision: 1,
      manifest_sha256, verification_present: true, file_count: 1, worker: "opencode", review_reviewer: "chatgpt", review_verdict: "PASS",
      latest_semantic_review_diagnostic_code: null, commit_state: null, local_commit: null, authoritative_done: false });
    expect(JSON.stringify(f.collector.boundedTask(taskId))).not.toMatch(/secret|private|session_id|execution_id|provider|model|usage|tools|acceptance_criteria/);
    const semanticReview = { ...revision.review, contract_sha256: controlHash, reviewer: "opencode-semantic",
      findings: ["finding secret"], session_id: "review session secret", execution_id: "review execution secret",
      provider: "review provider private", model: "review model private", usage: { private: "review usage secret" },
      tools: ["review tool secret"], evidence: { private: "arbitrary evidence secret" } };
    save({ ...evidence, contract: controlContract, contract_sha256: controlHash,
      revisions: [{ ...revision, review: semanticReview }] });
    expect(f.collector.boundedTask(taskId)).toMatchObject({ state: "REVIEW_ACCEPTED", progress_mode: "REVIEW_ACCEPTED",
      execution_profile: "tracked_typescript_control_plane", review_reviewer: "opencode-semantic", review_verdict: "PASS" });
    expect(JSON.stringify(f.collector.boundedTask(taskId))).not.toMatch(/secret|private|findings|session_id|execution_id|provider|model|usage|tools|evidence|acceptance_criteria/);
    save({ ...evidence, state: "RUNNING", contract: controlContract, contract_sha256: controlHash,
      revisions: [{ ...revision, review: { ...semanticReview, verdict: "NEEDS_WORK" } }] });
    expect(f.collector.boundedTask(taskId)).toMatchObject({ state: "RUNNING", progress_mode: "AUTO_REVISION",
      review_reviewer: "opencode-semantic", review_verdict: "NEEDS_WORK" });
    expect(JSON.stringify(f.collector.boundedTask(taskId))).not.toMatch(/secret|private|findings|session_id|execution_id|provider|model|usage|tools|evidence|acceptance_criteria/);
    const unsupportedContract = { ...contract, execution_profile: "unsupported_profile" };
    const unsupportedHash = createHash("sha256").update(JSON.stringify(unsupportedContract)).digest("hex");
    save({ ...evidence, contract: unsupportedContract, contract_sha256: unsupportedHash,
      revisions: [{ ...revision, review: { ...revision.review, contract_sha256: unsupportedHash } }] });
    expect(f.collector.boundedTask(taskId)).toBeNull();
    save({ ...evidence, state: "REVIEW_PENDING", revisions: [{ ...revision, review: undefined, files: [{}, {}] }] });
    expect(f.collector.boundedTask(taskId)).toMatchObject({ goal: "Read only <script>alert(1)</script>", latest_revision: 1,
      verification_present: true, file_count: 2, worker: "opencode", review_reviewer: null, review_verdict: null, progress_mode: "REVIEW_PENDING" });
    save({ ...evidence, state: "RUNNING", revisions: [] });
    expect(f.collector.boundedTask(taskId)).toMatchObject({ progress_mode: "EXECUTION", review_verdict: null });
    save({ ...evidence, state: "RUNNING" });
    expect(f.collector.boundedTask(taskId)).toMatchObject({ progress_mode: "EXECUTION", review_verdict: "PASS" });
    save({ ...evidence, state: "RUNNING", revisions: [{ ...revision, review: { ...revision.review, verdict: "NEEDS_WORK" } }] });
    expect(f.collector.boundedTask(taskId)).toMatchObject({ progress_mode: "AUTO_REVISION", review_verdict: "NEEDS_WORK" });
    expect(JSON.stringify(f.collector.boundedTask(taskId))).not.toMatch(/secret|private|session_id|execution_id|provider|model|usage|tools|acceptance_criteria/);
    save({ ...evidence, state: "ESCALATE" });
    expect(f.collector.boundedTask(taskId)).toMatchObject({ progress_mode: "ESCALATE" });
    save({ ...evidence, contract: { ...contract, goal: "Tampered" } }); expect(f.collector.boundedTasks()).toEqual([]);
    for (const changed of [{ task_id: `bounded-${"c".repeat(32)}` }, { revision: 2 },
      { contract_sha256: "c".repeat(64) }, { manifest_sha256: "c".repeat(64) },
      { reviewer: "opencode" }, { reviewer: "OPENCODE-SEMANTIC" }, { reviewer: "chatgpt " }, { reviewer: null }, { verdict: "FAIL" }]) {
      save({ ...evidence, revisions: [{ ...revision, review: { ...revision.review, ...changed } }] });
      expect(f.collector.boundedTask(taskId)).toBeNull();
    }
    save({ ...evidence, revisions: [{ ...revision, revision: 2 }] }); expect(f.collector.boundedTask(taskId)).toBeNull();
    save({ ...evidence, revisions: [{ ...revision, verify: undefined, verification: true, file_count: 1 }] });
    expect(f.collector.boundedTask(taskId)).toBeNull();
  });
  it("projects only correlated commit status and whitelisted latest semantic diagnostics", () => {
    const f = fixture(), stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-commit-dashboard-"));
    dirs.push(stateDir); process.env.C2C_STATE_DIR = stateDir;
    const taskId = `bounded-${"a".repeat(32)}`;
    const contract = { repo: "codex-with-chatgpt", goal: "Safe goal", edit_paths: ["src/dashboard/collector.ts"],
      acceptance_criteria: ["private criterion"], task_kind: "text_change", execution_profile: "tracked_typescript_dashboard",
      worker: "opencode", codex: { allowed: false, max_calls: 0 }, max_revisions: 3, timeout_ms: 600000 };
    const contract_sha256 = createHash("sha256").update(JSON.stringify(contract)).digest("hex"), manifest_sha256 = "b".repeat(64);
    const revision = { revision: 1, manifest_sha256, verify: {}, files: [],
      worker: { worker: "opencode", session_id: "session secret", execution_id: "execution secret", provider: null, model: null,
        usage: null, state: "completed", tools: null },
      review: { task_id: taskId, revision: 1, contract_sha256, manifest_sha256, reviewer: "opencode-semantic", verdict: "NEEDS_WORK" } };
    const dir = path.join(stateDir, "bounded-v2", "tasks", taskId); fs.mkdirSync(dir, { recursive: true });
    const save = (value: unknown) => fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(value));
    const evidence = { version: 2, task_id: taskId, state: "REVIEW_PENDING", contract, contract_sha256, revisions: [revision] };
    save(evidence);
    let status: unknown = { task_id: taskId, state: "NOT_PREPARED", commit: "a".repeat(40), authoritative_done: false, secret: "receipt secret" };
    const probe = vi.fn(() => status);
    const collector = new Collector(f.roots, f.review, f.queue, undefined, undefined, probe);
    const projected = () => collector.boundedTask(taskId);
    expect(projected()).toMatchObject({ commit_state: "NOT_PREPARED", local_commit: null, authoritative_done: false,
      review_reviewer: "opencode-semantic", review_verdict: "NEEDS_WORK", latest_semantic_review_diagnostic_code: null });
    status = { task_id: taskId, state: "PREPARED", commit: "a".repeat(40), authoritative_done: false };
    expect(projected()).toMatchObject({ commit_state: "PREPARED", local_commit: null, authoritative_done: false });
    status = { task_id: taskId, state: "COMMITTED", commit: "a".repeat(40), authoritative_done: false,
      receipt: { secret: "receipt secret" }, commit_state: "private legacy state", local_commit: "private legacy hash" };
    expect(projected()).toMatchObject({ commit_state: "COMMITTED", local_commit: "a".repeat(40), authoritative_done: false });
    expect(JSON.stringify(projected())).not.toMatch(/secret|session_id|execution_id|receipt|acceptance_criteria|provider|model|usage|findings|private legacy/);
    for (const commit of [undefined, "A".repeat(40), "g".repeat(40), "a".repeat(39), 42]) {
      status = { task_id: taskId, state: "COMMITTED", commit, authoritative_done: false };
      expect(projected()).toMatchObject({ commit_state: null, local_commit: null, authoritative_done: false });
    }
    for (const authoritative_done of [true, undefined, null, "false"]) {
      for (const state of ["NOT_PREPARED", "PREPARED", "COMMITTED"]) {
        status = { task_id: taskId, state, commit: "a".repeat(40), authoritative_done };
        expect(projected()).toMatchObject({ commit_state: null, local_commit: null, authoritative_done: false });
      }
    }
    for (const invalid of [null, { task_id: `bounded-${"c".repeat(32)}`, state: "COMMITTED", commit: "a".repeat(40), authoritative_done: false },
      { task_id: taskId, state: "DONE", commit: "a".repeat(40), authoritative_done: false },
      { task_id: taskId, commit_state: "COMMITTED", local_commit: "a".repeat(40), authoritative_done: false }]) {
      status = invalid;
      expect(projected()).toMatchObject({ commit_state: null, local_commit: null, authoritative_done: false });
    }
    probe.mockImplementationOnce(() => { throw new Error("private failure"); });
    expect(projected()).toMatchObject({ commit_state: null, local_commit: null, authoritative_done: false });
    status = { task_id: taskId, state: "NOT_PREPARED", authoritative_done: false };
    for (const code of ["SEMANTIC_REVIEW_FAILED", "SEMANTIC_REVIEW_TIMEOUT", "SEMANTIC_REVIEW_INVALID", "SEMANTIC_PROCESS_REQUIRES_INSPECTION"]) {
      save({ ...evidence, revisions: [{ ...revision, semantic_review_diagnostic: { phase: "SEMANTIC_REVIEW", error_code: code, secret: "diagnostic secret" } }] });
      expect(projected()?.latest_semantic_review_diagnostic_code).toBe(code);
      expect(JSON.stringify(projected())).not.toMatch(/diagnostic secret|receipt|session secret/);
    }
    for (const diagnostic of [null, "SEMANTIC_REVIEW_FAILED", { phase: "STRUCTURAL_REVIEW", error_code: "SEMANTIC_REVIEW_FAILED" },
      { phase: "SEMANTIC_REVIEW", error_code: "PASS" }, { phase: "SEMANTIC_REVIEW", error_code: "semantic_review_failed" }]) {
      save({ ...evidence, revisions: [{ ...revision, semantic_review_diagnostic: diagnostic }] });
      expect(projected()?.latest_semantic_review_diagnostic_code).toBeNull();
    }
    expect(probe).toHaveBeenCalledWith(taskId);
  });


describe("local bounded start boundary", () => {
  const task_id = `bounded-${"a".repeat(32)}`, contract_sha256 = "b".repeat(64);
  const body = { repo: "codex-with-chatgpt", goal: "Change the dashboard", edit_paths: ["src/dashboard/server.ts"], acceptance_criteria: ["Tests pass"] };
  async function setup(campaigns?: Parameters<typeof createDashboard>[5]) {
    let time = 1000;
    const start = vi.fn((_contract: unknown) => ({ task_id, contract_sha256, secret: "private" }));
    const server = createServer(createDashboard(fixture().collector, false, undefined, start, () => time, campaigns)); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
    const base = `http://127.0.0.1:${address.port}`;
    const session = async () => {
      const response = await fetch(base + "/api/bounded/start-session", { headers: { "Sec-Fetch-Site": "same-origin" } });
      const csrf = response.headers.get("X-Bounded-Start-CSRF");
      expect(csrf).toMatch(/^[a-f0-9]{64}$/);
      expect(response.headers.get("content-type")).toBeNull();
      expect(await response.text()).toBe("");
      if (csrf === null) throw new Error("Missing CSRF header");
      return { response, csrf, cookie: response.headers.get("set-cookie")!.split(";")[0] };
    };
    const post = (token: { csrf: string; cookie: string }, value: unknown = body, headers: Record<string, string> = {}) =>
      fetch(base + "/api/bounded/start", { method: "POST", headers: {
        "Content-Type": "application/json", Origin: base, "Sec-Fetch-Site": "same-origin",
        Cookie: token.cookie, "X-Bounded-Start-Csrf": token.csrf, ...headers
      }, body: JSON.stringify(value) });
    return { base, start, session, post, advance: (ms: number) => { time += ms; } };
  }
  it.each([
    ["codex-with-chatgpt", "tracked_typescript_dashboard"],
    ["codex-with-chatgpt-control-plane", "tracked_typescript_control_plane"]
  ])("maps %s to its fixed profile and sanitizes success", async (repo, execution_profile) => {
    const { start, session, post } = await setup();
    const token = await session();
    expect(token.response.status).toBe(204);
    expect(token.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(token.response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(token.response.headers.get("set-cookie")).toContain("Path=/api/bounded");
    expect(token.response.headers.get("set-cookie")).toContain("Max-Age=120");
    const response = await post(token, { ...body, repo });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ task_id, contract_sha256 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ ...body, repo, execution_profile, task_kind: "text_change",
      worker: "opencode", codex: { allowed: false, max_calls: 0 }, max_revisions: 3, timeout_ms: 600000 });
    expect(start.mock.calls[0]).toHaveLength(1);
    expect((await post(token, { ...body, repo })).status).toBe(403);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("rejects missing, invalid, expired and reused CSRF", async () => {
    const { base, start, session, post, advance } = await setup();
    const token = await session();
    expect((await post(token, body, { "X-Bounded-Start-Csrf": "" })).status).toBe(403);
    expect((await post(token, { ...body, csrf: token.csrf }, { "X-Bounded-Start-Csrf": "" })).status).toBe(403);
    expect((await post(token, body, { "X-Bounded-Start-Csrf": "0".repeat(64) })).status).toBe(403);
    expect((await post(token, body, { Cookie: "" })).status).toBe(403);
    expect((await post(token)).status).toBe(201);
    expect((await post(token)).status).toBe(403);
    const expired = await session(); advance(120_000);
    expect((await post(expired)).status).toBe(403);
    expect((await fetch(base + "/api/bounded/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("projects only campaign status metadata, excluding raw goals and acceptance criteria", async () => {
    const { base, start } = await setup(() => [{ campaign_id: task_id, state: "RUNNING",
      current_task: task_id, task_ids: [task_id], stop_reason: null, human_action: null,
      impact_paths: ["src/dashboard/server.ts"], started_at: "2026-10-08T00:00:00Z", deadline: 1234,
      contract: { goal: "PRIVATE_GOAL", acceptance_criteria: ["PRIVATE_CRITERION"] },
      contract_digest: "PRIVATE_DIGEST", failures: ["PRIVATE_FAILURE"] } as any]);
    const response = await fetch(base + "/api/bounded/campaigns");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const result = await response.json();
    expect(result).toEqual([{ campaign_id: task_id, state: "RUNNING", current_task: task_id,
      task_ids: [task_id], stop_reason: null, human_action: null, impact_paths: ["src/dashboard/server.ts"],
      started_at: "2026-10-08T00:00:00Z", deadline: 1234, authoritative_done: false }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(start).not.toHaveBeenCalled();
  });
  it("rejects malformed bodies, paths and limits without starting", async () => {
    const { start, session, post } = await setup();
    const invalid = [
      { ...body, repo: "pve-doc" }, { ...body, extra: true }, { goal: body.goal, repo: body.repo, edit_paths: body.edit_paths },
      { ...body, goal: "" }, { ...body, goal: "x".repeat(2001) },
      { ...body, edit_paths: [] }, { ...body, edit_paths: ["a", "b", "c", "d"] },
      { ...body, edit_paths: ["a".repeat(241)] },
      ...["../secret", "src/../secret", "/absolute", "C:/absolute", "src\\secret", "a//b", ".env"].map(p => ({ ...body, edit_paths: [p] })),
      { ...body, acceptance_criteria: [] }, { ...body, acceptance_criteria: Array(7).fill("x") },
      { ...body, acceptance_criteria: [" "] }, { ...body, acceptance_criteria: ["x".repeat(501)] }
    ];
    for (const value of invalid) expect((await post(await session(), value)).status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
  it("rejects cross-origin and non-browser requests", async () => {
    const { base, start, session, post } = await setup();
    const token = await session();
    for (const headers of [{ Origin: "http://evil.example" }, { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "" }, { "Content-Type": "application/json; charset=utf-8" }]) {
      expect((await post(token, body, headers)).status).toBe(403);
    }
    expect((await fetch(base + "/api/bounded/start-session")).status).toBe(403);
    expect((await fetch(base + "/api/bounded/start-session", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });
  it("does not expose helper failures or invalid results", async () => {
    const { start, session, post } = await setup();
    start.mockImplementationOnce(() => { throw new Error("private failure"); });
    let response = await post(await session());
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("private");
    start.mockImplementationOnce(() => ({ task_id: "invalid", contract_sha256, secret: "private" }));
    response = await post(await session());
    expect(response.status).toBe(502);
    start.mockImplementationOnce(() => ({ task_id, contract_sha256: "invalid", secret: "private" }));
    response = await post(await session());
    expect(response.status).toBe(502);
    expect(start).toHaveBeenCalledTimes(3);
  });
});
});
