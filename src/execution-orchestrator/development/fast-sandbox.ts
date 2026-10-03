import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalJson, freeze } from "../../task-contract/contract.js";
import { inspectCandidateRepository } from "./candidate-repo.js";
import { assertIdleStore, assertMutationCurrent, commitStore, inspectMutatedCandidate, sha256, snapshotTree,
  type MutatedCandidate } from "./candidate-mutation.js";
import { FAST_SANDBOX_PROFILE, MAX_FAST_OUTPUT_BYTES, parseFastSummary, type FastEvidence } from "./fast-evidence.js";

const runtime = "/opt/rc02-fast-runtime", backend = "/usr/bin/bwrap";
export const FAST_TIMEOUT_MS = 600_000;
export const fastEnvironment = freeze({ PATH: "/usr/bin", LANG: "C", LC_ALL: "C", TMPDIR: "/tmp",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0",
  GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_COUNT: "6", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false", GIT_CONFIG_KEY_2: "credential.helper", GIT_CONFIG_VALUE_2: "",
  GIT_CONFIG_KEY_3: "protocol.allow", GIT_CONFIG_VALUE_3: "never", GIT_CONFIG_KEY_4: "core.attributesFile", GIT_CONFIG_VALUE_4: "/dev/null",
  GIT_CONFIG_KEY_5: "core.excludesFile", GIT_CONFIG_VALUE_5: "/runtime/git-excludes" });
const namespaces = ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
  "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"];

/** Data-only plan. No caller-selected executable, environment, runtime or command. */
export function fastSandboxPlan(candidateRoot: string) {
  if (!path.isAbsolute(candidateRoot)) throw new Error("FAST_INVALID_ROOT");
  const args = [...namespaces, "--ro-bind", runtime, "/", "--ro-bind", candidateRoot, "/candidate",
    "--ro-bind", `${runtime}/runtime/scripts/verify-ai-workspace.mjs`, "/candidate/scripts/verify-ai-workspace.mjs",
    "--ro-bind", `${runtime}/runtime/scripts/verification-policy.mjs`, "/candidate/scripts/verification-policy.mjs",
    "--ro-bind", `${runtime}/runtime/node_modules`, "/candidate/node_modules",
    "--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev", "--remount-ro", "/dev",
    "--tmpfs", "/tmp", "--tmpfs", "/scratch", "--chdir", "/candidate",
    ...Object.entries(fastEnvironment).flatMap(([k, v]) => ["--setenv", k, v]),
    "--", "/usr/bin/node", "/candidate/scripts/verify-ai-workspace.mjs", "FAST"];
  return freeze({ executable: backend, args, environment: { LANG: "C" }, timeout: FAST_TIMEOUT_MS,
    maxBuffer: MAX_FAST_OUTPUT_BYTES, profile: FAST_SANDBOX_PROFILE });
}

function trusted(pathname: string) {
  for (let p = pathname; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink() || !s.isFile() && !s.isDirectory() || s.uid !== 0 || (s.mode & 0o6022) !== 0 ||
      s.isFile() && s.nlink !== 1 || fs.realpathSync.native(p) !== p) throw new Error("FAST_UNTRUSTED_RUNTIME");
    if (path.dirname(p) === p) break;
  }
}
export function inspectFastRuntime() {
  if (process.platform !== "linux") throw new Error("UNSUPPORTED_PLATFORM");
  if (process.getuid?.() === 0 || process.getuid?.() !== process.geteuid?.()) throw new Error("FAST_UNPRIVILEGED_HOST_REQUIRED");
  trusted(backend); trusted(runtime);
  // Reject bind/submount aliases: root ownership of the visible path alone does
  // not establish custody of a mounted directory's external source ancestors.
  const mounts = fs.readFileSync("/proc/self/mountinfo", "utf8");
  if (Buffer.byteLength(mounts) > 1024 * 1024) throw new Error("FAST_MOUNTINFO_LIMIT");
  for (const line of mounts.trim().split("\n")) {
    const fields = line.split(" "), mountpoint = fields[4]?.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
    if (!mountpoint || !line.includes(" - ")) throw new Error("FAST_MOUNTINFO_INVALID");
    if (mountpoint === runtime || mountpoint.startsWith(runtime + "/")) throw new Error("FAST_RUNTIME_MOUNT_ALIAS");
  }
  const tree = snapshotTree(runtime);
  for (const name of Object.keys(tree)) trusted(path.join(runtime, name));
  const allowed = ["usr", "lib", "lib64", "runtime", "candidate", "proc", "dev", "tmp", "scratch", "etc"];
  if (fs.readdirSync(runtime).some(n => !allowed.includes(n))) throw new Error("FAST_NONMINIMAL_RUNTIME");
  for (const name of ["candidate", "proc", "dev", "tmp", "scratch"])
    if (!fs.lstatSync(path.join(runtime, name)).isDirectory() || fs.readdirSync(path.join(runtime, name)).length)
      throw new Error("FAST_MOUNTPOINT_NOT_EMPTY");
  for (const name of ["usr/bin/node", "usr/bin/git", "runtime/scripts/verify-ai-workspace.mjs", "runtime/scripts/verification-policy.mjs"])
    if (tree[name]?.kind !== "FILE") throw new Error("FAST_RUNTIME_FILE_ABSENT");
  const fixedFiles = {
    "etc/hosts": "127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n",
    "etc/nsswitch.conf": "hosts: files\n",
    "runtime/git-excludes": "/node_modules/\n",
  };
  for (const [name, content] of Object.entries(fixedFiles)) {
    if (tree[name]?.kind !== "FILE") throw new Error("FAST_RUNTIME_FILE_ABSENT");
    if (fs.readFileSync(path.join(runtime, name), "utf8") !== content) throw new Error("FAST_RUNTIME_FIXED_CONTENT");
  }
  if (tree.etc?.kind !== "DIRECTORY" || fs.readdirSync(path.join(runtime, "etc")).some(n => !["hosts", "nsswitch.conf"].includes(n)))
    throw new Error("FAST_NONMINIMAL_RUNTIME");
  if (tree["runtime/node_modules"]?.kind !== "DIRECTORY" ||
    fs.readdirSync(path.join(runtime, "usr/bin")).some(n => !["node", "git"].includes(n))) throw new Error("FAST_RUNTIME_EXECUTABLES");
  // Content identity excludes host inode/device numbering and remains stable across provisioning.
  const contents = Object.entries(tree).map(([name, row]) => ({ path: name, kind: row.kind,
    ...(row.kind === "FILE" ? { sha256: row.sha256, byteLength: row.byteLength } : {}) }));
  return freeze({ runtimeCapsuleDigest: sha256(canonicalJson(contents)),
    nodeExecutableDigest: tree["usr/bin/node"].sha256!, gitExecutableDigest: tree["usr/bin/git"].sha256! });
}

type SandboxResult = { outcome: "PASS"; evidence: FastEvidence } | { outcome: "FAILED_KNOWN" | "UNKNOWN"; reason: string };
const used = new WeakSet<MutatedCandidate>();

/** One-shot execution, gated by a genuine mutation handle and a NEW durable FAST
 * reservation. Timeout/launch ambiguity never becomes known failure or a retry. */
export function runFastSandbox(handle: MutatedCandidate, hostExpected: unknown): SandboxResult {
  const data = inspectMutatedCandidate(handle);
  assertIdleStore(data.store, data.binding, hostExpected, "CANDIDATE_MUTATION_CONFIRMED");
  if (used.has(handle)) throw new Error("FAST_REPLAY");
  used.add(handle);
  commitStore(data.store, data.binding, { operation: "RESERVE", kind: "FAST" });
  let launched = false;
  try {
    assertMutationCurrent(data);
    const capsule = inspectFastRuntime();
    const candidate = data.candidate;
    inspectCandidateRepository(candidate);
    // No creation inside read-only candidate. Absent overlay destinations fail closed.
    // Linux live certification must validate bwrap destination semantics before activation.
    for (const name of ["scripts/verify-ai-workspace.mjs", "scripts/verification-policy.mjs"])
      if (!fs.lstatSync(path.join(candidate.root, name)).isFile()) throw new Error("FAST_OVERLAY_DESTINATION");
    if (!fs.lstatSync(path.join(candidate.root, "node_modules")).isDirectory()) throw new Error("FAST_DEPENDENCY_DESTINATION");
    const plan = fastSandboxPlan(candidate.root);
    const execute = (args: readonly string[], timeout = plan.timeout) => spawnSync(plan.executable, [...args], { shell: false, env: plan.environment,
      cwd: "/", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: plan.maxBuffer, killSignal: "SIGKILL" });
    launched = true;
    // Fixed trusted-only version probe within the same isolation. No project import.
    const version = execute([...plan.args.slice(0, -3), "/usr/bin/node", "--version"], 10_000);
    if (version.error || version.signal || version.status !== 0) return { outcome: "UNKNOWN", reason: "FAST_VERSION_PROBE_UNCERTAIN" };
    const nodeVersion = version.stdout.toString("utf8").trim();
    if (!/^v\d+\.\d+\.\d+$/.test(nodeVersion)) return { outcome: "UNKNOWN", reason: "FAST_NODE_VERSION" };
    const result = execute(plan.args);
    if (result.error || result.signal || result.status === null) return { outcome: "UNKNOWN", reason: "FAST_EXECUTION_UNCERTAIN" };
    assertMutationCurrent(data);
    if (canonicalJson(inspectFastRuntime()) !== canonicalJson(capsule)) return { outcome: "UNKNOWN", reason: "FAST_RUNTIME_DRIFT" };
    let summary;
    try { summary = parseFastSummary(result.stdout, result.stderr, result.status); }
    catch { return { outcome: "FAILED_KNOWN", reason: "FAST_VERIFICATION_FAILED" }; }
    return { outcome: "PASS", evidence: { domain: "RC02_DEVELOPMENT_V2_FAST_EVIDENCE_V1",
      attemptDigest: data.binding.attempt.digest, manifestDigest: data.binding.manifest!.digest, ...capsule, nodeVersion,
      requestedProfile: "FAST", effectiveProfile: "FAST", result: "PASS", summaryDigest: sha256(canonicalJson(summary)),
      stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr),
      candidatePostSnapshotDigest: sha256(canonicalJson(data.candidateTree)), networkIsolation: "OS_NETWORK_NAMESPACE",
      sandboxProfile: FAST_SANDBOX_PROFILE, sandboxProfileDigest: sha256(canonicalJson({ ...plan, args: fastSandboxPlan("/candidate").args })),
      osResourceCgroupLimit: "NOT_ESTABLISHED" } };
  } catch (error) {
    // Drift is uncertainty even when discovered before process launch.
    try { assertMutationCurrent(data); } catch { return { outcome: "UNKNOWN", reason: "FAST_CANDIDATE_OR_CANONICAL_DRIFT" }; }
    return { outcome: launched ? "UNKNOWN" : "FAILED_KNOWN", reason: error instanceof Error ? error.message : "FAST_FAILURE" };
  }
}
