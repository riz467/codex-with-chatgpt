import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashRecord } from "../src/execution-orchestrator/development/contract.js";
import { DevelopmentStore } from "../src/execution-orchestrator/development/store.js";
import { runAdvisoryReview } from "../src/execution-orchestrator/development/advisory-review.js";
import { inspectReviewContext } from "../src/execution-orchestrator/development/review-context.js";
import { materializeCanonicalFixture, verifyMaterializedReview, reachHumanCommitCheckpoint } from "../src/execution-orchestrator/development/canonical-materializer.js";
import { snapshotTree, sha256, safeComponents } from "../src/execution-orchestrator/development/candidate-mutation.js";
import * as transport from "../src/execution-orchestrator/development/opencode-transport.js";
import { cleanup, fixture } from "./rc02-development-e1-fixture.js";

afterEach(() => { vi.restoreAllMocks(); cleanup(); });
async function reviewed(result: "PASS" | "NEEDS_WORK" = "PASS") {
  const f = fixture();
  vi.spyOn(transport, "dispatchAdvisoryReview").mockImplementation(async handle => ({ result: "REVIEW_RECEIVED",
    findings: { ...JSON.parse(inspectReviewContext(handle).user).reviewIdentity, result, findings: [] }, nativeSessionId: "ses_fixture", model: "gpt-5.5" }));
  expect((await runAdvisoryReview(f.mutation, f.human)).result).toBe(result);
  return f;
}
describe("F fixture-only one-time materializer", () => {
  it("rejects absolute, traversal, Git, dependency, device and alias targets", () => {
    const f = fixture();
    for (const name of ["/absolute", "C:/escape", "../escape", ".git/HEAD", "node_modules/x", "CON.txt", "file.txt.", "a/../../x", "\\\\?\\C:\\escape"])
      expect(() => safeComponents(f.canonical.root, name), name).toThrow();
  });
  it("exact bytes, scope-only write, unchanged HEAD/index, bound REVIEW receipt and human checkpoint", async () => {
    const f = await reviewed(), before = snapshotTree(f.canonical.root, false);
    const truncate = fs.ftruncateSync, states: string[] = [];
    vi.spyOn(fs, "ftruncateSync").mockImplementation((fd, length) => {
      const s = f.store.recover().state; states.push(s.state);
      expect(s.consumedMaterialization).toBe(s.binding.attempt.materializationId);
      expect(s.reservations.find(r => r.kind === "CANONICAL")?.status).toBe("HELD"); truncate(fd, length);
    });
    const proof = materializeCanonicalFixture(f.canonical, f.mutation);
    expect(states).toEqual(["CANONICAL_MUTATION_IN_PROGRESS", "CANONICAL_MUTATION_IN_PROGRESS"]);
    let s = f.store.recover().state;
    expect(s.state).toBe("CANONICAL_MUTATION_CONFIRMED");
    expect(s.binding.materialization!.digest).toBe(hashRecord(s.binding.materialization));
    expect(s.binding.materialization!.advisoryReviewDigest).toBe(s.binding.review!.digest);
    for (const row of s.binding.manifest!.files) {
      const bytes = fs.readFileSync(path.join(f.canonical.root, row.path));
      expect(sha256(bytes)).toBe(row.after.sha256); expect(bytes).toEqual(fs.readFileSync(path.join(f.candidate.root, row.path)));
    }
    const after = snapshotTree(f.canonical.root, false);
    for (const name of Object.keys(before).filter(n => n.startsWith(".git") || ["keep.txt", "private.txt", "AGENTS.md"].includes(n)))
      expect(after[name]).toEqual(before[name]);
    expect(verifyMaterializedReview(proof).state).toBe("REVIEW_VERIFIED");
    s = f.store.recover().state; const r = s.binding.reviewReceipt!;
    expect(r.digest).toBe(hashRecord(r)); expect(r.materializationDigest).toBe(s.binding.materialization!.digest);
    const bytes = Buffer.from(s.blobs[r.evidenceDigest], "base64"); expect(sha256(bytes)).toBe(r.evidenceDigest);
    const evidence = JSON.parse(bytes.toString()); expect(evidence.canonicalScopeDigest).toBe(evidence.candidateScopeDigest);
    expect(evidence.advisoryReviewDigest).toBe(s.binding.review!.digest);
    expect(reachHumanCommitCheckpoint(proof)).toEqual({ state: "HUMAN_COMMIT_CHECKPOINT", kind: "LOCAL_LIFECYCLE_ONLY" });
    expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow();
    expect(() => verifyMaterializedReview(proof)).toThrow(); expect(() => reachHumanCommitCheckpoint(proof)).toThrow();
    expect(f.store.recover().state.consumedMaterialization).toBe(s.binding.attempt.materializationId);
  }, 90000);
  it("requires committed PASS and genuine exact fixture/candidate/store identities", async () => {
    const f = fixture(); expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow();
    const rejected = await reviewed("NEEDS_WORK"); expect(() => materializeCanonicalFixture(rejected.canonical, rejected.mutation)).toThrow();
    const pass = await reviewed();
    expect(() => materializeCanonicalFixture({ ...pass.canonical }, pass.mutation)).toThrow();
    expect(() => materializeCanonicalFixture(f.canonical, pass.mutation)).toThrow();
    expect(() => materializeCanonicalFixture(pass.canonical, { ...pass.mutation })).toThrow();
    expect(() => verifyMaterializedReview({ kind: "FIXTURE_MATERIALIZATION_CONFIRMED_ONLY" })).toThrow();
  });
  it.each(["HEAD", "scope", "index", "hardlink", "case", "junction"])("rejects %s drift/alias before any write", async mode => {
    const f = await reviewed();
    if (mode === "HEAD") fs.writeFileSync(path.join(f.canonical.root, ".git/HEAD"), "f".repeat(40) + "\n");
    if (mode === "scope") fs.writeFileSync(path.join(f.canonical.root, "file.txt"), "user edit");
    if (mode === "index") fs.appendFileSync(path.join(f.canonical.root, ".git/index"), "unexpected");
    if (mode === "hardlink") fs.linkSync(path.join(f.canonical.root, "file.txt"), path.join(f.canonical.root, "alias.txt"));
    if (mode === "case") fs.renameSync(path.join(f.canonical.root, "file.txt"), path.join(f.canonical.root, "FILE.txt"));
    if (mode === "junction") fs.symlinkSync(f.root, path.join(f.canonical.root, "nested"), process.platform === "win32" ? "junction" : "dir");
    const before = snapshotTree(f.canonical.root, false);
    expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow();
    expect(snapshotTree(f.canonical.root, false)).toEqual(before);
    expect(f.store.recover().state.consumedMaterialization).toBeNull();
  });
  it.each(["RESERVE", "CONSUME_MATERIALIZATION"])("%s failure causes zero canonical writes", async operation => {
    const f = await reviewed(), before = snapshotTree(f.canonical.root, false), original = DevelopmentStore.prototype.transact;
    vi.spyOn(DevelopmentStore.prototype, "transact").mockImplementation(function (c: any, expected) {
      if (c.operation === operation && (operation !== "RESERVE" || c.kind === "CANONICAL")) throw new Error("disk error");
      return original.call(this, c, expected);
    });
    expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow(); expect(snapshotTree(f.canonical.root, false)).toEqual(before);
  });
  it("partial write is UNKNOWN with consumed identity retained, never rollback or replay", async () => {
    const f = await reviewed(), write = fs.writeSync.bind(fs);
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Buffer, ...args: any[]) => {
      if (bytes.toString("utf8").includes("after\r\n")) { write(fd, bytes, 0, 2, 0); throw new Error("partial write"); }
      return (write as any)(fd, bytes, ...args);
    }) as typeof fs.writeSync);
    expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow("RECONCILE_REQUIRED"); vi.restoreAllMocks();
    expect(f.store.recover().state.state).toBe("RECONCILE_REQUIRED");
    expect(fs.readFileSync(path.join(f.canonical.root, "file.txt")).length).toBe(2);
    expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow();
  });
  it.each(["fsync", "outside"])("post-write %s uncertainty requires reconciliation", async mode => {
    const f = await reviewed(), truncate = fs.ftruncateSync, flush = fs.fsyncSync;
    let writtenFd: number | undefined;
    vi.spyOn(fs, "ftruncateSync").mockImplementation((fd, length) => {
      writtenFd = fd; truncate(fd, length);
      if (mode === "outside") fs.writeFileSync(path.join(f.canonical.root, "private.txt"), "concurrent user edit");
    });
    if (mode === "fsync") vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fd === writtenFd) { writtenFd = undefined; throw new Error("flush uncertain"); } flush(fd);
    });
    expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow("RECONCILE_REQUIRED"); vi.restoreAllMocks();
    expect(f.store.recover().state.state).toBe("RECONCILE_REQUIRED");
    expect(f.store.recover().state.consumedMaterialization).toBe(f.binding.attempt.materializationId);
    expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow();
  });
  it("lost consumption acknowledgement / crash is fenced on reopen without replay", async () => {
    const f = await reviewed(), before = snapshotTree(f.canonical.root, false), original = DevelopmentStore.prototype.transact;
    vi.spyOn(DevelopmentStore.prototype, "transact").mockImplementation(function (c: any, expected) {
      if (c.to === "RECONCILE_REQUIRED") throw new Error("process lost");
      const r = original.call(this, c, expected); if (c.operation === "CONSUME_MATERIALIZATION") throw new Error("process lost"); return r;
    });
    expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow(); vi.restoreAllMocks();
    const reopened = DevelopmentStore.open(f.storeRoot, f.store.recover().anchor).recover();
    expect(reopened.disposition).toBe("RECONCILE_REQUIRED"); expect(reopened.state.consumedMaterialization).toBe(f.binding.attempt.materializationId);
    expect(snapshotTree(f.canonical.root, false)).toEqual(before); expect(() => materializeCanonicalFixture(f.canonical, f.mutation)).toThrow();
  });
  it.each(["scope", "outside", "candidate"])("stale %s state invalidates REVIEW verification", async mode => {
    const f = await reviewed(), proof = materializeCanonicalFixture(f.canonical, f.mutation);
    fs.writeFileSync(path.join(mode === "candidate" ? f.candidate.root : f.canonical.root, mode === "outside" ? "private.txt" : "file.txt"), "drift");
    expect(() => verifyMaterializedReview(proof)).toThrow("RECONCILE_REQUIRED");
    expect(f.store.recover().state.binding.reviewReceipt).toBeUndefined();
  });
});
