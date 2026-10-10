import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

export const NATIVE_ROOTS = Object.freeze({ runtime: "/opt/ai-linux-provider/runtime", state: "/var/lib/ai-linux-provider",
  receipt: "/var/lib/ai-linux-results/receipt-001", cgroup: "/sys/fs/cgroup/ai-linux-provider.service" });
export const NATIVE_UID = 993;
export const nativeHash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const taskIdSchema = z.string().uuid();
export const authorizationSchema = z.object({ version: z.literal(1), task: z.literal("COUNTER_JSON_V1"),
  taskId: taskIdSchema, custodianUid: z.literal(993), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  manifestSha256: digestSchema, dispatch: z.literal("ONE_FIXED_ATTEMPT"), receiptId: z.literal("receipt-001") }).strict();
export const manifestSchema = z.object({ version: z.literal(1), files: z.record(digestSchema) }).strict();
export type NativeAuthorization = z.infer<typeof authorizationSchema>;
export function nativeBlocked(): Error { return new Error("NATIVE_BLOCKED_OR_UNKNOWN_NO_REPLAY"); }

export function assertNativeIdentity(platform: string, uid: number | undefined, euid: number | undefined) {
  if (platform !== "linux" || uid !== NATIVE_UID || euid !== NATIVE_UID) throw nativeBlocked();
}
export function assertNativeProcessIdentity() { assertNativeIdentity(process.platform, process.getuid?.(), process.geteuid?.()); }
export interface NativeFileMetadata { uid: number; mode: number; nlink: number; size: number; file: boolean; symlink: boolean }
/** Pure observation validation: useful in Windows tests, NOT an OS custody proof. */
export function assertNativeFileMetadata(s: NativeFileMetadata, uid: number, limit = 65536) {
  if (s.uid !== uid || !s.file || s.symlink || s.nlink !== 1 || s.size < 0 || s.size > limit ||
    (s.mode & 0o7022) || (uid === NATIVE_UID && (s.mode & 0o077))) throw nativeBlocked();
}
export function assertNativeDirectory(target: string, owner: number) {
  if (!path.isAbsolute(target)) throw nativeBlocked();
  for (let p = target; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o7022) || s.uid !== (p === target ? owner : 0)) throw nativeBlocked();
    if (p === target && owner === NATIVE_UID && (s.mode & 0o077)) throw nativeBlocked();
    if (path.dirname(p) === p) break;
  }
}
export function readNativeFile(file: string, owner: number, limit = 65536): Buffer {
  // Ancestors must be immutable to the custodian for root-authorized runtime files.
  if (owner === 0) assertNativeDirectory(path.dirname(file), 0);
  else {
    for (let p = path.dirname(file); ; p = path.dirname(p)) {
      const s = fs.lstatSync(p);
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o7022) || ![0, NATIVE_UID].includes(s.uid)) throw nativeBlocked();
      if (path.dirname(p) === p) break;
    }
  }
  const before = fs.lstatSync(file);
  assertNativeFileMetadata({ ...before, file: before.isFile(), symlink: before.isSymbolicLink() }, owner, limit);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    assertNativeFileMetadata({ ...s, file: s.isFile(), symlink: false }, owner, limit);
    if (s.dev !== before.dev || s.ino !== before.ino) throw nativeBlocked();
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== s.size || bytes.length > limit) throw nativeBlocked();
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** No caller path, environment flag, UID override, or injectable production admission. */
export function admitFixedNative(): NativeAuthorization {
  assertNativeProcessIdentity();
  assertNativeDirectory(NATIVE_ROOTS.runtime, 0);
  const auth = authorizationSchema.parse(JSON.parse(readNativeFile(`${NATIVE_ROOTS.runtime}/native-authorization.json`, 0).toString("utf8")));
  const bytes = readNativeFile(`${NATIVE_ROOTS.runtime}/native-manifest.json`, 0, 2 * 1024 * 1024);
  if (nativeHash(bytes) !== auth.manifestSha256) throw nativeBlocked();
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const required = ["bin/node", "dist/linux-development/native-worker.js", "dist/linux-development/native-host-transport.js"];
  if (required.some(p => !manifest.files[p])) throw nativeBlocked();
  const seen = new Set<string>(); let total = 0;
  function walk(relative: string) {
    const dir = path.join(NATIVE_ROOTS.runtime, relative); assertNativeDirectory(dir, 0);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && ["native-authorization.json", "native-manifest.json"].includes(name)) continue;
      if (entry.isDirectory()) walk(name);
      else {
        if (seen.size >= 20000 || !manifest.files[name]) throw nativeBlocked();
        const content = readNativeFile(path.join(dir, entry.name), 0, 128 * 1024 * 1024);
        total += content.length;
        if (total > 1024 * 1024 * 1024 || nativeHash(content) !== manifest.files[name]) throw nativeBlocked();
        seen.add(name);
      }
    }
  }
  walk("");
  if (seen.size !== Object.keys(manifest.files).length) throw nativeBlocked();
  const executable = fs.lstatSync(`${NATIVE_ROOTS.runtime}/bin/node`);
  if (!(executable.mode & 0o111)) throw nativeBlocked();
  assertNativeDirectory(NATIVE_ROOTS.state, NATIVE_UID);
  assertNativeDirectory(NATIVE_ROOTS.receipt, NATIVE_UID);
  return Object.freeze(auth);
}
