import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseStrict } from "../task-contract/contract.js";

// Proposed host adapter layout, NOT OpenCode's internal credential database format.
export const linuxCustodyPaths = Object.freeze({
  privateRoot: "/var/lib/ai-linux-provider",
  credentialFile: "/var/lib/ai-linux-provider/credentials/host-oauth.json",
  trustedRuntime: "/opt/ai-linux-provider/runtime/host-adapter.js",
});
const uid = z.number().int().min(0).max(0xffff_fffe);
const metadata = z.object({ ownerUid: uid, mode: z.number().int().min(0).max(0o7777),
  type: z.enum(["directory", "file"]), symlink: z.boolean(), nlink: z.number().int().positive() }).strict();
const observation = z.object({ platform: z.string(), realUid: uid, effectiveUid: uid, credentialUid: uid,
  untrustedUids: z.array(uid).min(1).max(32), privateRoot: metadata, credentialFile: metadata,
  privateAncestors: z.array(metadata).min(1).max(32), trustedRuntime: metadata,
  runtimeAncestors: z.array(metadata).min(1).max(32) }).strict();
export type LinuxCustodyObservation = z.infer<typeof observation>;
type Reason = "INVALID_METADATA" | "LINUX_NONROOT_CUSTODIAN_REQUIRED" | "SHARED_OR_ROOT_EXECUTOR_UID" |
  "PRIVATE_STORAGE_UNSAFE" | "TRUSTED_RUNTIME_UNSAFE" | "CUSTODIAN_UID_MISMATCH" | "UNSUPPORTED_PLATFORM" |
  "MISSING_OR_INACCESSIBLE_LAYOUT";
const result = (reasons: Reason[]) => Object.freeze({
  kind: "METADATA_INSPECTION_ONLY" as const, metadataCandidate: reasons.length === 0,
  reasons: Object.freeze([...new Set(reasons)]), credentialBytesRead: 0 as const,
  admitted: false as const, provider: "NOT_RUN" as const, authority: "NONE" as const,
  productionDispatch: "CLOSED" as const,
});

/** Offline policy validation, NOT authenticated host observation or an execution permit.
 * No credential handle, token, file reader or transport is returned even for a candidate.
 * Same-UID writers can replace code to steal secrets: a clean cwd/session is insufficient. */
export function assessLinuxCustodyMetadata(input: unknown) {
  let x: LinuxCustodyObservation;
  try { x = parseStrict(observation, input); } catch { return result(["INVALID_METADATA"]); }
  const reasons: Reason[] = [];
  if (x.platform !== "linux" || x.realUid === 0 || x.effectiveUid === 0 || x.credentialUid === 0)
    reasons.push("LINUX_NONROOT_CUSTODIAN_REQUIRED");
  if (x.realUid !== x.credentialUid || x.effectiveUid !== x.credentialUid) reasons.push("CUSTODIAN_UID_MISMATCH");
  if (x.untrustedUids.includes(0) || x.untrustedUids.includes(x.credentialUid)) reasons.push("SHARED_OR_ROOT_EXECUTOR_UID");
  const directory = (m: z.infer<typeof metadata>) => m.type === "directory" && !m.symlink;
  if (!directory(x.privateRoot) || x.privateRoot.ownerUid !== x.credentialUid || x.privateRoot.mode !== 0o700 ||
    x.credentialFile.type !== "file" || x.credentialFile.symlink || x.credentialFile.nlink !== 1 ||
    x.credentialFile.ownerUid !== x.credentialUid || x.credentialFile.mode !== 0o600 ||
    x.privateAncestors.some(m => !directory(m) || ![0, x.credentialUid].includes(m.ownerUid) || (m.mode & 0o022) !== 0))
    reasons.push("PRIVATE_STORAGE_UNSAFE");
  if (x.trustedRuntime.type !== "file" || x.trustedRuntime.symlink || x.trustedRuntime.nlink !== 1 ||
    x.trustedRuntime.ownerUid !== 0 || (x.trustedRuntime.mode & 0o7022) !== 0 ||
    x.runtimeAncestors.some(m => !directory(m) || m.ownerUid !== 0 || (m.mode & 0o022) !== 0))
    reasons.push("TRUSTED_RUNTIME_UNSAFE");
  return result(reasons);
}

/** Fixed-layout metadata only. No env/HOME/auth database/network/credential reads.
 * Ancestor inspection detects observed unsafe paths but is not race-free attestation;
 * privileged reentry, capabilities, ACL/ptrace and continuous custody need a host enforcer.
 * Existing production OAuth acquisition deliberately remains unconditionally closed. */
export function inspectLinuxCustodyMetadata() {
  if (process.platform !== "linux") return result(["UNSUPPORTED_PLATFORM"]);
  try {
    const stat = (p: string) => {
      const s = fs.lstatSync(p);
      if (!s.isFile() && !s.isDirectory() && !s.isSymbolicLink()) throw new Error("METADATA_TYPE");
      return { ownerUid: s.uid, mode: s.mode & 0o7777, type: s.isDirectory() ? "directory" as const : "file" as const,
        symlink: s.isSymbolicLink(), nlink: s.nlink };
    };
    const ancestors = (p: string) => {
      const rows = [];
      for (let parent = path.dirname(p); ; parent = path.dirname(parent)) {
        rows.push(stat(parent)); if (parent === "/") break;
      }
      return rows;
    };
    const privateRoot = stat(linuxCustodyPaths.privateRoot);
    return assessLinuxCustodyMetadata({ platform: process.platform, realUid: process.getuid?.(), effectiveUid: process.geteuid?.(),
      credentialUid: privateRoot.ownerUid, untrustedUids: [994], privateRoot,
      credentialFile: stat(linuxCustodyPaths.credentialFile), privateAncestors: ancestors(linuxCustodyPaths.credentialFile),
      trustedRuntime: stat(linuxCustodyPaths.trustedRuntime), runtimeAncestors: ancestors(linuxCustodyPaths.trustedRuntime) });
  } catch { return result(["MISSING_OR_INACCESSIBLE_LAYOUT"]); }
}
