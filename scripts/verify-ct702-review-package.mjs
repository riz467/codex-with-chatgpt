import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyPackage } from './ct702-package-integrity.mjs';

if (process.argv.length !== 4) throw Error('Usage: pnpm ct702:verify-package <package> <approved-manifest-sha256>');
const source = path.resolve(process.argv[2]), expected = process.argv[3];
verifyPackage(source, expected);
const tempBase = process.platform === 'win32' ? 'C:/Users/workspace/AppData/Local/Temp/1/opencode' : os.tmpdir();
const room = fs.mkdtempSync(path.join(tempBase, 'ct702-clean-room-'));
try {
  fs.cpSync(source, path.join(room, 'package'), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('./ct702-clean-room-fixture.mjs', import.meta.url)), path.join(room, 'fixture.mjs'));
  const node = path.join(room, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(process.execPath, node);
  if (process.platform !== 'win32') fs.chmodSync(node, 0o700);
  const output = execFileSync(node, ['--jitless', '--permission', `--allow-fs-read=${room}`, `--allow-fs-write=${room}`, 'fixture.mjs', expected], {
    cwd: room, encoding: 'utf8', timeout: 30000, env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
  });
  console.log(output.trim());
} finally { fs.rmSync(room, { recursive: true, force: true }); }
