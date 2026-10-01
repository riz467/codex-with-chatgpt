import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScratch, type Scratch } from "./support/scratch.js";
import { writeSyntheticReview, writePolicyReview, writeCompletedTask } from "./support/synthetic-review.js";

const allocations: Scratch[] = [];
function allocate() { const scratch = createScratch(); allocations.push(scratch); return scratch; }
afterEach(() => { for (const scratch of allocations.splice(0)) scratch.dispose(); });

describe("RC-01 scratch containment (before any production composition is imported)", () => {
  it.each(["C:\\work\\ai-orchestration-review", "C:\\work\\pve-doc", "C:\\work\\ai-orchestration-config",
    "C:\\work\\autonomous-generic-text-fixture", "C:\\work\\bounded-review-live-fixture",
    "C:\\rc01-nonexistent-external-root"])(
    "refuses write, remove and generation at external root %s by path alone", (root) => {
      const scratch = allocate();
      for (const target of [root, `${root}\\CURRENT_REVIEW.json`, `${root}\\reviews\\rc01-synthetic`, `${root}\\rpc-jobs\\rc01-synthetic`]) {
        expect(() => scratch.write(target, "MUST NOT BE WRITTEN")).toThrow("SCRATCH_CONTAINMENT");
        expect(() => scratch.remove(target)).toThrow("SCRATCH_CONTAINMENT");
        expect(() => writeSyntheticReview(scratch, target)).toThrow("SCRATCH_CONTAINMENT");
        expect(() => writePolicyReview(scratch, "approval", target)).toThrow("SCRATCH_CONTAINMENT");
        for (const location of ["repo", "config", "review"]) {
          expect(() => writeCompletedTask(scratch, { [location]: target })).toThrow("SCRATCH_CONTAINMENT");
        }
      }
      expect(fs.readdirSync(scratch.root)).toEqual([]);
    });

  it("rejects traversal, siblings, allocation root, Windows aliases, ADS and device paths", () => {
    const scratch = allocate(), other = allocate();
    const targets = ["../escaped", "nested/../../escaped", "nested\\..\\escaped", scratch.root,
      other.root, `${scratch.root}-sibling/file`, "file:stream", "C:relative", "NUL", "nested/CON.txt",
      "trailing./file", "trailing /file", "\\\\?\\C:\\work\\ai-orchestration-review\\x", "\\\\server\\share\\x"];
    for (const target of targets) {
      expect(() => scratch.write(target, "blocked")).toThrow("SCRATCH_CONTAINMENT");
      expect(() => scratch.remove(target)).toThrow("SCRATCH_CONTAINMENT");
    }
    expect(fs.readdirSync(scratch.root)).toEqual([]);
    expect(fs.readdirSync(other.root)).toEqual([]);
  });

  it("rejects junction/symlink escapes, including recursive cleanup before any deletion", () => {
    const scratch = allocate(), outside = allocate();
    const sentinel = outside.write("sentinel", "unchanged");
    scratch.write("tree/keep", "unchanged");
    const link = scratch.resolve("tree/link");
    fs.symlinkSync(outside.root, link, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => scratch.write(path.join(link, "new-file"), "blocked")).toThrow("SCRATCH_CONTAINMENT");
      expect(() => scratch.remove("tree")).toThrow("SCRATCH_CONTAINMENT");
      expect(() => scratch.dispose()).toThrow("SCRATCH_CONTAINMENT");
      expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
      expect(fs.readFileSync(path.join(scratch.root, "tree/keep"), "utf8")).toBe("unchanged");
      expect(fs.readdirSync(outside.root)).toEqual(["sentinel"]);
    } finally { fs.unlinkSync(link); } // Remove only the test-created link, never its target.
  });

  it("never overwrites hard links", () => {
    const scratch = allocate(), outside = allocate();
    const sentinel = outside.write("sentinel", "unchanged");
    const link = scratch.resolve("hard-link");
    fs.linkSync(sentinel, link);
    try {
      expect(() => scratch.write("hard-link", "blocked")).toThrow();
      expect(() => scratch.remove("hard-link")).toThrow("SCRATCH_CONTAINMENT");
      expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
    } finally { fs.unlinkSync(link); }
  });

  it("requires a minted dependency object and rejects use after disposal", () => {
    const scratch = allocate();
    expect(() => writeSyntheticReview({ ...scratch })).toThrow("SCRATCH_CONTAINMENT");
    expect(() => writePolicyReview({ ...scratch }, "approval")).toThrow("SCRATCH_CONTAINMENT");
    expect(() => writeCompletedTask({ ...scratch })).toThrow("SCRATCH_CONTAINMENT");
    expect(Object.isFrozen(scratch)).toBe(true);
    scratch.dispose();
    expect(() => scratch.write("after-disposal", "blocked")).toThrow("SCRATCH_CONTAINMENT");
    expect(fs.existsSync(scratch.root)).toBe(false);
  });

  it("writes and removes only its own allocation", () => {
    const scratch = allocate();
    const file = scratch.write("nested/evidence.md", "synthetic\n");
    expect(fs.readFileSync(file, "utf8")).toBe("synthetic\n");
    scratch.remove("nested");
    expect(fs.readdirSync(scratch.root)).toEqual([]);
  });
});
