import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { Collector, eventsFor, heartbeat, pipeline, readJson } from "../src/dashboard/collector.js";
import { createDashboard } from "../src/dashboard/server.js";
import { GatewayError } from "../src/mcp/local-gateway.js";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r())))); servers.length = 0; for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
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
    expect((await (await fetch(base + "/api/tasks")).json() as unknown[])).toHaveLength(1);
    expect((await fetch(base + "/api/tasks/../secret")).status).not.toBe(200);
    expect((await fetch(base + "/api/tasks/rpc-one", { method: "POST" })).status).toBe(405);
    const abort = new AbortController(); const response = await fetch(base + "/events", { signal: abort.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: snapshot"); expect(first).toContain('"current_task":null'); expect(first).toContain('"latest_task":'); expect(first).toContain("rpc-one"); abort.abort();
  });
});
