import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Release-owned data, never read from a candidate repo or an environment override.
const release = JSON.parse(fs.readFileSync(new URL("./proposer/opencode-release.json", import.meta.url), "utf8"));
export const opencodeVersion: string = release.version;
export function opencodeBinary(role: "proposer" | "reviewer"): string {
  if (!["win32", "linux"].includes(process.platform) || process.arch !== "x64") throw new Error("OPENCODE_BINARY_PLATFORM_UNSUPPORTED");
  return release[process.platform][role];
}
export function assertOpencodeBinary(role: "proposer" | "reviewer"): string {
  const executable = opencodeBinary(role);
  try {
    for (let item = executable; ; item = path.dirname(item)) {
      if (fs.lstatSync(item).isSymbolicLink()) throw new Error("alias");
      if (path.dirname(item) === item) break;
    }
    const stat = fs.lstatSync(executable);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("placement");
    const actual = fs.realpathSync.native(executable);
    if ((process.platform === "win32" ? actual.toLowerCase() !== executable.toLowerCase() : actual !== executable)) throw new Error("alias");
    if (createHash("sha256").update(fs.readFileSync(executable)).digest("hex") !== release[process.platform].sha256) {
      throw new Error("hash");
    }
  } catch { throw new Error("OPENCODE_BINARY_IDENTITY_MISMATCH"); }
  // The release digest pins the version before execution; /api/info must confirm it again.
  return executable;
}
