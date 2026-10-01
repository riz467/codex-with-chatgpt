import type { TrustedContextStore } from "./trusted-context-storage.js";
export type { AuthorityIngestorHost, AuthorityLookup } from "./authority-ingestor-validation.js";

/** Pass this narrow capability to an in-process caller, never the host/store.
 * The host installs dependencies when constructing TrustedContextStore. */
export function createTrustedAuthorityIngestor(store: TrustedContextStore) {
  return Object.freeze({
    adoptIndependentReview: (input: unknown) => store.adoptIndependentReview(input),
    registerHumanApproval: (input: unknown) => store.registerHumanApproval(input),
  });
}
