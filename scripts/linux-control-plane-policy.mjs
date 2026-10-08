// Fixed trusted-service entrypoints; no candidate execution, auth bootstrap or tunnel.
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

export const root = '/srv/ai-orchestration/codex-with-chatgpt';
export const home = '/var/lib/ai-control-staging';
export const node = '/usr/bin/node';
export const roles = Object.freeze({
  gateway: Object.freeze({ launcher: `${root}/scripts/run-linux-gateway.mjs`, entry: `${root}/dist/bridge/control-plane-staging.js`, port: 48767 }),
  dashboard: Object.freeze({ launcher: `${root}/scripts/run-linux-dashboard.mjs`, entry: `${root}/dist/bridge/control-plane-staging.js`, port: 48768 }),
});

export function launchPlan(role, identity) {
  const config = Object.hasOwn(roles, role) ? roles[role] : null;
  if (!config || identity.platform !== 'linux' || identity.uid === 0 || !Number.isInteger(identity.uid) || identity.uid < 1 ||
      identity.execPath !== node || identity.launcher !== config.launcher || identity.argv.length !== 2 ||
      identity.argv[1] !== config.launcher || identity.version !== 'v24.16.0') {
    throw new Error('LINUX_SERVICE_IDENTITY_REJECTED');
  }
  return Object.freeze({ ...config, command: node,
    args: Object.freeze([]),
    env: Object.freeze({ PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', C2C_STATE_DIR: `${home}/state` }),
    dispatch: 'CLOSED', authority: 'NONE' });
}

// Paths are provisioned by Human-admin, not created or repaired by the launcher.
export function verifyFixedPaths(plan) {
  for (const file of [root, home, plan.launcher, plan.entry]) {
    if (!path.posix.isAbsolute(file) || realpathSync.native(file) !== file) throw new Error('LINUX_SERVICE_PATH_REJECTED');
    let current = '/';
    for (const segment of file.split('/').filter(Boolean)) {
      current = path.posix.join(current, segment);
      if (lstatSync(current).isSymbolicLink()) throw new Error('LINUX_SERVICE_PATH_REJECTED');
    }
  }
}
