import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, cleanup, write } from "./helpers.js";
import { REPOS } from "../src/mcp/local-gateway.js";
import { searchRepo, readRepoFile } from "../src/mcp/repo-research.js";

let root: string;
const original = REPOS["ai-orchestration-config"];
beforeAll(() => {
  root = makeTmpDir("repo-research");
  (REPOS as Record<string, string>)["ai-orchestration-config"] = root;
  write(root, "docs/guide.md", "# Needle heading\nBefore\nThe needle is here\nAfter\n");
  write(root, "docs/other.md", "needle\n".repeat(40));
  write(root, "node_modules/pkg/file.md", "needle hidden");
  write(root, ".git/config", "needle hidden");
  write(root, "vendor/a.md", "needle hidden");
  write(root, "generated/a.md", "needle hidden");
  write(root, "binary.dat", Buffer.from([110, 101, 101, 100, 108, 101, 0, 1]));
  write(root, "large.txt", "x".repeat(1024 * 1024 + 1));
  write(root, ".gitignore", "ignored/\n");
  write(root, "ignored/a.md", "needle hidden");
  write(root, "docs/.gitignore", "private.md\n");
  write(root, "docs/private.md", "needle hidden");
  try { fs.symlinkSync(path.dirname(root), path.join(root, "escape"), "junction"); } catch { /* unavailable on host */ }
});
afterAll(() => {
  (REPOS as Record<string, string>)["ai-orchestration-config"] = original;
  cleanup(root);
});

describe("read-only repo research", () => {
  it("searches pve-doc and rejects unknown repos", () => {
    const result = searchRepo("pve-doc", "host", 5);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((match) => !path.isAbsolute(match.path))).toBe(true);
    expect(() => searchRepo("unknown", "host")).toThrow();
    expect(() => searchRepo("../pve-doc", "host")).toThrow();
  });
  it("excludes binaries, generated output, gitignore paths and dependencies", () => {
    const result = searchRepo("ai-orchestration-config", "needle");
    expect(result.matches.map((match) => match.path).sort()).toEqual(["docs/guide.md", "docs/other.md"]);
    expect(result.matches[0]).toMatchObject({ line: 1, heading: "# Needle heading" });
    expect(result.matches[0].snippet.length).toBeLessThan(601);
  });
  it("limits results and rejects control characters", () => {
    const result = searchRepo("ai-orchestration-config", "needle", 1);
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(() => searchRepo("ai-orchestration-config", "needle\nanything")).toThrow();
    expect(() => searchRepo("ai-orchestration-config", "needle", 51)).toThrow();
  });
  it("reads pve-doc and bounded ranges", () => {
    const result = readRepoFile("pve-doc", "00_overview.md", 1, 5);
    expect(result.repo).toBe("pve-doc");
    expect(result.content.length).toBeGreaterThan(0);
    const guide = readRepoFile("ai-orchestration-config", "docs/guide.md", 2, 3);
    expect(guide.content).toBe("Before\nThe needle is here");
  });
  it("rejects absolute, UNC, drive and traversal paths", () => {
    for (const input of ["/etc/passwd", "C:\\work\\pve-doc\\README.md", "\\\\server\\share", "../large.txt", "docs/../large.txt", "docs\\guide.md"]) {
      expect(() => readRepoFile("ai-orchestration-config", input)).toThrow();
    }
  });
  it("rejects symlink escape, directories, ignored, binary and oversized files", () => {
    if (fs.existsSync(path.join(root, "escape"))) expect(() => readRepoFile("ai-orchestration-config", "escape/other.txt")).toThrow();
    for (const input of ["docs", "docs/private.md", "binary.dat", "large.txt", "node_modules/pkg/file.md"]) {
      expect(() => readRepoFile("ai-orchestration-config", input)).toThrow();
    }
  });
});
