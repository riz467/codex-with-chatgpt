import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CAPSULE_PINS = Object.freeze({ nodeVersion: 'v24.16.0',
  nodeSha256: 'b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd',
  openCodeVersion: '2.0.22', openCodeSha256: '32cf5aa0a69a650e36277e3315d189835ddc79fb9aa1d0aef5025be5af5ad122', pnpmVersion: '11.24.0',
  pnpmPayloadSha256: 'f082bce3f6dd1c09a74883c7b598a59e437747b2180bab605487351c45597549', pnpmFileCount: 455 });
export const sha = data => createHash('sha256').update(data).digest('hex');
export function assertLinuxBuilder(platform, arch, uid, euid) {
  if (platform !== 'linux' || arch !== 'x64' || !Number.isInteger(uid) || !Number.isInteger(euid) || uid === 0 || euid === 0)
    throw Error('NONROOT_LINUX_X64_BUILDER_REQUIRED');
}
export function assertLinuxElf(bytes) {
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 || bytes.readUInt16LE(18) !== 62 || bytes.readUInt16LE(52) !== 64)
    throw Error('LINUX_X64_ELF_REQUIRED');
  const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || size !== 56 || !count || count > 4096 || offset < 64 || offset + count * size > bytes.length) throw Error('ELF_PROGRAM_HEADERS_REQUIRED');
  for (let i = 0; i < count; i++) {
    const at = offset + size * i, start = Number(bytes.readBigUInt64LE(at + 8)), length = Number(bytes.readBigUInt64LE(at + 32));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start + length > bytes.length) throw Error('ELF_SEGMENT_BOUNDS');
  }
}
export function packagePayloadSha256(root) {
  const h = createHash('sha256'), files = []; let total = 0;
  function walk(dir, prefix = '', depth = 0) {
    if (depth > 40) throw Error('BUILD_TOOL_DEPTH_LIMIT');
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name), s = fs.lstatSync(p), relative = prefix + name;
      if (s.isSymbolicLink()) throw Error('BUILD_TOOL_PAYLOAD_ALIAS');
      if (s.isDirectory()) walk(p, relative + '/', depth + 1);
      else if (s.isFile()) {
        if (s.nlink !== 1 || files.length >= 5000 || s.size > 64 * 1024 ** 2 || (total += s.size) > 256 * 1024 ** 2) throw Error('BUILD_TOOL_PAYLOAD_LIMIT');
        files.push({ relative, p });
      }
      else throw Error('BUILD_TOOL_SPECIAL_FILE');
    }
  }
  walk(root);
  for (const { relative, p } of files.sort((a,b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)) {
    const bytes = fs.readFileSync(p); h.update(`${relative}\0${bytes.length}\0`).update(bytes);
  }
  return { sha256: h.digest('hex'), files: files.length };
}
export function assertDryCertification(r) {
  if (r?.kind !== 'OPENCODE_CORE_CERTIFICATION_ONLY' || r.result !== 'COMPATIBLE' || r.compatible !== true ||
    r.effectivePermission !== 'DENY_ALL' || r.directTools !== 0 || r.codeModeTools !== 0 || r.preparedTools !== 0 ||
    r.activity?.network !== 0 || r.activity?.processes !== 0 || r.activity?.forbiddenReads !== 0 ||
    r.networkEnforcement !== 'APPLICATION_NO_NETWORK_DRY_PROFILE_ONLY') throw Error('LINUX_DRY_CORE_PROFILE_FAILED');
}
export function inventory(root) {
  const rows = []; let total = 0;
  const base = fs.realpathSync(root);
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = path.relative(base, file).split(path.sep).join('/'), s = fs.lstatSync(file);
      if (rows.length >= 100000 || /[\x00-\x1f\\]/.test(relative) || relative.split('/').some(p => ['.ssh', '.git-credentials', '.npmrc', 'auth.json'].includes(p) || p === '.env' || p.startsWith('.env.')) || /\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/.test(relative))
        throw Error('CAPSULE_PATH_OR_LIMIT');
      if (s.isSymbolicLink()) {
        const link = fs.readlinkSync(file); if (path.isAbsolute(link)) throw Error('CAPSULE_ABSOLUTE_LINK');
        const target = fs.realpathSync(file), inside = path.relative(base, target);
        if (path.isAbsolute(inside) || inside === '..' || inside.startsWith('..' + path.sep)) throw Error('CAPSULE_LINK_ESCAPE');
        if (relative.endsWith('.node')) {
          const t = fs.lstatSync(target); if (!t.isFile() || t.nlink !== 1 || t.size > 128 * 1024 ** 2) throw Error('CAPSULE_NATIVE_LINK_TARGET_LIMIT');
          assertLinuxElf(fs.readFileSync(target));
        }
        rows.push({ path: relative, type: 'SYMLINK', target: link });
      } else if (s.isDirectory()) {
        rows.push({ path: relative, type: 'DIRECTORY', mode: s.mode & 0o777 }); visit(file);
      } else if (s.isFile() && s.nlink === 1) {
        if (s.size > 256 * 1024 ** 2 || (total += s.size) > 2 * 1024 ** 3) throw Error('CAPSULE_SIZE_LIMIT');
        const bytes = fs.readFileSync(file);
        if (bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw Error('CAPSULE_DATABASE_PAYLOAD');
        if (/\.node$/.test(relative)) assertLinuxElf(bytes);
        rows.push({ path: relative, type: 'FILE', mode: s.mode & 0o777, bytes: bytes.length, sha256: sha(bytes), nativeModule: relative.endsWith('.node') });
      } else throw Error('CAPSULE_SPECIAL_OR_HARDLINK');
    }
  }
  visit(base); return rows;
}
export function assertRuntimeCustodyRows(rows) {
  if (rows.length > 20000 || rows.some(r => r.type === 'SYMLINK' || (r.type === 'FILE' && r.bytes > 128 * 1024 ** 2)) ||
    rows.reduce((n, r) => n + (r.bytes ?? 0), 0) > 1024 ** 3) throw Error('STRICT_NATIVE_RUNTIME_CUSTODY_REQUIRED');
}

/** Build-host operation only. No deployment, credentials, provider request or guest management.
 * Public package cache must already contain the frozen lock closure: installs are offline/no scripts. */
export function packLinuxNativeCapsule(inputs) {
  assertLinuxBuilder(process.platform, process.arch, process.getuid?.(), process.geteuid?.());
  if (!inputs || Object.keys(inputs).sort().join(',') !== 'commit,node,opencode,pnpm,store' || !/^[a-f0-9]{40}$/.test(inputs.commit)) throw Error('APPROVED_SOURCE_AND_PUBLIC_INPUTS_REQUIRED');
  inputs = { ...inputs, node: fs.realpathSync(inputs.node), opencode: fs.realpathSync(inputs.opencode), pnpm: fs.realpathSync(inputs.pnpm), store: fs.realpathSync(inputs.store) };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 }).trim();
  if (git('status', '--porcelain').length) throw Error('EXACT_CLEAN_GIT_SOURCE_REQUIRED');
  const commit = git('rev-parse', 'HEAD'); if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('SOURCE_COMMIT');
  if (commit !== inputs.commit) throw Error('APPROVED_SOURCE_MISMATCH');
  for (const name of ['node', 'opencode']) {
    const p = fs.realpathSync(inputs[name]), bytes = fs.readFileSync(p); assertLinuxElf(bytes);
    if (sha(bytes) !== CAPSULE_PINS[name === 'node' ? 'nodeSha256' : 'openCodeSha256']) throw Error('PUBLIC_BINARY_PIN_MISMATCH');
  }
  const output = path.join(root, '.tooling', 'linux-native-capsule');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output, { mode: 0o700 });
  const source = path.join(output, 'source'), runtime = path.join(output, 'runtime');
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(runtime, { mode: 0o700 });
  const archive = path.join(output, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '--output=' + archive, commit], { cwd: root, timeout: 30000 });
  execFileSync('tar', ['--same-permissions', '-xf', archive, '-C', source], { timeout: 30000 });
  const originalLockSha256 = sha(fs.readFileSync(path.join(source, 'pnpm-lock.yaml')));
  const originalSourceRows = inventory(source);
  // Only this newly created isolated output tree; never delete the original checkout's dist.
  if (fs.existsSync(path.join(source, 'dist'))) fs.rmSync(path.join(source, 'dist'), { recursive: true });
  const home = path.join(output, 'build-home'); fs.mkdirSync(home, { mode: 0o700 });
  const buildBin = path.join(output, 'build-bin'); fs.mkdirSync(buildBin, { mode: 0o700 });
  fs.copyFileSync(inputs.node, path.join(buildBin, 'node')); fs.chmodSync(path.join(buildBin, 'node'), 0o755);
  const env = { PATH: buildBin + ':/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home, XDG_STATE_HOME: home, TMPDIR: home, LANG: 'C', TZ: 'UTC', npm_config_ignore_scripts: 'true' };
  const publicStore = fs.realpathSync(inputs.store);
  const pnpmRoot = path.dirname(path.dirname(fs.realpathSync(inputs.pnpm)));
  const toolPayload = packagePayloadSha256(pnpmRoot);
  if (inputs.pnpm !== path.join(pnpmRoot, 'bin', 'pnpm.cjs') || toolPayload.sha256 !== CAPSULE_PINS.pnpmPayloadSha256 || toolPayload.files !== CAPSULE_PINS.pnpmFileCount) throw Error('BUILD_TOOL_PAYLOAD_PIN');
  const sandbox = '/usr/bin/unshare';
  const sandboxed = (cwd, executable, args, options = {}) => execFileSync(sandbox,
    ['--user', '--map-root-user', '--net', '--pid', '--fork', '--kill-child', '--mount-proc', '--', executable, ...args],
    { cwd, env, timeout: 240000, maxBuffer: 1024 * 1024, ...options });
  const pnpmAt = (cwd, ...args) => sandboxed(cwd, inputs.node, [fs.realpathSync(inputs.pnpm), ...args]);
  const pnpm = (...args) => pnpmAt(source, ...args);
  if (pnpm('--version').toString().trim() !== CAPSULE_PINS.pnpmVersion || sandboxed(source, path.join(buildBin, 'node'), ['--version']).toString().trim() !== CAPSULE_PINS.nodeVersion)
    throw Error('BUILDER_TOOLCHAIN_VERSION');
  pnpm('install', '--frozen-lockfile', '--offline', '--ignore-scripts', '--ignore-pnpmfile', '--package-import-method=copy', '--store-dir', publicStore);
  pnpm('exec', 'tsc', '-p', 'tsconfig.json');
  sandboxed(source, inputs.node, ['scripts/copy-runtime.mjs'], { timeout: 60000 });
  // Copy only the fresh Linux build/install. Never package this workstation's node_modules/HOME.
  for (const name of ['dist', 'package.json', 'pnpm-lock.yaml'])
    fs.cpSync(path.join(source, name), path.join(runtime, name), { recursive: true, dereference: false, verbatimSymlinks: true });
  pnpmAt(runtime, 'install', '--prod', '--frozen-lockfile', '--offline', '--ignore-scripts', '--ignore-pnpmfile', '--package-import-method=copy', '--node-linker=hoisted', '--store-dir', publicStore);
  if (sha(fs.readFileSync(path.join(source, 'pnpm-lock.yaml'))) !== originalLockSha256 || sha(fs.readFileSync(path.join(runtime, 'pnpm-lock.yaml'))) !== originalLockSha256) throw Error('LOCK_CHANGED_DURING_BUILD');
  for (const row of originalSourceRows.filter(r => r.type === 'FILE' && !r.path.startsWith('dist/'))) {
    if (sha(fs.readFileSync(path.join(source, row.path))) !== row.sha256) throw Error('SOURCE_CHANGED_DURING_BUILD');
  }
  const bin = path.join(runtime, 'bin'); fs.mkdirSync(bin);
  for (const name of ['node', 'opencode']) { fs.copyFileSync(inputs[name], path.join(bin, name)); fs.chmodSync(path.join(bin, name), 0o755); }
  // D0 is application-denied/no-network composition; not an auth/provider test or admission permit.
  const smoke = sandboxed(runtime, path.join(bin, 'node'), ['--input-type=module', '-e',
    'const m=await import("./dist/execution-orchestrator/development/opencode-core-profile.js");const r=await m.certifyOpenCodeCore();process.stdout.write(JSON.stringify(r));'],
    { timeout: 60000, maxBuffer: 65536 }).toString();
  const certification = JSON.parse(smoke); assertDryCertification(certification);
  const cliVersion = sandboxed(runtime, path.join(bin, 'opencode'), ['--version'], { timeout: 20000, maxBuffer: 65536 }).toString().trim();
  if (cliVersion !== CAPSULE_PINS.openCodeVersion) throw Error('OPENCODE_CLI_VERSION');
  const rows = inventory(runtime);
  assertRuntimeCustodyRows(rows);
  const manifest = { kind: 'LINUX_X64_OFFLINE_RUNTIME_CAPSULE_NOT_DEPLOYMENT_AUTHORIZATION', sourceCommit: commit,
    sourceArchiveSha256: sha(fs.readFileSync(archive)), sourceFiles: originalSourceRows, lockSha256: originalLockSha256,
    pins: CAPSULE_PINS, platform: process.platform, arch: process.arch, build: 'CLEAN_GIT_LINUX_OFFLINE_INSTALL_NO_LIFECYCLE',
    dryCoreProfile: certification, cliVersion, buildNetwork: 'LINUX_USER_NETWORK_PID_NAMESPACE_NO_INTERFACES',
    namespaceToolSha256: sha(fs.readFileSync(sandbox)), files: rows, nativeModules: rows.filter(r => r.nativeModule), provider: 'NOT_RUN',
    sysroot: 'HOST_GLIBC_AND_SYSTEM_TOOLS_NOT_BUNDLED_REQUIRES_TARGET_ABI_VERIFICATION', productionDispatch: 'CLOSED', authority: 'NONE' };
  fs.writeFileSync(path.join(output, 'CAPSULE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', path.join(output, 'runtime.tar'), '-C', runtime, '.'], { timeout: 120000 });
  const verify = path.join(output, 'relocated-verify'); fs.mkdirSync(verify, { mode: 0o700 });
  execFileSync('tar', ['--same-permissions', '-xf', path.join(output, 'runtime.tar'), '-C', verify], { timeout: 120000 });
  if (JSON.stringify(inventory(verify)) !== JSON.stringify(rows)) throw Error('RELOCATED_ARCHIVE_MISMATCH');
  const receipt = { sourceCommit: commit, manifestSha256: sha(fs.readFileSync(path.join(output, 'CAPSULE-MANIFEST.json'))), runtimeTarSha256: sha(fs.readFileSync(path.join(output, 'runtime.tar'))), dryCoreProfile: certification, deployed: false, provider: 'NOT_RUN' };
  fs.writeFileSync(path.join(output, 'BUILD-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 7) throw Error('APPROVED_COMMIT_NODE_OPENCODE_PNPM_CACHE_PATHS_REQUIRED');
    console.log(JSON.stringify(packLinuxNativeCapsule({ commit: process.argv[2], node: process.argv[3], opencode: process.argv[4], pnpm: process.argv[5], store: process.argv[6] })));
  } catch { console.error(JSON.stringify({ result: 'CAPSULE_BUILD_INCOMPLETE_FAIL_CLOSED', provider: 'NOT_RUN', authority: 'NONE' })); process.exitCode = 1; }
}
