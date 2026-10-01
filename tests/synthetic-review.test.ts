import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBundleIntegrity } from "../src/mcp/local-gateway.js";
import { createScratch, type Scratch } from "./support/scratch.js";
import { writeSyntheticReview } from "./support/synthetic-review.js";

let scratch: Scratch | undefined;
afterEach(() => scratch?.dispose());

describe("RC-01 explicit in-process review root", () => {
  it("verifies scratch-local evidence bytes while retaining the production workspace allowlist", () => {
    scratch = createScratch();
    const fixture = writeSyntheticReview(scratch);
    const metadata = JSON.parse(fs.readFileSync(path.join(fixture.root, fixture.bundle, "review-bundle.json"), "utf8"));
    expect(metadata.source_workspace).toBe(scratch.resolve("source"));
    expect(fixture.workspace).toBe(metadata.source_workspace);
    expect(fs.readFileSync(path.join(fixture.workspace, "README.md"), "utf8")).toBe("Document the synthetic regression fixture\n");
    // Byte integrity is valid, but scratch identities must not gain production authorization.
    // Assert the full result so no missing evidence/hash/manifest failure can be hidden.
    expect(verifyBundleIntegrity(fixture.bundle, fixture.root)).toEqual({ bundle: fixture.bundle, valid: false,
      issues: [{ kind: "invalid", path: "review-bundle.json" }] });
    expect(fs.existsSync(path.join(fixture.root, "CURRENT_REVIEW.json"))).toBe(false);
    expect(verifyBundleIntegrity(undefined, fixture.root)).toMatchObject({ valid: false,
      issues: [{ kind: "missing", path: "CURRENT_REVIEW.json" }] });
  });

  it("keeps byte-integrity enforcement active for the synthetic root", () => {
    scratch = createScratch();
    const fixture = writeSyntheticReview(scratch);
    const plan = path.join(fixture.root, fixture.bundle, "plan.md");
    scratch.remove(plan);
    scratch.write(plan, "tampered\n");
    expect(verifyBundleIntegrity(fixture.bundle, fixture.root)).toEqual({ bundle: fixture.bundle, valid: false,
      issues: [{ kind: "invalid", path: "review-bundle.json" }, { kind: "mismatch", path: "plan.md" }] });
  });
});
