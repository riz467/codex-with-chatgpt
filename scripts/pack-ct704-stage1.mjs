// Data/code only: no .git, ambient configuration, credentials or authority services.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
if (!output || fs.existsSync(output)) throw new Error('Usage: node scripts/pack-ct704-stage1.mjs <new-directory>');
const files = new Set();
function include(name) {
  if (files.has(name)) return;
  if (name.startsWith('../') || path.isAbsolute(name)) throw new Error('PACKAGE_ESCAPE');
  const source = fs.readFileSync(path.join(root, name), 'utf8'); files.add(name);
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
    let next = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier.text));
    if (next.endsWith('.js')) next = next.slice(0, -3) + '.ts';
    include(next);
  }
}
for (const name of ['tests/rc02-development-sandbox.test.ts', 'tests/rc02-development-fast-sandbox.test.ts',
  'tests/rc02-development-opencode-compatibility-sandbox.test.ts',
  'src/execution-orchestrator/development/opencode-compatibility.ts']) include(name);
// D.1 reads these sources as data; they are not necessarily static imports.
for (const name of ['opencode-core-adapter', 'opencode-oauth', 'opencode-transport', 'proposal-input', 'proposal'])
  include(`src/execution-orchestrator/development/${name}.ts`);
for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vitest.config.ts',
  'scripts/verify-ai-workspace.mjs', 'scripts/verification-policy.mjs', 'scripts/verify-opencode-compatibility.mjs',
  'scripts/ct704-stage1-guest.sh', 'scripts/ct704-stage1-runtime.mjs', 'scripts/ct704-stage1-live.mjs']) {
  files.add(name);
}
fs.mkdirSync(output, { recursive: true });
for (const name of [...files].sort()) {
  const dest = path.join(output, name); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(path.join(root, name), 'utf8').replaceAll('\r\n', '\n'));
}
fs.writeFileSync(path.join(output, 'stage1-files.json'), JSON.stringify([...files].sort(), null, 2) + '\n');
console.log(JSON.stringify({ result: 'PASS', files: files.size, output }));
