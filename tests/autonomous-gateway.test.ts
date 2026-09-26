import { describe, expect, it } from "vitest";
import { startOrchestration } from "../src/mcp/local-gateway.js";

describe("autonomous MCP start boundary", () => {
  it("rejects caller-supplied paths, executable names, arbitrary profiles and mismatched scope", () => {
    for (const repo of ["C:\\work\\autonomous-campaign-gateway-fixture", "../../fixture", "node.exe", "generic-code-change"])
      expect(() => startOrchestration(repo, "inspect", "autonomous")).toThrow();
    expect(() => startOrchestration("autonomous-campaign-gateway-fixture", "inspect", "autonomous", undefined,
      ["src/workspace/other.ts"])).toThrow("Only the trusted fixed edit scope");
    expect(() => startOrchestration("pve-doc", "inspect", "autonomous", undefined, ["README.md"])).toThrow();
    expect(() => startOrchestration("autonomous-campaign-gateway-fixture", "inspect", "change")).toThrow("Unknown repository key");
  });
});
