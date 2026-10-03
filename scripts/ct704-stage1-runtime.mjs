import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('ROOT_PROVISIONING_ONLY');
// Copy actual loader/dependency closure. Preserve loader lookup names but materialize
// symlinks as separate regular files: existing capsule contracts require this.
function binary(image, source, destination) {
  const copy = (src, dest) => {
    const target = path.join(image, dest); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
  };
  copy(source, destination);
  const libraries = execFileSync('/usr/bin/ldd', [source], { encoding: 'utf8', env: { LANG: 'C' } });
  if (libraries.includes('not found')) throw new Error('RUNTIME_LIBRARY_MISSING');
  for (const line of libraries.split('\n')) {
    const name = line.match(/(?:=>\s*)?(\/[^\s]+)\s+\(/)?.[1];
    if (name) copy(name, name);
  }
}
function seal(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) seal(name);
    else if (entry.isFile()) fs.chmodSync(name, fs.statSync(name).mode & 0o111 ? 0o755 : 0o644);
    else throw new Error('NON_REGULAR_CAPSULE_ENTRY');
  }
  fs.chmodSync(dir, 0o755);
}
for (const [image, fast] of [['/opt/rc02-sandbox-runtime', false], ['/opt/rc02-fast-runtime', true]]) {
  fs.mkdirSync(image); // Deliberately no overwrite/recovery of existing capsules.
  for (const dir of ['candidate', 'proc', 'dev', ...(fast ? ['tmp', 'scratch'] : [])]) fs.mkdirSync(path.join(image, dir));
  binary(image, process.execPath, '/usr/bin/node');
  if (fast) {
    binary(image, '/usr/bin/git', '/usr/bin/git');
    fs.mkdirSync(path.join(image, 'runtime/scripts'), { recursive: true });
    for (const name of ['verify-ai-workspace.mjs', 'verification-policy.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', name), path.join(image, 'runtime/scripts', name));
    fs.cpSync(path.join(root, 'node_modules'), path.join(image, 'runtime/node_modules'), { recursive: true, dereference: true });
  }
  seal(image);
}
console.log('RUNTIME_PREPARED=PASS; EXECUTION_PROOF_PENDING');
