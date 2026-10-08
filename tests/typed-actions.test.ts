import { describe, expect, it } from "vitest";
import { typedActionBootstrap } from "../src/mcp/typed-actions.js";
import { createHash } from "node:crypto";
import * as core from "../src/mcp/typed-actions.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalJson } from "../src/task-contract/contract.js";
import type { BoundedTasks } from "../src/mcp/bounded-task.js";

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

function maintenanceSnapshot(): any {
  return {
    schemaVersion: 1, snapshotId: uuid, collectorId: otherId, collectedAt: "2026-10-01T00:00:10.000Z",
    inventoryGeneration: 7, inventorySha256: hash, policySha256: otherHash,
    checks: [
      { checkId: uuid, checkKind: "NodeResources", target: { kind: "node", id: uuid }, result: "PASS",
        targetGeneration: 3, observedAt: "2026-10-01T00:00:01.000Z", evidenceSha256: hash },
      { checkId: otherId, checkKind: "ServiceHealth", target: { kind: "service", id: otherId }, result: "WARN",
        targetGeneration: 4, observedAt: "2026-10-01T00:00:02.000Z", evidenceSha256: otherHash },
      { checkId: nextAttemptId, checkKind: "BackupFreshness", target: { kind: "backup", id: nextAttemptId }, result: "UNKNOWN",
        targetGeneration: 5, observedAt: "2026-10-01T00:00:03.000Z", evidenceSha256: hash },
    ],
  };
}

function maintenancePlan(snapshot = maintenanceSnapshot()): any {
  return {
    schemaVersion: 1, planId: "44444444-4444-4444-8444-444444444444",
    snapshotHash: core.hashMaintenanceSnapshot(snapshot), createdAt: "2026-10-01T00:00:11.000Z",
    semantics: { authority: "none", executionPermission: false, approval: "required-for-mutation", done: false },
    recommendations: [
      { checkId: uuid, target: { kind: "node", id: uuid }, disposition: "NO_ACTION", actionKind: null, reasonCode: "HEALTHY" },
      { checkId: otherId, target: { kind: "service", id: otherId }, disposition: "PROPOSE_ACTION", actionKind: "RestartService", reasonCode: "DEGRADED" },
      { checkId: nextAttemptId, target: { kind: "backup", id: nextAttemptId }, disposition: "ESCALATE_HUMAN", actionKind: null, reasonCode: "EVIDENCE_UNKNOWN" },
    ],
  };
}

describe("Dot maintenance proposal-only contract", () => {
  it("binds complete normalized observations and a non-authoritative plan deterministically", () => {
    const snapshot = maintenanceSnapshot(), plan = maintenancePlan(snapshot);
    const parsed = core.parseMaintenanceSnapshot(snapshot), bound = core.bindMaintenancePlan(plan, snapshot);
    expect(Object.isFrozen(parsed.checks)).toBe(true);
    expect(Object.isFrozen(bound.plan.recommendations)).toBe(true);
    expect(core.hashMaintenanceSnapshot(reverseKeys(snapshot))).toBe(core.hashMaintenanceSnapshot(snapshot));
    expect(core.hashMaintenancePlan(reverseKeys(plan))).toBe(core.hashMaintenancePlan(plan));
    expect(core.hashMaintenanceSnapshot(snapshot)).toBe(createHash("sha256")
      .update(`dot-maintenance-snapshot-v1\n${core.canonicalizeMaintenanceSnapshot(snapshot)}`).digest("hex"));
    expect(core.hashMaintenancePlan(plan)).toBe(createHash("sha256")
      .update(`dot-maintenance-plan-v1\n${core.canonicalizeMaintenancePlan(plan)}`).digest("hex"));
    expect(bound.snapshotHash).toBe(plan.snapshotHash);
    expect(bound.plan.semantics).toEqual({ authority: "none", executionPermission: false,
      approval: "required-for-mutation", done: false });
    expect(core.maintenanceActionKinds).toEqual(["AptUpgradeNode", "AptUpgradeGuest", "AppUpgrade", "RestartService", "RebootNode"]);
    expect(core.maintenanceActionKinds).not.toContain("GitIntegrateMain" as any);
  });

  it("requires every non-PASS result to remain visible and every snapshot check to be covered", () => {
    const snapshot = maintenanceSnapshot();
    for (const index of [1, 2]) {
      const plan = maintenancePlan(snapshot);
      plan.recommendations[index].disposition = "NO_ACTION";
      plan.recommendations[index].actionKind = null;
      expect(() => core.bindMaintenancePlan(plan, snapshot)).toThrow("Non-PASS maintenance result requires attention");
    }
    const missing = maintenancePlan(snapshot); missing.recommendations.pop();
    expect(() => core.bindMaintenancePlan(missing, snapshot)).toThrow("Maintenance plan must cover every check");
    const duplicate = maintenancePlan(snapshot); duplicate.recommendations[2].checkId = duplicate.recommendations[1].checkId;
    expect(() => core.parseMaintenancePlan(duplicate)).toThrow();
  });

  it("binds targets, time and snapshot identity and rejects incompatible maintenance actions", () => {
    const snapshot = maintenanceSnapshot();
    const wrongSnapshot = maintenancePlan(snapshot); wrongSnapshot.snapshotHash = otherHash;
    expect(() => core.bindMaintenancePlan(wrongSnapshot, snapshot)).toThrow("Maintenance snapshot binding mismatch");
    const early = maintenancePlan(snapshot); early.createdAt = "2026-09-30T23:59:59.000Z";
    expect(() => core.bindMaintenancePlan(early, snapshot)).toThrow("Maintenance plan predates snapshot");
    const retarget = maintenancePlan(snapshot); retarget.recommendations[1].target.id = uuid;
    expect(() => core.bindMaintenancePlan(retarget, snapshot)).toThrow("Maintenance recommendation binding mismatch");
    const wrongAction = maintenancePlan(snapshot); wrongAction.recommendations[1].actionKind = "AptUpgradeNode";
    expect(() => core.bindMaintenancePlan(wrongAction, snapshot)).toThrow("Maintenance action target mismatch");
    const git = maintenancePlan(snapshot); git.recommendations[1].actionKind = "GitIntegrateMain";
    expect(() => core.parseMaintenancePlan(git)).toThrow();
    const noActionKind = maintenancePlan(snapshot); noActionKind.recommendations[1].actionKind = null;
    expect(() => core.parseMaintenancePlan(noActionKind)).toThrow();
    const hiddenAction = maintenancePlan(snapshot); hiddenAction.recommendations[0].actionKind = "RestartService";
    expect(() => core.parseMaintenancePlan(hiddenAction)).toThrow();
  });

  it("rejects malformed collector semantics, unsafe escape hatches and inconsistent normalized targets", () => {
    const future = maintenanceSnapshot(); future.checks[0].observedAt = "2026-10-01T00:00:11.000Z";
    expect(() => core.parseMaintenanceSnapshot(future)).toThrow();
    const wrongTarget = maintenanceSnapshot(); wrongTarget.checks[0].target.kind = "service";
    expect(() => core.parseMaintenanceSnapshot(wrongTarget)).toThrow();
    const wrongBoundary = maintenanceSnapshot();
    wrongBoundary.checks[0].checkKind = "SecurityBoundary";
    wrongBoundary.checks[0].target.kind = "node";
    expect(() => core.parseMaintenanceSnapshot(wrongBoundary)).toThrow();
    wrongBoundary.checks[0].target.kind = "security-boundary";
    expect(() => core.parseMaintenanceSnapshot(wrongBoundary)).not.toThrow();
    const duplicate = maintenanceSnapshot(); duplicate.checks[2].checkId = duplicate.checks[1].checkId;
    expect(() => core.parseMaintenanceSnapshot(duplicate)).toThrow();
    for (const key of ["command", "shell", "executable", "script", "path", "url", "args", "credential", "token"]) {
      const snapshot = maintenanceSnapshot(); snapshot.checks[0][key] = "arbitrary";
      expect(() => core.parseMaintenanceSnapshot(snapshot)).toThrow();
      const plan = maintenancePlan(); plan.recommendations[0][key] = "arbitrary";
      expect(() => core.parseMaintenancePlan(plan)).toThrow();
    }
    const authority = maintenancePlan(); authority.semantics.authority = "approved";
    expect(() => core.parseMaintenancePlan(authority)).toThrow();
    const execution = maintenancePlan(); execution.semantics.executionPermission = true;
    expect(() => core.parseMaintenancePlan(execution)).toThrow();
    const accessor = maintenanceSnapshot(); Object.defineProperty(accessor.checks[0], "command", { get: () => "exec", enumerable: true });
    expect(() => core.parseMaintenanceSnapshot(accessor)).toThrow("Invalid JSON property");
  });
});

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
      "assertExpectedState", "assertRetryRequest", "bindActionReceipt", "bindActionRequest", "bindMaintenancePlan",
      "bindActionAttempt", "hashActionAttempt", "canonicalizeActionRequest", "canonicalizeMaintenancePlan",
      "canonicalizeMaintenanceSnapshot", "executableMutationAdapters", "hashActionRequest", "hashMaintenancePlan",
      "hashMaintenanceSnapshot", "maintenanceActionKinds", "maintenanceCheckKinds", "maintenancePlanSchema",
      "maintenanceSnapshotSchema", "parseActionRequest", "parseMaintenancePlan", "parseMaintenanceSnapshot", "typedActionBootstrap",
      "prepareBoundedCommit", "commitBoundedPatch", "getBoundedCommitStatus", "reconcileBoundedCommit",
      "assessProductionKvmReadiness", "hashProductionKvmCandidate", "hashProductionKvmEvidence",
      "parseProductionKvmCandidate", "parseProductionKvmEvidence", "productionKvmCandidateSchema",
      "productionKvmEvidenceSchema", "productionKvmReadinessGateNames",
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

const requiredKvmGates = [
  "stage1SubstrateKvm", "negativeCredentials", "negativeRepoExternalReads",
  "negativeUnapprovedNetwork", "negativeHostProcessSpawn",
  "negativeCanonicalControllerVerifierMutation", "negativeGenericShellToolEscalation",
  "negativeOutOfEvidencePathMutation", "cgroupResourceLimits", "providerOnlyEgress",
  "trustedHostOnlyOAuthCustody", "liveProviderCertification", "productionPlatformDurability",
  "exclusiveHostCustodyCurrentness",
];
function kvmCandidate(): any {
  return {
    schemaVersion: 1,
    identity: {
      inventory: { inventoryId: uuid, inventoryGeneration: 1, inventorySha256: hash },
      sourceCommit: structuredClone(commit),
      executorPackageSha256: hash, executorRuntimeSha256: hash, executorPolicySha256: hash,
      stage1ProofHashes: { substrateSha256: hash, negativeBoundarySha256: otherHash },
    },
    semantics: { oauthCustody: "HOST_ONLY", mutation: "FORBIDDEN", deployment: "FORBIDDEN",
      reviewSigningApproval: "FORBIDDEN", genericExecution: "FORBIDDEN" },
  };
}
function kvmEvidence(candidate = kvmCandidate()): any {
  return {
    schemaVersion: 1, candidateHash: core.hashProductionKvmCandidate(candidate),
    boundIdentity: structuredClone(candidate.identity),
    gates: Object.fromEntries(requiredKvmGates.map(name => [name, { result: "PASS", evidenceSha256: hash }])),
  };
}

describe("pure Production KVM Executor readiness", () => {
  it("requires exactly the named gates and never grants authority, execution, a permit or DONE", () => {
    const candidate = kvmCandidate(), evidence = kvmEvidence(candidate);
    expect(core.productionKvmReadinessGateNames).toEqual(requiredKvmGates);
    expect(Object.keys(core.parseProductionKvmEvidence(evidence).gates)).toEqual(requiredKvmGates);
    const ready = core.assessProductionKvmReadiness(candidate, evidence);
    expect(ready).toEqual({ candidateHash: evidence.candidateHash,
      evidenceHash: core.hashProductionKvmEvidence(evidence), status: "READY_FOR_HUMAN_BOUNDARY_REVIEW",
      authority: "NONE", productionExecution: false, permit: "NOT_ISSUED", done: false });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(core.parseProductionKvmCandidate(candidate).identity.sourceCommit)).toBe(true);
    expect(core.hashProductionKvmCandidate(reverseKeys(candidate))).toBe(ready.candidateHash);
    expect(core.hashProductionKvmEvidence(reverseKeys(evidence))).toBe(ready.evidenceHash);
    expect(core.hashProductionKvmCandidate(candidate)).not.toBe(core.hashProductionKvmEvidence(evidence));
    expect(core.executableMutationAdapters).toEqual([]);
  });

  it.each(requiredKvmGates)("blocks %s independently on FAIL or UNKNOWN and binds its evidence hash", name => {
    const candidate = kvmCandidate(), evidence = kvmEvidence(candidate);
    const baseline = core.assessProductionKvmReadiness(candidate, evidence);
    for (const result of ["FAIL", "UNKNOWN"]) {
      const changed = structuredClone(evidence); changed.gates[name].result = result;
      expect(core.assessProductionKvmReadiness(candidate, changed)).toMatchObject({
        status: "BLOCKED", authority: "NONE", productionExecution: false, permit: "NOT_ISSUED", done: false,
      });
    }
    const changed = structuredClone(evidence);
    changed.gates[name].evidenceSha256 = otherHash;
    const rebound = core.assessProductionKvmReadiness(candidate, changed);
    expect(rebound.status).toBe("READY_FOR_HUMAN_BOUNDARY_REVIEW");
    expect(rebound.evidenceHash).not.toBe(baseline.evidenceHash);
    expect(rebound.candidateHash).toBe(baseline.candidateHash);
  });

  it("fails closed for missing, extra or malformed gate evidence, without pre-hashing invalid data", () => {
    const candidate = kvmCandidate(), evidence = kvmEvidence(candidate);
    for (const name of requiredKvmGates) {
      const missing = structuredClone(evidence); delete missing.gates[name];
      expect(() => core.assessProductionKvmReadiness(candidate, missing)).toThrow();
      const malformed = structuredClone(evidence); malformed.gates[name].evidenceSha256 = "invalid";
      expect(() => core.assessProductionKvmReadiness(candidate, malformed)).toThrow();
      const extraField = structuredClone(evidence); extraField.gates[name].approved = true;
      expect(() => core.assessProductionKvmReadiness(candidate, extraField)).toThrow();
    }
    const extra = structuredClone(evidence); extra.gates.genericBoundary = { result: "PASS", evidenceSha256: hash };
    expect(() => core.assessProductionKvmReadiness(candidate, extra)).toThrow();
    const substitution = structuredClone(evidence);
    delete substitution.gates.negativeCredentials;
    substitution.gates.genericNegative = { result: "PASS", evidenceSha256: hash };
    expect(() => core.assessProductionKvmReadiness(candidate, substitution)).toThrow();
    const unknown = structuredClone(evidence); unknown.gates.stage1SubstrateKvm.result = "SKIPPED";
    expect(() => core.assessProductionKvmReadiness(candidate, unknown)).toThrow();
  });

  it("blocks mismatched candidate hash or bound identity and hashes each candidate identity field", () => {
    const candidate = kvmCandidate(), evidence = kvmEvidence(candidate);
    const blocked = { status: "BLOCKED", authority: "NONE", productionExecution: false,
      permit: "NOT_ISSUED", done: false };
    const wrongHash = structuredClone(evidence); wrongHash.candidateHash = otherHash;
    expect(core.assessProductionKvmReadiness(candidate, wrongHash)).toMatchObject(blocked);
    const wrongIdentity = structuredClone(evidence); wrongIdentity.boundIdentity.inventory.inventoryId = otherId;
    expect(core.assessProductionKvmReadiness(candidate, wrongIdentity)).toMatchObject(blocked);
    for (const path of [
      ["inventory", "inventoryId"], ["inventory", "inventoryGeneration"], ["inventory", "inventorySha256"],
      ["sourceCommit", "digest"], ["executorPackageSha256"], ["executorRuntimeSha256"],
      ["executorPolicySha256"], ["stage1ProofHashes", "substrateSha256"],
      ["stage1ProofHashes", "negativeBoundarySha256"],
    ]) {
      const changed = kvmCandidate();
      let node = changed.identity;
      for (const key of path.slice(0, -1)) node = node[key];
      const key = path.at(-1)!;
      node[key] = typeof node[key] === "number" ? node[key] + 1
        : node[key] === uuid ? otherId : node[key] === hash ? otherHash
          : node[key] === otherHash ? hash : "b".repeat(40);
      expect(core.hashProductionKvmCandidate(changed)).not.toBe(evidence.candidateHash);
      expect(core.assessProductionKvmReadiness(changed, evidence)).toMatchObject(blocked);
    }
  });

  it("fixes custody and forbidden semantics and rejects unsafe JSON at every boundary", () => {
    const candidate = kvmCandidate(), evidence = kvmEvidence(candidate);
    for (const key of Object.keys(candidate.semantics)) {
      const changed = structuredClone(candidate); changed.semantics[key] = "ALLOWED";
      expect(() => core.assessProductionKvmReadiness(changed, evidence)).toThrow();
    }
    for (const [location, value] of [
      [candidate, "candidate"], [candidate.identity, "identity"],
      [candidate.identity.stage1ProofHashes, "proofs"], [evidence, "evidence"],
      [evidence.boundIdentity, "bound identity"], [evidence.gates, "gates"],
    ] as const) {
      const changed = value === "candidate" || value === "identity" || value === "proofs"
        ? structuredClone(candidate) : structuredClone(evidence);
      const target = value === "candidate" ? changed : value === "identity" ? changed.identity
        : value === "proofs" ? changed.identity.stage1ProofHashes
          : value === "evidence" ? changed : value === "bound identity" ? changed.boundIdentity : changed.gates;
      target.command = "arbitrary";
      expect(() => value === "candidate" || value === "identity" || value === "proofs"
        ? core.assessProductionKvmReadiness(changed, evidence)
        : core.assessProductionKvmReadiness(candidate, changed)).toThrow();
      expect(location).toBeDefined();
    }
    const accessor = kvmEvidence(candidate);
    Object.defineProperty(accessor.gates.stage1SubstrateKvm, "result", {
      get: () => { throw new Error("getter invoked"); }, enumerable: true,
    });
    expect(() => core.assessProductionKvmReadiness(candidate, accessor)).toThrow("Invalid JSON property");
    const prototype = kvmCandidate(); Object.setPrototypeOf(prototype.identity, { command: "arbitrary" });
    expect(() => core.assessProductionKvmReadiness(prototype, evidence)).toThrow("Expected plain JSON data");
    const hidden = kvmEvidence(candidate); hidden.gates[Symbol("hidden")] = true;
    expect(() => core.assessProductionKvmReadiness(candidate, hidden)).toThrow();
  });
});

describe("bounded local commit", () => {
  function fixture(large = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-commit-"));
    const repo = path.join(dir, "repo"), stateDir = path.join(dir, "state");
    fs.mkdirSync(repo); fs.mkdirSync(stateDir);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@localhost");
    fs.writeFileSync(path.join(repo, "scope.txt"), "before\n");
    fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
    git("add", "--", "scope.txt", "other.txt"); git("commit", "-qm", "baseline");
    const baseline = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "scope.txt"), large ? "after\n".repeat(1800) : "after\n");
    const patch = execFileSync("git", ["-C", repo, "diff", "--binary", "HEAD", "--", "scope.txt"]);
    const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
    const taskId = `bounded-${"1".repeat(32)}`, reviewId = `review-${uuid}`;
    const contractHash = sha("contract"), manifestHash = sha("manifest");
    const task: any = { task_id: taskId, state: "REVIEW_ACCEPTED", contract_sha256: contractHash,
      baseline_head: baseline, baseline: { "scope.txt": sha("before\n") },
      contract: { edit_paths: ["scope.txt"] },
      revisions: [{ revision: 1, manifest_sha256: manifestHash,
        review: { review_id: reviewId, reviewer: "chatgpt", task_id: taskId, revision: 1,
          contract_sha256: contractHash, manifest_sha256: manifestHash, verdict: "PASS" } }] };
    const artifact = { name: "revision-1-diff.patch", size: patch.length, sha256: sha(patch) };
    const tasks = {
      status: () => task,
      artifacts: () => ({ task_id: taskId, revision: 1, contract_sha256: contractHash,
        manifest_sha256: manifestHash, files: [artifact] }),
      readArtifact: (_id: string, _revision: number, _name: string, offset: number) => {
        const page = patch.subarray(offset, offset + 8192);
        return { manifest_sha256: manifestHash, file_sha256: artifact.sha256, offset,
          content_base64: page.toString("base64"), next_offset: offset + page.length === patch.length ? null : offset + page.length };
      },
      acceptedSnapshot: () => { throw new Error("Commit must not call acceptedSnapshot"); },
    } as unknown as BoundedTasks;
    const prepared = { task_id: taskId, revision: 1, review_id: reviewId, reviewer: "chatgpt",
      contract_sha256: contractHash, manifest_sha256: manifestHash, diff_sha256: artifact.sha256,
      baseline_head: baseline, baseline: task.baseline, edit_paths: ["scope.txt"], artifact,
      state: "PREPARED", authoritative_done: false };
    const file = path.join(stateDir, "bounded-prepared-v1", `${taskId}.json`);
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ receipt: prepared, seal: sha(canonicalJson(prepared)) }));
    return { dir, repo, stateDir, git, task, tasks, taskId, file, prepared, sha };
  }
  it.each([false, true])("commits exact prepared bytes once (large=%s), survives restart", large => {
    const f = fixture(large);
    try {
      if (large) expect(f.prepared.artifact.size).toBeGreaterThan(8192);
      expect(core.getBoundedCommitStatus(f.tasks, f.taskId, f.stateDir).state).toBe("PREPARED");
      const committed = core.commitBoundedPatch(f.tasks, f.taskId, f.stateDir, f.repo);
      expect(committed).toMatchObject({ state: "COMMITTED", authoritative_done: false,
        prepared_receipt_digest: f.sha(canonicalJson(f.prepared)) });
      expect(f.git("rev-list", "--count", `${f.prepared.baseline_head}..HEAD`)).toBe("1");
      expect(f.git("rev-parse", "HEAD^")).toBe(f.prepared.baseline_head);
      expect(f.git("diff", "--name-only", "--no-renames", f.prepared.baseline_head, "HEAD")).toBe("scope.txt");
      const committedPatch = execFileSync("git", ["-C", f.repo, "diff", "--binary",
        f.prepared.baseline_head, "HEAD", "--", "scope.txt"]);
      expect(committedPatch.length).toBe(f.prepared.artifact.size);
      expect(f.sha(committedPatch)).toBe(f.prepared.diff_sha256);
      expect(f.git("status", "--porcelain=v1", "--untracked-files=all")).toBe("");
      expect(core.getBoundedCommitStatus(f.tasks, f.taskId, f.stateDir)).toEqual(committed);
      expect(core.commitBoundedPatch(f.tasks, f.taskId, f.stateDir, f.repo)).toEqual(committed);
      expect(f.git("rev-list", "--count", `${f.prepared.baseline_head}..HEAD`)).toBe("1");
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
  it("reconciles the exact post-commit/pre-receipt crash without another commit", () => {
    const f = fixture();
    try {
      const first = core.commitBoundedPatch(f.tasks, f.taskId, f.stateDir, f.repo);
      fs.unlinkSync(path.join(f.stateDir, "bounded-committed-v1", `${f.taskId}.json`));
      expect(core.commitBoundedPatch(f.tasks, f.taskId, f.stateDir, f.repo)).toEqual(first);
      expect(f.git("rev-list", "--count", `${f.prepared.baseline_head}..HEAD`)).toBe("1");
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
  it("projects an existing sealed receipt after subsequent repository work", () => {
    const f = fixture();
    try {
      core.commitBoundedPatch(f.tasks, f.taskId, f.stateDir, f.repo);
      fs.writeFileSync(path.join(f.repo, "other.txt"), "later work\n");
      f.git("add", "other.txt"); f.git("commit", "-qm", "later fixture work");
      const head = f.git("rev-parse", "HEAD");
      expect(core.reconcileBoundedCommit(f.tasks, f.taskId, f.stateDir, f.repo)).toBe(true);
      expect(f.git("rev-parse", "HEAD")).toBe(head);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
  it("rejects reviewer drift before a local commit", () => {
    const f = fixture();
    try {
      f.task.revisions[0].review.reviewer = "opencode-semantic";
      expect(() => core.commitBoundedPatch(f.tasks, f.taskId, f.stateDir, f.repo)).toThrow();
      expect(f.git("rev-parse", "HEAD")).toBe(f.prepared.baseline_head);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
  it.each(["staged", "untracked", "out-of-scope", "stale", "tampered"])("rejects %s before committing", kind => {
    const f = fixture();
    try {
      if (kind === "staged") f.git("add", "--", "scope.txt");
      if (kind === "untracked") fs.writeFileSync(path.join(f.repo, "new.txt"), "new\n");
      if (kind === "out-of-scope") fs.writeFileSync(path.join(f.repo, "other.txt"), "changed\n");
      if (kind === "stale") f.task.revisions[0].review.review_id = `review-${otherId}`;
      if (kind === "tampered") fs.appendFileSync(f.file, " ");
      if (kind === "tampered") {
        const value = JSON.parse(fs.readFileSync(f.file, "utf8"));
        value.receipt.diff_sha256 = "0".repeat(64);
        fs.writeFileSync(f.file, JSON.stringify(value));
      }
      expect(() => core.commitBoundedPatch(f.tasks, f.taskId, f.stateDir, f.repo)).toThrow();
      expect(f.git("rev-parse", "HEAD")).toBe(f.prepared.baseline_head);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
  it("rejects a tampered COMMITTED seal and never runs remote Git", () => {
    const f = fixture();
    try {
      core.commitBoundedPatch(f.tasks, f.taskId, f.stateDir, f.repo);
      const file = path.join(f.stateDir, "bounded-committed-v1", `${f.taskId}.json`);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      record.receipt.commit = f.prepared.baseline_head;
      fs.writeFileSync(file, JSON.stringify(record));
      expect(() => core.getBoundedCommitStatus(f.tasks, f.taskId, f.stateDir)).toThrow();
      expect(() => core.commitBoundedPatch(f.tasks, f.taskId, f.stateDir, f.repo)).toThrow();
      expect(f.git("remote")).toBe("");
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
});
