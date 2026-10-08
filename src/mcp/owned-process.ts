import { spawnSync, type ChildProcess } from "node:child_process";

/** Only for children spawned with detached: true on POSIX (a private process group). */
export function terminateOwnedProcess(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore", timeout: 2000 });
    if (!result.error && result.status === 0) return;
    try { child.kill("SIGKILL"); } catch { /* tree status is still unknown */ }
    throw new Error("PROCESS_TREE_TERMINATION_REQUIRES_INSPECTION");
  }
  // Kill the group even if its leader exited while descendants still hold pipes.
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("PROCESS_GROUP_EXIT_REQUIRES_INSPECTION");
  }
}

export async function terminateOwnedProcessAndWait(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 2000;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    terminateOwnedProcess(child);
  } else await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.removeListener("exit", exited); };
    const exited = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("PROCESS_EXIT_REQUIRES_INSPECTION")); }, 2000);
    child.once("exit", exited);
    try { terminateOwnedProcess(child); }
    catch (error) { cleanup(); reject(error); }
  });
  if (process.platform === "win32" || !child.pid) return;
  for (;;) {
    try { process.kill(-child.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw new Error("PROCESS_GROUP_EXIT_REQUIRES_INSPECTION");
    }
    if (Date.now() >= deadline) throw new Error("PROCESS_GROUP_EXIT_REQUIRES_INSPECTION");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
