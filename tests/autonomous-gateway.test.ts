import { describe, expect, it } from "vitest";
import { startOrchestration } from "../src/mcp/local-gateway.js";
import { validateAutonomousRequest } from "../src/mcp/autonomous-gateway.js";
import { getReviewProfile } from "../src/mcp/review-profiles.js";
import { createScratch } from "./support/scratch.js";

describe("autonomous MCP start boundary", () => {
  it("rejects caller-supplied paths, executable names, arbitrary profiles and mismatched scope", () => {
    const scratch = createScratch();
    try {
      const key = "autonomous-campaign-gateway-fixture";
      const identity = getReviewProfile(key).workspace;
      const profiles = { [key]: { path: identity, review: true, semantic_review: true, edit_path: "src/workspace/git.ts" } };
      scratch.write("profiles/autonomous-repo-profiles.json", JSON.stringify(profiles));
      const trusted = JSON.parse(scratch.read("profiles/autonomous-repo-profiles.json").toString("utf8"));
      for (const repo of ["C:\\work\\autonomous-campaign-gateway-fixture", "../../fixture", "node.exe", "generic-code-change"]) {
        expect(() => startOrchestration(repo, "inspect", "autonomous")).toThrow("Unknown autonomous repository key");
        expect(() => validateAutonomousRequest(repo, undefined, trusted)).toThrow();
      }
      expect(validateAutonomousRequest(key, ["src/workspace/git.ts"], trusted).root).toBe(identity);
      expect(() => validateAutonomousRequest(key, ["src/workspace/other.ts"], trusted)).toThrow("Only the trusted fixed edit scope");
      expect(() => validateAutonomousRequest("pve-doc", ["README.md"], trusted)).toThrow();
      expect(() => validateAutonomousRequest(key, undefined, { [key]: { ...profiles[key], path: scratch.root } })).toThrow("Autonomous repository profile is not trusted");
      expect(() => startOrchestration(key, "inspect", "change")).toThrow("Unknown repository key");
    } finally { scratch.dispose(); }
  });
});
