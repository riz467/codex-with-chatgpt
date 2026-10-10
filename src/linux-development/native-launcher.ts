import fs from "node:fs";
import { spawn } from "node:child_process";
import { canonicalJson } from "../task-contract/contract.js";
import { assertNativeProcessIdentity, nativeBlocked, NATIVE_ROOTS, NATIVE_UID } from "./native-admission.js";
import type { NativeRole, NativeWorkerInput } from "./native-worker.js";

const controls = Object.freeze({ "memory.high": "536870912", "memory.max": "671088640",
  "memory.swap.max": "0", "cpu.max": "100000 100000" });
export const nativeCgroupMembership = (role: NativeRole | "control") => `0::${NATIVE_ROOTS.cgroup.slice("/sys/fs/cgroup".length)}/${role}`;
const roleGroup = (role: NativeRole) => {
  if (role !== "proposer" && role !== "reviewer") throw nativeBlocked();
  return `${NATIVE_ROOTS.cgroup}/${role}`;
};
function cgRead(file: string): string {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink()) throw nativeBlocked();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const b = Buffer.alloc(8193), n = fs.readSync(fd, b, 0, b.length, null);
    if (n > 8192) throw nativeBlocked();
    return b.subarray(0, n).toString("utf8").trim();
  } finally { fs.closeSync(fd); }
}
function cgWrite(file: string, value: string) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try { fs.writeSync(fd, value); } finally { fs.closeSync(fd); }
}
export interface CgroupObservation { events: string; pids: string; descendantGroups: number }
/** An empty direct cgroup.procs alone is insufficient (descendants may still run). */
export function assertEmptyCgroupObservation(o: CgroupObservation) {
  const lines = o.events.split("\n"), populated = lines.filter(l => /^populated\s/.test(l));
  if (populated.length !== 1 || populated[0] !== "populated 0" || o.pids.trim() !== "" || o.descendantGroups !== 0) throw nativeBlocked();
}
export interface ChildSettlementObservation { exitCode: number | null; signal: string | null; closeObserved: boolean;
  group: CgroupObservation; outputBounded: boolean; spawnError: boolean }
export function assertNativeSettlement(o: ChildSettlementObservation) {
  if (!o.closeObserved || o.spawnError || !o.outputBounded || o.exitCode !== 0 || o.signal !== null) throw nativeBlocked();
  assertEmptyCgroupObservation(o.group);
}
function groupObservation(role: NativeRole): CgroupObservation {
  const group = roleGroup(role);
  return { events: cgRead(`${group}/cgroup.events`), pids: cgRead(`${group}/cgroup.procs`),
    descendantGroups: fs.readdirSync(group, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).length };
}
function assertDelegationQuiescent() {
  // A worker can migrate within its delegation. Observing only its role subgroup
  // would miss escaped descendants; inspect the entire fixed delegation as well.
  if (cgRead(`${NATIVE_ROOTS.cgroup}/cgroup.procs`) !== "") throw nativeBlocked();
  const groups = fs.readdirSync(NATIVE_ROOTS.cgroup, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink());
  if (groups.length !== 3 || groups.some(e => e.isSymbolicLink() || !["control", "proposer", "reviewer"].includes(e.name))) throw nativeBlocked();
  for (const group of groups) {
    const p = `${NATIVE_ROOTS.cgroup}/${group.name}`;
    if (fs.readdirSync(p, { withFileTypes: true }).some(e => e.isDirectory() || e.isSymbolicLink())) throw nativeBlocked();
    if (cgRead(`${p}/cgroup.procs`) !== (group.name === "control" ? String(process.pid) : "")) throw nativeBlocked();
    if (group.name !== "control") assertEmptyCgroupObservation(groupObservation(group.name as NativeRole));
  }
}
function assertCgroupProvisioning(role: NativeRole) {
  assertNativeProcessIdentity();
  if (fs.statfsSync(NATIVE_ROOTS.cgroup).type !== 0x63677270) throw nativeBlocked(); // cgroup v2, not a lookalike directory
  for (const [group, owner] of [[NATIVE_ROOTS.cgroup, 0], [roleGroup(role), NATIVE_UID]] as const) {
    const s = fs.lstatSync(group);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== owner || (s.mode & 0o022)) throw nativeBlocked();
    if (cgRead(`${group}/cgroup.type`) !== "domain") throw nativeBlocked();
  }
  for (const [name, value] of Object.entries(controls)) {
    const s = fs.lstatSync(`${NATIVE_ROOTS.cgroup}/${name}`);
    if (s.uid !== 0 || (s.mode & 0o022) || cgRead(`${NATIVE_ROOTS.cgroup}/${name}`) !== value) throw nativeBlocked();
  }
}
/** Writes only a root-provisioned delegated subgroup. Never sudo, systemd-run or cgroup.kill. */
export function prepareFixedNativeCgroup(role: NativeRole) {
  assertCgroupProvisioning(role);
  if (cgRead("/proc/self/cgroup") !== nativeCgroupMembership("control")) throw nativeBlocked();
  assertDelegationQuiescent();
  assertEmptyCgroupObservation(groupObservation(role));
  for (const [name, value] of Object.entries(controls)) cgWrite(`${roleGroup(role)}/${name}`, value);
  for (const [name, value] of Object.entries(controls)) if (cgRead(`${roleGroup(role)}/${name}`) !== value) throw nativeBlocked();
}
/** Trusted bootstrap joins before loading the host/provider module or starting any child. */
export function joinFixedNativeCgroup(role: NativeRole) {
  assertCgroupProvisioning(role);
  for (const [name, value] of Object.entries(controls)) if (cgRead(`${roleGroup(role)}/${name}`) !== value) throw nativeBlocked();
  cgWrite(`${roleGroup(role)}/cgroup.procs`, String(process.pid));
  const expected = nativeCgroupMembership(role);
  if (cgRead("/proc/self/cgroup") !== expected || !cgRead(`${roleGroup(role)}/cgroup.procs`).split("\n").includes(String(process.pid))) throw nativeBlocked();
}
export interface NativeLaunchResult { output: unknown; settlement: "EXIT_0_AND_CGROUP_EMPTY"; pid: number }
export type NativeRoleLauncher = (input: NativeWorkerInput) => Promise<NativeLaunchResult>;
let active = false;
/** Real Linux launcher. The durable journal is the cross-process fence; this is an additional serial in-process guard. */
export const launchFixedNativeRole: NativeRoleLauncher = async input => {
  if (active) throw nativeBlocked();
  active = true;
  // UNKNOWN permanently holds this fence. No finally release and no replay/kill.
  prepareFixedNativeCgroup(input.role);
  const runtime = NATIVE_ROOTS.runtime;
  const cwd = `${NATIVE_ROOTS.state}/${input.role}`;
  const s = fs.lstatSync(cwd);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== NATIVE_UID || (s.mode & 0o077)) throw nativeBlocked();
  const env: NodeJS.ProcessEnv = { HOME: cwd, XDG_CONFIG_HOME: cwd, XDG_DATA_HOME: cwd, XDG_STATE_HOME: cwd,
    XDG_CACHE_HOME: cwd, TMPDIR: cwd, LANG: "C", TZ: "UTC", PATH: `${runtime}/bin` };
  const child = spawn(`${runtime}/bin/node`, ["--disable-proto=throw", `${runtime}/dist/linux-development/native-worker.js`, input.role],
    { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return await new Promise<NativeLaunchResult>((resolve, reject) => {
    let finished = false, outputBounded = true, spawnError = false, size = 0, stderrSize = 0;
    const chunks: Buffer[] = [];
    const finishUnknown = () => {
      if (finished) return; finished = true; clearTimeout(timer);
      child.unref();
      // Continue consuming and discarding streams, but do not keep a status CLI alive.
      for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
      reject(nativeBlocked());
    };
    const timer = setTimeout(finishUnknown, 45_000);
    child.stdout.on("data", (b: Buffer) => { size += b.length; if (size > 8192) { outputBounded = false; chunks.length = 0; }
      else if (outputBounded && !finished) chunks.push(Buffer.from(b)); });
    child.stderr.on("data", (b: Buffer) => { stderrSize += b.length; if (stderrSize > 8192) outputBounded = false; });
    child.stdin.on("error", () => { spawnError = true; finishUnknown(); });
    child.on("error", () => { spawnError = true; finishUnknown(); });
    child.on("close", (exitCode, signal) => {
      if (finished) return;
      try {
        assertNativeSettlement({ exitCode, signal, closeObserved: true, spawnError, outputBounded, group: groupObservation(input.role) });
        assertDelegationQuiescent();
        const output: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!child.pid) throw nativeBlocked();
        finished = true; clearTimeout(timer); active = false;
        resolve({ output, settlement: "EXIT_0_AND_CGROUP_EMPTY", pid: child.pid });
      } catch { finishUnknown(); }
    });
    child.stdin.end(canonicalJson(input));
  });
};
