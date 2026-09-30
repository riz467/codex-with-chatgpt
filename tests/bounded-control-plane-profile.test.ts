import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BoundedTasks, type Contract, type Verifier, type Worker } from "../src/mcp/bounded-task.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("bounded control-plane profile", () => {
  it("allows only the exact bootstrap control-plane files and keeps the profile gate out of scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-control-plane-")); roots.push(root);
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "src", "mcp"), { recursive: true });
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });

    fs.writeFileSync(path.join(repo, "src", "mcp", "server.ts"), "export const server = 1;\n");
    fs.writeFileSync(path.join(repo, "src", "mcp", "typed-actions.ts"), "export const action = 1;\n");
    fs.writeFileSync(path.join(repo, "tests", "typed-actions.test.ts"), "export const test = 1;\n");
    fs.writeFileSync(path.join(repo, "src", "mcp", "bounded-task.ts"), "export const gate = 1;\n");
    fs.writeFileSync(path.join(repo, "src", "mcp", "local-gateway.ts"), "export const gateway = 1;\n");

    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");

    const actual = fs.realpathSync.native(repo);
    const worker: Worker = async () => ({
      worker: "opencode", session_id: "ses_control", execution_id: "msg_control",
      provider: "fixture", model: "fixture", usage: null, tools: 0, state: "completed",
      output: JSON.stringify({ edits: [{
        path: "src/mcp/typed-actions.ts",
        old_text: "export const action = 1;",
        new_text: "export const action = 2;",
      }] }),
    });
    const verifier: Verifier = (_repo, profile, paths) => ({
      profile, passed: true, paths: [...paths], tests_run: 0, checks: [],
    });
    const tasks = new BoundedTasks(
      { control: actual },
      path.join(root, "store"),
      worker,
      { control: "tracked_typescript_control_plane" },
      verifier,
    );

    const base: Contract = {
      repo: "control",
      goal: "Implement one bounded typed action",
      edit_paths: ["src/mcp/server.ts", "src/mcp/typed-actions.ts", "tests/typed-actions.test.ts"],
      acceptance_criteria: ["Remain inside the fixed control-plane scope"],
      task_kind: "text_change",
      execution_profile: "tracked_typescript_control_plane",
      worker: "opencode",
      codex: { allowed: false, max_calls: 0 },
      max_revisions: 1,
      timeout_ms: 600000,
    };

    expect(() => tasks.start({ ...base, edit_paths: ["src/mcp/bounded-task.ts"] })).toThrow("INVALID_CONTRACT");
    expect(() => tasks.start({ ...base, edit_paths: ["src/mcp/local-gateway.ts"] })).toThrow("INVALID_CONTRACT");
    expect(() => tasks.start({ ...base, execution_profile: "tracked_typescript_dashboard" })).toThrow("INVALID_CONTRACT");

    const started = tasks.start(base);
    const result = await tasks.execute(started.task_id);
    expect(result.state).toBe("REVIEW_PENDING");
    expect(tasks.status(started.task_id).codex_calls).toBe(0);
    expect(tasks.artifacts(started.task_id, 1).verify).toMatchObject({
      profile: "tracked_typescript_control_plane",
      passed: true,
      paths: ["src/mcp/typed-actions.ts"],
    });
  });
});