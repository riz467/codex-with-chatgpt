import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { verifyBundleIntegrity, startTestJob, startOrchestration, getOrchestrationStatus, getOrchestrationResult, validateEditPaths } from "../src/mcp/local-gateway.js";
import { runReadOnlyJob } from "../src/mcp/read-only-worker.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(), spawnSync: vi.fn(actual.spawnSync) };
});

const roots: string[] = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-test-")); roots.push(root); return root; };
afterEach(() => { vi.mocked(spawn).mockReset(); vi.mocked(spawnSync).mockClear(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function bundle(root: string) {
  const dir = path.join(root, "reviews", "demo");
  fs.mkdirSync(dir, { recursive: true });
  const payload = Buffer.from([0, 255, 1, 13, 10]);
  fs.writeFileSync(path.join(dir, "payload.bin"), payload);
  const manifest = { version: 1, files: [{ path: "payload.bin", size: payload.length, sha256: sha(payload) }] };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "review-bundle.json"), JSON.stringify({ version: 1, task_id: "task-1", source_workspace: "C:\\work\\pve-doc", manifest_sha256: sha(fs.readFileSync(path.join(dir, "manifest.json"))) }));
  fs.writeFileSync(path.join(root, "CURRENT_REVIEW.json"), JSON.stringify({ review_bundle: "reviews/demo", task_id: "task-1", source_workspace: "C:\\work\\pve-doc" }));
  return dir;
}
describe("local review integrity", () => {
  it("reports an absent current pointer without creating review state", () => {
    const root = temp();
    expect(verifyBundleIntegrity(undefined, root)).toEqual({ bundle: null, valid: false, issues: [{ kind: "missing", path: "CURRENT_REVIEW.json" }] });
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("checks manifest and payload raw bytes independently", () => {
    const root = temp(), dir = bundle(root);
    expect(verifyBundleIntegrity(undefined, root).valid).toBe(true);
    fs.writeFileSync(path.join(dir, "payload.bin"), Buffer.from([0, 255, 2, 13, 10]));
    expect(verifyBundleIntegrity(undefined, root).issues).toContainEqual({ kind: "mismatch", path: "payload.bin" });
    fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
    expect(verifyBundleIntegrity(undefined, root).issues).toContainEqual({ kind: "mismatch", path: "manifest.json" });
  });
  it("reports missing, extra, traversal, symlink escape", () => {
    const root = temp(), dir = bundle(root);
    fs.writeFileSync(path.join(dir, "extra.txt"), "extra");
    expect(verifyBundleIntegrity(undefined, root).issues).toContainEqual({ kind: "extra", path: "extra.txt" });
    fs.unlinkSync(path.join(dir, "payload.bin"));
    expect(verifyBundleIntegrity(undefined, root).issues).toContainEqual({ kind: "missing", path: "payload.bin" });
    expect(() => verifyBundleIntegrity("reviews/../outside", root)).toThrow();
    const manifest = { version: 1, files: [{ path: "../escape", size: 1, sha256: "0".repeat(64) }] };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    expect(verifyBundleIntegrity(undefined, root).issues.some((x) => x.kind === "invalid")).toBe(true);
    const outside = temp();
    fs.symlinkSync(outside, path.join(dir, "link"), "junction");
    expect(verifyBundleIntegrity(undefined, root).issues).toContainEqual({ kind: "invalid", path: "link" });
  });
});
describe("bounded actions", () => {
  it("accepts only existing repo-relative files, normalizes duplicates, and denies traversal, globs and symlink escapes", () => {
    const repo = temp(), outside = temp();
    fs.writeFileSync(path.join(repo, "README.md"), "readme");
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside");
    fs.symlinkSync(outside, path.join(repo, "escape"), "junction");
    expect(validateEditPaths(repo, ["README.md", "README.md"])).toEqual(["README.md"]);
    for (const paths of [[], ["../outside.txt"], ["/absolute"], ["C:\\work\\pve-doc\\README.md"], ["\\\\server\\share\\x"],
      ["escape/outside.txt"], ["."], ["*.md"], ["README.md\u0000"], ["README.md", "x"], Array(6).fill("README.md")]) {
      expect(() => validateEditPaths(repo, paths)).toThrow();
    }
  });
  it("writes only unique fixed markers", () => {
    const root = temp();
    const a = startTestJob(root), b = startTestJob(root);
    expect(a.request_id).not.toBe(b.request_id);
    expect(fs.readdirSync(root)).toEqual(["rpc-test"]);
    expect(JSON.parse(fs.readFileSync(path.join(root, "rpc-test", `${a.request_id}.json`), "utf8"))).toEqual(a);
    expect(Object.keys(a)).toEqual(["request_id", "timestamp", "marker", "source"]);
  });
  it("rejects unknown repos, path-like keys and malformed goals before spawning", () => {
    const root = temp();
    for (const mode of ["change", "read_only"] as const) {
      for (const repo of ["C:\\work\\pve-doc", "../pve-doc", "unknown"]) expect(() => startOrchestration(repo, "goal", mode, root)).toThrow();
      for (const goal of ["", " ", "a".repeat(4001), "a\nb", "a\0b"]) expect(() => startOrchestration("pve-doc", goal, mode, root)).toThrow();
    }
    expect(() => startOrchestration("pve-doc", "goal", "invalid" as "change", root)).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("starts only the fixed ai-run executable with separate arguments and returns a job immediately", () => {
    const root = temp();
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const goal = "Review a narrow change; do not execute arbitrary shell";
    const job = startOrchestration("pve-doc", goal, "change", root);
    expect(job.job_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(job.task_id).toMatch(/^rpc-[a-f0-9]{32}$/);
    const [exe, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(exe).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-File", "C:\\Users\\workspace\\.local\\bin\\ai-run.ps1", "-Repo", "C:\\work\\pve-doc", "-TaskId", job.task_id, "-Goal", goal]);
    expect(opts).toMatchObject({ shell: false, windowsHide: true });
    expect(JSON.parse(fs.readFileSync(path.join(root, "rpc-jobs", job.job_id, "job.json"), "utf8"))).toMatchObject({ job_id: job.job_id, task_id: job.task_id, repo_key: "pve-doc", process_id: process.pid });
    expect(() => startOrchestration("pve-doc", goal, "change", root)).toThrow(/already running/);
    expect(spawn).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(root, "rpc-jobs", job.job_id, "stdout.log"), "RESULT: HUMAN_SCOPE_CONFIRMATION_REQUIRED\n");
    child.emit("exit", 2);
    expect(getOrchestrationStatus(job.job_id, root)).toMatchObject({ mode: "change", process: "exited", exit_code: 2, result_category: "HUMAN_SCOPE_CONFIRMATION_REQUIRED" });
  });
  it("read_only dispatches only the fixed Node worker, never ai-run or a caller command", () => {
    const root = temp();
    const exists = fs.existsSync.bind(fs);
    const existsMock = vi.spyOn(fs, "existsSync").mockImplementation((file) => String(file).endsWith("read-only-worker.js") || exists(file));
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const job = startOrchestration("ai-orchestration-config", "現在状態を読み取り専用で確認", "read_only", root);
    existsMock.mockRestore();
    const [exe, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(exe).toBe(process.execPath);
    expect(args?.[0]).toMatch(/read-only-worker\.js$/);
    expect(args?.slice(1)).toEqual(["ai-orchestration-config", job.job_id, job.task_id]);
    expect(JSON.stringify(args)).not.toContain("現在状態");
    expect(opts).toMatchObject({ shell: false, cwd: "C:\\work\\ai-orchestration-config" });
    expect(getOrchestrationStatus(job.job_id, root).mode).toBe("read_only");
    expect(getOrchestrationResult(job.task_id, root)).toMatchObject({ mode: "read_only", changed_paths: [], published: false });
    expect(() => startOrchestration("ai-orchestration-config", "goal", "read_only", root, ["README.md"])).toThrow();
  });
  it("change with explicit EditPaths passes a JSON array through only the fixed ai-run wrapper", () => {
    const root = temp();
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const goal = "README.mdに1行追記してください";
    const job = startOrchestration("ai-orchestration-config", goal, "change", root, ["README.md", "README.md"]);
    expect(job.mode).toBe("change");
    const [exe, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(exe).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(args?.[3]).toMatch(/invoke-ai-run\.ps1$/);
    expect(args?.slice(4, 10)).toEqual(["-Repo", "C:\\work\\ai-orchestration-config", "-TaskId", job.task_id, "-Goal", goal]);
    expect(args?.[10]).toBe("-EditPathsBase64");
    expect(JSON.parse(Buffer.from(args?.[11] ?? "", "base64").toString("utf8"))).toEqual(["README.md"]);
    expect(opts).toMatchObject({ shell: false, cwd: "C:\\work\\ai-orchestration-config" });
    child.emit("exit", 0);
  });
  it("PowerShell adapter binds multiple EditPaths as an array to ai-run", () => {
    const dir = temp(), stub = path.join(dir, "ai-run.ps1"), wrapper = path.join(dir, "invoke-ai-run.ps1");
    fs.writeFileSync(stub, 'param([string]$Repo,[string]$TaskId,[string]$Goal,[string[]]$EditPaths)\nConvertTo-Json -InputObject @($EditPaths) -Compress\n');
    fs.writeFileSync(wrapper, fs.readFileSync("src/mcp/invoke-ai-run.ps1", "utf8").replace("C:\\Users\\workspace\\.local\\bin\\ai-run.ps1", stub.replaceAll("'", "''")));
    const encoded = Buffer.from(JSON.stringify(["README.md", "docs/guide.md"]), "utf8").toString("base64");
    const output = spawnSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", wrapper, "-Repo", "test-repo", "-TaskId", "test-task", "-Goal", "test-goal", "-EditPathsBase64", encoded], { encoding: "utf8" });
    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout.trim())).toEqual(["README.md", "docs/guide.md"]);
  });
  it("read_only worker writes only fixed result evidence; rejects foreign job directories", () => {
    const root = temp(), id = "worker-test", task = "rpc-worker-test";
    const dir = path.join(root, "rpc-jobs", id);
    fs.mkdirSync(dir, { recursive: true });
    expect(() => runReadOnlyJob("../outside" as "pve-doc", id, task, root)).toThrow();
    expect(() => runReadOnlyJob("ai-orchestration-config", "../outside", task, root)).toThrow();
    runReadOnlyJob("ai-orchestration-config", id, task, root);
    expect(vi.mocked(spawnSync).mock.calls.every(([exe, args, opts]) =>
      exe === "C:\\Program Files\\Git\\cmd\\git.exe" && opts?.shell === false &&
      !args?.some((arg) => /^(commit|push|add|reset|checkout|clean)$/.test(arg)))).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["read-only-result.json"]);
    const result = JSON.parse(fs.readFileSync(path.join(dir, "read-only-result.json"), "utf8"));
    expect(result).toMatchObject({ state: "DONE", mode: "read_only", changed_paths: [], published: false });
    expect(result.summary).not.toContain("HUMAN_SCOPE_CONFIRMATION_REQUIRED");
  });
  it("rejects unknown jobs and task IDs without writes", () => {
    const root = temp();
    expect(() => getOrchestrationStatus("unknown", root)).toThrow();
    expect(() => getOrchestrationResult("../outside", root)).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("polls registered running/exited processes without returning logs", () => {
    const root = temp(), id = "test-job", task = "rpc-test-task";
    const dir = path.join(root, "rpc-jobs", id);
    fs.mkdirSync(dir, { recursive: true });
    const job = { job_id: id, task_id: task, process_id: process.pid, repo_key: "pve-doc", started_at: new Date().toISOString(), goal_sha256: "0".repeat(64), stdout_path: path.join(dir, "stdout.log"), stderr_path: path.join(dir, "stderr.log") };
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job));
    fs.writeFileSync(path.join(dir, "stdout.log"), "SECRET".repeat(10000) + "\nRESULT: BLOCKED\n");
    const status = getOrchestrationStatus(task, root);
    expect(status.process).toBe("running");
    expect(status.state).toBeNull();
    expect(JSON.stringify(status)).not.toContain("SECRET");
    const result = getOrchestrationResult(id, root);
    expect(result.final_result_line).toBe("RESULT: BLOCKED");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ ...job, exit_code: 2 }));
    expect(getOrchestrationStatus(id, root).process).toBe("exited");
  });
  it("reads BLOCKED, NEEDS_APPROVAL and READY_FOR_REVIEW only from task ledger evidence", () => {
    const root = temp(), id = "ledger-job", task = "rpc-ledger-task", dir = path.join(root, "rpc-jobs", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ job_id: id, task_id: task, repo_key: "pve-doc", process_id: process.pid, started_at: new Date().toISOString(), exit_code: 2 }));
    const ledger = path.join("C:\\work\\pve-doc", ".ai", "tasks", task, "status.json");
    const exists = fs.existsSync.bind(fs), read = fs.readFileSync.bind(fs);
    let state = "BLOCKED";
    const existsMock = vi.spyOn(fs, "existsSync").mockImplementation((file) => String(file) === ledger || exists(file));
    const readMock = vi.spyOn(fs, "readFileSync").mockImplementation(((file: string, encoding?: string) =>
      String(file) === ledger ? JSON.stringify({ task_id: task, state, last_updated: "2026-09-24T00:00:00Z", message: "Human review needed", allowed_paths: ["README.md"], verify_completed: false }) : read(file, encoding as BufferEncoding)) as typeof fs.readFileSync);
    try {
      for (state of ["BLOCKED", "NEEDS_APPROVAL", "READY_FOR_REVIEW"]) {
        expect(getOrchestrationStatus(id, root).state).toBe(state);
        expect(getOrchestrationResult(id, root).state).toBe(state);
      }
      expect(getOrchestrationResult(id, root).changed_paths).toEqual(["README.md"]);
      expect(getOrchestrationResult(id, root).published).toBe(false);
    } finally { existsMock.mockRestore(); readMock.mockRestore(); }
  });
});
