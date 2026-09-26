// Review-side allowlist. A caller supplies a repo key, never a path or profile name.
import { fixtureDocumentPolicy } from "./review-profiles/fixture-document-policy.js";
import { timeoutBehavior } from "./review-profiles/timeout-behavior.js";
export type ReviewProfile = {
  workspace: string;
  profile: "generic-text-change" | "generic-code-change" | "fixture-document-policy" | "missing-evidence-fixture";
  allowedPath: RegExp;
  maxChangedFiles: number;
  requiredEvidence: readonly string[];
  acceptedTestKinds?: readonly string[];
  semanticRequiresBehavior?: boolean;
  semanticReview?: boolean;
  behaviorTestKinds?: readonly string[];
  behaviorCheck?: (goal: string, test: Record<string, unknown>) => { reason_category: string; unresolved_issues: string[] } | null;
  policyCheck?: (edits: unknown[], diff: string) => boolean;
};
const base = ["manifest.json", "status.json", "audit/review-seal.json", "verification.md", "plan.md", "research.md",
  "decisions.md", "execution.md", "source-git-diff.patch", "source-git-status.txt", "audit/coordinator-actions.jsonl"] as const;
export const reviewProfiles: Readonly<Record<string, ReviewProfile>> = Object.freeze({
  "autonomous-review-verified-fixture": {
    workspace: "C:\\work\\autonomous-review-verified-fixture", profile: "fixture-document-policy", allowedPath: /^docs\/document-map\.md$/,
    maxChangedFiles: 1, requiredEvidence: base, policyCheck: fixtureDocumentPolicy,
  },
  "autonomous-review-negative-fixture": {
    workspace: "C:\\work\\autonomous-review-negative-fixture", profile: "fixture-document-policy", allowedPath: /^docs\/document-map\.md$/,
    maxChangedFiles: 1, requiredEvidence: base, policyCheck: fixtureDocumentPolicy,
  },
  "autonomous-generic-text-fixture": {
    workspace: "C:\\work\\autonomous-generic-text-fixture", profile: "generic-text-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.md$/,
    maxChangedFiles: 1, requiredEvidence: base,
  },
  "autonomous-generic-code-fixture": {
    workspace: "C:\\work\\autonomous-generic-code-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.(?:ts|js|ps1)$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["powershell-parse"],
  },
  "autonomous-generic-missing-fixture": {
    workspace: "C:\\work\\autonomous-generic-missing-fixture", profile: "missing-evidence-fixture", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.md$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/required-review-test-evidence.json"],
  },
  "autonomous-generic-timeout-fixture": {
    workspace: "C:\\work\\autonomous-generic-timeout-fixture", profile: "generic-text-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.md$/,
    maxChangedFiles: 1, requiredEvidence: base,
  },
  "autonomous-semantic-pass-fixture": {
    workspace: "C:\\work\\autonomous-semantic-pass-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true, behaviorTestKinds: ["git-timeout-mock"], behaviorCheck: timeoutBehavior,
  },
  "autonomous-semantic-confirmed-fixture": {
    workspace: "C:\\work\\autonomous-semantic-confirmed-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-semantic-wrong-fixture": {
    workspace: "C:\\work\\autonomous-semantic-wrong-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-semantic-insufficient-fixture": {
    workspace: "C:\\work\\autonomous-semantic-insufficient-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["typescript-parse"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-semantic-success-fixture": {
    workspace: "C:\\work\\autonomous-semantic-success-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-semantic-accepted-fixture": {
    workspace: "C:\\work\\autonomous-semantic-accepted-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-semantic-mismatch-fixture": {
    workspace: "C:\\work\\autonomous-semantic-mismatch-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-semantic-no-behavior-fixture": {
    workspace: "C:\\work\\autonomous-semantic-no-behavior-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["typescript-parse"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-campaign-success-fixture": {
    workspace: "C:\\work\\autonomous-campaign-success-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-campaign-recovered-fixture": {
    workspace: "C:\\work\\autonomous-campaign-recovered-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-campaign-gateway-fixture": {
    workspace: "C:\\work\\autonomous-campaign-gateway-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-campaign-wrong-fixture": {
    workspace: "C:\\work\\autonomous-campaign-wrong-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-campaign-wrong-review-fixture": {
    workspace: "C:\\work\\autonomous-campaign-wrong-review-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-campaign-human-fixture": {
    workspace: "C:\\work\\autonomous-campaign-human-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-consolidation-success-fixture": {
    workspace: "C:\\work\\autonomous-consolidation-success-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-consolidation-success2-fixture": {
    workspace: "C:\\work\\autonomous-consolidation-success2-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-consolidation-wrong-fixture": {
    workspace: "C:\\work\\autonomous-consolidation-wrong-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true, semanticReview: true,
  },
  "autonomous-consolidation-timeout-fixture": {
    workspace: "C:\\work\\autonomous-consolidation-timeout-fixture", profile: "generic-code-change", allowedPath: /^(?:[\w.-]+\/)*[\w.-]+\.ts$/,
    maxChangedFiles: 1, requiredEvidence: [...base, "audit/autonomous-tests.json"], acceptedTestKinds: ["git-timeout-mock"], semanticRequiresBehavior: true,
  },
});

export function getReviewProfile(repoKey: string): ReviewProfile {
  if (!Object.hasOwn(reviewProfiles, repoKey)) throw new Error("UNKNOWN_REVIEW_PROFILE");
  const profile = reviewProfiles[repoKey];
  // Keep the fixture's behavioral rule in this trusted profile module, not in
  // generic Review/controller logic. Profiles without a behavioral rule fail closed.
  return profile.semanticRequiresBehavior && profile.acceptedTestKinds?.includes("git-timeout-mock") ?
    { ...profile, behaviorTestKinds: ["git-timeout-mock"], behaviorCheck: timeoutBehavior } : profile;
}
export const reviewWorkspaces = Object.values(reviewProfiles).map((p) => p.workspace);
