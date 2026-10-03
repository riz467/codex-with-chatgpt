import { canonicalJson } from "../../task-contract/contract.js";
import { hashRecord, parseBinding, reviewSchema } from "./contract.js";
import { advanceStore, commitStore, currentStore, inspectMutatedCandidate, sha256, type MutatedCandidate } from "./candidate-mutation.js";
import { assertReviewCandidate, inspectReviewContext, prepareReviewContext } from "./review-context.js";
import { dispatchAdvisoryReview } from "./opencode-transport.js";
import type { RequestInputHandle } from "./request-input.js";

/** PASS is local eligibility only. REVIEW_PENDING durably fences dispatch even
 * across process loss; there is deliberately no resume/retry API. */
export async function runAdvisoryReview(mutation: MutatedCandidate, human: RequestInputHandle) {
  const context = prepareReviewContext(mutation, human), prompt = inspectReviewContext(context);
  const { store } = inspectMutatedCandidate(mutation), b = prompt.binding;
  advanceStore(store, b, "REVIEW_PENDING", "CONFIRMED");
  try {
    const result = await dispatchAdvisoryReview(context);
    if (result.result !== "REVIEW_RECEIVED") throw new Error("REVIEW_TRANSPORT_FAILED");
    assertReviewCandidate(mutation, b);
    const s = currentStore(store).state;
    if (s.state !== "REVIEW_PENDING" || canonicalJson(s.binding) !== canonicalJson(b)) throw new Error("REVIEW_STATE_CHANGED");
    const bytes = Buffer.from(canonicalJson(result.findings));
    commitStore(store, b, { operation: "ARTIFACT", artifactId: `dev2-artifact-findings-${b.attempt.digest}`, contentBase64: bytes.toString("base64") });
    const record = reviewSchema.parse({ domain: "RC02_DEVELOPMENT_V2_ADVISORY_REVIEW", id: b.attempt.advisoryReviewId,
      attemptDigest: b.attempt.digest, manifestDigest: b.manifest!.digest, fastDigest: b.fast!.digest,
      result: result.findings.result, findingsDigest: sha256(bytes), digest: "0".repeat(64) });
    const binding = parseBinding({ ...b, review: { ...record, digest: hashRecord(record) } });
    commitStore(store, binding, { operation: "REVIEW_ARTIFACT" });
    assertReviewCandidate(mutation, b);
    commitStore(store, binding, { operation: "COMMIT_REVIEW" });
    if (binding.review!.result === "PASS") advanceStore(store, binding, "MATERIALIZATION_ELIGIBLE", "CONFIRMED");
    return Object.freeze({ result: binding.review!.result, state: currentStore(store).state.state, model: result.model });
  } catch {
    try { advanceStore(store, currentStore(store).state.binding, "RECONCILE_REQUIRED", "UNKNOWN"); } catch { /* pending state fences redispatch */ }
    return Object.freeze({ result: "RECONCILE_REQUIRED" as const });
  }
}
