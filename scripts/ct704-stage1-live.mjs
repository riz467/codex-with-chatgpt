import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tsImport } from 'tsx/esm/api';
const root = path.resolve(import.meta.dirname, '..');
const results = Object.fromEntries(['CAPSULE', 'BWRAP', 'DL2_C', 'D1', 'E0_FAST'].map(k => [k, 'UNRESOLVED']));
function run(exe, args, timeout = 650000) {
  const r = spawnSync(exe, args, { cwd: root, env: process.env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    // Fixed fixture output only; no production credentials enter this process.
    process.stderr.write(r.stderr ?? '');
    process.stderr.write(r.stdout ?? '');
    throw new Error(`PROCESS_FAILED:${r.error?.code ?? r.status}`);
  }
  return r.stdout;
}
function live(file, title) {
  const report = JSON.parse(run(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', file,
    '-t', title, '--maxWorkers=1', '--reporter=json', '--configLoader=runner']));
  const assertions = report.testResults.flatMap(f => f.assertionResults);
  if (!report.success || assertions.filter(a => a.status === 'passed').length !== 1 ||
    !assertions.some(a => a.status === 'passed' && a.fullName.includes(title))) throw new Error('LIVE_ASSERTION_NOT_PASSED');
}
try {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.versions.node !== '26.10.0') throw new Error('LIVE_PLATFORM_REQUIRED');
  const sandbox = await tsImport('../src/execution-orchestrator/development/sandbox.ts', import.meta.url);
  if (!sandbox.sandboxCapability().available) throw new Error('SANDBOX_CAPABILITY_UNAVAILABLE');
  results.CAPSULE = 'PASS';
  // Retain bwrap's exact diagnostic before the contract deliberately redacts it.
  run('/usr/bin/bwrap', [...sandbox.sandboxNamespaceArguments, '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--clearenv', '--ro-bind', '/opt/rc02-sandbox-runtime', '/', '--proc', '/proc', '--dev', '/dev',
    '--', '/usr/bin/node', '--version'], 10000);
  results.BWRAP = 'PASS';
  live('tests/rc02-development-sandbox.test.ts', 'LIVE Linux:');
  results.DL2_C = 'PASS';
  live('tests/rc02-development-opencode-compatibility-sandbox.test.ts', 'fetch/http/https/net are permission-denied');
  const compatibility = JSON.parse(run(process.execPath, ['scripts/verify-opencode-compatibility.mjs', '--acquire', '--candidate', '2.0.22'], 300000));
  if (compatibility.certificate.result !== 'COMPATIBLE' || compatibility.liveProbe !== 'COMPLETED' ||
    compatibility.certificate.capabilities.providerCalls !== 0) throw new Error('D1_NOT_COMPATIBLE');
  fs.writeFileSync('/var/lib/rc02-stage1/d1-report.json', JSON.stringify(compatibility, null, 2));
  results.D1 = 'PASS';
  live('tests/rc02-development-fast-sandbox.test.ts', 'Linux live malicious-test fixture');
  results.E0_FAST = 'PASS';
} catch (error) {
  const pending = Object.keys(results).find(k => results[k] === 'UNRESOLVED');
  if (pending) results[pending] = 'FAIL';
  for (const key of Object.keys(results)) if (results[key] === 'UNRESOLVED') results[key] = 'SKIP';
  console.error(error.message); process.exitCode = 1;
} finally {
  console.log(JSON.stringify({ stage: 'RC02_STAGE1', results, productionExecution: 'DISABLED',
    authority: 'UNRESOLVED_UNTIL_HUMAN_BOUNDARY_REVIEW' }));
}
