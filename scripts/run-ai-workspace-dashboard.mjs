// Fixed Task Scheduler entrypoint. Never accepts host, port, path or command arguments.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = 'C:\\work\\codex-with-chatgpt';
const node = 'C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node.exe';
const launcher = path.join(root, 'scripts', 'run-ai-workspace-dashboard.mjs');
const server = path.join(root, 'dist', 'dashboard', 'server.js');

if (process.argv.length !== 2 || process.platform !== 'win32' ||
    path.resolve(process.execPath).toLowerCase() !== node.toLowerCase() ||
    fileURLToPath(import.meta.url).toLowerCase() !== launcher.toLowerCase()) {
  console.error('Dashboard launcher identity or arguments rejected');
  process.exit(2);
}
process.chdir(root);
const { createDashboard } = await import(pathToFileURL(server).href);
createDashboard().listen(48766, '127.0.0.1');
