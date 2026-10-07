import { z } from "zod";
import { parsePresentation, sameRequest, type TrustedTypedActionPresentation } from "../approver-service/presentation.js";
import { idSchema, sha256Schema, parseStrict, signedTypedActionApprovalSchema } from "../typed-action-approval/contract.js";
import type { TrustedContextStore } from "./trusted-context-storage.js";
export type { AuthorityIngestorHost, AuthorityLookup } from "./authority-ingestor-validation.js";

export interface TrustedPresentationPeer {
  registerPresentation(input: TrustedTypedActionPresentation): unknown;
  status(id: string): unknown;
  evidence(id: string): unknown;
}

const receiptSchema = z.object({ approvalRequestId: idSchema, presentationHash: sha256Schema }).strict();
const statusSchema = z.object({ approvalRequestId: idSchema, presentationHash: sha256Schema,
  state: z.enum(["CURRENT", "STALE", "SUPERSEDED"]), approvalState: z.enum(["PENDING", "APPROVED"]),
  current: z.boolean() }).strict();

type BaseIngestor = Readonly<{
  adoptIndependentReview: (input: unknown) => ReturnType<TrustedContextStore["adoptIndependentReview"]>;
  registerHumanApproval: (input: unknown) => ReturnType<TrustedContextStore["registerHumanApproval"]>;
}>;
type PeerIngestor = BaseIngestor & Readonly<{
  registerTrustedPresentation: (input: unknown) => unknown;
  collectApprovedHumanApproval: (input: unknown) => ReturnType<TrustedContextStore["registerHumanApproval"]>;
}>;

/** Pass this narrow capability to an in-process caller, never the host/store.
 * The host installs dependencies when constructing TrustedContextStore. */
export function createTrustedAuthorityIngestor(store: TrustedContextStore): BaseIngestor;
export function createTrustedAuthorityIngestor(store: TrustedContextStore, peer: TrustedPresentationPeer): PeerIngestor;
export function createTrustedAuthorityIngestor(store: TrustedContextStore, peer?: TrustedPresentationPeer) {
  const base = {
    adoptIndependentReview: (input: unknown) => store.adoptIndependentReview(input),
    registerHumanApproval: (input: unknown) => store.registerHumanApproval(input),
  };
  if (!peer) return Object.freeze(base);
  const registerPresentation = peer.registerPresentation.bind(peer);
  const status = peer.status.bind(peer);
  const evidenceFor = peer.evidence.bind(peer);
  return Object.freeze({
    ...base,
    registerTrustedPresentation: (input: unknown) => {
      const presentation = parsePresentation(input);
      const receipt = parseStrict(receiptSchema, registerPresentation(presentation));
      if (receipt.approvalRequestId !== presentation.request.approvalRequestId ||
          receipt.presentationHash !== presentation.presentationHash) throw new Error("Presentation receipt mismatch");
      return receipt;
    },
    collectApprovedHumanApproval: (input: unknown) => {
      const presentation = parsePresentation(input);
      const approvalStatus = parseStrict(statusSchema, status(presentation.request.approvalRequestId));
      if (approvalStatus.approvalRequestId !== presentation.request.approvalRequestId ||
          approvalStatus.presentationHash !== presentation.presentationHash ||
          approvalStatus.state !== "CURRENT" || approvalStatus.approvalState !== "APPROVED" ||
          approvalStatus.current !== true) throw new Error("Presentation is not currently approved");
      const evidence = parseStrict(signedTypedActionApprovalSchema, evidenceFor(presentation.request.approvalRequestId));
      if (!sameRequest(evidence.payload, presentation.request)) throw new Error("Approval request mismatch");
      const { actionId, targetId, requestHash, attemptId, attemptHash } = presentation.request;
      return store.registerHumanApproval({ identity: { actionId, targetId, requestHash, attemptId, attemptHash }, evidence });
    },
  });
}
