import { canonicalJson } from "../task-contract/contract.js";
import { hashRecord, parseBinding, reviewSchema } from "../execution-orchestrator/development/contract.js";
import { DevelopmentStore, type StoreAnchor } from "../execution-orchestrator/development/store.js";
import { assertIdleStore, assertMutationCurrent, commitStore, currentStore, advanceStore,
  inspectMutatedCandidate, mutateCandidate, sha256, type MutatedCandidate } from "../execution-orchestrator/development/candidate-mutation.js";
import type { CandidateRepository } from "../execution-orchestrator/development/candidate-repo.js";
import type { RequestInputHandle } from "../execution-orchestrator/development/request-input.js";
import { prepareProposalInput } from "../execution-orchestrator/development/proposal-input.js";
import { parseProposal } from "../execution-orchestrator/development/proposal.js";
import { sealFastEvidence, type FastEvidence } from "../execution-orchestrator/development/fast-evidence.js";
import { assertReviewCandidate, assertReviewDispatchCurrent, inspectReviewContext, prepareReviewContext,
  type ReviewContext } from "../execution-orchestrator/development/review-context.js";
import { parseFindings } from "../execution-orchestrator/development/review-evidence.js";
import type { dispatchProposal, dispatchAdvisoryReview } from "../execution-orchestrator/development/opencode-transport.js";

const boundary = Object.freeze({ authority: "NONE" as const, productionDispatch: "CLOSED" as const,
  mode: "OFFLINE_INJECTED_CAPABILITIES_NOT_NATIVE_E2E" as const, replay: false as const });
const fail = () => new Error("LINUX_TASK_STOP_NO_REPLAY");

/** No implemented authenticated Linux host adapter exists. No input flag or injected
 * capability can open this production entry; not even host credential readers run. */
export function runLinuxDevelopmentTask(_input?: unknown) {
  return Object.freeze({ ...boundary, mode: "PRODUCTION_HOST_ADAPTER_CLOSED" as const,
    result: "HOST_ADAPTER_CLOSED" as const, provider: "NOT_RUN" as const });
}

/** Test composition only, NOT an OS sandbox or a capability issuer. Transport types
 * are exactly the existing development adapters. The trusted test host supplies
 * public, secret-filtered results and synthetic FAST evidence, never caller knobs. */
export interface OfflineTaskCapabilities {
  propose: typeof dispatchProposal;
  review: typeof dispatchAdvisoryReview;
  fastEvidence: (mutation: MutatedCandidate) => Promise<FastEvidence>;
}
export interface OfflineTaskHost {
  store: DevelopmentStore;
  binding: unknown;
  candidate: CandidateRepository;
  inputHandle: RequestInputHandle;
}
function exactData(input: unknown, keys: readonly string[]) {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) throw fail();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k))) throw fail();
  const copy: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(input, k)!;
    if (!d.enumerable || !("value" in d)) throw fail();
    copy[k] = d.value;
  }
  return copy;
}
async function settled<T>(call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Timeout does not cancel, kill or replay the underlying operation. Late
    // results/rejections are consumed but cannot continue the orchestration.
    return await Promise.race([Promise.resolve().then(call), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fail()), 45_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function artifact(store: DevelopmentStore, name: string, body: unknown) {
  const b = currentStore(store).state.binding;
  return commitStore(store, b, { operation: "ARTIFACT", artifactId: `dev2-artifact-linux-task-${name}`,
    contentBase64: Buffer.from(canonicalJson(body)).toString("base64") });
}
function status(store: DevelopmentStore) {
  const r = currentStore(store), s = r.state;
  const terminal = s.artifacts.find(a => a.id === "dev2-artifact-linux-task-result");
  const value = terminal ? JSON.parse(Buffer.from(s.blobs[terminal.sha256], "base64").toString("utf8")) : undefined;
  const result: "UNKNOWN_NO_REPLAY" | "ADVISORY_PASS_ONLY" | "NEEDS_WORK" = r.disposition === "RECONCILE_REQUIRED" || r.writerFenced ? "UNKNOWN_NO_REPLAY" :
    value?.result === "ADVISORY_PASS_ONLY" || value?.result === "NEEDS_WORK" ? value.result : "UNKNOWN_NO_REPLAY";
  // No prompt, source bytes, findings text, exception body or credential data in public status.
  return Object.freeze({ ...boundary, result, storageState: s.state, requestDigest: s.binding.request.digest,
    attemptDigest: s.binding.attempt.digest, manifestDigest: s.binding.manifest?.digest ?? null,
    reviewDigest: s.binding.review?.digest ?? null,
    evidence: s.artifacts.map(a => Object.freeze({ id: a.id, sha256: a.sha256, bindingDigest: a.bindingDigest })) });
}

/** Read-only reopen using an independently retained host anchor. No dispatch/resume. */
export function readLinuxDevelopmentTask(root: string, hostAnchor: StoreAnchor) {
  try { return status(DevelopmentStore.open(root, hostAnchor)); } catch { throw fail(); }
}

/** Explicit offline host entry. Host objects/callbacks are captured once and not
 * accepted from task callers. Genuine existing opaque handles are required.
 * Ready candidate/store provisioning and anchor retention remain host duties. */
export function createOfflineLinuxDevelopmentTask(hostInput: OfflineTaskHost, hostExpected: unknown,
  capabilities: OfflineTaskCapabilities) {
  try {
    const host = exactData(hostInput, ["store", "binding", "candidate", "inputHandle"]) as unknown as OfflineTaskHost;
    const caps = exactData(capabilities, ["propose", "review", "fastEvidence"]) as unknown as OfflineTaskCapabilities;
    if ([caps.propose, caps.review, caps.fastEvidence].some(f => typeof f !== "function")) throw fail();
    const b = assertIdleStore(host.store, host.binding, hostExpected, "CANDIDATE_READY");
    const expected = parseBinding(hostExpected);
    const proposalInput = Object.freeze({ binding: b, inputHandle: host.inputHandle, candidate: host.candidate });
    prepareProposalInput(proposalInput, expected); // authenticates handles before task acceptance
    let used = false;
    return Object.freeze({
      readStatus: () => { try { return status(host.store); } catch { throw fail(); } },
      async run() {
        if (used) throw fail();
        used = true; // synchronous process fence; journal fences process loss
        // A stale second handle is rejected without rewriting another run's evidence.
        try { assertIdleStore(host.store, b, expected, "CANDIDATE_READY"); } catch { throw fail(); }
        try {
          artifact(host.store, "accepted", { ...boundary, requestDigest: b.request.digest, attemptDigest: b.attempt.digest });
          commitStore(host.store, b, { operation: "RESERVE", kind: "DISPATCH" });
          commitStore(host.store, b, { operation: "ADVANCE", to: "WORKER_DISPATCH_IN_PROGRESS",
            candidateOutcome: "NOT_STARTED", canonicalOutcome: "NOT_STARTED" });
          artifact(host.store, "proposal-intent", { ...boundary, settlement: "UNKNOWN_UNTIL_RECEIPT" });
          const proposalResult = await settled(() => caps.propose(proposalInput, expected));
          if (proposalResult.result !== "PROPOSAL_RECEIVED" ||
            !/^ses_[A-Za-z0-9]+$/.test(proposalResult.evidence.nativeSessionId)) throw fail();
          const proposal = parseProposal(canonicalJson(proposalResult.proposal), b, expected);
          artifact(host.store, "proposal", { proposalDigest: proposal.proposalDigest,
            sessionId: proposalResult.evidence.nativeSessionId, ...boundary });
          commitStore(host.store, b, { operation: "ADVANCE", to: "PROPOSAL_FIXED",
            candidateOutcome: "NOT_STARTED", canonicalOutcome: "NOT_STARTED" });
          DevelopmentStore.prototype.completeRelease.call(host.store, "DISPATCH");
          const mutation = mutateCandidate({ store: host.store, candidate: host.candidate, binding: b,
            proposal: canonicalJson(proposal) }, expected);
          const data = inspectMutatedCandidate(mutation), manifestBinding = data.binding;
          commitStore(host.store, manifestBinding, { operation: "RESERVE", kind: "FAST" });
          artifact(host.store, "fast-intent", { ...boundary, settlement: "UNKNOWN_UNTIL_RECEIPT", candidateCode: "NOT_EXECUTED_BY_TASK" });
          const sealed = sealFastEvidence(manifestBinding, await settled(() => caps.fastEvidence(mutation)));
          assertMutationCurrent(data);
          if (sealed.evidence.candidatePostSnapshotDigest !== sha256(canonicalJson(data.candidateTree))) throw fail();
          commitStore(host.store, manifestBinding, { operation: "ARTIFACT", artifactId: sealed.artifactId, contentBase64: sealed.contentBase64 });
          advanceStore(host.store, parseBinding({ ...manifestBinding, fast: sealed.fast }), "FAST_EVIDENCE_FIXED", "CONFIRMED");
          DevelopmentStore.prototype.completeRelease.call(host.store, "FAST");
          const context: ReviewContext = prepareReviewContext(mutation, host.inputHandle), prompt = inspectReviewContext(context);
          advanceStore(host.store, prompt.binding, "REVIEW_PENDING", "CONFIRMED");
          artifact(host.store, "review-intent", { ...boundary, contextDigest: prompt.digest, settlement: "UNKNOWN_UNTIL_RECEIPT" });
          assertReviewDispatchCurrent(context);
          const reviewResult = await settled(() => caps.review(context));
          assertReviewDispatchCurrent(context);
          if (reviewResult.result !== "REVIEW_RECEIVED" || !/^ses_[A-Za-z0-9]+$/.test(reviewResult.nativeSessionId) ||
            reviewResult.nativeSessionId === proposalResult.evidence.nativeSessionId) throw fail();
          const findings = parseFindings(canonicalJson(reviewResult.findings), prompt.binding, prompt.digest);
          const bytes = Buffer.from(canonicalJson(findings));
          commitStore(host.store, prompt.binding, { operation: "ARTIFACT", artifactId: `dev2-artifact-findings-${b.attempt.digest}`,
            contentBase64: bytes.toString("base64") });
          const record = reviewSchema.parse({ domain: "RC02_DEVELOPMENT_V2_ADVISORY_REVIEW", id: b.attempt.advisoryReviewId,
            attemptDigest: b.attempt.digest, manifestDigest: prompt.binding.manifest!.digest, fastDigest: prompt.binding.fast!.digest,
            result: findings.result, findingsDigest: sha256(bytes), digest: "0".repeat(64) });
          const reviewed = parseBinding({ ...prompt.binding, review: { ...record, digest: hashRecord(record) } });
          commitStore(host.store, reviewed, { operation: "REVIEW_ARTIFACT" });
          assertReviewCandidate(mutation, prompt.binding);
          commitStore(host.store, reviewed, { operation: "COMMIT_REVIEW" });
          artifact(host.store, "review", { ...boundary, sessionId: reviewResult.nativeSessionId, contextDigest: prompt.digest });
          // Deliberately stop at advisory evidence; no materialization/Qualification/Human gates.
          artifact(host.store, "result", { ...boundary, result: findings.result === "PASS" ? "ADVISORY_PASS_ONLY" : "NEEDS_WORK" });
        } catch {
          // No raw upstream error/cause/logging. If storage is unsettled the existing
          // durable intent/reservation remains the fence; never release or replay it.
          try { advanceStore(host.store, currentStore(host.store).state.binding, "RECONCILE_REQUIRED", "UNKNOWN"); } catch { /* retain fence */ }
          try { artifact(host.store, "result", { ...boundary, result: "UNKNOWN_NO_REPLAY" }); } catch { /* retain fence */ }
        }
        try { return status(host.store); } catch { throw fail(); }
      },
    });
  } catch { throw fail(); }
}
