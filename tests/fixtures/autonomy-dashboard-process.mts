import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Owns the entire fixture Dashboard, scheduler, worker and reviewer lifecycle.
export async function startFixtureDashboard(root: string, interrupt: boolean, onReviewPending: () => void) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--serve"], {
    env: { ...process.env, C2C_LIVE_FIXTURE: root, C2C_STATE_DIR: path.join(root, "state"),
      C2C_FIXTURE_INTERRUPT: interrupt ? "1" : "0" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("DASHBOARD_CHILD_START_TIMEOUT")); }, 30000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("DASHBOARD_CHILD_EXITED")); });
    child.on("message", (message: any) => {
      if (message.type === "ready") { clearTimeout(timer); resolve(message.base); }
      if (message.type === "review_pending") onReviewPending();
    });
    child.stderr.on("data", data => fs.appendFileSync(path.join(root, "dashboard-child.log"), data));
  });
  return { base, pid: child.pid!, async stop() { child.kill(); await exited; } };
}

if (process.argv.includes("--serve")) {
  const root = process.env.C2C_LIVE_FIXTURE!;
  if (!root || !path.basename(root).startsWith("autonomy-live-")) throw new Error("INVALID_FIXTURE_CHILD");
  const repo = fs.realpathSync.native(path.join(root, "repo")), state = path.join(root, "state");
  const { BoundedTasks, opencodeWorker } = await import("../../src/mcp/bounded-task.js");
  const { BoundedCampaigns } = await import("../../src/mcp/bounded-campaign.js");
  const { createBoundedLifecycleController, recoverFailedBoundedWorkspace } = await import("../../src/mcp/server.js");
  const { prepareBoundedCommit, commitBoundedPatch, getBoundedCommitStatus, reconcileBoundedCommit } = await import("../../src/mcp/typed-actions.js");
  const { semanticSession } = await import("../../src/mcp/semantic-session.js");
  const { Collector } = await import("../../src/dashboard/collector.js");
  const { createDashboard } = await import("../../src/dashboard/server.js");
  const { Workspace } = await import("../../src/workspace/manager.js");
  const tasks = new BoundedTasks({ "codex-with-chatgpt": repo }, undefined, async (...args) => {
    fs.appendFileSync(path.join(root, "dashboard-worker-calls.jsonl"), JSON.stringify({ pid: process.pid }) + "\n");
    return opencodeWorker(...args);
  }, { "codex-with-chatgpt": "tracked_typescript_dashboard" });
  let stopCampaigns = () => {};
  const lifecycle = createBoundedLifecycleController(tasks, repo, id => {
    prepareBoundedCommit(tasks, id, state); commitBoundedPatch(tasks, id, state, repo);
  }, async (...args) => {
    if (process.env.C2C_FIXTURE_INTERRUPT === "1") {
      // Select the durable pending-review crash boundary, not an arbitrary
      // unowned gate-creation instruction that intentionally requires inspection.
      stopCampaigns();
      fs.writeFileSync(path.join(root, "restart-boundary.json"), JSON.stringify({
        state: "REVIEW_PENDING", scheduler_quiesced_before_kill: true, pid: process.pid }));
      process.send?.({ type: "review_pending" });
      await new Promise(() => {});
    }
    return semanticSession(...args);
  });
  const campaigns = new BoundedCampaigns(path.join(state, "bounded-campaigns"), tasks, lifecycle, id => {
    tasks.withRecoveryLock(id, task => recoverFailedBoundedWorkspace(tasks, new Workspace(repo), task, repo));
  }, id => reconcileBoundedCommit(tasks, id, state, repo));
  const collector = new Collector({ fixture: repo }, path.join(root, "review"), path.join(root, "queue"), undefined, {},
    id => getBoundedCommitStatus(tasks, id, state));
  const server = createDashboard(collector, false, undefined, contract => campaigns.start(contract), Date.now, () => campaigns.list()).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("FIXTURE_LISTENER_FAILED");
  stopCampaigns = campaigns.run();
  process.send?.({ type: "ready", base: `http://127.0.0.1:${address.port}` });
}
