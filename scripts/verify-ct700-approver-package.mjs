import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { verifyPackage, sha256 } from './ct700-package-integrity.mjs';

if (process.argv.length !== 2) throw Error('No verification arguments accepted');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, '.tooling/ct700-approver-package');
const digest = sha256(fs.readFileSync(path.join(source, 'manifest.json')));
verifyPackage(source, digest);
const base = path.join(os.tmpdir(), 'opencode'); fs.mkdirSync(base, { recursive: true });
const temporary = fs.mkdtempSync(path.join(base, 'ct700-clean-room-'));
try {
  fs.cpSync(source, path.join(temporary, 'package'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/ct700-clean-room-fixture.mjs'), path.join(temporary, 'fixture.mjs'));
  fs.writeFileSync(path.join(temporary, 'webauthn-simulator.mjs'), ts.transpileModule(
    fs.readFileSync(path.join(root, 'tests/fixtures/webauthn-simulator.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  // No checkout module paths or inherited loader/proxy settings in the child.
  execFileSync(process.execPath, ['--no-global-search-paths', path.join(temporary, 'fixture.mjs'), digest], {
    cwd: temporary, stdio: 'inherit', timeout: 120_000,
    env: { SystemRoot: process.env.SystemRoot ?? '', TEMP: temporary, TMP: temporary, HOME: temporary },
  });
  console.log(`Verified manifest SHA256: ${digest}`);
} finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
