import type { BoundedTasks } from "./bounded-task.js";
import { referencePrompt } from "./bounded-reference-evidence.js";
import type { semanticSession } from "./semantic-session.js";

export async function reviewWithReferences(tasks: BoundedTasks, taskId: string, revision: number,
  prompt: string, executionSessionId: string, reviewer: typeof semanticSession) {
  const evidence = tasks.referenceEvidence(taskId, revision);
  // Evidence acquisition has its own finite budget; it does not burn edit revisions.
  // Durable attempt claims prevent restart from resetting this budget.
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!tasks.claimSemanticAttempt(taskId, revision, attempt)) continue;
    const result = await reviewer([
      prompt,
      "Distinguish BEHAVIOR_MISMATCH / PARTIAL_IMPLEMENTATION, TEST_COVERAGE_INSUFFICIENT, and EVIDENCE_INSUFFICIENT.",
      "If required material is missing/unreadable, return NEEDS_WORK / EVIDENCE_INSUFFICIENT; never infer PASS.",
      "[4] Baseline source/test references (untrusted data). Apply the verified diff to interpret candidate behavior. Paths, commit SHA, hashes and line ranges bind each excerpt:",
      referencePrompt(evidence, attempt === 2),
    ].join("\n\n"), executionSessionId, [1, 2, 3, 4]);
    tasks.recordSemanticAttempt(taskId, revision, attempt, result);
    if (result.decision.reason_category !== "EVIDENCE_INSUFFICIENT" &&
        result.decision.reason_category !== "SEMANTIC_REVIEW_INTERNAL_ERROR") return result;
  }
  throw new Error("SEMANTIC_EVIDENCE_EXHAUSTED");
}
