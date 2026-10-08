import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// PID reuse and access-denied are conservatively treated as alive. Legacy/partial
// locks without a parseable owner are never stolen.
export function acquireProcessLock(lock: string): (() => void) | null {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const gate = `${lock}.gate`;
  try { fs.mkdirSync(gate); } catch { return null; }
  const owner = { pid: process.pid, nonce: randomUUID() };
  try {
    if (fs.existsSync(lock)) {
      let prior: { pid: number };
      try { prior = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch { return null; }
      if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) return null;
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
