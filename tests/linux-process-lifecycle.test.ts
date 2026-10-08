import { expect, it } from "vitest";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deployment } from "../src/config/deployment.js";
import { terminateOwnedProcessAndWait } from "../src/mcp/owned-process.js";

function ready(child: ReturnType<typeof spawn>): Promise<{ parent: number; leaf: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("FIXTURE_START_TIMEOUT")), 5000);
    let text = "";
    child.stdout!.on("data", bytes => {
      text += bytes.toString();
      if (!text.includes("\n")) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(text.trim())); } catch (error) { reject(error); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("FIXTURE_EARLY_EXIT")); });
  });
}
function stat(pid: number) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
it.skipIf(process.platform !== "linux").each([false, true])("ends the real PowerShell tree after timeout (leader already gone=%s)", async leaderGone => {
  const child = spawn(deployment.pwsh, ["-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./fixtures/linux-process-tree.ps1", import.meta.url)), "-NodeExecutable", process.execPath],
  { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const peer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  try {
    const pids = await ready(child);
    for (const pid of [pids.parent, pids.leaf]) expect(stat(pid)).toMatchObject({ group: child.pid, session: child.pid });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    if (leaderGone) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await exited;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    await terminateOwnedProcessAndWait(child);
    await Promise.race([closed, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("DESCENDANT_PIPE_NOT_CLOSED")), 2000); timer.unref();
    })]);
    for (const pid of [pids.parent, pids.leaf]) {
      // A terminated orphan can briefly remain a zombie until the fixture init reaps it.
      expect([undefined, "Z", "X"]).toContain(stat(pid)?.state);
    }
    expect(process.kill(peer.pid!, 0)).toBe(true);
  } finally {
    await Promise.all([child, peer].map(process => terminateOwnedProcessAndWait(process as ChildProcess)));
  }
}, 15000);
