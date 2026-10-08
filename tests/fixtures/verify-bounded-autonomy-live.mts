// Explicit opt-in local fixture probe. Never points task execution at the main repo.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--execute-task")) {
  const id = process.argv[process.argv.indexOf("--execute-task") + 1];
  const fixture = process.env.C2C_LIVE_FIXTURE!;
  if (!fixture || !path.basename(fixture).startsWith("autonomy-live-") || !/^bounded-[a-f0-9]{32}$/.test(id)) throw new Error("INVALID_FIXTURE_CHILD");
  process.env.C2C_STATE_DIR = path.join(fixture, "state");
  const { BoundedTasks } = await import("../../src/mcp/bounded-task.js");
  const tasks = new BoundedTasks({ "codex-with-chatgpt": fs.realpathSync.native(path.join(fixture, "repo")) }, undefined, undefined,
    { "codex-with-chatgpt": "tracked_typescript_dashboard" });
  await tasks.execute(id);
  console.log("DURABLE_REVIEW_PENDING");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (!process.argv.includes("--run")) throw new Error("Explicit --run required");
const scenario = process.argv[process.argv.indexOf("--scenario") + 1] ?? "B";
if (!["A", "B", "C", "D"].includes(scenario)) throw new Error("Explicit --scenario A|B|C|D required");
const source = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const root = path.join(source, ".tooling", `autonomy-live-${Date.now()}`);
const repo = path.join(root, "repo"), state = path.join(root, "state");
fs.mkdirSync(path.join(repo, "src/dashboard"), { recursive: true });
fs.mkdirSync(path.join(repo, "tests")); fs.mkdirSync(state);
process.env.C2C_STATE_DIR = state;
fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
fs.writeFileSync(path.join(repo, "src/dashboard/banner.ts"), 'export const banner: string = "PENDING";\n');
fs.writeFileSync(path.join(repo, "tests/dashboard-banner.test.ts"), 'import { expect, it } from "vitest";\nimport { banner } from "../src/dashboard/banner.js";\nit("banner is bounded display text", () => { expect(typeof banner).toBe("string"); expect(banner.length).toBeLessThan(32); });\n');
if (scenario === "A" || scenario === "D") fs.appendFileSync(path.join(repo, "tests/dashboard-banner.test.ts"), 'it("banner is exactly READY", () => { expect(banner).toBe("READY"); });\n');
fs.writeFileSync(path.join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true }, include: ["src/**/*.ts", "tests/**/*.ts"] }));
for (const name of ["package.json", "pnpm-lock.yaml"]) fs.copyFileSync(path.join(source, name), path.join(repo, name));
// Reuse the pinned, cached toolchain. No new dependency or install script is authorized.
const install = execFileSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "pnpm install --offline --ignore-scripts --ignore-workspace"],
  { cwd: repo, timeout: 180000, encoding: "utf8" });
fs.writeFileSync(path.join(root, "install.log"), install);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git("init", "-q"); git("config", "core.autocrlf", "false");
git("config", "user.name", "Autonomy fixture"); git("config", "user.email", "fixture@local.invalid");
git("add", "."); git("commit", "-qm", "isolated development fixture");
const baseline = git("rev-parse", "HEAD");

const { BoundedTasks, opencodeWorker } = await import("../../src/mcp/bounded-task.js");
const { BoundedCampaigns } = await import("../../src/mcp/bounded-campaign.js");
const { createBoundedLifecycleController, recoverFailedBoundedWorkspace } = await import("../../src/mcp/server.js");
const { prepareBoundedCommit, commitBoundedPatch, getBoundedCommitStatus } = await import("../../src/mcp/typed-actions.js");
const { semanticSession } = await import("../../src/mcp/semantic-session.js");
const { Collector } = await import("../../src/dashboard/collector.js");
const { createDashboard } = await import("../../src/dashboard/server.js");
const { Workspace } = await import("../../src/workspace/manager.js");
let workerCalls = 0;
const faultLog: unknown[] = [];
const worker: typeof opencodeWorker = async (repo, prompt, timeout, promptTimeout) => {
  workerCalls++;
  // Scenario C injects a wrong goal into three real worker prompts. The independent
  // reviewer still receives the actual READY contract and must reject the drafts.
  // This seam is fixture-only and every injected prompt is retained as evidence.
  if (scenario === "C" && workerCalls <= 3) {
    const marker = prompt.indexOf("Contract: ") + 10;
    const input = JSON.parse(prompt.slice(marker));
    input.contract.goal = `Set banner to exactly DRAFT${workerCalls}. Keep tests unchanged.`;
    input.contract.acceptance_criteria = [`banner is exactly DRAFT${workerCalls}`, "Keep tests unchanged"];
    input.feedback = [];
    prompt = prompt.slice(0, marker) + JSON.stringify(input);
    faultLog.push({ worker_call: workerCalls, kind: "wrong_goal_in_real_worker_prompt", prompt });
    fs.writeFileSync(path.join(root, "fault-injection.json"), JSON.stringify(faultLog, null, 2));
  }
  return opencodeWorker(repo, prompt, timeout, promptTimeout);
};
const tasks = new BoundedTasks({ "codex-with-chatgpt": fs.realpathSync.native(repo) }, undefined, worker,
  { "codex-with-chatgpt": "tracked_typescript_dashboard" });
const controller = createBoundedLifecycleController(tasks, repo, id => {
  prepareBoundedCommit(tasks, id, state); commitBoundedPatch(tasks, id, state, repo);
}, semanticSession);
let crashEvidence: unknown = null;
if (scenario === "D") {
  const normalRun = controller.runBoundedLifecycle;
  let interrupted = false;
  controller.runBoundedLifecycle = id => {
    if (interrupted) return normalRun(id);
    interrupted = true; controller.lifecycleRunning.add(id);
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--execute-task", id],
      { cwd: source, env: { ...process.env, C2C_LIVE_FIXTURE: root }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => {
      if (chunk.toString().includes("DURABLE_REVIEW_PENDING")) {
        crashEvidence = { old_controller_pid: child.pid, new_controller_pid: process.pid, state_at_kill: tasks.status(id).state };
        child.kill();
      }
    });
    child.on("close", () => { controller.lifecycleRunning.delete(id); });
    return true;
  };
}
const campaigns = new BoundedCampaigns(path.join(state, "bounded-campaigns"), tasks, controller, id => {
  tasks.withRecoveryLock(id, task => { recoverFailedBoundedWorkspace(tasks, new Workspace(repo), task, repo); });
}, id => getBoundedCommitStatus(tasks, id, state).state === "COMMITTED");
const stop = campaigns.run();
const collector = new Collector({ fixture: repo }, path.join(root, "review"), path.join(root, "queue"), undefined, {},
  id => getBoundedCommitStatus(tasks, id, state));
const app = createDashboard(collector, false, undefined, contract => campaigns.start(contract), Date.now, () => campaigns.list());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("FIXTURE_LISTENER_FAILED");
const base = `http://127.0.0.1:${address.port}`;
console.log(JSON.stringify({ scenario, fixture: root, dashboard: base, baseline }));
let id = "";
try {
  const session = await fetch(`${base}/api/bounded/start-session`, { headers: { "sec-fetch-site": "same-origin" } });
  const csrf = session.headers.get("x-bounded-start-csrf"), cookie = session.headers.get("set-cookie")?.split(";")[0];
  if (!csrf || !cookie) throw new Error("FIXTURE_SESSION_FAILED");
  const response = await fetch(`${base}/api/bounded/start`, { method: "POST", headers: {
    "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin", cookie, "x-bounded-start-csrf": csrf,
  }, body: JSON.stringify({ repo: "codex-with-chatgpt", goal: 'Set the exported dashboard banner constant to exactly "READY".',
    edit_paths: ["src/dashboard/banner.ts", "tests/dashboard-banner.test.ts"],
    acceptance_criteria: ['banner is exactly "READY"', "Preserve existing test assertions; adding a focused READY assertion is allowed. Typecheck and Vitest pass."] }) });
  const started = await response.json() as { task_id?: string };
  if (response.status !== 201 || !started.task_id) throw new Error("FIXTURE_START_FAILED");
  id = started.task_id;
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const campaign = campaigns.status(id);
    if (["COMMITTED", "STOPPED"].includes(campaign.state)) {
      const dashboard = await (await fetch(`${base}/api/status`)).json();
      const evidence = { scenario, fixture: root, baseline, head: git("rev-parse", "HEAD"), campaign, dashboard, crashEvidence,
        task: tasks.status(campaign.current_task), authoritative_done: false };
      fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ state: campaign.state, stop_reason: campaign.stop_reason, evidence: path.join(root, "result.json") }));
      if (campaign.state !== "COMMITTED") process.exitCode = 1;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!["COMMITTED", "STOPPED"].includes(campaigns.status(id).state)) throw new Error("LIVE_FIXTURE_DEADLINE");
} finally {
  stop(); server.close();
}
