import fs from "node:fs";
import { createHash } from "node:crypto";
import { safePath, GatewayError } from "../mcp/local-gateway.js";

// Read-only executor projection. Claims/requests are transport evidence, not
// authorization for starting, retrying, or completing a task.
export function queueDepth(queueRoot: string): number | null {
  try {
    const requests = safePath(queueRoot, "requests"), results = safePath(queueRoot, "results");
    return fs.readdirSync(requests, { withFileTypes: true }).filter(e => e.isFile() &&
      /^[A-Za-z0-9_-]+-[12]\.json$/.test(e.name) && !fs.existsSync(safePath(results, e.name))).length;
  } catch { return null; }
}

export function activeQueueTask<T extends { task_id: string; repo: string; state: string | null }>(
  queueRoot: string, roots: Readonly<Record<string, string>>, tasks: T[], heartbeatFresh: boolean): T | null {
  if (!heartbeatFresh) return null;
  const requests = safePath(queueRoot, "requests");
  try {
    for (const entry of fs.readdirSync(requests, { withFileTypes: true })) {
      if (!entry.isFile() || !/^([A-Za-z0-9_-]+)-([12])\.json$/.test(entry.name)) continue;
      const name = entry.name.slice(0, -5);
      const requestFile = safePath(queueRoot, `requests/${entry.name}`);
      const runningFile = safePath(queueRoot, `claims/${name}.running`);
      const resultFile = safePath(queueRoot, `results/${entry.name}`);
      if (!fs.existsSync(runningFile) || fs.existsSync(resultFile)) continue;
      if (!fs.lstatSync(requestFile).isFile() || fs.statSync(requestFile).size > 16384 ||
          !fs.lstatSync(runningFile).isFile() || fs.statSync(runningFile).size !== 64) continue;
      const bytes = fs.readFileSync(requestFile);
      if (fs.readFileSync(runningFile, "utf8") !== createHash("sha256").update(bytes).digest("hex")) continue;
      let request: Record<string, unknown> | null;
      try { request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; } catch { continue; }
      const task = tasks.find(t => t.task_id === request?.task_id && roots[t.repo] === request.repo);
      if (request?.kind !== "orchestration" || `${request.task_id}-${request.attempt}` !== name || task?.state !== "EXECUTING") continue;
      return task;
    }
  } catch (error) { if (error instanceof GatewayError) throw error; /* incomplete queue stays unknown */ }
  return null;
}
