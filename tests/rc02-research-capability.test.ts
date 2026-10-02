import { describe, expect, it } from "vitest";
import { parseResearchOperation } from "../src/task-contract/research-capability.js";

const accepted = [
  { operation: "ReadCatalogFile", repoId: "repo-one", evidenceId: "evidence-one" },
  { operation: "ObserveStatus", repoId: "repo-one" },
  { operation: "ReadHead", repoId: "repo-one" },
  { operation: "ReadBoundedHistory", repoId: "repo-one", approvedRangeId: "range-one" },
  { operation: "ReadBoundedDiff", repoId: "repo-one", approvedComparisonId: "comparison-one" },
  { operation: "ReadTrackedBlob", repoId: "repo-one", approvedObjectId: "object-one", approvedPathId: "path-one" },
];
describe("RC02 research contract represents only local inventory observations", () => {
  it.each(accepted)("accepts exactly $operation with opaque selectors", input => {
    expect(parseResearchOperation(input)).toEqual(input);
    expect(Object.isFrozen(parseResearchOperation(input))).toBe(true);
  });
  it.each(["fetch", "ls-remote", "push", "commit", "reset", "checkout", "clean", "Git", "Shell", "NetworkRequest",
    "git fetch --no-tags origin", "git status; git push", "ReadHead && git fetch"])("rejects operation %s", operation => {
    expect(() => parseResearchOperation({ operation, repoId: "repo-one" })).toThrow();
  });
  it.each([
    ["executable", "git"], ["shell", "pwsh"], ["command", "git status && git fetch origin"],
    ["argv", ["fetch", "origin"]], ["cwd", "C:\\work"], ["environment", { GIT_CONFIG: "caller" }],
    ["remote", "origin"], ["url", "https://example.invalid"], ["config", { alias: "!shell" }],
    ["gitConfigOverride", "core.sshCommand"], ["subcommand", "status"], ["path", "README.md"],
  ])("rejects caller-controlled %s on every operation", (key, value) => {
    for (const input of accepted) expect(() => parseResearchOperation({ ...input, [key as string]: value })).toThrow();
  });
  it.each(["https://example.invalid", "../outside", "C:\\repo", "HEAD:path", "--config", "a;b", "a&&b", "a b", "a\n"])(
    "rejects command/path/URL selector %s", selector => {
      expect(() => parseResearchOperation({ operation: "ReadCatalogFile", repoId: "repo-one", evidenceId: selector })).toThrow();
    });
  it("rejects incomplete selectors, missing operation and unknown fields", () => {
    for (const input of accepted) {
      const missing = { ...input } as Record<string, unknown>; delete missing.repoId;
      expect(() => parseResearchOperation(missing)).toThrow();
    }
    expect(() => parseResearchOperation({ repoId: "repo-one" })).toThrow();
    expect(() => parseResearchOperation({ operation: "ReadTrackedBlob", repoId: "repo-one" })).toThrow();
    expect(() => parseResearchOperation(null)).toThrow();
  });
  it("does not invoke accessor-shaped command input or accept inherited permissions", () => {
    const input = { ...accepted[0] }; let invoked = false;
    Object.defineProperty(input, "command", { enumerable: true, get() { invoked = true; return "git fetch"; } });
    expect(() => parseResearchOperation(input)).toThrow(); expect(invoked).toBe(false);
    expect(() => parseResearchOperation(Object.assign(Object.create({ network: true }), accepted[0]))).toThrow();
  });
});
