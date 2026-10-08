import fs from "node:fs";
import path from "node:path";

// Release-managed placement, never MCP/Dashboard input or project configuration.
export function deploymentFor(platform: NodeJS.Platform) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const root = windows ? "C:\\work" : "/srv/ai-orchestration";
  return Object.freeze({
    executionRoot: paths.join(root, "codex-with-chatgpt"),
    reviewRoot: paths.join(root, "ai-orchestration-review"),
    configRoot: paths.join(root, "ai-orchestration-config"),
    pveDocsRoot: paths.join(root, "pve-doc"),
    fixtureRoot: paths.join(root, "bounded-review-live-fixture"),
    pwsh: windows ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : "/usr/bin/pwsh",
    // ponytail: Linux dispatch stays closed until credential-free Executor verification is connected.
    localExecutionEnabled: windows,
  });
}

export const deployment = deploymentFor(process.platform);

/** Resolve aliases, preserving Linux case; missing/unreadable roots establish no identity. */
export function sameDeploymentPath(left: string, right: string): boolean {
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  try {
    const a = fs.realpathSync.native(left), b = fs.realpathSync.native(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}
