import fs from "node:fs";
import path from "node:path";
import { git } from "../helpers.js";
import { assertScratch, type Scratch } from "./scratch.js";
import type { RepoResearchRoots } from "../../src/mcp/repo-research.js";

/** Real, isolated Git repositories. Only logical allowlisted identities are reused. */
export function writeResearchRepos(scratch: Scratch) {
  assertScratch(scratch);
  const roots: RepoResearchRoots = Object.freeze({
    "pve-doc": scratch.resolve("pve-doc"),
    "ai-orchestration-config": scratch.resolve("ai-orchestration-config"),
  });
  for (const root of Object.values(roots)) {
    scratch.write(path.join(root, "README.md"), "# Synthetic repository\n");
    git(root, "init", "-b", "main");
  }
  scratch.write(path.join(roots["pve-doc"], "00_overview.md"), "# AI-Workspace host\nThe host is synthetic.\n");
  const config = roots["ai-orchestration-config"];
  for (const [name, content] of Object.entries({
    "docs/guide.md": "# Needle heading\nBefore\nThe needle is here\nAfter\n",
    "docs/other.md": "needle\n".repeat(40),
    "node_modules/pkg/file.md": "needle hidden",
    "vendor/a.md": "needle hidden",
    "generated/a.md": "needle hidden",
    "binary.dat": Buffer.from([110, 101, 101, 100, 108, 101, 0, 1]),
    "large.txt": "x".repeat(1024 * 1024 + 1),
    ".gitignore": "ignored/\n",
    "ignored/a.md": "needle hidden",
    "docs/.gitignore": "private.md\n",
    "docs/private.md": "needle hidden",
  })) scratch.write(path.join(config, name), content);
  git(roots["pve-doc"], "add", ".");
  git(roots["pve-doc"], "commit", "-m", "synthetic overview");
  git(config, "add", ".");
  git(config, "commit", "-m", "synthetic research files");
  scratch.write("outside/other.txt", "outside repository\n");
  const escape = path.join(config, "escape");
  let hasEscape = false;
  try {
    fs.symlinkSync(scratch.resolve("outside"), escape, process.platform === "win32" ? "junction" : "dir");
    hasEscape = true;
  } catch { /* symlink privilege may be unavailable */ }
  return Object.freeze({ roots, hasEscape, disposeEscape(): void {
    // Only remove the known link, never follow it; Scratch rejects links on disposal.
    if (hasEscape) {
      scratch.resolve(config);
      if (!fs.lstatSync(escape).isSymbolicLink()) throw new Error("Synthetic escape replaced");
      fs.unlinkSync(escape);
    }
  } });
}
