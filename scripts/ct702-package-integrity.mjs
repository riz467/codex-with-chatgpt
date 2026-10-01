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
      if (!/^[a-zA-Z0-9@_./+~-]+$/.test(relative) || /(^|\/)(\.git|\.env)([./]|$)|\.(db|sqlite|pem|key|map|ts|mts|cts)$|(?:-wal|-shm)$|(^|\/)(credentials?|tokens?|secrets?)([./]|$)/i.test(relative)) throw Error(`FORBIDDEN_PACKAGE_FILE ${relative}`);
      if (stat.isDirectory()) walk(file, relative + '/');
      else if (relative !== 'manifest.json') {
        const bytes = fs.readFileSync(file);
        if (/-----BEGIN (?:.*PRIVATE KEY|CERTIFICATE)-----/.test(bytes.toString('utf8'))) throw Error('FORBIDDEN_KEY_MATERIAL');
        files[relative] = sha256(bytes);
      }
    }
  }
  walk(root); return files;
}
export function verifyPackage(root, expectedManifestHash) {
  if (!/^[0-9a-f]{64}$/.test(expectedManifestHash)) throw Error('EXPECTED_MANIFEST_HASH_REQUIRED');
  const manifestPath = path.join(root, 'manifest.json'), stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('UNSAFE_MANIFEST');
  const raw = fs.readFileSync(manifestPath);
  if (sha256(raw) !== expectedManifestHash) throw Error('MANIFEST_HASH_MISMATCH');
  const manifest = JSON.parse(raw);
  if (Object.keys(manifest).sort().join(',') !== 'files,format,node,role,runtimeSha256' || manifest.format !== 1 ||
      manifest.role !== 'ct702-independent-review' || manifest.node !== process.version || manifest.runtimeSha256 !== sha256(fs.readFileSync(process.execPath))) throw Error('RUNTIME_MISMATCH');
  if (JSON.stringify(inventory(root)) !== JSON.stringify(manifest.files)) throw Error('PACKAGE_INVENTORY_MISMATCH');
  for (const required of ['runtime/review-service/production-cli.js', 'runtime/review-service/runtime.js', 'runtime/review-service/store.js',
    'runtime/review-service/provider.js', 'runtime/review-service/server.js', 'runtime/review-service/hardening.js',
    'runtime/typed-action-review/contract.js', 'runtime/typed-action-review/signer.js', 'runtime/typed-action-review/verifier.js',
    'node_modules/zod/package.json', 'config.example.json', 'ct702-review.service', 'README.md', 'pnpm-lock.yaml', 'provenance.json', 'package.json']) {
    if (!manifest.files[required]) throw Error('MISSING_RUNTIME_FILE');
  }
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw Error('Usage: node ct702-package-integrity.mjs <package> <approved-manifest-sha256>');
  verifyPackage(path.resolve(process.argv[2]), process.argv[3]); console.log('CT702 package integrity PASS');
}
