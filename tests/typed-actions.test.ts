import { describe, expect, it } from "vitest";
import { typedActionBootstrap } from "../src/mcp/typed-actions.js";
import { createHash } from "node:crypto";
import * as core from "../src/mcp/typed-actions.js";

describe("typed-action bootstrap seam", () => {
  it("starts with no executable action surface", () => {
    expect(typedActionBootstrap).toEqual({ version: 1 });
    expect(Object.keys(typedActionBootstrap)).toEqual(["version"]);
  });
});

const uuid = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const nextAttemptId = "33333333-3333-4333-8333-333333333333";
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const backup = { snapshotId: uuid, sha256: hash, generation: 1 };
const commit = { algorithm: "sha1", digest: "a".repeat(40) };

function request(kind: core.ActionKind = "RestartService"): any {
  const common = {
    schemaVersion: 1, actionId: uuid, kind,
    preconditions: { targetGeneration: 1, policySha256: hash, maintenanceWindowId: uuid,
      recheck: "immediately-before-mutation-under-exclusive-fence" },
    timeout: { preflightMs: 1000, executionMs: 60_000, verificationMs: 1000, onExpiry: "stop-and-reconcile" },
    rollback: { mode: "none", onFailure: "block-and-reconcile" },
    retry: { automaticMutationRetries: 0, recovery: "new-request-fresh-preflight-and-new-approval" },
    retryOf: null, risk: "elevated",
    approval: { human: "required", independentReview: "required", binding: "request-hash-and-attempt",
      destructive: "not-applicable", reboot: "not-applicable" },
    reboot: "forbidden",
  };
  const variants = {
    GitIntegrateMain: { target: { kind: "repository", id: uuid },
      expected: { generation: 1, head: commit, remoteHead: commit, stagedDeltaSha256: hash,
        localChangePathsSha256: hash, unstagedDeltaSha256: hash, untrackedStateSha256: hash },
      desired: { branch: "main", remote: "origin", operation: "merge-origin-main-no-edit-and-push",
        fetch: "no-tags", remoteHeadCheck: "match-expected-after-fetch", divergenceCheck: "recheck-before-merge",
        overlapCheck: "remote-only-paths-disjoint-from-local-change-paths", onConflict: "merge-abort-and-block",
        parentCheck: "verify-against-premerge-heads", localState: "preserve-staged-unstaged-and-untracked-deltas",
        finalRelation: "origin-main-equals-head", finalVerification: "fetch-and-check-zero-ahead-zero-behind-and-local-state" } },
    AptUpgradeNode: { target: { kind: "node", id: uuid }, expected: { generation: 1, inventorySha256: hash, backup },
      desired: { approvedManifestSha256: hash }, reboot: "separate-approved-action-if-needed" },
    AptUpgradeGuest: { target: { kind: "guest", id: uuid }, expected: { generation: 1, inventorySha256: hash, backup },
      desired: { approvedManifestSha256: hash }, reboot: "separate-approved-action-if-needed" },
    AppUpgrade: { target: { kind: "application", id: uuid },
      expected: { generation: 1, artifactSha256: hash, serviceState: "running", backup },
      desired: { artifactSha256: otherHash, releaseGeneration: 2 } },
    RestartService: { target: { kind: "service", id: uuid },
      expected: { generation: 1, serviceState: "running", configurationSha256: hash }, desired: { serviceState: "running" } },
    RebootNode: { target: { kind: "node", id: uuid }, expected: { generation: 1, bootId: uuid, backup },
      desired: { boot: "new-boot-id", health: "healthy" }, risk: "destructive", reboot: "required",
      approval: { ...common.approval, destructive: "separate-required", reboot: "separate-required" } },
  };
  return structuredClone({ ...common, ...variants[kind] });
}

function attempt(input = request()): any {
  return { schemaVersion: 1, attemptId: input.retryOf ? nextAttemptId : otherId,
    actionId: input.actionId, requestHash: core.hashActionRequest(input),
    sequence: input.retryOf ? input.retryOf.attemptSequence + 1 : 1,
    createdAt: input.retryOf ? "2026-10-01T00:02:00.000Z" : "2026-10-01T00:00:00.000Z",
    approvalIdentity: "typed-action-attempt-sha256-v1" };
}

function boundAttempt(input = request()) {
  return core.bindActionAttempt(attempt(input), input);
}

function bindReceipt(result: unknown, input = request()) {
  return core.bindActionReceipt(result, input, boundAttempt(input));
}

function receipt(input = request()): any {
  const bound = boundAttempt(input);
  return {
    schemaVersion: 1, actionId: input.actionId, attemptId: bound.attempt.attemptId,
    attemptHash: bound.attemptHash, requestHash: core.hashActionRequest(input),
    startedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:01:00.000Z",
    authorization: { humanApprovalEvidenceHash: hash, independentReviewEvidenceHash: otherHash,
      destructiveApprovalEvidenceHash: null, rebootApprovalEvidenceHash: null },
    preflight: { status: "passed", evidenceHashes: [hash] },
    execution: { status: "passed", evidenceHashes: [hash] },
    healthCheck: { status: "passed", evidenceHashes: [hash] },
    gitResult: null,
    rollback: { status: "not-needed", actionId: null, receiptHash: null },
    finalState: "SUCCEEDED", evidenceHashes: [hash],
  };
}

function reverseKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
  }
  return value;
}

describe("typed action requests", () => {
  it.each(core.actionKinds)("accepts and deeply freezes %s", (kind) => {
    const input = request(kind);
    const bound = core.bindActionRequest(input);
    expect(bound.request).toEqual(input);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.request.expected)).toBe(true);
    input.target.id = otherId;
    expect(bound.request.target.id).toBe(uuid);
    expect(() => { (bound.request.target as any).id = otherId; }).toThrow();
  });

  it.each(["Shell", "RunCommand", "Exec", "Script", "Unknown", "__proto__"])("rejects action kind %s", (kind) => {
    expect(() => core.hashActionRequest({ ...request(), kind })).toThrow();
  });

  it.each(core.actionKinds)("rejects unknown fields at every object depth for %s", (kind) => {
    function walk(value: any, path: string[] = []): void {
      if (value === null || typeof value !== "object") return;
      const changed = request(kind);
      let node = changed;
      for (const key of path) node = node[key];
      node.unexpected = "ignored?";
      expect(() => core.hashActionRequest(changed)).toThrow();
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    }
    walk(request(kind));
  });

  it.each([null, [], {}, "request", 42, undefined])("rejects malformed root %s", (input) => {
    expect(() => core.parseActionRequest(input)).toThrow();
  });

  it("rejects missing fields, wrong types, invalid bounds and mismatched targets", () => {
    for (const key of Object.keys(request())) {
      const input = request(); delete input[key];
      expect(() => core.parseActionRequest(input)).toThrow();
    }
    for (const value of [-1, 0, 3_600_001, 1.5, Infinity, NaN, "1000"]) {
      const input = request(); input.timeout.executionMs = value;
      expect(() => core.parseActionRequest(input)).toThrow();
    }
    const bad = request(); bad.target.kind = "node";
    expect(() => core.parseActionRequest(bad)).toThrow();
    bad.target.kind = "service"; bad.expected.generation = Number.MAX_SAFE_INTEGER + 1;
    expect(() => core.parseActionRequest(bad)).toThrow();
  });

  it("rejects data that canonical JSON would silently lose or invoke", () => {
    const inputs = [request(), request(), request(), request(), request(), request(), request()];
    inputs[0].extra = undefined;
    inputs[1][Symbol("command")] = "exec";
    Object.defineProperty(inputs[2], "command", { value: "exec", enumerable: false });
    Object.defineProperty(inputs[3], "actionId", { get: () => { throw new Error("getter invoked"); }, enumerable: true });
    Object.setPrototypeOf(inputs[4].target, { command: "exec" });
    inputs[5].expected.generation = -0;
    inputs[6].extra = inputs[6];
    for (const input of inputs) expect(() => core.hashActionRequest(input)).toThrow();
    expect(() => core.hashActionRequest(inputs[3])).toThrow("Invalid JSON property");
  });

  it.each(core.actionKinds)("fixes risk/approval/retry metadata for %s", (kind) => {
    const valid = core.parseActionRequest(request(kind));
    expect(valid.risk).toBe(kind === "RebootNode" ? "destructive" : "elevated");
    expect(valid.approval.human).toBe("required");
    expect(valid.approval.independentReview).toBe("required");
    expect(valid.retry.automaticMutationRetries).toBe(0);
    for (const change of [
      (r: any) => { r.risk = "low"; },
      (r: any) => { r.approval.human = "approved"; },
      (r: any) => { r.approval.independentReview = "none"; },
      (r: any) => { r.approval.approved = true; },
      (r: any) => { r.retry.automaticMutationRetries = 1; },
      (r: any) => { r.reboot = "automatic"; },
    ]) {
      const input = request(kind); change(input);
      expect(() => core.parseActionRequest(input)).toThrow();
    }
  });

  it.each(["sh -c whoami", "C:\\Windows\\System32", "../../etc/passwd", "/etc/passwd", "origin", "refs/heads/main", "https://example.com", "file:///etc/passwd"])("rejects arbitrary selector %s", (selector) => {
    for (const kind of core.actionKinds) {
      const input = request(kind); input.target.id = selector;
      expect(() => core.hashActionRequest(input)).toThrow();
    }
    const git = request("GitIntegrateMain"); git.expected.remoteHead.digest = selector;
    expect(() => core.hashActionRequest(git)).toThrow();
  });

  it.each(["command", "shell", "executable", "script", "path", "remote", "ref", "url", "args"])("has no %s escape hatch", (key) => {
    for (const kind of core.actionKinds) {
      for (const location of ["target", "expected", "desired", "preconditions"]) {
        const input = request(kind); input[location][key] = "arbitrary";
        expect(() => core.hashActionRequest(input)).toThrow();
      }
    }
  });
});

describe("canonical binding and preflight", () => {
  it.each(core.actionKinds)("hashes %s deterministically with SHA-256", (kind) => {
    const input = request(kind);
    const canonical = core.canonicalizeActionRequest(input);
    expect(core.hashActionRequest(reverseKeys(input))).toBe(core.hashActionRequest(input));
    expect(core.canonicalizeActionRequest(reverseKeys(input))).toBe(canonical);
    expect(core.hashActionRequest(input)).toBe(createHash("sha256").update(`typed-action-request-v1\n${canonical}`).digest("hex"));
    expect(core.hashActionRequest(input)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(core.actionKinds)("binds every variable security field in %s", (kind) => {
    const input = request(kind);
    function walk(value: any, path: string[] = []): void {
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
        return;
      }
      let replacement: any;
      if (typeof value === "number" && path[0] !== "schemaVersion") replacement = value + 1;
      else if (value === uuid) replacement = otherId;
      else if (value === hash) replacement = otherHash;
      else if (value === otherHash) replacement = hash;
      else if (value === "a".repeat(40)) replacement = "b".repeat(40);
      else if (value === "running" && path[0] === "expected") replacement = "stopped";
      else return; // Fixed enum/literal fields cannot be changed into another valid value.
      const changed = structuredClone(input);
      let node = changed;
      for (const key of path.slice(0, -1)) node = node[key];
      node[path.at(-1)!] = replacement;
      if (path.join(".") === "retry.automaticMutationRetries") {
        expect(() => core.hashActionRequest(changed)).toThrow();
      } else {
        expect(core.hashActionRequest(changed)).not.toBe(core.hashActionRequest(input));
      }
    }
    walk(input);
    const changed = structuredClone(input);
    changed.rollback = { mode: "separate-approved-action", backup };
    expect(core.hashActionRequest(changed)).not.toBe(core.hashActionRequest(input));
  });

  it.each(core.actionKinds)("checks all expected-state fields of %s", (kind) => {
    const input = request(kind);
    expect(() => core.assertExpectedState(input, reverseKeys(input.expected))).not.toThrow();
    for (const key of Object.keys(input.expected)) {
      const observed = structuredClone(input.expected); delete observed[key];
      expect(() => core.assertExpectedState(input, observed)).toThrow();
    }
    expect(() => core.assertExpectedState(input, { ...input.expected, generation: 2 })).toThrow();
    expect(() => core.assertExpectedState(input, { ...input.expected, extra: true })).toThrow();
  });
});

describe("lifecycle and receipts", () => {
  it("validates the entire transition matrix and rejects terminal reexecution", () => {
    const allowed = new Set([
      "PROPOSED:WAITING_APPROVAL", "PROPOSED:BLOCKED", "WAITING_APPROVAL:APPROVED", "WAITING_APPROVAL:BLOCKED",
      "APPROVED:PREFLIGHT", "APPROVED:BLOCKED", "PREFLIGHT:EXECUTING", "PREFLIGHT:FAILED", "PREFLIGHT:BLOCKED",
      "EXECUTING:VERIFYING", "EXECUTING:FAILED", "EXECUTING:BLOCKED", "VERIFYING:SUCCEEDED", "VERIFYING:FAILED", "VERIFYING:BLOCKED",
    ]);
    for (const from of core.actionStates) for (const to of core.actionStates) {
      const transition = () => core.assertActionTransition(from, to);
      if (allowed.has(`${from}:${to}`)) expect(transition).not.toThrow();
      else expect(transition).toThrow();
    }
    expect(() => core.assertActionTransition("__proto__" as any, "EXECUTING")).toThrow();
    expect(() => core.assertActionTransition("PROPOSED", "unknown" as any)).toThrow();
  });

  it("binds immutable receipts to a request and every receipt field", () => {
    const input = request(); const result = receipt(input);
    const bound = bindReceipt(result, input);
    expect(Object.isFrozen(bound.receipt.execution.evidenceHashes)).toBe(true);
    expect(bindReceipt(reverseKeys(result), input).receiptHash).toBe(bound.receiptHash);
    for (const change of [
      (r: any) => { r.attemptId = uuid; },
      (r: any) => { r.completedAt = "2026-10-01T00:02:00.000Z"; },
      (r: any) => { r.startedAt = "2026-10-01T00:00:01.000Z"; },
      (r: any) => { r.preflight.evidenceHashes = [otherHash]; },
      (r: any) => { r.execution.evidenceHashes = [otherHash]; },
      (r: any) => { r.healthCheck.evidenceHashes = [otherHash]; },
      (r: any) => { r.authorization.humanApprovalEvidenceHash = otherHash; },
      (r: any) => { r.finalState = "FAILED"; },
      (r: any) => { r.evidenceHashes = [otherHash]; },
    ]) {
      const changed = structuredClone(result); change(changed);
      if (changed.attemptId !== result.attemptId) {
        // A different attempt now also requires its matching deterministic binding.
        expect(() => bindReceipt(changed, input)).toThrow("Receipt attempt mismatch");
        const newAttempt = core.bindActionAttempt({ ...attempt(input), attemptId: changed.attemptId }, input);
        changed.attemptHash = newAttempt.attemptHash;
        expect(core.bindActionReceipt(changed, input, newAttempt).receiptHash).not.toBe(bound.receiptHash);
      } else {
        expect(bindReceipt(changed, input).receiptHash).not.toBe(bound.receiptHash);
      }
    }
  });

  it("rejects mismatches, invalid evidence and impossible success receipts", () => {
    for (const change of [
      (r: any) => { r.actionId = otherId; },
      (r: any) => { r.requestHash = otherHash; },
      (r: any) => { r.completedAt = "2025-10-01T00:00:00.000Z"; },
      (r: any) => { r.startedAt = "not a date"; },
      (r: any) => { r.preflight.status = "failed"; },
      (r: any) => { r.execution.status = "indeterminate"; },
      (r: any) => { r.healthCheck.status = "not-run"; },
      (r: any) => { r.authorization = null; },
      (r: any) => { r.execution.evidenceHashes = []; },
      (r: any) => { r.execution.extra = true; },
      (r: any) => { r.extra = true; },
      (r: any) => { r.rollback.status = "separate-action"; },
      (r: any) => { r.rollback.actionId = otherId; },
    ]) {
      const result = receipt(); change(result);
      expect(() => bindReceipt(result, request())).toThrow();
    }
  });

  it("requires separate destructive and reboot audit evidence", () => {
    const input = request("RebootNode"); const result = receipt(input);
    expect(() => bindReceipt(result, input)).toThrow();
    result.authorization.destructiveApprovalEvidenceHash = hash;
    expect(() => bindReceipt(result, input)).toThrow();
    result.authorization.rebootApprovalEvidenceHash = otherHash;
    expect(() => bindReceipt(result, input)).not.toThrow();
  });

  it("records blocked preflight and links rollback as a separate action", () => {
    const result = receipt(); result.finalState = "BLOCKED"; result.authorization = null;
    result.preflight.status = "failed";
    result.execution = result.healthCheck = { status: "not-run", evidenceHashes: [] };
    expect(() => bindReceipt(result, request())).not.toThrow();
    result.rollback = { status: "separate-action", actionId: otherId, receiptHash: otherHash };
    expect(() => bindReceipt(result, request())).not.toThrow();
  });
});

describe("retry and empty execution surface", () => {
  it("requires a new proposal linked to a failed/indeterminate receipt", () => {
    const previous = request(); const result = receipt(previous);
    result.finalState = "FAILED"; result.execution.status = "indeterminate";
    result.healthCheck = { status: "not-run", evidenceHashes: [] };
    const bound = bindReceipt(result, previous);
    const priorAttempt = boundAttempt(previous);
    const next = request(); next.actionId = otherId;
    next.retryOf = { actionId: previous.actionId, requestHash: bound.receipt.requestHash, receiptHash: bound.receiptHash,
      attemptId: priorAttempt.attempt.attemptId, attemptHash: priorAttempt.attemptHash, attemptSequence: priorAttempt.attempt.sequence };
    expect(() => core.assertRetryRequest(previous, result, next, priorAttempt, boundAttempt(next))).not.toThrow();
    expect(core.hashActionRequest(next)).not.toBe(core.hashActionRequest(previous));
    for (const change of [
      (r: any) => { r.actionId = previous.actionId; },
      (r: any) => { r.retryOf = null; },
      (r: any) => { r.retryOf.actionId = otherId; },
      (r: any) => { r.retryOf.requestHash = otherHash; },
      (r: any) => { r.retryOf.receiptHash = otherHash; },
      (r: any) => { r.target.id = otherId; },
      (r: any) => { r.retry.automaticMutationRetries = 1; },
    ]) {
      const changed = structuredClone(next); change(changed);
      expect(() => core.assertRetryRequest(previous, result, changed, priorAttempt, boundAttempt(next))).toThrow();
    }
    const success = receipt(previous); const successBound = bindReceipt(success, previous);
    next.retryOf.receiptHash = successBound.receiptHash;
    expect(() => core.assertRetryRequest(previous, success, next, priorAttempt, boundAttempt(next))).toThrow();
  });

  it("has exactly zero executable mutation adapters and no registration/approval API", () => {
    expect(core.executableMutationAdapters).toEqual([]);
    expect(Object.isFrozen(core.executableMutationAdapters)).toBe(true);
    expect(() => (core.executableMutationAdapters as any[]).push({ execute: () => {} })).toThrow();
    expect(Object.keys(core).sort()).toEqual([
      "actionAttemptSchema", "actionKinds", "actionReceiptSchema", "actionRequestSchema", "actionStates", "assertActionTransition",
      "assertExpectedState", "assertRetryRequest", "bindActionReceipt", "bindActionRequest",
      "bindActionAttempt", "hashActionAttempt", "canonicalizeActionRequest", "executableMutationAdapters", "hashActionRequest", "parseActionRequest", "typedActionBootstrap",
    ].sort());
  });
});

describe("fixed main integration contract", () => {
  it("expresses only the fixed origin/main workflow, with no predicted merge commit", () => {
    const input = request("GitIntegrateMain");
    expect(core.parseActionRequest(input)).toEqual(input);
    expect(input.desired).toEqual({
      branch: "main", remote: "origin", operation: "merge-origin-main-no-edit-and-push",
      fetch: "no-tags", remoteHeadCheck: "match-expected-after-fetch", divergenceCheck: "recheck-before-merge",
      overlapCheck: "remote-only-paths-disjoint-from-local-change-paths", onConflict: "merge-abort-and-block",
      parentCheck: "verify-against-premerge-heads", localState: "preserve-staged-unstaged-and-untracked-deltas",
      finalRelation: "origin-main-equals-head", finalVerification: "fetch-and-check-zero-ahead-zero-behind-and-local-state",
    });
    for (const field of Object.keys(input.desired)) {
      const changed = structuredClone(input); changed.desired[field] = "caller-choice";
      expect(() => core.hashActionRequest(changed)).toThrow();
    }
    expect(() => core.parseActionRequest({ ...input, kind: "GitIntegration" })).toThrow();
  });

  it.each([
    ["branch", "feature"], ["remote", "upstream"], ["ref", "refs/heads/other"],
    ["strategy", "ours"], ["strategy", "fast-forward-only"], ["integrationCommit", commit],
    ["mergeCommit", commit], ["commitMessage", "caller message"], ["command", "git status"],
    ["force", true], ["rebase", true], ["stash", true], ["autostash", true], ["reset", true],
    ["checkout", true], ["clean", true], ["amend", true], ["cherryPick", commit],
  ])("rejects caller-controlled %s", (key, value) => {
    for (const location of [null, "target", "expected", "desired", "preconditions"]) {
      const input = request("GitIntegrateMain");
      (location ? input[location] : input)[key as string] = value;
      expect(() => core.hashActionRequest(input)).toThrow();
    }
  });

  function gitReceipt() {
    const input = request("GitIntegrateMain");
    input.expected.remoteHead = { algorithm: "sha1", digest: "b".repeat(40) };
    const result = receipt(input);
    const generated = { algorithm: "sha1", digest: "c".repeat(40) };
    result.gitResult = { integration: "merge", finalHead: generated, originMainHead: generated,
      mergeCommit: generated, mergeParents: [input.expected.head, input.expected.remoteHead],
       localChangePathsSha256: hash, unstagedDeltaSha256: hash, untrackedStateSha256: hash,
       stagedDeltaSha256: hash, ahead: 0, behind: 0 };
    return { input, result };
  }

  it("records the actual generated merge commit and validates postconditions", () => {
    const { input, result } = gitReceipt();
    const bound = bindReceipt(result, input);
    expect(bound.receipt.gitResult?.mergeCommit?.digest).toBe("c".repeat(40));
    expect(Object.isFrozen(bound.receipt.gitResult?.mergeParents)).toBe(true);
    const changed = structuredClone(result);
    for (const field of ["mergeCommit", "finalHead", "originMainHead"]) changed.gitResult[field].digest = "d".repeat(40);
    expect(bindReceipt(changed, input).receiptHash).not.toBe(bound.receiptHash);
    for (const change of [
      (g: any) => { g.mergeCommit = null; },
      (g: any) => { g.mergeParents.reverse(); },
      (g: any) => { g.mergeParents = []; },
      (g: any) => { g.originMainHead = input.expected.remoteHead; },
      (g: any) => { g.ahead = 1; }, (g: any) => { g.behind = 1; },
      (g: any) => { g.localChangePathsSha256 = otherHash; },
      (g: any) => { g.unstagedDeltaSha256 = otherHash; },
      (g: any) => { g.untrackedStateSha256 = otherHash; },
      (g: any) => { g.indexChangesPreserved = false; },
      (g: any) => { g.strategy = "ours"; },
    ]) {
      const invalid = structuredClone(result); change(invalid.gitResult);
      expect(() => bindReceipt(invalid, input)).toThrow();
    }
    expect(() => bindReceipt({ ...result, gitResult: null }, input)).toThrow();
    expect(() => bindReceipt({ ...receipt(), gitResult: result.gitResult })).toThrow();
    const identicalHeads = request("GitIntegrateMain");
    const impossibleMerge = receipt(identicalHeads);
    impossibleMerge.gitResult = { ...result.gitResult, mergeParents: [commit, commit] };
    expect(() => bindReceipt(impossibleMerge, identicalHeads)).toThrow("Git merge parent mismatch");
  });

  it.each(["fast-forward", "unchanged"])("records %s without inventing a merge commit", (integration) => {
    const { input, result } = gitReceipt();
    const head = integration === "fast-forward" ? input.expected.remoteHead : input.expected.head;
    Object.assign(result.gitResult, { integration, finalHead: head, originMainHead: head, mergeCommit: null, mergeParents: [] });
    expect(() => bindReceipt(result, input)).not.toThrow();
    result.gitResult.mergeCommit = head;
    expect(() => bindReceipt(result, input)).toThrow();
  });

  const localDigestKeys = ["stagedDeltaSha256", "unstagedDeltaSha256", "untrackedStateSha256", "localChangePathsSha256"] as const;

  describe.each(["merge", "fast-forward", "unchanged"])("successful %s local state", (integration) => {
  it.each(localDigestKeys)("requires the bound final %s", (key) => {
    const { input, result } = gitReceipt();
    if (integration !== "merge") {
      const head = integration === "fast-forward" ? input.expected.remoteHead : input.expected.head;
      Object.assign(result.gitResult, { integration, finalHead: head, originMainHead: head, mergeCommit: null, mergeParents: [] });
    }
    const bound = bindReceipt(result, input);
    expect(bound.receipt.gitResult?.[key]).toBe(input.expected[key]);

    for (const digest of [otherHash, "0".repeat(64), "f".repeat(64)]) {
      const changed = structuredClone(result);
      changed.gitResult[key] = digest;
      // Well-formed caller claims still cannot satisfy the bound expected state.
      expect(() => bindReceipt(changed, input)).toThrow("Git postcondition mismatch");
    }
    const missing = structuredClone(result);
    delete missing.gitResult[key];
    expect(() => bindReceipt(missing, input)).toThrow();
    for (const digest of [undefined, null, "arbitrary", "a".repeat(63), "A".repeat(64), 123]) {
      const malformed = structuredClone(result);
      malformed.gitResult[key] = digest;
      expect(() => bindReceipt(malformed, input)).toThrow();
    }
  });
  });

  it.each(localDigestKeys)("binds observed %s into the receipt hash independently of the request", (key) => {
    const { input, result } = gitReceipt();
    // Failed verification may record an observed mismatch for audit. Keeping
    // request/attempt and every other receipt field fixed isolates this field.
    result.finalState = "FAILED";
    result.healthCheck.status = "failed";
    const bound = bindReceipt(result, input);
    const changed = structuredClone(result);
    changed.gitResult[key] = otherHash;
    const changedBound = bindReceipt(changed, input);
    expect(changedBound.receipt.requestHash).toBe(bound.receipt.requestHash);
    expect(changedBound.receipt.attemptHash).toBe(bound.receipt.attemptHash);
    expect(changedBound.receipt.gitResult?.[key]).toBe(otherHash);
    expect(changedBound.receiptHash).not.toBe(bound.receiptHash);
    expect(bindReceipt(reverseKeys(changed), input).receiptHash).toBe(changedBound.receiptHash);
  });

  it.each(localDigestKeys)("binds expected %s into the request hash", (key) => {
    const input = request("GitIntegrateMain");
    const changed = structuredClone(input);
    changed.expected[key] = otherHash;
    expect(core.hashActionRequest(changed)).not.toBe(core.hashActionRequest(input));
  });

  it.each(["indexStateSha256", "dirtyWorkingTreeSha256", "dirtyPathsSha256", "indexChangesPreserved"])("rejects obsolete field %s", (key) => {
    const { input, result } = gitReceipt();
    expect(() => bindReceipt(result, input)).not.toThrow();
    const changed = structuredClone(input);
    changed.expected[key] = key === "indexChangesPreserved" ? true : hash;
    expect(() => core.parseActionRequest(changed)).toThrow();
    result.gitResult[key] = changed.expected[key];
    expect(() => bindReceipt(result, input)).toThrow();
    for (const field of localDigestKeys) delete result.gitResult[field];
    expect(() => bindReceipt(result, input)).toThrow();
  });

  // Test-only semantic model, not an adapter or a production digest encoder.
  // Sorted tuples bind exact paths and both sides, with null for absence.
  type Entry = { mode: string; object: { algorithm: string; digest: string } };
  type Tree = Record<string, Entry>;
  const blob = (content: string, mode = "100644"): Entry => ({ mode,
    object: { algorithm: "sha256", digest: createHash("sha256").update(content).digest("hex") } });
  const fixtureHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  function stagedDigest(head: Tree, index: Tree): string {
    const paths = [...new Set([...Object.keys(head), ...Object.keys(index)])].sort();
    return fixtureHash(paths.filter((path) => JSON.stringify(head[path]) !== JSON.stringify(index[path]))
      .map((path) => [path, head[path] ?? null, index[path] ?? null]));
  }
  function withStagedDigest(expected: string, observed: string) {
    const { input, result } = gitReceipt();
    input.expected.stagedDeltaSha256 = expected;
    const rebound = receipt(input);
    rebound.gitResult = { ...result.gitResult, stagedDeltaSha256: observed };
    return { input, result: rebound };
  }

  it.each(["modify", "add", "delete", "mode", "type"])("preserves staged %s while HEAD and clean index paths advance", (change) => {
    const head: Tree = { A: blob("A1"), B: blob("B1") };
    const index: Tree = { ...head, B: blob("B2") };
    if (change === "add") delete head.B;
    if (change === "delete") delete index.B;
    if (change === "mode") index.B = blob("B1", "100755");
    if (change === "type") index.B = blob("target", "120000");
    const finalHead = { ...head, A: blob("A2") };
    const finalIndex = { ...index, A: blob("A2") };
    expect(fixtureHash(finalIndex)).not.toBe(fixtureHash(index));
    expect(stagedDigest(head, index)).not.toBe(stagedDigest(head, head));
    expect(stagedDigest(finalHead, finalIndex)).toBe(stagedDigest(head, index));
    const { input, result } = withStagedDigest(stagedDigest(head, index), stagedDigest(finalHead, finalIndex));
    expect(result.gitResult.finalHead).not.toEqual(input.expected.head);
    expect(() => bindReceipt(result, input)).not.toThrow();
  });

  it.each(["blob", "path-add", "path-remove", "head-blob", "mode", "type"])("rejects staged delta change: %s", (change) => {
    const head: Tree = { A: blob("A1"), B: blob("B1") };
    const index: Tree = { ...head, B: blob("B2") };
    const finalHead = { ...head, A: blob("A2") };
    const finalIndex = { ...index, A: blob("A2") };
    if (change === "blob") finalIndex.B = blob("B3");
    if (change === "path-add") finalIndex.C = blob("C1");
    if (change === "path-remove") finalIndex.B = head.B;
    if (change === "head-blob") finalHead.B = blob("B0");
    if (change === "mode") finalIndex.B = blob("B2", "100755");
    if (change === "type") finalIndex.B = blob("B2", "120000");
    const { input, result } = withStagedDigest(stagedDigest(head, index), stagedDigest(finalHead, finalIndex));
    expect(() => bindReceipt(result, input)).toThrow("Git postcondition mismatch");
  });
});

describe("execution attempt identity", () => {
  it("deterministically binds the complete attempt and request hash", () => {
    const input = request(); const raw = attempt(input);
    const bound = core.bindActionAttempt(raw, input);
    expect(core.hashActionAttempt(reverseKeys(raw), reverseKeys(input))).toBe(bound.attemptHash);
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))));
    expect(bound.attemptHash).toBe(createHash("sha256").update(`typed-action-attempt-v1\n${canonical}`).digest("hex"));
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.attempt)).toBe(true);
    raw.attemptId = nextAttemptId;
    expect(bound.attempt.attemptId).toBe(otherId);
    expect(core.hashActionAttempt(raw, input)).not.toBe(bound.attemptHash);
    expect(core.hashActionAttempt({ ...raw, createdAt: "2026-10-01T00:00:01.000Z" }, input)).not.toBe(core.hashActionAttempt(raw, input));
    const changedRequest = request(); changedRequest.expected.generation++;
    expect(core.hashActionAttempt(attempt(changedRequest), changedRequest)).not.toBe(bound.attemptHash);
    expect(() => core.bindActionAttempt(raw, changedRequest)).toThrow("Attempt request mismatch");
  });

  it("rejects wrong request/action bindings, missing fields, extras and malformed attempts", () => {
    const input = request();
    for (const change of [
      (a: any) => { a.requestHash = otherHash; }, (a: any) => { a.actionId = otherId; },
      (a: any) => { a.attemptId = "arbitrary"; }, (a: any) => { a.sequence = 0; },
      (a: any) => { a.sequence = 2; }, (a: any) => { a.sequence = 1.5; },
      (a: any) => { a.sequence = Number.MAX_SAFE_INTEGER + 1; },
      (a: any) => { a.createdAt = "2026-10-01"; },
      (a: any) => { a.approvalIdentity = "request-hash-only"; },
      (a: any) => { a.approved = true; }, (a: any) => { a.extra = undefined; },
      (a: any) => { a.attemptId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"; },
      (a: any) => { a[Symbol("hidden")] = true; },
    ]) {
      const raw = attempt(input); change(raw);
      expect(() => core.bindActionAttempt(raw, input)).toThrow();
    }
    for (const key of Object.keys(attempt(input))) {
      const raw = attempt(input); delete raw[key];
      expect(() => core.hashActionAttempt(raw, input)).toThrow();
    }
  });

  it("rejects attempt tampering and receipt/attempt identity mismatches", () => {
    const input = request(); const result = receipt(input); const bound = boundAttempt(input);
    for (const change of [
      (b: any) => { b.attempt.attemptId = nextAttemptId; },
      (b: any) => { b.attempt.createdAt = "2026-09-30T00:00:00.000Z"; },
      (b: any) => { b.attempt.requestHash = otherHash; },
      (b: any) => { b.attempt.actionId = otherId; },
      (b: any) => { b.attempt.sequence = 2; },
      (b: any) => { b.attemptHash = otherHash; },
      (b: any) => { b.extra = true; },
    ]) {
      const changed = structuredClone(bound); change(changed);
      expect(() => core.bindActionReceipt(result, input, changed)).toThrow();
    }
    for (const key of ["attemptId", "attemptHash", "requestHash"]) {
      const changed = { ...result, [key]: key === "attemptId" ? nextAttemptId : otherHash };
      expect(() => core.bindActionReceipt(changed, input, bound)).toThrow();
    }
    const other = core.bindActionAttempt({ ...attempt(input), attemptId: nextAttemptId }, input);
    expect(() => core.bindActionReceipt(result, input, other)).toThrow("Receipt attempt mismatch");
    expect(() => core.bindActionReceipt(result, input, undefined)).toThrow();
    expect(() => core.bindActionReceipt({ ...result, startedAt: "2026-09-30T00:00:00.000Z" }, input, bound)).toThrow();
  });

  it("requires a new attempt for retry, with verified lineage, fresh preflight and new approval", () => {
    const previous = request(); const prior = boundAttempt(previous); const result = receipt(previous);
    result.finalState = "FAILED"; result.execution.status = "indeterminate";
    result.healthCheck = { status: "not-run", evidenceHashes: [] };
    const failed = core.bindActionReceipt(result, previous, prior);
    const next = request(); next.actionId = otherId;
    next.retryOf = { actionId: previous.actionId, requestHash: prior.attempt.requestHash, receiptHash: failed.receiptHash,
      attemptId: prior.attempt.attemptId, attemptHash: prior.attemptHash, attemptSequence: prior.attempt.sequence };
    const fresh = boundAttempt(next);
    expect(fresh.attempt.sequence).toBe(2);
    expect(fresh.attempt.attemptId).not.toBe(prior.attempt.attemptId);
    expect(fresh.attemptHash).not.toBe(prior.attemptHash);
    expect(next.retry).toEqual({ automaticMutationRetries: 0, recovery: "new-request-fresh-preflight-and-new-approval" });
    expect(next.preconditions.recheck).toBe("immediately-before-mutation-under-exclusive-fence");
    expect(next.approval).toMatchObject({ human: "required", independentReview: "required", binding: "request-hash-and-attempt" });
    expect(() => core.assertRetryRequest(previous, result, next, prior, fresh)).not.toThrow();
    expect(() => core.assertRetryRequest(previous, result, next, prior, undefined)).toThrow();
    expect(() => core.assertRetryRequest(previous, result, next, prior, prior)).toThrow();
    expect(() => core.bindActionAttempt({ ...attempt(next), attemptId: prior.attempt.attemptId }, next)).toThrow();
    expect(() => core.bindActionAttempt({ ...attempt(next), sequence: 1 }, next)).toThrow();
    const tooEarly = core.bindActionAttempt({ ...attempt(next), createdAt: prior.attempt.createdAt }, next);
    expect(() => core.assertRetryRequest(previous, result, next, prior, tooEarly)).toThrow();
    for (const key of ["attemptId", "attemptHash", "attemptSequence", "requestHash", "receiptHash"]) {
      const changed = structuredClone(next);
      changed.retryOf[key] = key === "attemptId" ? uuid : key === "attemptSequence" ? 5 : otherHash;
      expect(() => core.assertRetryRequest(previous, result, changed, prior, boundAttempt(changed))).toThrow();
    }
    // An old request clone cannot silently become a new attempt of that request.
    expect(() => core.bindActionAttempt({ ...attempt(previous), sequence: 2, attemptId: nextAttemptId }, previous)).toThrow();
  });
});
