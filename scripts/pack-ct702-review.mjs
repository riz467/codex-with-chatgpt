import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { inventory, sha256, verifyPackage } from './ct702-package-integrity.mjs';

if (process.argv.length !== 2) throw Error('No pack arguments accepted');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tooling/ct702-review-package');
if (fs.existsSync(output)) throw Error('Package output already exists; retain/review or explicitly remove before rebuilding');
fs.mkdirSync(output, { recursive: true });
const seen = new Set(), externals = new Set(), sources = {};
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
      if (name !== 'zod') throw Error(`UNREVIEWED_DEPENDENCY ${name}`);
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
local('review-service/production-cli.js');
const dependencies = {};
for (const name of externals) {
  const req = createRequire(path.join(root, 'package.json'));
  const directory = fs.realpathSync(req.resolve.paths(name).map(base => path.join(base, name)).find(dir => fs.existsSync(path.join(dir, 'package.json'))));
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  if (pkg.name !== 'zod' || Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) throw Error('UNREVIEWED_TRANSITIVE_DEPENDENCY');
  const dest = path.join(output, 'node_modules', name);
  fs.cpSync(directory, dest, { recursive: true, filter: source => {
    const relative = path.relative(directory, source);
    return !relative.split(path.sep).includes('node_modules') && !/\.(map|ts|mts|cts)$/.test(relative);
  } });
  dependencies[`node_modules/${name}`] = { name, version: pkg.version, packageJsonSha256: sha256(fs.readFileSync(path.join(directory, 'package.json'))) };
}
for (const name of fs.readdirSync(path.join(root, 'deploy/ct702-review')).sort()) {
  fs.writeFileSync(path.join(output, name), fs.readFileSync(path.join(root, 'deploy/ct702-review', name), 'utf8').replace(/\r\n/g, '\n'));
}
fs.copyFileSync(path.join(root, 'scripts/ct702-package-integrity.mjs'), path.join(output, 'ct702-package-integrity.mjs'));
fs.copyFileSync(path.join(root, 'pnpm-lock.yaml'), path.join(output, 'pnpm-lock.yaml'));
fs.copyFileSync(path.join(root, 'docs/ct702-independent-review.md'), path.join(output, 'README.md'));
for (const relative of ['package.json', 'tsconfig.json', 'scripts/pack-ct702-review.mjs', 'scripts/ct702-package-integrity.mjs',
  'scripts/verify-ct702-review-package.mjs', 'scripts/ct702-clean-room-fixture.mjs', 'tests/ct702-review.test.ts', 'tests/ct702-package-integrity.test.ts',
  'docs/ct702-independent-review.md', ...fs.readdirSync(path.join(root, 'deploy/ct702-review')).sort().map(name => `deploy/ct702-review/${name}`)]) {
  sources[relative] = sha256(fs.readFileSync(path.join(root, relative)));
}
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ private: true, type: 'module', engines: { node: process.version.slice(1) } }, null, 2) + '\n');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify({ baseCommit: git('rev-parse', 'HEAD'),
  trackedDiffSha256: sha256(git('diff', 'HEAD', '--binary')), lockSha256: sha256(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'))),
  packageManager: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).packageManager,
  sources, dependencies, platform: process.platform, arch: process.arch }, null, 2) + '\n');
const manifest = JSON.stringify({ format: 1, role: 'ct702-independent-review', node: process.version,
  runtimeSha256: sha256(fs.readFileSync(process.execPath)), files: inventory(output) }, null, 2) + '\n';
fs.writeFileSync(path.join(output, 'manifest.json'), manifest);
verifyPackage(output, sha256(manifest));
console.log(`CT702 package: ${output}\nManifest SHA256: ${sha256(manifest)}\nNode: ${process.version}\nRuntime closure: ${[...seen].sort().join(', ')}`);
