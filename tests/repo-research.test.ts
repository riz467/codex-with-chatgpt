import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { searchRepo, readRepoFile } from "../src/mcp/repo-research.js";
import { createScratch, type Scratch } from "./support/scratch.js";
import { writeResearchRepos } from "./support/synthetic-repos.js";

let scratch: Scratch;
let fixture: ReturnType<typeof writeResearchRepos>;
const search = (repo: string, query: string, limit?: number) => searchRepo(repo, query, limit, fixture.roots);
const read = (repo: string, file: string, start?: number, end?: number) => readRepoFile(repo, file, start, end, fixture.roots);
beforeAll(() => {
  scratch = createScratch();
  fixture = writeResearchRepos(scratch);
});
afterAll(() => {
  fixture?.disposeEscape();
  scratch?.dispose();
});

describe("read-only repo research", () => {
  it("searches pve-doc and rejects unknown repos", () => {
    const result = search("pve-doc", "host", 5);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((match) => !path.isAbsolute(match.path))).toBe(true);
    expect(() => search("unknown", "host")).toThrow();
    expect(() => search("../pve-doc", "host")).toThrow();
  });
  it("excludes binaries, generated output, gitignore paths and dependencies", () => {
    const result = search("ai-orchestration-config", "needle");
    expect(result.matches.map((match) => match.path).sort()).toEqual(["docs/guide.md", "docs/other.md"]);
    expect(result.matches[0]).toMatchObject({ line: 1, heading: "# Needle heading" });
    expect(result.matches[0].snippet.length).toBeLessThan(601);
  });
  it("limits results and rejects control characters", () => {
    const result = search("ai-orchestration-config", "needle", 1);
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(() => search("ai-orchestration-config", "needle\nanything")).toThrow();
    expect(() => search("ai-orchestration-config", "needle", 51)).toThrow();
  });
  it("reads pve-doc and bounded ranges", () => {
    const result = read("pve-doc", "00_overview.md", 1, 5);
    expect(result.repo).toBe("pve-doc");
    expect(result.content.length).toBeGreaterThan(0);
    const guide = read("ai-orchestration-config", "docs/guide.md", 2, 3);
    expect(guide.content).toBe("Before\nThe needle is here");
  });
  it("rejects absolute, UNC, drive and traversal paths", () => {
    for (const input of ["/etc/passwd", "C:\\work\\pve-doc\\README.md", "\\\\server\\share", "../large.txt", "docs/../large.txt", "docs\\guide.md"]) {
      expect(() => read("ai-orchestration-config", input)).toThrow();
    }
  });
  it("rejects symlink escape, directories, ignored, binary and oversized files", () => {
    if (fixture.hasEscape) expect(() => read("ai-orchestration-config", "escape/other.txt")).toThrow();
    for (const input of ["docs", "docs/private.md", "binary.dat", "large.txt", "node_modules/pkg/file.md"]) {
      expect(() => read("ai-orchestration-config", input)).toThrow();
    }
  });
});
