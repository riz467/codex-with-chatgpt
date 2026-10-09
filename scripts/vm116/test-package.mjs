import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
const runtime = path.resolve(process.argv[2]);
const probe = path.resolve('scripts/vm116/probe-staging.mjs');
const temporary = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir();
const home = mkdtempSync(path.join(temporary, 'vm116-health-package-'));
const entry = pathToFileURL(path.join(runtime, 'dist/bridge/control-plane-staging.js')).href;
const code = `import {createControlPlaneStaging} from ${JSON.stringify(entry)};
const ports=[]; for(const role of ['gateway','dashboard']) {
 const s=createControlPlaneStaging(role).listen(0,'127.0.0.1');
 await new Promise((ok,no)=>{s.once('listening',ok);s.once('error',no)}); ports.push(s.address().port);
} console.log(JSON.stringify(ports));`;
const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
  cwd: runtime, env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, LANG: 'C.UTF-8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('START_TIMEOUT')), 10000);
    let output = '';
    child.stdout.on('data', data => { output += data; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0])); } });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CHILD_EXIT:${code}`)); });
  });
  console.log(execFileSync(process.execPath, [probe, ...ports.map(String)], { encoding: 'utf8', timeout: 30000, env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: home } }).trim());
} finally {
  const exit = new Promise(resolve => child.once('exit', resolve));
  if (child.exitCode === null) { child.kill(); await exit; }
  rmSync(home, { recursive: true, force: true });
}
