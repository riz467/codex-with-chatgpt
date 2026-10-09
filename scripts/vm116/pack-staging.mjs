// Build a health-only, pure-JavaScript runtime. Never ship Windows junctions/native modules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const base = '456eadfc2c12703ad998e009b12d9cb7010ec245';
execFileSync('git', ['merge-base', '--is-ancestor', base, sha], { cwd: root });
const out = path.resolve(process.argv[2] || path.join(root, '..', 'runtime'));
if (fs.existsSync(out)) throw new Error('OUTPUT_EXISTS');
fs.mkdirSync(out, { recursive: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inventory = [];
function put(relative, bytes) {
  const target = path.join(out, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  inventory.push({ path: relative.replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes), mode: '0644' });
}
for (const name of ['run-linux-gateway.mjs', 'run-linux-dashboard.mjs', 'linux-control-plane-policy.mjs'])
  put(`scripts/${name}`, fs.readFileSync(path.join(root, 'scripts', name)));
for (const role of ['gateway', 'dashboard'])
  put(`scripts/systemd/ai-linux-${role}-staging.service`, Buffer.from(fs.readFileSync(path.join(root, 'scripts/systemd', `ai-linux-${role}-staging.service`), 'utf8').replaceAll('\r\n', '\n')));
put('dist/bridge/control-plane-staging.js', fs.readFileSync(path.join(root, 'dist/bridge/control-plane-staging.js')));
put('package.json', Buffer.from(JSON.stringify({ private: true, type: 'module', description: 'VM116 health-only staging; no production runtime' }) + '\n'));
const packages = new Map();
const selected = new Map();
function collect(dir) {
  dir = fs.realpathSync(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
  const id = `${pkg.name}@${pkg.version}`;
  if (packages.has(id)) return id;
  if (pkg.os || pkg.cpu || pkg.gypfile || ['preinstall', 'install', 'postinstall'].some(k => pkg.scripts?.[k]))
    throw new Error(`NON_PORTABLE_PACKAGE:${pkg.name}`);
  const info = { name: pkg.name, version: pkg.version, dir, deps: {} };
  packages.set(id, info);
  if (!selected.has(pkg.name)) selected.set(pkg.name, id);
  for (const dep of Object.keys(pkg.dependencies || {})) {
    let parent = dir, found;
    while (true) {
      const candidate = path.join(parent, 'node_modules', dep);
      if (fs.existsSync(path.join(candidate, 'package.json'))) { found = candidate; break; }
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    }
    if (!found) throw new Error(`DEPENDENCY_MISSING:${dep}`);
    info.deps[dep] = collect(found);
  }
  return id;
}
collect(path.join(root, 'node_modules/express'));
function copy(dir, relative) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const source = path.join(dir, entry.name), dest = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('PACKAGE_SYMLINK');
    if (entry.isDirectory()) copy(source, dest);
    else if (entry.isFile()) {
      if (/\.(node|exe|dll|so|dylib)$/i.test(entry.name)) throw new Error('NATIVE_FILE');
      put(dest, fs.readFileSync(source));
    } else throw new Error('SPECIAL_FILE');
  }
}
function emit(id, target, ancestors = []) {
  if (ancestors.includes(id)) throw new Error('NESTED_CYCLE');
  const pkg = packages.get(id);
  copy(pkg.dir, target);
  for (const [name, dep] of Object.entries(pkg.deps)) {
    if (selected.get(name) !== dep) emit(dep, `${target}/node_modules/${name}`, [...ancestors, id]);
  }
}
for (const [name, id] of selected) emit(id, `node_modules/${name}`);
inventory.sort((a,b) => a.path.localeCompare(b.path, 'en'));
const manifest = { schema: 1, baselineCommit: base, sourceCommit: sha, node: '24.16.0', scope: 'health-only-staging',
  dispatch: 'CLOSED', authority: 'NONE', dependencies: Object.fromEntries([...packages].map(([id,p]) => [id, p.deps])),
  lockfileSha256: hash(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'))), files: inventory,
  portability: 'plain files; pure JS dependency closure; Linux execution NOT yet verified' };
fs.writeFileSync(path.join(out, 'RUNTIME-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ out, files: inventory.length, packages: packages.size, manifestSha256: hash(fs.readFileSync(path.join(out, 'RUNTIME-MANIFEST.json'))) }));
