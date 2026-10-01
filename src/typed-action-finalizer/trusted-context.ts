import { AsyncLocalStorage } from "node:async_hooks";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { actionBindingFields, bindingsMatch, canonicalJson, hashTypedActionApproval, idSchema, immutable, jtiSchema,
  parseStrict, sha256Schema, trustedTypedActionApprovalContextSchema } from "../typed-action-approval/contract.js";
import { verifyTypedActionApproval, withinWindow, validTimeRange } from "../typed-action-approval/verifier.js";
import { trustedExecutionContextSchema, trustedIndependentReviewSchema, trustedPolicyContextSchema } from "./contract.js";
import type { ContextIdentity, TrustedContextProvider } from "./server.js";
import { TrustedContextStore } from "./trusted-context-storage.js";

const identitySchema = z.object({
  actionId: idSchema, targetId: idSchema, requestHash: sha256Schema, attemptId: idSchema,
  attemptHash: sha256Schema, approvalRequestId: idSchema.optional(), humanApprovalJti: jtiSchema,
  humanApprovalEvidenceHash: sha256Schema,
}).strict();
function requireAuthority(condition: unknown): asserts condition {
  if (!condition) throw new Error("Trusted authority binding rejected");
}

/** Production-oriented core, deliberately not wired into production config.
 * Identity is only a lookup/binding constraint; no authority comes from HTTP or
 * a permit. CT702, request, policy, target and signed Human registration are
 * independent persisted records adopted by the host-installed ingestor (or
 * explicitly seeded through the test/bootstrap seam). */
export function createTrustedContextProvider(host: {
  store: TrustedContextStore; trustedHumanKeys: ReadonlyMap<string, KeyObject>; now?: () => number;
}): TrustedContextProvider {
  const scope = new AsyncLocalStorage<{ identity: ContextIdentity; open: boolean; lastTime: number }>();
  const now = host.now ?? Date.now;
  const keys = new Map(host.trustedHumanKeys);
  function contexts(rawIdentity: ContextIdentity) {
    const identity = parseStrict(identitySchema, rawIdentity), fence = scope.getStore();
    requireAuthority(fence?.open && canonicalJson(identity) === canonicalJson(fence.identity));
    host.store.assertFence();
    const clock = now();
    requireAuthority(Number.isSafeInteger(clock) && clock >= 0 && clock >= fence.lastTime);
    fence.lastTime = clock;
    // Read every record on EVERY invocation, including both sides of consumption.
    const { request, review, policy, approval, generation } = host.store.snapshot(identity.attemptHash, identity.humanApprovalEvidenceHash);
    requireAuthority(request.actionId === identity.actionId && request.targetId === identity.targetId
      && request.requestHash === identity.requestHash && request.attemptId === identity.attemptId && request.attemptHash === identity.attemptHash
      && hashTypedActionApproval(approval) === identity.humanApprovalEvidenceHash
      && approval.payload.jti === identity.humanApprovalJti
      && (identity.approvalRequestId === undefined || identity.approvalRequestId === approval.payload.approvalRequestId));
    requireAuthority(bindingsMatch(request, review) && bindingsMatch(request, approval.payload)
      && review.result === "PASS" && review.evidenceIntegrityValid
      && policy.policySha256 === request.policySha256 && policy.targetId === request.targetId
      && policy.actionKind === request.actionKind && policy.actionAllowed
      && generation === request.targetGeneration && generation === review.targetGeneration && generation === policy.targetGeneration
      && policy.maintenanceWindowId === request.maintenanceWindowId);
    requireAuthority(validTimeRange(review.issuedAt, review.expiresAt, clock)
      && Date.parse(review.issuedAt) <= clock && Date.parse(approval.payload.issuedAt) <= clock
      && Date.parse(request.attemptCreatedAt) <= Date.parse(review.issuedAt)
      && Date.parse(review.issuedAt) <= Date.parse(approval.payload.issuedAt)
      && withinWindow(approval.payload.issuedAt, approval.payload.expiresAt,
        policy.maintenanceWindowStartsAt, policy.maintenanceWindowExpiresAt, clock));
    const binding = Object.fromEntries(actionBindingFields.map(field => [field, request[field]]));
    const humanContext = parseStrict(trustedTypedActionApprovalContextSchema, {
      ...binding, independentReviewResult: "PASS", reviewIsCurrent: true, requestIsCurrent: true, policyIsCurrent: true,
      maintenanceWindowValid: true, maintenanceWindowStartsAt: policy.maintenanceWindowStartsAt,
      maintenanceWindowExpiresAt: policy.maintenanceWindowExpiresAt,
    });
    requireAuthority(verifyTypedActionApproval(approval, humanContext, keys, clock).valid);
    return immutable({
      finalization: {
        humanContext,
        independentReview: parseStrict(trustedIndependentReviewSchema, { ...review, isCurrent: true }),
        policyContext: parseStrict(trustedPolicyContextSchema, { ...policy, isCurrent: true, requestIsCurrent: true }),
      },
      execution: parseStrict(trustedExecutionContextSchema, {
        ...humanContext, humanApprovalEvidenceHash: identity.humanApprovalEvidenceHash, humanApprovalJti: approval.payload.jti,
        humanApprovalIssuedAt: approval.payload.issuedAt, humanApprovalExpiresAt: approval.payload.expiresAt,
        independentReviewIssuedAt: review.issuedAt, independentReviewExpiresAt: review.expiresAt,
      }),
    });
  }
  return Object.freeze({
    async withFence<T>(rawIdentity: ContextIdentity, operation: () => Promise<T>): Promise<T> {
      const identity = immutable(parseStrict(identitySchema, rawIdentity));
      return host.store.withFence(async () => {
        const fence = { identity, open: true, lastTime: 0 };
        return scope.run(fence, async () => {
          try {
            const before = contexts(identity);
            const result = await operation();
            requireAuthority(canonicalJson(before) === canonicalJson(contexts(identity)));
            return result;
          } finally { fence.open = false; }
        });
      });
    },
    finalization(identity: ContextIdentity) { return contexts(identity).finalization; },
    execution(identity: ContextIdentity) { return contexts(identity).execution; },
  });
}
