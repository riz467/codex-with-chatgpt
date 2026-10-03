import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/task-contract/contract.js";
import { hashRecord } from "../src/execution-orchestrator/development/contract.js";
import { DevelopmentStore } from "../src/execution-orchestrator/development/store.js";
import { fixCandidateFast, runCandidateE0 } from "../src/execution-orchestrator/development/candidate-fast.js";
import { inspectMutatedCandidate, mutateCandidate, sha256, snapshotTree, commitStore } from "../src/execution-orchestrator/development/candidate-mutation.js";
import * as sandbox from "../src/execution-orchestrator/development/fast-sandbox.js";
import { FAST_SANDBOX_PROFILE } from "../src/execution-orchestrator/development/fast-evidence.js";
import { cleanup, fixture } from "./rc02-development-e0-fixture.js";

afterEach(() => { vi.restoreAllMocks(); cleanup(); });
// Deliberate host-test seam: this does NOT claim Linux sandbox execution. Actual
// sandbox reservation and argv are checked independently in fast-sandbox tests.
function fixtureSandbox(outcome: "PASS" | "FAILED_KNOWN" | "UNKNOWN" = "PASS", after?: () => void) {
  return vi.spyOn(sandbox, "runFastSandbox").mockImplementation(handle => {
    const data = inspectMutatedCandidate(handle);
    commitStore(data.store, data.binding, { operation: "RESERVE", kind: "FAST" });
    after?.();
    if (outcome !== "PASS") return { outcome, reason: "fixture outcome" };
    return { outcome: "PASS", evidence: { domain: "RC02_DEVELOPMENT_V2_FAST_EVIDENCE_V1",
      attemptDigest: data.binding.attempt.digest, manifestDigest: data.binding.manifest!.digest,
      runtimeCapsuleDigest: "a".repeat(64), nodeExecutableDigest: "b".repeat(64), gitExecutableDigest: "c".repeat(64),
      nodeVersion: "v22.1.0", requestedProfile: "FAST", effectiveProfile: "FAST", result: "PASS", summaryDigest: "d".repeat(64),
      stdoutSha256: "e".repeat(64), stderrSha256: sha256(""), candidatePostSnapshotDigest: sha256(canonicalJson(data.candidateTree)),
      networkIsolation: "OS_NETWORK_NAMESPACE", sandboxProfile: FAST_SANDBOX_PROFILE, sandboxProfileDigest: "f".repeat(64),
      osResourceCgroupLimit: "NOT_ESTABLISHED" } };
  });
}
describe("E0 committed evidence sequencing (fixture, evidence only)", () => {
  it("Manifest before FAST reservation, artifact before FAST binding, exact immutable artifact hash", () => {
    const f = fixture(); f.ready(); const canonical = snapshotTree(f.canonical, false);
    const fake = fixtureSandbox();
    const result = runCandidateE0(f.input(), f.binding);
    expect(result.result).toBe("PASS");
    const r = f.store.recover();
    expect(r.state.state).toBe("FAST_EVIDENCE_FIXED");
    const fast = r.state.binding.fast!;
    expect(fast.digest).toBe(hashRecord(fast));
    const artifact = r.state.artifacts.find(a => a.id === `dev2-artifact-fast-${f.binding.attempt.digest}`)!;
    const bytes = Buffer.from(r.state.blobs[artifact.sha256], "base64");
    expect(sha256(bytes)).toBe(fast.evidenceDigest); expect(artifact.sha256).toBe(fast.evidenceDigest);
    expect(JSON.parse(bytes.toString()).runtimeCapsuleDigest).toBe("a".repeat(64));
    expect(JSON.parse(bytes.toString())).not.toHaveProperty("stdout");
    const firstManifest = r.receipts.findIndex(x => x.manifestDigest !== null);
    const artifactIndex = r.receipts.findIndex(x => x.operation === "ARTIFACT");
    expect(firstManifest).toBeLessThan(artifactIndex);
    expect(r.receipts[artifactIndex + 1].operation).toBe("ADVANCE");
    expect(r.state.reservations.every(x => x.status === "RELEASED")).toBe(true);
    expect(() => f.store.transact({ operation: "ARTIFACT", transactionId: "dev2-store-tx-tamper", expectedVersion: r.state.version,
      binding: r.state.binding, artifactId: artifact.id, contentBase64: Buffer.from("tamper").toString("base64") }, r.state.binding)).toThrow("IMMUTABLE_CONFLICT");
    expect(() => runCandidateE0(f.input(), f.binding)).toThrow(); expect(fake).toHaveBeenCalledTimes(1);
    expect(snapshotTree(f.canonical, false)).toEqual(canonical);
    expect(r.state.binding.review).toBeUndefined(); expect(r.state.binding.materialization).toBeUndefined();
  });
  it.each(["FAILED_KNOWN", "UNKNOWN"] as const)("%s closes the attempt without retry", outcome => {
    const f = fixture(); f.ready(); const fake = fixtureSandbox(outcome);
    const handle = mutateCandidate(f.input(), f.binding), b = inspectMutatedCandidate(handle).binding;
    expect(fixCandidateFast(handle, b).result).toBe(outcome);
    expect(f.store.recover().state.state).toBe(outcome === "UNKNOWN" ? "RECONCILE_REQUIRED" : "FAST_FAILED_KNOWN");
    expect(f.store.recover().state.binding.fast).toBeUndefined();
    expect(() => fixCandidateFast(handle, b)).toThrow();
    // Mock is entered again, but store refuses a second reservation before execution.
    expect(fake).toHaveBeenCalledTimes(2);
  });
  it("candidate drift cannot be downgraded to known verification failure or PASS", () => {
    const f = fixture(); f.ready(); fixtureSandbox("PASS", () => fs.writeFileSync(path.join(f.candidate.root, "keep.txt"), "drift"));
    expect(() => runCandidateE0(f.input(), f.binding)).toThrow("RECONCILE_REQUIRED");
    expect(f.store.recover().state.state).toBe("RECONCILE_REQUIRED");
    expect(f.store.recover().state.binding.fast).toBeUndefined();
  });
  it("artifact persistence failure never introduces FAST", () => {
    const f = fixture(); f.ready(); fixtureSandbox(); const transact = DevelopmentStore.prototype.transact;
    vi.spyOn(DevelopmentStore.prototype, "transact").mockImplementation(function (command: any, expected) {
      if (command.operation === "ARTIFACT") throw new Error("disk failed");
      return transact.call(this, command, expected);
    });
    expect(() => runCandidateE0(f.input(), f.binding)).toThrow("RECONCILE_REQUIRED");
    expect(f.store.recover().state.binding.fast).toBeUndefined();
    expect(f.store.recover().state.state).toBe("RECONCILE_REQUIRED");
  });
});
