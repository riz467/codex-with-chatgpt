import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BoundedTasks, Contract } from "./bounded-task.js";
import { GatewayError, safePath } from "./local-gateway.js";
import { acquireProcessLock, ProcessLockInspectionRequired } from "./bounded-process-lock.js";

const idPattern = /^bounded-[a-f0-9]{32}$/;
const newId = () => `bounded-${randomUUID().replaceAll("-", "")}`;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type Campaign = {
  version: 1; campaign_id: string; contract: Contract; contract_digest: string;
  task_ids: string[]; current_task: string; pending_task: string | null;
  state: "RUNNING" | "RECOVERING" | "COMMITTED" | "STOPPED";
  started_at: string; deadline: number; failures: string[]; finalize_attempts: number;
  stop_reason: string | null; human_action: string | null; impact_paths: string[];
};
type Lifecycle = { lifecycleRunning: Set<string>; runBoundedLifecycle(id: string): boolean };
export class BoundedCampaigns {
  private stopTimer?: () => void;
  constructor(private readonly root: string, private readonly tasks: BoundedTasks,
    private readonly lifecycle: Lifecycle, private readonly recover: (id: string) => void,
    private readonly committed: (id: string) => boolean) {}
  private file(id: string) {
    if (!idPattern.test(id)) throw new GatewayError("INVALID_TASK_ID", "Invalid campaign ID");
    return safePath(this.root, `${id}.json`);
  }
  private save(c: Campaign) {
    fs.mkdirSync(this.root, { recursive: true });
    const file = this.file(c.campaign_id), temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(c), { flag: "wx" }); fs.renameSync(temp, file);
  }
  status(id: string): Campaign {
    const c = JSON.parse(fs.readFileSync(this.file(id), "utf8")) as Campaign;
    if (c.version !== 1 || c.campaign_id !== id || digest(c.contract) !== c.contract_digest ||
        !Array.isArray(c.task_ids) || c.task_ids.length > 3 || c.task_ids.some(t => !idPattern.test(t)) ||
        !idPattern.test(c.current_task) || (c.pending_task !== null && !idPattern.test(c.pending_task)) ||
        !Number.isFinite(c.deadline) || c.deadline > Date.parse(c.started_at) + 45 * 60_000)
      throw new Error("CAMPAIGN_LEDGER_INVALID");
    return c;
  }
  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter(n => /^bounded-[a-f0-9]{32}\.json$/.test(n)).map(n => {
      try { return this.status(n.slice(0, -5)); } catch {
        return { campaign_id: n.slice(0, -5), state: "STOPPED" as const, current_task: null,
          task_ids: [], impact_paths: [], stop_reason: "CAMPAIGN_LEDGER_INVALID",
          human_action: "Inspect the invalid campaign ledger; its bytes were preserved and no task was resumed." };
      }
    });
  }
  start(contract: Contract) {
    const id = newId();
    const c: Campaign = { version: 1, campaign_id: id, contract, contract_digest: digest(contract),
      task_ids: [], current_task: id, pending_task: id, state: "RUNNING", started_at: new Date().toISOString(),
      deadline: Date.now() + 45 * 60_000, failures: [], finalize_attempts: 0,
      stop_reason: null, human_action: null, impact_paths: [...contract.edit_paths] };
    // Write intent before task creation; restart uses this same ID, never a fresh one.
    c.deadline = Date.parse(c.started_at) + 45 * 60_000;
    this.save(c);
    try {
      const started = this.tasks.start(contract, id, undefined, c.deadline);
      c.task_ids.push(id); c.pending_task = null; this.save(c);
      this.lifecycle.runBoundedLifecycle(id);
      return started;
    } catch (error) { this.stop(c, "START_FAILED"); throw error; }
  }
  private stop(c: Campaign, reason: string) {
    c.state = "STOPPED"; c.stop_reason = reason;
    c.human_action = "Inspect the task ledger and affected paths; resolve the reported cause before authorizing a new campaign. Do not manually replay commit or delete unknown locks.";
    this.save(c);
  }
  tick(id: string) {
    let release: (() => void) | null = null;
    let c: Campaign | undefined;
    try {
      c = this.status(id);
      if (c.state === "COMMITTED" || c.state === "STOPPED" && c.stop_reason !== "CAMPAIGN_TIME_BUDGET_EXHAUSTED") return;
      release = acquireProcessLock(safePath(this.root, `${id}.controller.lock`));
      if (!release) {
        if (Date.now() >= c.deadline) this.stop(c, "CAMPAIGN_TIME_BUDGET_EXHAUSTED");
        return;
      }
      c = this.status(id);
      if (c.state === "COMMITTED" || c.state === "STOPPED" && c.stop_reason !== "CAMPAIGN_TIME_BUDGET_EXHAUSTED") return;
      // Project an existing verified receipt even after downtime outlasts the
      // execution budget. This path never starts work or creates a new commit.
      if (!c.pending_task && this.tasks.status(c.current_task).state === "REVIEW_ACCEPTED") {
        const unlock = this.tasks.lifecycleLock(c.current_task);
        if (!unlock) {
          if (Date.now() >= c.deadline) this.stop(c, "CAMPAIGN_TIME_BUDGET_EXHAUSTED");
          return;
        }
        try {
          if (this.committed(c.current_task)) {
            c.state = "COMMITTED"; c.stop_reason = null; c.human_action = null; this.save(c); return;
          }
        } finally { unlock(); }
      }
      // A deadline-stopped campaign may project a commit that another owner
      // completed, but must never resume execution, review, recovery or commit.
      if (c.state === "STOPPED") return;
      if (Date.now() >= c.deadline) { this.stop(c, "CAMPAIGN_TIME_BUDGET_EXHAUSTED"); return; }
      if (this.lifecycle.lifecycleRunning.has(c.current_task)) return;
      // Another Dashboard/Gateway process may own this task's full lifecycle.
      if (!c.pending_task) {
        const probe = this.tasks.lifecycleLock(c.current_task);
        if (!probe) return;
        probe();
      }
      if (c.pending_task) {
        let exists = false;
        try { this.tasks.status(c.pending_task); exists = true; } catch (error) {
          if (!(error instanceof GatewayError) || error.code !== "NOT_FOUND") throw error;
        }
        if (!exists) this.tasks.start(c.contract, c.pending_task, c.task_ids.at(-1), c.deadline);
        c.current_task = c.pending_task;
        if (!c.task_ids.includes(c.current_task)) c.task_ids.push(c.current_task);
        c.pending_task = null; c.state = "RUNNING"; c.finalize_attempts = 0; this.save(c);
      }
      const task = this.tasks.status(c.current_task);
      if (JSON.stringify(task.contract) !== JSON.stringify(this.tasks.status(c.task_ids[0]).contract))
        throw new Error("CAMPAIGN_SCOPE_CHANGED");
      if (this.tasks.executing(c.current_task)) { this.stop(c, "INTERRUPTED_OR_ACTIVE_EXECUTION_REQUIRES_INSPECTION"); return; }
      if (task.state === "REVIEW_ACCEPTED") {
        if (this.committed(c.current_task)) { c.state = "COMMITTED"; this.save(c); return; }
        if (c.finalize_attempts >= 2) { this.stop(c, task.controller_diagnostic?.error_code ?? "FINALIZATION_BUDGET_EXHAUSTED"); return; }
        c.finalize_attempts++; this.save(c); this.lifecycle.runBoundedLifecycle(c.current_task); return;
      }
      const latest = task.revisions.at(-1);
      if (task.state === "REVIEW_PENDING" && (!latest || !latest.worker?.session_id || !latest.worker?.execution_id || !latest.verify?.passed)) {
        this.stop(c, "REVIEW_EVIDENCE_MISSING"); return;
      }
      if (latest?.semantic_review_diagnostic) { this.stop(c, latest.semantic_review_diagnostic.error_code); return; }
      if (task.state !== "ESCALATE") { this.lifecycle.runBoundedLifecycle(c.current_task); return; }
      if (!["REVISION_BUDGET_EXHAUSTED", "VERIFY_FAILED", "VERIFY_TIMEOUT", "EXECUTION_UNKNOWN", "WORKER_FAILED", "WORKER_TIMEOUT", "INVALID_PROPOSAL"].includes(task.stop_reason ?? "")) {
        this.stop(c, task.stop_reason ?? "UNKNOWN_FAILURE"); return;
      }
      const fingerprint = digest({ code: task.stop_reason, findings: latest?.review?.findings });
      if (c.state !== "RECOVERING") {
        c.failures.push(fingerprint); c.state = "RECOVERING"; this.save(c);
      }
      this.recover(c.current_task);
      if (c.task_ids.length >= 3 || c.failures.filter(f => f === fingerprint).length >= 2) {
        this.stop(c, "CAMPAIGN_ATTEMPT_BUDGET_EXHAUSTED"); return;
      }
      c.pending_task = newId(); this.save(c);
      // A subsequent tick consumes the persisted handoff intent, including after restart.
    } catch (error) {
      if (c) this.stop(c, error instanceof GatewayError ? error.code : error instanceof ProcessLockInspectionRequired ? error.message : "CAMPAIGN_RECONCILIATION_FAILED");
    } finally { release?.(); }
  }
  run() {
    if (this.stopTimer) return this.stopTimer;
    const reconcile = () => { for (const c of this.list()) if ("contract" in c) this.tick(c.campaign_id); };
    reconcile(); const timer = setInterval(reconcile, 1500); timer.unref();
    this.stopTimer = () => { clearInterval(timer); this.stopTimer = undefined; };
    return this.stopTimer;
  }
}
