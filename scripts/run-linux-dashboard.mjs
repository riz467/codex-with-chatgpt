import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchPlan, verifyFixedPaths, root } from './linux-control-plane-policy.mjs';

try {
  const plan = launchPlan('dashboard', { platform: process.platform, uid: process.getuid?.(), execPath: process.execPath,
    launcher: fileURLToPath(import.meta.url), argv: process.argv, version: process.version });
  verifyFixedPaths(plan);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, plan.env);
  process.chdir(root);
  const { createControlPlaneStaging } = await import(pathToFileURL(plan.entry).href);
  const server = createControlPlaneStaging('dashboard').listen(plan.port, '127.0.0.1');
  server.once('error', () => { console.error('LINUX_DASHBOARD_START_FAILED'); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(); });
} catch {
  console.error('LINUX_DASHBOARD_START_REJECTED'); process.exitCode = 2;
}
