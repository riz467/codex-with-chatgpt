import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { acquireProcessLock } from "../src/mcp/bounded-process-lock.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
it("does not steal a live process lock; reclaims it only after that process exits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-process-lock-")); roots.push(root);
  const lock = path.join(root, "lifecycle.lock");
  const child = spawn(process.execPath, ["-e", `const fs=require('fs');fs.mkdirSync(process.argv[1]);fs.writeFileSync(process.argv[1]+'/owner.json',JSON.stringify({pid:process.pid,nonce:'fixture'}));process.stdout.write('ready');setInterval(()=>{},1000)`, lock],
    { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    expect(acquireProcessLock(lock)).toBeNull();
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited;
    const release = acquireProcessLock(lock); expect(release).not.toBeNull();
    expect(acquireProcessLock(lock)).toBeNull();
    release!(); expect(fs.existsSync(lock)).toBe(false);
    fs.mkdirSync(lock);
    expect(() => acquireProcessLock(lock)).toThrow("PROCESS_LOCK_OWNER_REQUIRES_INSPECTION");
    expect(fs.existsSync(lock)).toBe(true);
  } finally { if (child.exitCode === null) child.kill(); }
});
