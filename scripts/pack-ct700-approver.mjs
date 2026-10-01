import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { inventory, sha256, verifyPackage } from './ct700-package-integrity.mjs';

if (process.argv.length !== 2) throw Error('No pack arguments accepted');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tooling/ct700-approver-package');
if (fs.existsSync(output)) throw Error('Package output already exists; retain/review or explicitly remove before rebuilding');
fs.mkdirSync(output, { recursive: true });
const seen = new Set(), externals = new Set(), sources = {};
const allowed = new Set(['express', 'zod', '@simplewebauthn/server']);
function local(relative) {
  if (seen.has(relative)) return;
  if (!/^[a-zA-Z0-9_./-]+\.js$/.test(relative) || relative.startsWith('../')) throw Error('UNSAFE_IMPORT');
  seen.add(relative);
  const text = fs.readFileSync(path.join(root, 'dist', relative), 'utf8');
  const dest = path.join(output, 'runtime', relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text.replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
  sources[`src/${relative.replace(/\.js$/, '.ts')}`] = sha256(fs.readFileSync(path.join(root, 'src', relative.replace(/\.js$/, '.ts'))));
  function specifier(value) {
    if (!ts.isStringLiteral(value)) throw Error('NON_LITERAL_RUNTIME_IMPORT');
    const name = value.text;
    if (name.startsWith('.')) local(path.posix.normalize(path.posix.join(path.posix.dirname(relative), name)));
    else if (!name.startsWith('node:')) {
      if (!allowed.has(name)) throw Error(`UNREVIEWED_DEPENDENCY ${name}`);
      externals.add(name);
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) { if (node.moduleSpecifier) specifier(node.moduleSpecifier); }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      if (node.arguments.length !== 1) throw Error('UNSUPPORTED_IMPORT'); specifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
}
local('approver-service/production-cli.js');
const dependencies = {};
const hoisted = new Map();
function dependency(name, from, parent, scope = new Map(), ancestry = new Set()) {
  const req = createRequire(from);
  let directory = req.resolve.paths(name).map(base => path.join(base, name)).find(dir => fs.existsSync(path.join(dir, 'package.json')));
  if (!directory) throw Error(`MISSING_DEPENDENCY ${name}`);
  directory = fs.realpathSync(directory);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  if (pkg.name !== name || Object.keys(pkg.optionalDependencies ?? {}).length) throw Error('UNSUPPORTED_DEPENDENCY');
  if ((scope.get(name) ?? hoisted.get(name)) === directory) return;
  if (ancestry.has(directory)) throw Error('DEPENDENCY_CYCLE');
  const global = !hoisted.has(name);
  const destination = path.join(global ? output : parent, 'node_modules', name);
  if (global) hoisted.set(name, directory);
  const childScope = new Map(global ? [] : scope); childScope.set(name, directory);
  const next = new Set(ancestry).add(directory);
  dependencies[path.relative(output, destination).replaceAll('\\', '/')] = { name, version: pkg.version, packageJsonSha256: sha256(fs.readFileSync(path.join(directory, 'package.json'))) };
  fs.cpSync(directory, destination, { recursive: true, filter: source => {
    const relative = path.relative(directory, source);
    return !relative.split(path.sep).includes('node_modules') && !relative.endsWith('.map');
  } });
  for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) dependency(dep, path.join(directory, 'package.json'), destination, childScope, next);
}
for (const name of [...externals].sort()) dependency(name, path.join(root, 'package.json'), output);
const publicDir = path.join(output, 'runtime/approver-service/public'); fs.mkdirSync(publicDir, { recursive: true });
for (const name of ['index.html', 'production.js']) fs.copyFileSync(path.join(root, 'src/approver-service/public', name), path.join(publicDir, name));
for (const name of fs.readdirSync(path.join(root, 'deploy/ct700-typed-approver')).sort()) {
  fs.writeFileSync(path.join(output, name), fs.readFileSync(path.join(root, 'deploy/ct700-typed-approver', name), 'utf8').replace(/\r\n/g, '\n'));
}
fs.copyFileSync(path.join(root, 'scripts/ct700-package-integrity.mjs'), path.join(output, 'ct700-package-integrity.mjs'));
fs.copyFileSync(path.join(root, 'pnpm-lock.yaml'), path.join(output, 'pnpm-lock.yaml'));
fs.copyFileSync(path.join(root, 'docs/ct700-production-approver.md'), path.join(output, 'README.md'));
for (const relative of ['package.json', 'tsconfig.json', 'scripts/pack-ct700-approver.mjs', 'scripts/ct700-package-integrity.mjs',
  'scripts/verify-ct700-approver-package.mjs', 'scripts/ct700-clean-room-fixture.mjs', 'tests/fixtures/webauthn-simulator.ts',
  'src/approver-service/public/index.html', 'src/approver-service/public/production.js', 'docs/ct700-production-approver.md',
  ...fs.readdirSync(path.join(root, 'deploy/ct700-typed-approver')).sort().map(name => `deploy/ct700-typed-approver/${name}`)]) {
  sources[relative] = sha256(fs.readFileSync(path.join(root, relative)));
}
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ private: true, type: 'module', engines: { node: process.version.slice(1) } }, null, 2) + '\n');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify({ baseCommit: git('rev-parse', 'HEAD'),
  trackedDiffSha256: sha256(git('diff', 'HEAD', '--binary')), lockSha256: sha256(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'))),
  packageManager: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).packageManager,
  sources, dependencies, platform: process.platform, arch: process.arch }, null, 2) + '\n');
const manifest = JSON.stringify({ format: 1, role: 'ct700-typed-approver', node: process.version,
  runtimeSha256: sha256(fs.readFileSync(process.execPath)), files: inventory(output) }, null, 2) + '\n';
fs.writeFileSync(path.join(output, 'manifest.json'), manifest);
verifyPackage(output, sha256(manifest));
console.log(`Package: ${output}\nManifest SHA256: ${sha256(manifest)}\nNode: ${process.version}\nRuntime closure: ${[...seen].sort().join(', ')}`);
