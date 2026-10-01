import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inventory, sha256, verifyPackage } from '../scripts/ct700-package-integrity.mjs';

describe('CT700 offline package integrity', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct700-inventory-')); dirs.push(dir);
    const required = ['runtime/approver-service/production-cli.js', 'runtime/approver-service/production.js',
      'runtime/typed-action-approval/contract.js', 'runtime/typed-action-approval/verifier.js',
      'runtime/approver-service/public/production.js', 'pnpm-lock.yaml', 'provenance.json'];
    for (const file of required) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), 'fixture'); }
    const manifest = { format: 1, role: 'ct700-typed-approver', node: process.version,
      runtimeSha256: sha256(fs.readFileSync(process.execPath)), files: inventory(dir) };
    const raw = JSON.stringify(manifest); fs.writeFileSync(path.join(dir, 'manifest.json'), raw);
    return { dir, digest: sha256(raw), manifest, required };
  }
  it('requires independently pinned manifest and exact runtime', () => {
    const x = fixture(); expect(verifyPackage(x.dir, x.digest)).toEqual(x.manifest);
    expect(() => verifyPackage(x.dir, '0'.repeat(64))).toThrow('MANIFEST_HASH');
    expect(() => verifyPackage(x.dir, '')).toThrow('EXPECTED_MANIFEST');
    const raw = JSON.stringify({ ...x.manifest, node: 'v0.0.0' }); fs.writeFileSync(path.join(x.dir, 'manifest.json'), raw);
    expect(() => verifyPackage(x.dir, sha256(raw))).toThrow('RUNTIME_MISMATCH');
  });
  it.each(['missing', 'tamper', 'extra', 'manifest'] as const)('rejects %s', mode => {
    const x = fixture(), file = path.join(x.dir, x.required[0]);
    if (mode === 'missing') fs.unlinkSync(file);
    if (mode === 'tamper') fs.appendFileSync(file, 'tamper');
    if (mode === 'extra') fs.writeFileSync(path.join(x.dir, 'extra.js'), 'extra');
    if (mode === 'manifest') fs.appendFileSync(path.join(x.dir, 'manifest.json'), '\n');
    expect(() => verifyPackage(x.dir, x.digest)).toThrow();
  });
  it.each(['signing.key', 'state.db', 'state.sqlite', '.git/config', '.env', 'runtime/app.js.map'])('rejects forbidden artifact %s', file => {
    const x = fixture(); fs.mkdirSync(path.dirname(path.join(x.dir, file)), { recursive: true }); fs.writeFileSync(path.join(x.dir, file), 'fixture');
    expect(() => inventory(x.dir)).toThrow('FORBIDDEN_PACKAGE_FILE');
  });
  it('rejects hardlinked files and missing required closure even with recomputed inventory', () => {
    const x = fixture(); fs.linkSync(path.join(x.dir, x.required[0]), path.join(x.dir, 'link.js'));
    expect(() => inventory(x.dir)).toThrow('UNSAFE_PACKAGE_FILE'); fs.unlinkSync(path.join(x.dir, 'link.js'));
    fs.unlinkSync(path.join(x.dir, x.required[0]));
    const raw = JSON.stringify({ ...x.manifest, files: inventory(x.dir) }); fs.writeFileSync(path.join(x.dir, 'manifest.json'), raw);
    expect(() => verifyPackage(x.dir, sha256(raw))).toThrow('MISSING_RUNTIME_FILE');
  });
});
