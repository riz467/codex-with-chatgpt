import { z } from "zod";
import { checkpointSchema, id, sha, strict, utc, uuid, type Manifest, type Step } from "./contract.js";
import { digest } from "./hash.js";
import { assertTransition, states, terminal, type State, type StepState } from "./state-machine.js";

export const zeroHash = "0".repeat(64);
export const events = ["CAMPAIGN_PREPARED", "WAITING_HUMAN_AUTHORIZATION", "AUTHORIZATION_REGISTERED", "CAMPAIGN_AUTHORIZED",
  "STATE_ENTERED", "STEP_INTENT", "STEP_DISPATCHED", "STEP_OBSERVED", "STEP_VERIFIED", "HUMAN_CEREMONY_WAIT",
  "HUMAN_CEREMONY_RESUMED", "CAMPAIGN_BLOCKED", "RECONCILE_REQUIRED", "READY_FOR_PASSKEY_CUTOVER",
  "BOOTSTRAP_DISABLED_PENDING", "PASSKEY_ONLY", "COMPLETE"] as const;
export const reasons = ["CONTINUATION_AUTHORIZATION_REQUIRED", "MUTATION_UNCERTAIN", "CANCELLED", "EXPIRED",
  "CLOCK_ROLLBACK", "TIMEOUT", "PRECONDITION_MISMATCH", "VERIFICATION_MISMATCH", "CUTOVER_PENDING"] as const;
export const eventSchema = z.object({ schemaVersion: z.literal(1), sequence: z.number().int().safe().positive(),
  event: z.enum(events), campaignId: uuid, manifestSha256: sha, timestamp: utc, previousEventHash: sha, eventHash: sha,
  state: z.enum(states), stepId: id.nullable(), operationId: sha.nullable(), evidenceHashes: z.array(sha).max(8),
  details: z.object({ reason: z.enum(reasons).nullable(), receiptSha256: sha.nullable(),
    executionIdentity: uuid.nullable() }).strict() }).strict();
export type JournalEvent = z.infer<typeof eventSchema>;
export type Reason = typeof reasons[number];
export type StepProgress = { state: StepState; operationId: string | null; intentAt: string | null;
  receiptSha256: string | null; evidenceRoot: string | null };
export type Run = { manifest: Manifest; manifestSha256: string; state: State; reason: Reason | null;
  steps: Map<string, StepProgress>; waiting: string | null; authorized: boolean; activated: boolean;
  executionIdentity: string | null; checkpoint: z.infer<typeof checkpointSchema>;
  lastVerifiedCheckpoint: z.infer<typeof checkpointSchema>; mode: "BOOTSTRAP" | "BOOTSTRAP_DISABLED_PENDING" | "PASSKEY_ONLY" };
export function operationId(m: Manifest, step: Step): string {
  return digest("bootstrap-offline-operation-v1", { campaignId: m.campaignId, stepId: step.stepId });
}
export function eventHash(event: Omit<JournalEvent, "eventHash">): string { return digest("bootstrap-campaign-journal-v1", event); }
export function verifyChain(input: unknown[]): JournalEvent[] {
  let previous = zeroHash, timestamp = "", sequence = 0;
  return input.map(value => {
    const e = strict(eventSchema, value), { eventHash: hash, ...body } = e;
    if (e.sequence !== ++sequence || e.previousEventHash !== previous || eventHash(body) !== hash || e.timestamp < timestamp) throw new Error("Journal chain integrity");
    previous = hash; timestamp = e.timestamp; return e;
  });
}
export function reconstruct(m: Manifest, hash: string, all: JournalEvent[]): Run {
  const run: Run = { manifest: m, manifestSha256: hash, state: "PREPARED", reason: null, waiting: null,
    authorized: false, activated: false, executionIdentity: null, checkpoint: { sequence: 0, eventHash: zeroHash },
    lastVerifiedCheckpoint: m.continuation?.lastVerifiedCheckpoint ?? { sequence: 0, eventHash: zeroHash }, mode: "BOOTSTRAP",
    steps: new Map(m.steps.map(s => [s.stepId, { state: "NOT_STARTED", operationId: null, intentAt: null, receiptSha256: null, evidenceRoot: null }])) };
  for (const receipt of m.continuation?.verifiedReceipts ?? []) {
    const step = run.steps.get(receipt.stepId); if (!step) throw new Error("Continuation step missing");
    Object.assign(step, { state: "VERIFIED", receiptSha256: receipt.receiptSha256, evidenceRoot: receipt.evidenceRoot });
  }
  let prepared = false;
  for (const e of all.filter(e => e.campaignId === m.campaignId)) {
    if (e.manifestSha256 !== hash || terminal(run.state)) throw new Error("Journal campaign binding/terminal violation");
    if (!prepared && e.event !== "CAMPAIGN_PREPARED") throw new Error("Missing prepare event");
    const fixedStates: Partial<Record<JournalEvent["event"], State>> = { CAMPAIGN_PREPARED: "PREPARED",
      WAITING_HUMAN_AUTHORIZATION: "WAITING_HUMAN_AUTHORIZATION", CAMPAIGN_AUTHORIZED: "AUTHORIZED",
      CAMPAIGN_BLOCKED: "BLOCKED", RECONCILE_REQUIRED: "RECONCILE_REQUIRED", READY_FOR_PASSKEY_CUTOVER: "READY_FOR_PASSKEY_CUTOVER",
      BOOTSTRAP_DISABLED_PENDING: "READY_FOR_PASSKEY_CUTOVER", PASSKEY_ONLY: "READY_FOR_PASSKEY_CUTOVER", COMPLETE: "COMPLETE" };
    const required = fixedStates[e.event];
    if (required && e.state !== required) throw new Error("Event/state mismatch");
    if (!required && e.event !== "STATE_ENTERED" && e.state !== run.state) throw new Error("Unexpected state change");
    const stepEvent = ["STEP_INTENT", "STEP_DISPATCHED", "STEP_OBSERVED", "STEP_VERIFIED", "HUMAN_CEREMONY_WAIT", "HUMAN_CEREMONY_RESUMED"].includes(e.event);
    if (stepEvent !== (e.stepId !== null)) throw new Error("Event/step mismatch");
    if (e.event === "STATE_ENTERED" || e.event === "READY_FOR_PASSKEY_CUTOVER") {
      if (run.waiting || m.steps.some(s => s.phase === run.state && run.steps.get(s.stepId)!.state !== "VERIFIED")) throw new Error("Unfinished phase");
    }
    if (e.event === "CAMPAIGN_PREPARED") {
      if (prepared || e.state !== "PREPARED") throw new Error("Duplicate prepare"); prepared = true;
    } else if (e.event === "AUTHORIZATION_REGISTERED") {
      if (run.authorized || run.state !== "WAITING_HUMAN_AUTHORIZATION") throw new Error("Duplicate authorization"); run.authorized = true;
    } else if (e.event === "CAMPAIGN_AUTHORIZED") {
      if (!run.authorized || run.activated || !e.details.executionIdentity) throw new Error("Invalid activation");
      run.activated = true; run.executionIdentity = e.details.executionIdentity;
    }
    if (e.stepId !== null) {
      const spec = m.steps.find(s => s.stepId === e.stepId), step = run.steps.get(e.stepId);
      if (!spec || !step || e.operationId !== operationId(m, spec) || run.state !== spec.phase || !run.activated) throw new Error("Step journal binding");
      if (e.event === "HUMAN_CEREMONY_WAIT") {
        if (spec.operationKind !== "TEST_HUMAN_CEREMONY" || run.waiting || step.state !== "NOT_STARTED") throw new Error("Invalid ceremony wait");
        if (spec.dependencies.some(d => run.steps.get(d)?.state !== "VERIFIED")) throw new Error("Unverified ceremony dependency");
        run.waiting = e.stepId;
      } else if (e.event === "HUMAN_CEREMONY_RESUMED") {
        if (run.waiting !== e.stepId || !e.details.receiptSha256) throw new Error("Invalid ceremony resume");
        run.waiting = null; step.state = "VERIFIED"; step.receiptSha256 = e.details.receiptSha256; step.evidenceRoot = e.evidenceHashes[0];
        run.lastVerifiedCheckpoint = { sequence: e.sequence, eventHash: e.eventHash };
      } else {
        const sequence = ["STEP_INTENT", "STEP_DISPATCHED", "STEP_OBSERVED", "STEP_VERIFIED"];
        const states: StepState[] = ["NOT_STARTED", "INTENT_DURABLE", "DISPATCHED", "OBSERVED", "VERIFIED"];
        const index = sequence.indexOf(e.event);
        if (index < 0 || step.state !== states[index] || spec.operationKind === "TEST_HUMAN_CEREMONY") throw new Error("Invalid step transition");
        if (spec.dependencies.some(d => run.steps.get(d)?.state !== "VERIFIED")) throw new Error("Unverified dependency");
        step.state = states[index + 1]; step.operationId = e.operationId;
        if (index === 0) step.intentAt = e.timestamp;
        if (index >= 2) {
          if (!e.details.receiptSha256 || !e.evidenceHashes[0]) throw new Error("Missing receipt");
          step.receiptSha256 = e.details.receiptSha256; step.evidenceRoot = e.evidenceHashes[0];
        }
        if (index === 3) run.lastVerifiedCheckpoint = { sequence: e.sequence, eventHash: e.eventHash };
      }
    } else if (e.operationId !== null) throw new Error("Orphan operation");
    if (e.event === "BOOTSTRAP_DISABLED_PENDING") {
      if (run.state !== "READY_FOR_PASSKEY_CUTOVER" || run.mode !== "BOOTSTRAP") throw new Error("Invalid cutover pending"); run.mode = "BOOTSTRAP_DISABLED_PENDING";
    }
    if (e.event === "PASSKEY_ONLY") {
      if (run.mode !== "BOOTSTRAP_DISABLED_PENDING") throw new Error("Invalid passkey transition"); run.mode = "PASSKEY_ONLY";
    }
    if (e.event === "COMPLETE" && run.mode !== "PASSKEY_ONLY") throw new Error("Missing cutover tombstone");
    if (e.event === "CAMPAIGN_BLOCKED" || e.event === "RECONCILE_REQUIRED") {
      const uncertain = m.steps.some(s => s.operationKind === "TEST_MUTATION" && !["NOT_STARTED", "VERIFIED"].includes(run.steps.get(s.stepId)!.state));
      if ((e.event === "RECONCILE_REQUIRED") !== uncertain || !e.details.reason) throw new Error("Uncertainty classification mismatch");
    }
    if (e.state !== run.state) { assertTransition(run.state, e.state); run.state = e.state; }
    run.reason = e.details.reason ?? run.reason;
    run.checkpoint = { sequence: e.sequence, eventHash: e.eventHash };
  }
  if (!prepared) throw new Error("Campaign journal missing");
  return run;
}
