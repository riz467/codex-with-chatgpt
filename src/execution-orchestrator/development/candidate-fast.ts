import { validateBinding } from "./contract.js";
import { DevelopmentStore } from "./store.js";
import { advanceStore, assertMutationCurrent, commitStore, inspectMutatedCandidate, mutateCandidate,
  type MutatedCandidate } from "./candidate-mutation.js";
import { runFastSandbox } from "./fast-sandbox.js";
import { sealFastEvidence } from "./fast-evidence.js";

/** Manifest is already durably bound. PASS is evidence only, never authorization. */
export function fixCandidateFast(handle: MutatedCandidate, hostExpected: unknown) {
  const data = inspectMutatedCandidate(handle);
  const result = runFastSandbox(handle, hostExpected);
  if (result.outcome !== "PASS") {
    try {
      advanceStore(data.store, data.binding, result.outcome === "UNKNOWN" ? "RECONCILE_REQUIRED" : "FAST_FAILED_KNOWN",
        result.outcome === "UNKNOWN" ? "UNKNOWN" : "CONFIRMED");
      if (result.outcome === "FAILED_KNOWN") DevelopmentStore.prototype.completeRelease.call(data.store, "FAST");
    } catch { throw new Error("DL2_E0_RECONCILE_REQUIRED"); }
    return Object.freeze({ result: result.outcome, reason: result.reason });
  }
  try {
    assertMutationCurrent(data);
    const sealed = sealFastEvidence(data.binding, result.evidence);
    commitStore(data.store, data.binding, { operation: "ARTIFACT", artifactId: sealed.artifactId, contentBase64: sealed.contentBase64 });
    const binding = validateBinding({ ...data.binding, fast: sealed.fast }, { ...data.binding, fast: sealed.fast }).binding;
    assertMutationCurrent(data);
    advanceStore(data.store, binding, "FAST_EVIDENCE_FIXED", "CONFIRMED");
    DevelopmentStore.prototype.completeRelease.call(data.store, "FAST");
    return Object.freeze({ result: "PASS" as const, binding, evidence: sealed.evidence, artifactId: sealed.artifactId });
  } catch (error) {
    try { advanceStore(data.store, data.binding, "RECONCILE_REQUIRED", "UNKNOWN"); } catch { /* durable fence or held FAST reservation */ }
    throw new Error("DL2_E0_RECONCILE_REQUIRED", { cause: error });
  }
}

export function runCandidateE0(input: Parameters<typeof mutateCandidate>[0], hostExpected: unknown) {
  const handle = mutateCandidate(input, hostExpected);
  return fixCandidateFast(handle, inspectMutatedCandidate(handle).binding);
}
