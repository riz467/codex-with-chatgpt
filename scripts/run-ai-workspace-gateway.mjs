// Fixed, non-interactive Task Scheduler supervisor. Child stdout/stderr is deliberately
// discarded: upstream output is not guaranteed to be free of credentials or pairing codes.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync, appendFileSync, rmSync } from 'node:fs';
import net from 'node:net';

const node = 'C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node.exe';
const executionCli = 'C:\\work\\codex-with-chatgpt\\.tooling\\ai-workspace-execution-runtime\\dist\\cli\\index.js';
const reviewCli = 'C:\\work\\codex-with-chatgpt\\dist\\cli\\index.js';
const executionStateDir = 'C:\\Users\\workspace\\AppData\\Local\\codex-with-chatgpt';
const boundedReviewerClientId = 'c2c_client_Um175Y3xYaj2RoCN';
const cloudflared = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const config = 'C:\\Users\\workspace\\.cloudflared\\config.yml';
const logDir = 'C:\\work\\ai-workspace-logs';
const {
  C2C_STATE_DIR: _ignoredStateDir,
  C2C_BOUNDED_REVIEW_CLIENT_ID: _ignoredReviewerClientId,
  ...inheritedEnv
} = process.env;
const baseEnv = {
  ...inheritedEnv,
  USERPROFILE: 'C:\\Users\\workspace',
  HOME: 'C:\\Users\\workspace',
  LOCALAPPDATA: 'C:\\Users\\workspace\\AppData\\Local',
  APPDATA: 'C:\\Users\\workspace\\AppData\\Roaming',
};
const executionEnv = {
  ...baseEnv,
  C2C_STATE_DIR: executionStateDir,
  C2C_BOUNDED_REVIEW_CLIENT_ID: boundedReviewerClientId,
};
const definitions = [
  { name: 'execution-bridge', command: node, args: [executionCli, 'serve', '--workspace', 'C:\\work\\codex-with-chatgpt', '--port', '48765'], port: 48765, env: executionEnv },
  { name: 'review-bridge', command: node, args: [reviewCli, 'serve', '--workspace', 'C:\\work\\ai-orchestration-review', '--port', '54108'], port: 54108, env: baseEnv },
  { name: 'cloudflared', command: cloudflared, args: ['--config', config, 'tunnel', 'run', 'ai-workspace-mcp'], env: baseEnv },
];
mkdirSync(logDir, { recursive: true });
const children = new Map();
const nextTry = new Map();
const messages = new Map();

function log(name, message) {
  const file = `${logDir}\\${name}.log`;
  // Rotate before each bounded, locally generated message; never copy child output.
  if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) {
    rmSync(`${file}.3`, { force: true });
    for (let i = 2; i >= 1; i--) {
      const old = `${file}.${i}`;
      if (existsSync(old)) renameSync(old, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  }
  appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
}

function occupied(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
}

function tunnelAlreadyRunning() {
  // Only check the exact configured tunnel; avoid a second connector for the same name.
  const ps = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$p=Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\"; @($p | Where-Object { $_.ExecutablePath -eq 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe' -and $_.CommandLine -match 'tunnel run ai-workspace-mcp' }).Count",
  ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  // Query failures must not turn into a duplicate tunnel.
  return ps.status !== 0 || Number(ps.stdout.trim()) > 0 || !/^\d+$/.test(ps.stdout.trim());
}

function once(name, message) {
  if (messages.get(name) !== message) {
    log(name, message);
    messages.set(name, message);
  }
}

async function reconcile() {
  for (const def of definitions) {
    if (children.has(def.name) || Date.now() < (nextTry.get(def.name) ?? 0)) continue;
    const busy = def.port ? await occupied(def.port) : tunnelAlreadyRunning();
    if (busy) {
      once(def.name, 'existing listener or tunnel detected; not starting a duplicate');
      continue;
    }
    messages.delete(def.name);
    const child = spawn(def.command, def.args, {
      cwd: 'C:\\work\\codex-with-chatgpt', env: def.env, stdio: 'ignore', windowsHide: true,
    });
    children.set(def.name, child);
    log(def.name, `started pid=${child.pid ?? 'unknown'}`);
    child.once('error', () => {
      log(def.name, 'spawn failed; retry scheduled (output suppressed)');
    });
    child.once('exit', (code, signal) => {
      children.delete(def.name);
      nextTry.set(def.name, Date.now() + 10_000);
      log(def.name, `exited code=${code ?? 'none'} signal=${signal ?? 'none'}; retry scheduled`);
    });
  }
}

for (const def of definitions) log(def.name, 'supervisor started');
await reconcile();
setInterval(() => { void reconcile().catch(() => {
  // Fail closed: retry later; no exception text from child or environment in logs.
  for (const def of definitions) once(def.name, 'supervisor check failed; will retry');
}); }, 10_000);
