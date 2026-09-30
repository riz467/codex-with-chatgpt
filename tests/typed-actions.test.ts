import { describe, expect, it } from "vitest";
import { typedActionBootstrap } from "../src/mcp/typed-actions.js";

describe("typed-action bootstrap seam", () => {
  it("starts with no executable action surface", () => {
    expect(typedActionBootstrap).toEqual({ version: 1 });
    expect(Object.keys(typedActionBootstrap)).toEqual(["version"]);
  });
});