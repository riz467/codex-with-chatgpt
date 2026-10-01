import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function inventory(root) {
  const files = {};
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = prefix + name, stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.isFile() && stat.nlink !== 1) throw Error('UNSAFE_PACKAGE_FILE');
      if (!/^[a-zA-Z0-9@_./+~-]+$/.test(relative) || /(^|\/)(\.git|\.env)(\/|$)|\.(db|sqlite|pem|key|map)$/.test(relative)) throw Error(`FORBIDDEN_PACKAGE_FILE ${relative}`);
      if (stat.isDirectory()) walk(file, relative + '/');
      else if (relative !== 'manifest.json') files[relative] = sha256(fs.readFileSync(file));
    }
  }
  walk(root); return files;
}
export function verifyPackage(root, expectedManifestHash) {
  if (!/^[0-9a-f]{64}$/.test(expectedManifestHash)) throw Error('EXPECTED_MANIFEST_HASH_REQUIRED');
  const raw = fs.readFileSync(path.join(root, 'manifest.json'));
  if (sha256(raw) !== expectedManifestHash) throw Error('MANIFEST_HASH_MISMATCH');
  const manifest = JSON.parse(raw);
  if (manifest.format !== 1 || manifest.role !== 'ct700-typed-approver' || manifest.node !== process.version ||
      manifest.runtimeSha256 !== sha256(fs.readFileSync(process.execPath))) throw Error('RUNTIME_MISMATCH');
  if (JSON.stringify(inventory(root)) !== JSON.stringify(manifest.files)) throw Error('PACKAGE_INVENTORY_MISMATCH');
  for (const required of ['runtime/approver-service/production-cli.js', 'runtime/approver-service/production.js',
    'runtime/typed-action-approval/contract.js', 'runtime/typed-action-approval/verifier.js',
    'runtime/approver-service/public/production.js', 'pnpm-lock.yaml', 'provenance.json']) {
    if (!manifest.files[required]) throw Error('MISSING_RUNTIME_FILE');
  }
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw Error('Usage: node ct700-package-integrity.mjs <package> <approved-manifest-sha256>');
  verifyPackage(path.resolve(process.argv[2]), process.argv[3]); console.log('Package integrity PASS');
}
