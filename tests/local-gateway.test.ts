import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { REVIEW_ROOT, verifyBundleIntegrity, startTestJob, startOrchestration, getOrchestrationStatus, getOrchestrationResult, getOrchestrationApproval, getOrchestrationRetryPlan, retryOrchestration, validateEditPaths, completeOrchestration, completeIntegratedOrchestration } from "../src/mcp/local-gateway.js";
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
  it("never invokes the engine without an explicit PASS and approval or with an unsafe task ID", () => {
    expect(() => completeOrchestration("task-1", "NEEDS_WORK", true)).toThrow();
    expect(() => completeOrchestration("task-1", "PASS", false)).toThrow();
    expect(() => completeOrchestration("../task-1", "PASS", true)).toThrow();
    expect(() => completeIntegratedOrchestration("task-1", "NEEDS_WORK", true)).toThrow();
    expect(() => completeIntegratedOrchestration("task-1", "PASS", false)).toThrow();
    expect(() => completeIntegratedOrchestration("../task-1", "PASS", true)).toThrow();
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });
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
  it("reads the existing integrated CPU task without a registry job or any writes", () => {
    const id = "rpc-e2e-cpu-20260925-02";
    const registry = path.join(REVIEW_ROOT, "rpc-jobs");
    expect(fs.readdirSync(registry).some((entry) => {
      const file = path.join(registry, entry, "job.json");
      return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).task_id === id;
    })).toBe(false);
    const write = vi.spyOn(fs, "writeFileSync");
    try {
      expect(getOrchestrationStatus(id)).toMatchObject({ task_id: id, repo: "pve-doc", job_id: null,
        state: "DONE", process: "not_running", result_category: "DONE", next_action: "None" });
      expect(getOrchestrationResult(id)).toMatchObject({ task_id: id, repo: "pve-doc", mode: "change", state: "DONE",
        result_category: "DONE", review_result: "PASS", done_approved: true, completion_mode: "post_integration",
        integrated_commit: "97920b6bf6cdd86e9f89b3f416f5f9ed2977a98e", published: true,
        changed_paths: ["03_services/ai-workspace.md"], verification: { completed: true, exit_code: 0 } });
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
  it("reads normal review DONE and READY_FOR_REVIEW from a fixed ledger, failing closed on ambiguity and traversal", () => {
    const root = temp(), id = "rpc-fallback-test", repo = "C:\\work\\pve-doc", other = "C:\\work\\ai-orchestration-config";
    const ledger = path.join(repo, ".ai", "tasks", id, "status.json");
    const duplicate = path.join(other, ".ai", "tasks", id, "status.json");
    const decision = path.join(repo, ".ai", "tasks", id, "review-decision.json");
    const status = { task_id: id, state: "DONE", message: "Reviewed", edits: [{ path: "README.md" }], verify_completed: true,
      verify_exit_code: 0, state_transition_history: [{ to: "DONE", timestamp: "2026-09-25T12:00:00Z" }] };
    const files = new Map([[ledger, JSON.stringify(status)], [decision, JSON.stringify({ task_id: id, new_state: "DONE",
      review_result: "PASS", done_approved: true, reviewed_at: "2026-09-25T12:00:00Z" })]]);
    const originalExists = fs.existsSync.bind(fs), originalRead = fs.readFileSync.bind(fs);
    const exists = vi.spyOn(fs, "existsSync").mockImplementation((file) => files.has(String(file)) || originalExists(file));
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((file: string, encoding?: string) =>
      files.has(String(file)) ? files.get(String(file))! : originalRead(file, encoding as BufferEncoding)) as typeof fs.readFileSync);
    try {
      expect(getOrchestrationResult(id, root)).toMatchObject({ job_id: null, state: "DONE", result_category: "DONE",
        review_result: "PASS", done_approved: true, completion_mode: null, integrated_commit: null,
        completed_at: "2026-09-25T12:00:00Z", published: false });
      status.state = "READY_FOR_REVIEW";
      files.set(ledger, JSON.stringify(status));
      expect(getOrchestrationStatus(id, root)).toMatchObject({ state: "READY_FOR_REVIEW", stop_reason_category: "READY_FOR_REVIEW" });
      expect(getOrchestrationResult(id, root)).toMatchObject({ state: "READY_FOR_REVIEW", published: false });
      files.set(duplicate, JSON.stringify(status));
      expect(() => getOrchestrationStatus(id, root)).toThrow(/multiple allowlisted/);
      expect(() => getOrchestrationResult(id, root)).toThrow(/multiple allowlisted/);
      for (const bad of ["../rpc-fallback-test", "rpc-../test", "rpc-foo\\bar", "rpc-%2e%2e", "rpc-"]) {
        expect(() => getOrchestrationResult(bad, root)).toThrow();
      }
      expect(() => getOrchestrationResult("rpc-nonexistent-ledger-task", root)).toThrow(/Unknown/);
    } finally { exists.mockRestore(); read.mockRestore(); }
  });
  it("rejects a reparse-point task directory before reading ledger evidence", () => {
    const root = temp(), id = "rpc-symlink-escape";
    const directory = path.join("C:\\work\\pve-doc", ".ai", "tasks", id);
    const original = fs.lstatSync.bind(fs);
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((file: string) =>
      String(file) === directory ? { isSymbolicLink: () => true } as fs.Stats : original(file)) as typeof fs.lstatSync);
    try {
      expect(() => getOrchestrationResult(id, root)).toThrow(/Reparse or escaped path/);
    } finally { lstat.mockRestore(); }
  });
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
      expect(getOrchestrationResult(id, root).changed_paths).toEqual([]);
      expect(getOrchestrationResult(id, root).published).toBe(false);
    } finally { existsMock.mockRestore(); readMock.mockRestore(); }
  });
  it("inspects recorded approval without exposing replacement text or changing the ledger", () => {
    const root = temp(), id = "approval-job", task = "rpc-approval-task";
    const dir = path.join(root, "rpc-jobs", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ job_id: id, task_id: task, mode: "change", repo_key: "pve-doc", process_id: process.pid, exit_code: 2 }));
    fs.writeFileSync(path.join(dir, "stdout.log"), "RESULT: HUMAN_APPROVAL_REQUIRED\n");
    const ledger = path.join("C:\\work\\pve-doc", ".ai", "tasks", task, "status.json");
    const proposalFile = path.join("C:\\work\\pve-doc", ".ai", "tasks", task, "codex-attempt-1.stdout.txt");
    const status = { task_id: task, state: "NEEDS_APPROVAL", approval_required: true, message: "Codex structured proposal requests approval", edit_paths: ["README.md"],
      allowed_paths: ["README.md", `.ai/tasks/${task}/**`], codex_attempts: 1, verify_completed: false, edits: [] };
    const proposal = { task_id: task, state: "NEEDS_APPROVAL", approval_required: true, message: "Human decision requested", proposed_command: "git push origin main",
      edits: [{ path: "README.md", old_text: "PRIVATE OLD TEXT", new_text: "PRIVATE NEW TEXT" }] };
    const originalExists = fs.existsSync.bind(fs), originalRead = fs.readFileSync.bind(fs);
    const exists = vi.spyOn(fs, "existsSync").mockImplementation((file) => [ledger, proposalFile].includes(String(file)) || originalExists(file));
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((file: string, encoding?: string) =>
      String(file) === ledger ? JSON.stringify(status) : String(file) === proposalFile ? Buffer.from(JSON.stringify(proposal)) : originalRead(file, encoding as BufferEncoding)) as typeof fs.readFileSync);
    try {
      const result = getOrchestrationResult(task, root);
      expect(result).toMatchObject({ task_id: task, state: "NEEDS_APPROVAL", result_category: "HUMAN_APPROVAL_REQUIRED", approval_required: true,
        approval_type: "structured_proposal", approval_reason: status.message, planned_paths: ["README.md"], push_requested: true,
        commit_requested: false, changed_paths_so_far: [], verification_status: { completed: false },
        stop_reason_category: "HUMAN_APPROVAL_REQUIRED", human_action_required: true });
      expect(getOrchestrationStatus(id, root)).toMatchObject({ state: "NEEDS_APPROVAL", result_category: "HUMAN_APPROVAL_REQUIRED",
        stop_reason_category: "HUMAN_APPROVAL_REQUIRED", human_action_required: true });
      expect(result.proposal_hash).toBe(sha(Buffer.from(JSON.stringify(proposal))));
      expect(result.risky_actions).toContain("git push origin main");
      expect(getOrchestrationApproval(id, root).structured_proposal?.edits).toHaveLength(1);
      expect(JSON.stringify(getOrchestrationApproval(id, root))).not.toMatch(/PRIVATE OLD TEXT|PRIVATE NEW TEXT/);
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
      proposal.proposed_command = "";
      proposal.message = "Repository read timed out; unable to inspect files for evidence";
      proposal.edits = [] as typeof proposal.edits;
      expect(getOrchestrationStatus(id, root)).toMatchObject({ state: "NEEDS_APPROVAL", result_category: "HUMAN_APPROVAL_REQUIRED",
        stop_reason_category: "EVIDENCE_INSUFFICIENT", human_action_required: false });
      expect(getOrchestrationResult(id, root).recommended_next_action).toMatch(/retry research/i);
      for (const message of [
        "読み取りコマンドが実行環境の接続タイムアウトで失敗し、編集案を提示しません。",
        "作業環境への読取アクセスが失敗したため、対象文書と未コミット差分を確認できませんでした。正確な置換箇所を特定できず、編集案は提示できません。",
        "Read access failed before inspecting the repository; no edit proposal could be grounded.",
        "Unable to inspect target files; no edit proposal is available.",
        "対象文書を確認できず、編集案を提示できません。",
        "正確な置換箇所を特定できず、編集案は提示できません。",
      ]) {
        proposal.message = message;
        expect(getOrchestrationStatus(id, root)).toMatchObject({ state: "NEEDS_APPROVAL", result_category: "HUMAN_APPROVAL_REQUIRED",
          stop_reason_category: "EVIDENCE_INSUFFICIENT", human_action_required: false });
        expect(getOrchestrationResult(id, root)).toMatchObject({ stop_reason_category: "EVIDENCE_INSUFFICIENT", human_action_required: false });
        expect(getOrchestrationApproval(id, root).stop_reason_category).toBe("EVIDENCE_INSUFFICIENT");
      }
      proposal.message = "No edits; human approval required before proceeding";
      expect(getOrchestrationResult(id, root).stop_reason_category).toBe("HUMAN_APPROVAL_REQUIRED");
      proposal.message = "Unable to inspect target files; request human approval to proceed";
      expect(getOrchestrationResult(id, root).stop_reason_category).toBe("HUMAN_APPROVAL_REQUIRED");
      proposal.message = "Cannot identify replacement; please approve git push";
      expect(getOrchestrationResult(id, root).stop_reason_category).toBe("HUMAN_APPROVAL_REQUIRED");
      proposal.message = "Edit scope unclear: target paths unspecified";
      expect(getOrchestrationResult(id, root)).toMatchObject({ stop_reason_category: "SCOPE_CONFIRMATION_REQUIRED", human_action_required: true });
      status.state = "READY_FOR_REVIEW";
      expect(getOrchestrationStatus(id, root).stop_reason_category).toBe("READY_FOR_REVIEW");
      expect(getOrchestrationResult(id, root).stop_reason_category).toBe("READY_FOR_REVIEW");
      status.state = "BLOCKED";
      status.message = "VerifyInternal failed: validation failed";
      Object.assign(status, { verify_exit_code: 1, state_transition_history: [{ from: "VERIFYING", to: "BLOCKED" }] });
      expect(getOrchestrationStatus(id, root)).toMatchObject({ stop_reason_category: "VERIFY_BLOCKED", human_action_required: false });
      expect(getOrchestrationResult(id, root).recommended_next_action).toMatch(/RetryVerify/);
      status.message = "Codex runtime unavailable";
      expect(getOrchestrationResult(id, root).stop_reason_category).toBe("EXECUTION_BLOCKED");
      status.state = "NEEDS_APPROVAL";
      status.message = "";
      expect(getOrchestrationApproval(id, root).approval_reason).toBe("approval reason unavailable");
      status.state = "BLOCKED";
      expect(() => getOrchestrationApproval(id, root)).toThrow(/not NEEDS_APPROVAL/);
    } finally { exists.mockRestore(); read.mockRestore(); }
  });
  it("classifies pre-ledger scope confirmation without pretending an engine task exists", () => {
    const root = temp(), id = "scope-job", task = "rpc-scope-task", dir = path.join(root, "rpc-jobs", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ job_id: id, task_id: task, repo_key: "pve-doc", process_id: process.pid, exit_code: 2 }));
    fs.writeFileSync(path.join(dir, "stdout.log"), "RESULT: HUMAN_SCOPE_CONFIRMATION_REQUIRED\n");
    expect(getOrchestrationStatus(id, root)).toMatchObject({ state: null, result_category: "HUMAN_SCOPE_CONFIRMATION_REQUIRED",
      stop_reason_category: "SCOPE_CONFIRMATION_REQUIRED", human_action_required: true });
    expect(getOrchestrationResult(id, root)).toMatchObject({ state: null, stop_reason_category: "SCOPE_CONFIRMATION_REQUIRED" });
    expect(() => getOrchestrationApproval(id, root)).toThrow(/not NEEDS_APPROVAL/);
    expect(getOrchestrationRetryPlan(id, root)).toMatchObject({ eligible: false, stop_reason_category: "SCOPE_CONFIRMATION_REQUIRED" });
  });
  it("retries only a hash-matched original goal and identical scoped paths as a new job", () => {
    const root = temp(), id = "retry-parent", task = "rpc-retry-parent", goal = "Read and correct README.md. Do not commit or push.";
    const dir = path.join(root, "rpc-jobs", id);
    fs.mkdirSync(dir, { recursive: true });
    const parent = { job_id: id, task_id: task, mode: "change", repo_key: "ai-orchestration-config", process_id: process.pid,
      exit_code: 2, goal_sha256: sha(Buffer.from(goal)), goal, edit_paths: ["README.md"] };
    const parentBytes = JSON.stringify(parent);
    fs.writeFileSync(path.join(dir, "job.json"), parentBytes);
    fs.writeFileSync(path.join(dir, "stdout.log"), "RESULT: HUMAN_APPROVAL_REQUIRED\n");
    const statusFile = path.join("C:\\work\\ai-orchestration-config", ".ai", "tasks", task, "status.json");
    const proposalFile = path.join("C:\\work\\ai-orchestration-config", ".ai", "tasks", task, "codex-attempt-1.stdout.txt");
    const status = { task_id: task, state: "NEEDS_APPROVAL", goal, message: "Codex structured proposal requests approval", codex_attempts: 1,
      edit_paths: ["README.md"], allowed_paths: ["README.md", `.ai/tasks/${task}/**`], edits: [] };
    const proposal = { task_id: task, state: "EXECUTING", approval_required: true, message: "Repository read timed out; insufficient evidence",
      proposed_command: "", edits: [] as { path: string }[] };
    const existsOriginal = fs.existsSync.bind(fs), readOriginal = fs.readFileSync.bind(fs);
    const exists = vi.spyOn(fs, "existsSync").mockImplementation((file) => [statusFile, proposalFile].includes(String(file)) || existsOriginal(file));
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((file: string, encoding?: string) =>
      String(file) === statusFile ? JSON.stringify(status) : String(file) === proposalFile ? Buffer.from(JSON.stringify(proposal)) : readOriginal(file, encoding as BufferEncoding)) as typeof fs.readFileSync);
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    try {
      expect(() => retryOrchestration("unknown", undefined, root)).toThrow();
      expect(getOrchestrationRetryPlan(task, root)).toMatchObject({ eligible: true, stop_reason_category: "EVIDENCE_INSUFFICIENT",
        inherited_goal: goal, inherited_edit_paths: ["README.md"], attempt: 1 });
      expect(fs.readFileSync(path.join(dir, "job.json"), "utf8")).toBe(parentBytes);
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
      const retried = retryOrchestration(id, "Research timed out", root);
      expect(retried).toMatchObject({ parent_task_id: task, retry_of: task, retry_reason: "Research timed out", attempt: 2 });
      expect(retried.task_id).not.toBe(task);
      const childJob = JSON.parse(fs.readFileSync(path.join(root, "rpc-jobs", retried.job_id, "job.json"), "utf8"));
      expect(childJob).toMatchObject({ goal, goal_sha256: parent.goal_sha256, edit_paths: ["README.md"],
        repo_key: parent.repo_key, mode: parent.mode, parent_task_id: task, retry_of: task, retry_reason: "Research timed out", attempt: 2 });
      expect(getOrchestrationStatus(retried.job_id, root)).toMatchObject({ task_id: retried.task_id, parent_task_id: task, retry_of: task, attempt: 2 });
      expect(getOrchestrationResult(retried.task_id, root)).toMatchObject({ parent_task_id: task, retry_of: task, attempt: 2 });
      const [, args, opts] = vi.mocked(spawn).mock.calls[0];
      expect(opts).toMatchObject({ shell: false });
      expect(args?.slice(4, 10)).toEqual(["-Repo", "C:\\work\\ai-orchestration-config", "-TaskId", retried.task_id, "-Goal", goal]);
      expect(JSON.parse(Buffer.from(args?.[11] ?? "", "base64").toString("utf8"))).toEqual(["README.md"]);
      expect(fs.readFileSync(path.join(dir, "job.json"), "utf8")).toBe(parentBytes);
      expect(getOrchestrationRetryPlan(id, root).eligible).toBe(false);
      expect(() => retryOrchestration(id, undefined, root)).toThrow(/reserved/);
      child.emit("exit", 2);
    } finally { exists.mockRestore(); read.mockRestore(); }
  });
  it("denies risky, review, verify and scope-drift retries without spawning", () => {
    const root = temp(), id = "retry-denied", task = "rpc-retry-denied", goal = "Edit README.md";
    const dir = path.join(root, "rpc-jobs", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ job_id: id, task_id: task, mode: "change", repo_key: "ai-orchestration-config",
      process_id: process.pid, exit_code: 2, goal_sha256: sha(Buffer.from(goal)), goal, edit_paths: ["README.md"] }));
    const statusFile = path.join("C:\\work\\ai-orchestration-config", ".ai", "tasks", task, "status.json");
    const proposalFile = path.join("C:\\work\\ai-orchestration-config", ".ai", "tasks", task, "codex-attempt-1.stdout.txt");
    const status = { task_id: task, state: "NEEDS_APPROVAL", goal, message: "Approval needed", codex_attempts: 1,
      edit_paths: ["README.md"], allowed_paths: ["README.md", `.ai/tasks/${task}/**`], edits: [] };
    const proposal = { task_id: task, message: "Approval required", proposed_command: "git push origin main", edits: [] };
    const existsOriginal = fs.existsSync.bind(fs), readOriginal = fs.readFileSync.bind(fs);
    const exists = vi.spyOn(fs, "existsSync").mockImplementation((file) => [statusFile, proposalFile].includes(String(file)) || existsOriginal(file));
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((file: string, encoding?: string) =>
      String(file) === statusFile ? JSON.stringify(status) : String(file) === proposalFile ? Buffer.from(JSON.stringify(proposal)) : readOriginal(file, encoding as BufferEncoding)) as typeof fs.readFileSync);
    try {
      expect(getOrchestrationRetryPlan(id, root)).toMatchObject({ eligible: false, stop_reason_category: "HUMAN_APPROVAL_REQUIRED" });
      expect(() => retryOrchestration(id, undefined, root)).toThrow(/Human approval/);
      status.state = "READY_FOR_REVIEW";
      expect(() => retryOrchestration(id, undefined, root)).toThrow(/not eligible/);
      status.state = "BLOCKED";
      status.message = "VerifyInternal failed: check";
      Object.assign(status, { verify_exit_code: 1, state_transition_history: [{ from: "VERIFYING", to: "BLOCKED" }] });
      expect(() => retryOrchestration(id, undefined, root)).toThrow(/RetryVerify/);
      status.message = "Runtime unavailable";
      expect(getOrchestrationRetryPlan(id, root)).toMatchObject({ eligible: true, stop_reason_category: "EXECUTION_BLOCKED" });
      status.edit_paths = ["README.md", "docs/other.md"];
      expect(getOrchestrationRetryPlan(id, root)).toMatchObject({ eligible: false });
      status.edit_paths = ["README.md"];
      status.state = "NEEDS_APPROVAL";
      proposal.proposed_command = "";
      proposal.message = "Edit scope unclear: paths unspecified";
      expect(getOrchestrationRetryPlan(id, root)).toMatchObject({ eligible: true, stop_reason_category: "SCOPE_CONFIRMATION_REQUIRED" });
      status.goal = "Different goal";
      expect(getOrchestrationRetryPlan(id, root)).toMatchObject({ eligible: false });
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    } finally { exists.mockRestore(); read.mockRestore(); }
  });
});
