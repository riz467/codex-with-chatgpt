import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { z } from "zod";
import { inspectCandidateRepository, type CandidateRepository } from "./candidate-repo.js";

const backend = "/usr/bin/bwrap";
// CT704 must provision this minimal, root-owned, non-writable runtime image out of band.
// It contains /usr/bin/node and its loader/libraries, plus EMPTY mount points /candidate,
// /proc and /dev. No host /usr, /etc, HOME or credential directory is bind-mounted.
// No installation, runtime mutation, or downloading is performed by this module.
const runtime = "/opt/rc02-sandbox-runtime";
export const sandboxWorkerEnvironment = Object.freeze({ PATH: "/usr/bin", LANG: "C" });
// Host-owned, immutable argv policy. --unshare-all only requests userns on a try basis;
// --disable-userns validation requires explicit --unshare-user before implicit userns setup.
export const sandboxNamespaceArguments = Object.freeze([
  "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
] as const);
const requestSchema = z.object({ candidate: z.custom<CandidateRepository>(v => !!v && typeof v === "object"),
  profile: z.literal("ISOLATION_FIXTURE") }).strict();

export class SandboxUnavailable extends Error {
  constructor(readonly code: "UNSUPPORTED_PLATFORM" | "SANDBOX_UNAVAILABLE") { super(code); }
}

function trustedPath(path: string): void {
  for (let p = path; ; p = dirname(p)) {
    const stat = lstatSync(p);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || realpathSync(p) !== p ||
      (stat.isFile() && (stat.nlink !== 1 || (stat.mode & 0o6000) !== 0))) throw new SandboxUnavailable("SANDBOX_UNAVAILABLE");
    if (dirname(p) === p) break;
  }
}

function trustedImage(path: string): void {
  trustedPath(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) trustedImage(child);
    else if (entry.isFile()) trustedPath(child);
    else throw new SandboxUnavailable("SANDBOX_UNAVAILABLE");
  }
}

/** Static preflight is NOT proof of working kernel isolation. Only the live fixture is proof.
 * Root/setuid invocation is deliberately unsupported. Missing flags, namespaces or runtime
 * dependencies cause bwrap to fail; there is no direct-process or soft-sandbox fallback. */
export function sandboxCapability() {
  if (process.platform !== "linux") return Object.freeze({ available: false, code: "UNSUPPORTED_PLATFORM" as const });
  try {
    if (process.getuid?.() === 0 || process.getuid?.() !== process.geteuid?.()) throw new Error("Unprivileged host required");
    trustedPath(backend); trustedImage(runtime); trustedPath(join(runtime, "usr/bin/node"));
    if (readdirSync(runtime).some(name => !["usr", "lib", "lib64", "candidate", "proc", "dev"].includes(name)))
      throw new Error("Non-minimal runtime image");
    for (const name of ["candidate", "proc", "dev"])
      if (readdirSync(join(runtime, name)).length) throw new Error("Mount point must be empty");
    return Object.freeze({ available: true, code: "LIVE_PROBE_REQUIRED" as const });
  } catch { return Object.freeze({ available: false, code: "SANDBOX_UNAVAILABLE" as const }); }
}

// Host-authored, harmless fixture only. It never imports candidate modules, scripts, package
// metadata, Git config, or startup files. Future mutation/FAST profiles require a new host-owned
// implementation and authorization connection; neither RESERVE nor a recovered receipt is accepted.
const fixture = String.raw`
const fs = require('node:fs'), net = require('node:net'), os = require('node:os');
const input = JSON.parse(process.argv[1]);
function assert(v, label) { if (!v) throw new Error(label); }
function denied(fn, label) {
  try { fn(); } catch (e) { if (['ENOENT','EACCES','EPERM','EROFS','ESRCH'].includes(e.code)) return; throw e; }
  throw new Error(label);
}
assert(JSON.stringify(Object.keys(process.env).sort()) === JSON.stringify(['LANG','PATH']), 'environment');
assert(process.env.LANG === 'C' && process.env.PATH === '/usr/bin', 'environment values');
assert(fs.readFileSync('/proc/self/status','utf8').match(/^NoNewPrivs:\s+1$/m), 'no new privileges');
assert(fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:\s+0+$/m), 'capabilities');
for (const name of ['mnt','net','pid','user','ipc','uts','cgroup'])
  assert(fs.readlinkSync('/proc/self/ns/' + name) !== input.namespaces[name], name + ' namespace');
assert(Object.keys(os.networkInterfaces()).every(n => n === 'lo'), 'network interfaces');
fs.writeFileSync('/candidate/.rc02-isolation-fixture', 'isolated\n', {flag:'wx'});
denied(() => fs.writeFileSync('/rc02-outside-probe','x', {flag:'wx'}), 'outside write');
denied(() => fs.readFileSync(input.canonical + '/.git/HEAD'), 'canonical read');
denied(() => fs.writeFileSync(input.canonical + '/.rc02-forbidden','x', {flag:'wx'}), 'canonical write');
// The image has no HOME. Host path and /home are neither mounted nor forwarded as environment.
denied(() => fs.readdirSync(input.home), 'host HOME');
denied(() => fs.readdirSync('/root'), 'root HOME');
denied(() => process.kill(input.hostPid, 0), 'host process visibility');
assert(fs.readdirSync('/dev').every(n => ['null','zero','full','random','urandom','tty','stdin','stdout','stderr','fd','core','shm','pts','ptmx'].includes(n)), 'devices');
const socket = net.connect({host:'1.1.1.1',port:53});
socket.on('connect', () => { console.error('network escaped'); process.exit(1); });
socket.on('error', () => { console.log('RC02_ISOLATION_FIXTURE_PASS'); });
socket.setTimeout(1500, () => { socket.destroy(); console.error('network inconclusive'); process.exitCode = 1; });
`;

/** The sole execution surface: fixed harmless profile, opaque preparation handle, no caller
 * command/argv/cwd/env/mount/network/profile configuration. NOT a production execution permit.
 * Proposal transport is a different process role and must never execute candidate code here.
 *
 * Linux enforcement: bwrap unshares mount/user/PID/network/IPC/UTS/cgroup namespaces; a minimal
 * read-only root image hides ALL host paths. Only candidate is a writable persistent bind mount.
 * /proc is the new PID namespace, /dev is bwrap's minimal synthetic device set (no host devices).
 * --cap-drop ALL + bwrap's PR_SET_NO_NEW_PRIVS + --disable-userns prevent privilege escalation.
 * --new-session removes controlling-terminal access; only fresh pipe stdio is inherited.
 * --unshare-net has no external interfaces; there is no network-enabled execution profile.
 * Host-exclusive parents/runtime are required until bwrap has established the mounts; no other
 * candidate worker may run concurrently on this preparation handle. No host code runs after it.
 */
export function runSandboxFixture(input: unknown) {
  const request = requestSchema.parse(input);
  const capability = sandboxCapability();
  if (!capability.available) throw new SandboxUnavailable(capability.code as "UNSUPPORTED_PLATFORM" | "SANDBOX_UNAVAILABLE");
  const identity = inspectCandidateRepository(request.candidate);
  // Path payload is JSON data to a fixed script, never interpolated into executable source.
  // os.homedir() would consult attacker-controlled environment, so use the account database.
  // The actual HOME path is obtained from /etc/passwd via Node's native userInfo implementation.
  const namespaces = Object.fromEntries(["mnt", "net", "pid", "user", "ipc", "uts", "cgroup"]
    .map(name => [name, readlinkSync(`/proc/self/ns/${name}`)]));
  const args = [...sandboxNamespaceArguments, "--die-with-parent", "--new-session",
    "--cap-drop", "ALL", "--clearenv", "--ro-bind", runtime, "/", "--bind", request.candidate.root, "/candidate",
    "--proc", "/proc", "--dev", "/dev", "--chdir", "/candidate",
    ...Object.entries(sandboxWorkerEnvironment).flatMap(([key, value]) => ["--setenv", key, value]),
    "--", "/usr/bin/node", "--no-addons", "--no-warnings", "-e", fixture,
    JSON.stringify({ canonical: identity.canonicalRoot, home: hostHome(), hostPid: process.pid, namespaces })];
  const result = spawnSync(backend, args, { shell: false, env: { LANG: "C" }, cwd: "/",
    stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0 || result.stdout.toString().trim() !== "RC02_ISOLATION_FIXTURE_PASS")
    throw new SandboxUnavailable("SANDBOX_UNAVAILABLE");
  return Object.freeze({ profile: "ISOLATION_FIXTURE" as const, result: "PASS" as const,
    osEnforcementLiveTest: "PASS" as const });
}

function hostHome(): string { return userInfo().homedir; }
