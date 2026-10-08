import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class ProcessLockInspectionRequired extends Error {
  constructor(reason = "PROCESS_LOCK_GATE_REQUIRES_INSPECTION") { super(reason); }
}

// PID reuse and access-denied are conservatively treated as alive. Legacy/partial
// locks without a parseable owner are never stolen.
export function acquireProcessLock(lock: string): (() => void) | null {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const gate = `${lock}.gate`;
  try { fs.mkdirSync(gate); } catch {
    // An unowned gate cannot safely be stolen. Bound contention waiting and
    // surface inspection instead of silently retrying an interrupted gate forever.
    try {
      if (Date.now() - fs.statSync(gate).mtimeMs >= 30_000) throw new ProcessLockInspectionRequired();
    } catch (error) { if (error instanceof ProcessLockInspectionRequired) throw error; }
    return null;
  }
  const owner = { pid: process.pid, nonce: randomUUID() };
  try {
    if (fs.existsSync(lock)) {
      let prior: { pid: number };
      try { prior = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); }
      catch { throw new ProcessLockInspectionRequired("PROCESS_LOCK_OWNER_REQUIRES_INSPECTION"); }
      if (!prior || !Number.isSafeInteger(prior.pid) || prior.pid < 1)
        throw new ProcessLockInspectionRequired("PROCESS_LOCK_OWNER_REQUIRES_INSPECTION");
      try { process.kill(prior.pid, 0); return null; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null;
      }
      fs.rmSync(lock, { recursive: true });
    }
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx" });
  } finally { fs.rmdirSync(gate); }
  return () => {
    const current = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
    if (current.pid !== owner.pid || current.nonce !== owner.nonce) throw new Error("PROCESS_LOCK_CHANGED");
    fs.rmSync(lock, { recursive: true });
  };
}
