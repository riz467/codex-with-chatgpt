import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../task-contract/contract.js";
import { nativePublicReceiptSchema, type NativePublicReceipt } from "./native-receipt.js";
import { assertNativeProcessIdentity, nativeBlocked } from "./native-admission.js";

export const NATIVE_PUBLIC_RESULTS = "/var/lib/ai-linux-results/public-receipt-001";
/** Deliberately separate sanitized DATA area, never under custodian credential HOME. */
function assertPublicLayout() {
  for (const p of ["/", "/var", "/var/lib", "/var/lib/ai-linux-results"]) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) throw nativeBlocked();
  }
  const s = fs.lstatSync(NATIVE_PUBLIC_RESULTS);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 993 || s.gid !== 985 || (s.mode & 0o7777) !== 0o2750) throw nativeBlocked();
}
export function assertNativePublicResultProvisioning() {
  assertNativeProcessIdentity(); assertPublicLayout();
  if (!process.getgroups?.().includes(985)) throw nativeBlocked();
}
export function publishNativePublicReceipt(input: NativePublicReceipt) {
  assertNativePublicResultProvisioning();
  const value = nativePublicReceiptSchema.parse(input);
  const file = `${NATIVE_PUBLIC_RESULTS}/handoff.json`;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o640);
  try {
    fs.fchownSync(fd, 993, 985); fs.fchmodSync(fd, 0o640);
    fs.writeFileSync(fd, canonicalJson(value)); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const directory = fs.openSync(NATIVE_PUBLIC_RESULTS, fs.constants.O_RDONLY);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
/** Read-only Win11 SSH entry for existing ai-linux-dev UID994, not provider UID993.
 * It never opens private claims/journal/SQLite, authenticates, repairs or launches. */
export function readNativePublicReceipt(): NativePublicReceipt {
  if (process.platform !== "linux" || process.getuid?.() !== 994 || process.geteuid?.() !== 994) throw nativeBlocked();
  assertPublicLayout();
  const file = `${NATIVE_PUBLIC_RESULTS}/handoff.json`, before = fs.lstatSync(file);
  const valid = (s: fs.Stats) => s.isFile() && !s.isSymbolicLink() && s.uid === 993 && s.gid === 985 &&
    (s.mode & 0o7777) === 0o640 && s.nlink === 1 && s.size > 0 && s.size <= 65536;
  if (!valid(before)) throw nativeBlocked();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!valid(opened) || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw nativeBlocked();
    const buffer = Buffer.alloc(65537); let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (n === 0) break; length += n;
    }
    if (length !== opened.size || length > 65536) throw nativeBlocked();
    const r = nativePublicReceiptSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))));
    if (r.mode !== "NATIVE_LINUX_HOST") throw nativeBlocked();
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw nativeBlocked();
    return r;
  } finally { fs.closeSync(fd); }
}
export function parseNativeObserverCli(args: readonly string[]) {
  if (args.length !== 1 || !["status", "readreceipt"].includes(args[0])) throw nativeBlocked();
  return readNativePublicReceipt();
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.stdout.write(JSON.stringify(parseNativeObserverCli(process.argv.slice(2))) + "\n"); }
  catch { process.stdout.write(JSON.stringify({ result: "PUBLIC_RECEIPT_NOT_AVAILABLE_OR_BLOCKED", authority: "NONE", replay: false }) + "\n"); process.exitCode = 2; }
}
