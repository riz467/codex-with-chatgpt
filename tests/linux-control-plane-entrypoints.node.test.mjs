import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchPlan, roles, root, home } from '../scripts/linux-control-plane-policy.mjs';

const node = '/opt/node-v24.16.0/bin/node';
const identity = role => ({ platform: 'linux', uid: 1001, execPath: node, launcher: roles[role].launcher,
  argv: [node, roles[role].launcher], version: 'v24.16.0' });

test('fixed Gateway loads only health staging without auth, tunnel or execution worker', () => {
  const plan = launchPlan('gateway', identity('gateway'));
  assert.equal(plan.command, node);
  assert.equal(plan.entry, `${root}/dist/bridge/control-plane-staging.js`);
  assert.deepEqual(plan.args, []);
  assert.equal(plan.env.HOME, home); assert.equal(plan.dispatch, 'CLOSED'); assert.equal(plan.authority, 'NONE');
  assert.deepEqual(Object.keys(plan.env).sort(), ['C2C_STATE_DIR', 'HOME', 'LANG', 'PATH']);
});
test('fixed Dashboard loads only health staging on a separate port', () => {
  const plan = launchPlan('dashboard', identity('dashboard'));
  assert.equal(plan.command, node);
  assert.equal(plan.port, 48768); assert.deepEqual(plan.args, []);
  assert.equal(plan.entry, `${root}/dist/bridge/control-plane-staging.js`);
});
test('Linux launchers never import the production factories', () => {
  for (const role of ['gateway', 'dashboard']) {
    const text = readFileSync(new URL(`../scripts/run-linux-${role}.mjs`, import.meta.url), 'utf8');
    assert.ok(text.includes(`createControlPlaneStaging('${role}')`));
    assert.ok(!text.includes('createDashboard'));
    assert.ok(!text.includes('spawn('));
    assert.deepEqual(text.match(/^import .*$/gm), [
      "import { fileURLToPath, pathToFileURL } from 'node:url';",
      "import { launchPlan, verifyFixedPaths, root } from './linux-control-plane-policy.mjs';",
    ]);
    assert.deepEqual(text.match(/\bimport\s*\([^;]+/g), ['import(pathToFileURL(plan.entry).href)']);
  }
  const text = readFileSync(new URL('../src/bridge/control-plane-staging.ts', import.meta.url), 'utf8');
  assert.deepEqual(text.match(/^import .*$/gm), ['import express from "express";']);
  assert.ok(!/\bimport\s*\(/.test(text));
});
for (const [name, change] of [
  ['Windows', { platform: 'win32' }], ['root', { uid: 0 }], ['unknown uid', { uid: undefined }],
  ['wrong Node', { execPath: '/tmp/node' }], ['version drift', { version: 'v24.17.0' }],
  ['legacy Node path', { execPath: '/usr/bin/node' }],
  ['foreign launcher', { launcher: '/tmp/launcher.mjs' }],
  ['argument override', { argv: [node, roles.gateway.launcher, '--start'] }],
]) test(`rejects ${name} before runtime loading`, () => {
  for (const role of ['gateway', 'dashboard']) {
    assert.throws(() => launchPlan(role, { ...identity(role), ...change }), /IDENTITY_REJECTED/);
  }
});
test('rejects unknown role and inherited object role', () => {
  for (const role of ['executor', 'toString', '__proto__']) assert.throws(() => launchPlan(role, identity('gateway')));
});
test('units have no root, auth path, external egress or writable source', () => {
  for (const role of ['gateway', 'dashboard']) {
    const text = readFileSync(new URL(`../scripts/systemd/ai-linux-${role}-staging.service`, import.meta.url), 'utf8');
    assert.ok(text.split('\n').includes(`ExecStart=${node} ${roles[role].launcher}`));
    for (const line of ['User=ai-control-staging', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes',
      'CapabilityBoundingSet=', 'KillMode=control-group', 'IPAddressDeny=any', 'IPAddressAllow=localhost',
      'ReadWritePaths=/var/lib/ai-control-staging']) assert.ok(text.split('\n').includes(line));
    assert.ok(!text.includes('User=root')); assert.ok(!text.includes('ExecStartPre='));
  }
});
test('source gates recovery before workspace writes and review before ledger mutation', () => {
  // Source-order regression only; full TypeScript/Vitest integration is NOT exercised here.
  const text = readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf8');
  const route = marker => {
    const start = text.indexOf(marker); assert.ok(start >= 0, 'missing registration');
    const next = text.indexOf('server.registerTool(', start + marker.length);
    return text.slice(start, next >= 0 ? next : undefined);
  };
  const recover = route('server.registerTool("recover_failed_bounded_task"');
  const guard = recover.indexOf('assertProductionExecution();'), write = recover.indexOf('tasks.withRecoveryLock');
  assert.ok(guard >= 0 && write >= 0 && guard < write);
  const review = route('server.registerTool("submit_bounded_chatgpt_review"');
  const reviewGuard = review.indexOf('if (!ctx.boundedTasks) assertProductionExecution();'), reviewWrite = review.indexOf('tasks.submitReview(args)');
  assert.ok(reviewGuard >= 0 && reviewWrite >= 0 && reviewGuard < reviewWrite);
});
test('production Dashboard start/session have early disconnected responses', () => {
  const text = readFileSync(new URL('../src/dashboard/server.ts', import.meta.url), 'utf8');
  for (const route of ['app.get("/api/bounded/start-session"', 'app.post("/api/bounded/start"']) {
    const start = text.indexOf(route); assert.ok(start >= 0, 'missing route');
    const next = text.indexOf('  app.', start + route.length);
    const part = text.slice(start, next >= 0 ? next : undefined);
    const guard = part.indexOf('!deployment.localExecutionEnabled'), response = part.indexOf('EXECUTOR_NOT_CONNECTED'), browser = part.indexOf('boundedBrowser(');
    assert.ok(guard >= 0 && response >= 0 && browser >= 0 && guard < browser && response < browser);
  }
});
test('Gateway staging gate precedes auth and cannot silently switch port', () => {
  const text = readFileSync(new URL('../src/bridge/server.ts', import.meta.url), 'utf8');
  const guard = text.indexOf('if (opts.controlPlaneStaging) app.use('), auth = text.indexOf('createOAuthRouter({');
  assert.ok(guard >= 0 && auth >= 0 && guard < auth);
  assert.ok(text.includes('req.path === "/health"'));
  assert.ok(text.includes('opts.port ?? DEFAULT_PORT, !opts.controlPlaneStaging'));
  assert.ok(text.includes('allowPortFallback && preferredPort !== 0'));
  assert.ok(text.includes('opts.persistRuntime !== false'));
});
