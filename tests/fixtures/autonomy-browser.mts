import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Uses the already-installed Edge and built-in WebSocket; no browser framework,
// existing user profile, shared debugging service or new dependency.
export async function openFixtureBrowser(base: string, root: string) {
  const profile = path.join(root, "browser-profile"); fs.mkdirSync(profile);
  const child = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  let socket: WebSocket | undefined;
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; });
  try {
  const portFile = path.join(profile, "DevToolsActivePort");
  let port = 0;
  for (let n = 0; n < 100; n++) {
    if (spawnError) throw spawnError;
    try {
      const candidate = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
      if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) { port = candidate; break; }
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!port) throw new Error("FIXTURE_BROWSER_START_FAILED");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json() as { type: string; webSocketDebuggerUrl: string }[];
  const page = pages.find(p => p.type === "page");
  if (!page) { child.kill(); throw new Error("FIXTURE_BROWSER_PAGE_MISSING"); }
  const ws = socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("FIXTURE_BROWSER_CONNECTION_TIMEOUT")), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("FIXTURE_BROWSER_CONNECTION_FAILED")); };
  });
  let sequence = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (error: Error) => void }>();
  ws.onmessage = message => { const response = JSON.parse(String(message.data));
    const task = pending.get(response.id); if (!task) return; pending.delete(response.id);
    if (response.error) task.reject(new Error("FIXTURE_BROWSER_PROTOCOL_ERROR")); else task.resolve(response.result);
  };
  const send = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error("FIXTURE_BROWSER_TIMEOUT")); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("FIXTURE_BROWSER_SCRIPT_FAILED");
    return r.result.value;
  };
  const wait = async (expression: string) => {
    for (let n = 0; n < 60; n++) { const value = await evaluate(expression); if (value) return value; await new Promise(r => setTimeout(r, 250)); }
    throw new Error("FIXTURE_BROWSER_UI_NOT_READY");
  };
  await send("Page.navigate", { url: base });
  await wait("Boolean(document.querySelector('#bounded-opencode form'))");
  return {
    async submit(contract: { repo: string; goal: string; edit_paths: string[]; acceptance_criteria: string[] }) {
      await evaluate(`(() => { const c=${JSON.stringify(contract)}; const f=document.querySelector('#bounded-opencode form');
        f.querySelector('select').value=c.repo; const t=f.querySelectorAll('textarea');
        t[0].value=c.goal;t[1].value=c.edit_paths.join('\\n');t[2].value=c.acceptance_criteria.join('\\n');
        f.querySelector('button').click(); return true; })()`);
      return await wait("document.querySelector('#bounded-opencode [role=status]')?.textContent.match(/bounded-[a-f0-9]{32}/)?.[0]") as string;
    },
    async capture(commit: string) {
      await wait(`document.body.innerText.includes(${JSON.stringify(commit)}) && document.body.innerText.includes('COMMITTED')`);
      fs.writeFileSync(path.join(root, "dashboard-rendered.txt"), await evaluate("document.body.innerText"));
      const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      fs.writeFileSync(path.join(root, "dashboard.png"), Buffer.from(screenshot.data, "base64"));
    },
    async close() { await send("Browser.close").catch(() => {}); ws.close(); if (child.exitCode === null) child.kill(); },
  };
  } catch (error) {
    socket?.close();
    if (child.exitCode === null) child.kill();
    throw error;
  }
}
