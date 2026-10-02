import { describe, expect, it } from "vitest";
import * as goalIntent from "../src/execution-orchestrator/policy/goal-intent.js";
import { assessGoalIntent, type GoalIntentAssessment } from "../src/execution-orchestrator/policy/goal-intent.js";

const paths = ["README.md", "docs/security-ct700-tailnet-policy-migration.md"];
const assess = (goal: string, editPaths = paths) => assessGoalIntent({ goal, editPaths });
function noAuthority(result: GoalIntentAssessment) {
  expect(result.authority).toBe("NONE");
  for (const key of ["operations", "allowed_operations", "allowedOperations", "authorized", "approved",
    "executionMayStart", "retry", "retryPermission", "completion", "doneApproved", "PASS", "DONE"]) {
    expect(result).not.toHaveProperty(key);
  }
}

describe("RC02 pure STOP / candidate scope evidence, never an authorization gate", () => {
  it("has only the assessment API, no retry/completion/dispatcher exports", () => {
    expect(Object.keys(goalIntent)).toEqual(["assessGoalIntent"]);
  });

  it.each([
    "Document the bounded local review workflow in README.md.",
    "Edit README.md. Do not commit or push.",
    "Document a policy candidate removing member-wide autogroup:member -> funnel nodeAttrs in the two Markdown files. Do not apply the actual tailnet policy, commit or push.",
    "Write an SSH execution example and a delete/remove/publish history in the documents.",
    "Document docs/security-ct700-tailnet-policy-migration.md.",
  ])("returns only a non-authoritative candidate: %s", goal => {
    const result = assess(goal);
    expect(result.kind).toBe("CANDIDATE_BOUNDED_SCOPE");
    expect(result.reasonCode).toBe("BOUNDED_SCOPE_CANDIDATE");
    expect(result).toHaveProperty("requiresBinding", "RC02_REQUEST_ATTEMPT_GATE");
    expect(result).toHaveProperty("candidateScope", paths);
    expect(result.reason).toContain("host authorization");
    expect(result.evidence.length).toBeGreaterThan(0);
    noAuthority(result);
  });

  // HEAD goal-intent and approval-gate risk cases, plus dirty structured regressions.
  it.each([
    "commitしてください", "pushしてください", "変更後にcommitしてpushしてください",
    "git push origin main", "force pushしてください", "commitまでやって", "commit and push",
    "origin/mainへpush", "commitは禁止。変更後にpushしてください",
    "do not commit, but git push origin main", "commit・pushは禁止。その後commitしてください",
    "do not commit or pushしてください", "Document the candidate, then apply the actual tailnet policy.",
    "Document the candidate and apply the policy.", "Do not push. After editing, git push origin main.",
    "Edit the documents and ssh host to restart the service.", "deploy to production",
    "本番反映を実行する", "production変更の実行", "本番環境の設定を変更して",
    "change production settings", "CPU Typeをhostへ変更して", "VMを停止して",
    "npm installを実行して", "本番反映して", "git pushして", "deployして",
    "secretを削除して", "delete the README file", "remove the README file",
    "secretを変更して保存", "rotate credentials in production",
    "Edit README.md and restart the service.", "Document the change and run node script.js.",
    "Execute tool.exe", "pwsh -Command whoami", "bash -c whoami", "cmd /c whoami",
    "Document an example and execute it.", "Do not push, and restart production.",
    "Never commit and deploy to production.", "Document a history and push origin main.",
    "Document a restart example, restart it.", "Document history, execute the example.",
  ])("risky intent fails closed without executable operations: %s", goal => {
    const result = assess(goal);
    expect(result.kind).toBe("STOP");
    expect(result).not.toHaveProperty("candidateScope");
    noAuthority(result);
  });

  it.each([
    "Edit the documents and handle the production change as appropriate.",
    "Document the candidate; handle the production change as appropriate.",
    "Handle the unspecified operation as appropriate.", "Do the unspecified thing.",
    "fix it", "make it better", "anything", "よしなに", "Do not push.", "Bonjour",
    "Document README.md; something else", "Do not edit README.md.",
    "Edit one of the documents.", "Edit whichever file needs it.",
  ])("ambiguous or unresolved intent fails closed: %s", goal => {
    const result = assess(goal);
    expect(result.kind).toBe("STOP");
    expect(result.reasonCode).toBe("INTENT_UNRESOLVED");
    noAuthority(result);
  });

  it("requires explicit targets rather than inferring them from the goal", () => {
    const result = assess("Edit README.md", []);
    expect(result.reasonCode).toBe("SCOPE_MISSING");
    expect(result.kind).toBe("STOP");
    noAuthority(result);
  });

  it("retains dirty reason/evidence semantics without returning operation descriptors", () => {
    const live = assess("Document the candidate, then apply the actual tailnet policy.");
    expect(live.reasonCode).toBe("LIVE_OPERATION_REQUESTED");
    expect(live.evidence).toContainEqual({ source: "goal", code: "goal:operation", excerpt: "apply the actual tailnet policy" });
    const uncertain = assess("Edit the documents and handle the production change as appropriate.");
    expect(uncertain.reasonCode).toBe("INTENT_UNRESOLVED");
    expect(uncertain.evidence[0].code).toBe("goal:open-ended");
    const candidate = assess("Edit README.md. Do not commit or push.");
    expect(candidate.evidence).toContainEqual({ source: "goal", code: "goal:prohibition", excerpt: "Do not commit or push" });
    noAuthority(live);
    noAuthority(uncertain);
    noAuthority(candidate);
  });

  it.each([
    ["../outside.md"], ["/absolute.md"], ["C:/file.md"], ["docs\\file.md"],
    ["docs//file.md"], ["docs/./file.md"], ["README.md", "README.md"],
    ["README.md", "readme.md"], ["docs/file.md", "README.md"], [".git/config"],
    [".ai/status.json"], ["CON.txt"], ["file.md."], ["file.md "], ["a\u0000.md"], ["*.md"],
  ])("rejects unsafe or ambiguous scope %j", (...scope) => {
    const result = assess("Edit the documents", scope);
    expect(result.kind).toBe("STOP");
    expect(result.reasonCode).toBe("SCOPE_INVALID");
    noAuthority(result);
  });

  it("does not mask an undeclared filename as scope evidence", () => {
    expect(assess("Edit SECOND.md").reasonCode).toBe("SCOPE_INVALID");
    expect(assess("Edit ../README.md").kind).toBe("STOP");
  });

  it.each([undefined, null, [], "Edit README.md", {}, { goal: "", editPaths: paths },
    { goal: " \n", editPaths: paths }, { goal: 4, editPaths: paths },
    { goal: "Edit README.md", editPaths: "README.md" }, { goal: "Edit README.md", editPaths: [null] },
    { goal: "Edit\u0000README.md", editPaths: paths }])("rejects malformed structured input %j", input => {
    const result = assessGoalIntent(input);
    expect(result.kind).toBe("STOP");
    expect(result.reasonCode).toBe("INPUT_INVALID");
    noAuthority(result);
  });

  it.each(["confidence", "authorized", "allowed_operations", "action", "proposed_command", "executable",
    "PASS", "DoneApproved", "retry", "completion", "request", "attempt", "gate", "new_text", "stderr"])(
    "rejects unknown/authority/engine field %s rather than trusting it", key => {
      const result = assessGoalIntent({ goal: "Edit README.md", editPaths: paths, [key]: 1 });
      expect(result.kind).toBe("STOP");
      expect(result.reasonCode).toBe("INPUT_INVALID");
      noAuthority(result);
    });

  it("rejects hidden authority, getters, custom prototypes and sparse arrays without reading getters", () => {
    let invoked = false;
    const getter = { editPaths: paths };
    Object.defineProperty(getter, "goal", { enumerable: true, get() { invoked = true; return "Edit README.md"; } });
    const hidden = { goal: "Edit README.md", editPaths: paths };
    Object.defineProperty(hidden, "confidence", { value: 1 });
    const inherited = Object.assign(Object.create({ authorized: true }), hidden);
    for (const input of [getter, hidden, inherited, { goal: "Edit README.md", editPaths: new Array(1) }]) {
      expect(assessGoalIntent(input).reasonCode).toBe("INPUT_INVALID");
    }
    expect(invoked).toBe(false);
  });

  it("is deterministic and returns frozen detached evidence/scope without freezing caller data", () => {
    const input = { goal: "Edit README.md", editPaths: [...paths] };
    const result = assessGoalIntent(input);
    expect(result).toEqual(assessGoalIntent(input));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence[0])).toBe(true);
    expect(Object.isFrozen(input.editPaths)).toBe(false);
    input.editPaths[0] = "OTHER.md";
    expect(result).toHaveProperty("candidateScope", paths);
    if (result.kind === "CANDIDATE_BOUNDED_SCOPE") expect(Object.isFrozen(result.candidateScope)).toBe(true);
  });

  it("intentionally does not port dirty ALLOW, STOP permissions, permissive negation or engine transitions", () => {
    // Dirty Get-AiGoalDecision returns allowed_operations even on STOP and treats
    // a document keyword or broad negation as enough to suppress some operations.
    const stopped = assess("Edit README.md and restart the service");
    expect(stopped.kind).toBe("STOP");
    noAuthority(stopped);
    expect(assess("Document restart instructions and restart").kind).toBe("STOP");
    expect(assess("Do not push, restart the service").kind).toBe("STOP");
    // External approval-gate's VERIFYING/edit/seal behavior is NOT a candidate result.
    const candidate = assess("Edit README.md");
    expect(candidate.kind).toBe("CANDIDATE_BOUNDED_SCOPE");
    expect(candidate).not.toHaveProperty("state");
    noAuthority(candidate);
    // A perfect caller score is still an unknown field, never an authority override.
    expect(assessGoalIntent({ goal: "Edit README.md", editPaths: paths, confidence: 1 }).kind).toBe("STOP");
  });
});
