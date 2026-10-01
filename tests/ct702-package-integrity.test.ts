import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Repository packaging scripts are native ESM.
import { inventory, sha256, verifyPackage } from '../scripts/ct702-package-integrity.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct702-package-')); dirs.push(dir);
  const required = ['runtime/review-service/production-cli.js', 'runtime/review-service/runtime.js', 'runtime/review-service/store.js',
    'runtime/review-service/provider.js', 'runtime/review-service/server.js', 'runtime/review-service/hardening.js',
    'runtime/typed-action-review/contract.js', 'runtime/typed-action-review/signer.js', 'runtime/typed-action-review/verifier.js',
    'node_modules/zod/package.json', 'config.example.json', 'ct702-review.service', 'README.md', 'pnpm-lock.yaml', 'provenance.json', 'package.json'];
  for (const name of required) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}'); }
  const raw = JSON.stringify({ format: 1, role: 'ct702-independent-review', node: process.version, runtimeSha256: sha256(fs.readFileSync(process.execPath)), files: inventory(dir) });
  fs.writeFileSync(path.join(dir, 'manifest.json'), raw);
  return { dir, digest: sha256(raw), target: path.join(dir, required[0]) };
}
it('requires externally pinned manifest and exact complete package inventory', () => {
  const f = fixture(); expect(() => verifyPackage(f.dir, f.digest)).not.toThrow();
  expect(() => verifyPackage(f.dir, '')).toThrow('EXPECTED_MANIFEST_HASH_REQUIRED');
  fs.appendFileSync(f.target, '\n'); expect(() => verifyPackage(f.dir, f.digest)).toThrow('INVENTORY');
  fs.unlinkSync(f.target); expect(() => verifyPackage(f.dir, f.digest)).toThrow('INVENTORY');
  fs.appendFileSync(path.join(f.dir, 'manifest.json'), '\n'); expect(() => verifyPackage(f.dir, f.digest)).toThrow('MANIFEST_HASH');
});
it.each(['secret.key', 'private.pem', 'state.sqlite', 'state.db-wal', '.env', '.env.local', 'credentials.json', 'tokens.json', 'runtime/source.ts', 'runtime/code.js.map'])('excludes forbidden payload %s', name => {
  const f = fixture(), file = path.join(f.dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x');
  expect(() => inventory(f.dir)).toThrow('FORBIDDEN_PACKAGE_FILE');
});
it('rejects extra payload, disguised private key material and hard links', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.dir, 'extra.js'), 'extra'); expect(() => verifyPackage(f.dir, f.digest)).toThrow('INVENTORY');
  fs.writeFileSync(path.join(f.dir, 'extra.js'), '-----BEGIN PRIVATE KEY-----'); expect(() => inventory(f.dir)).toThrow('FORBIDDEN_KEY_MATERIAL');
  fs.unlinkSync(path.join(f.dir, 'extra.js')); fs.linkSync(f.target, path.join(f.dir, 'linked.js')); expect(() => inventory(f.dir)).toThrow('UNSAFE_PACKAGE_FILE');
});
