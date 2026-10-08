import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchPlan, verifyFixedPaths, root } from './linux-control-plane-policy.mjs';

let child;
try {
  const plan = launchPlan('gateway', { platform: process.platform, uid: process.getuid?.(), execPath: process.execPath,
    launcher: fileURLToPath(import.meta.url), argv: process.argv, version: process.version });
  verifyFixedPaths(plan);
  process.chdir(root);
  child = spawn(plan.command, plan.args, { cwd: root, env: plan.env, stdio: 'ignore', shell: false });
  child.once('error', () => { console.error('LINUX_GATEWAY_START_FAILED'); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code === 0 ? 0 : 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { child.kill(signal); });
} catch {
  console.error('LINUX_GATEWAY_START_REJECTED'); process.exitCode = 2;
}
