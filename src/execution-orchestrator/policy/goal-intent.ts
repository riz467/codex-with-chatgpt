import { z } from "zod";
import { exactScopeSchema, freeze, parseStrict } from "../../task-contract/contract.js";

/**
 * Evidence provenance (not an authority port): external ai-common.ps1 HEAD and
 * tests/goal-intent.ps1 HEAD distinguish complete prohibitions from later requests
 * and filenames from actions. Working-tree Get-AiGoalDecision and the dirty goal
 * and approval tests add explicit scope, reason codes and unresolved evidence.
 * Neither source is authoritative: ALLOW_BOUNDED_EDIT, allowed_operations on STOP,
 * approval/resume, engine execution and local verification authority are rejected.
 * This lexical assessment cannot prove tracking, existence, reparse safety or intent.
 */
const inputSchema = z.object({
  goal: z.string().min(1).max(8000).refine(value => value.trim().length > 0 &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)),
  // Empty scope has its own diagnostic; otherwise reuse the canonical lexical contract.
  editPaths: z.array(z.string()).max(20),
}).strict();

type ReasonCode = "INPUT_INVALID" | "SCOPE_MISSING" | "SCOPE_INVALID" |
  "LIVE_OPERATION_REQUESTED" | "INTENT_UNRESOLVED" | "BOUNDED_SCOPE_CANDIDATE";
type Evidence = Readonly<{ source: "input" | "editPaths" | "goal"; code: string; excerpt: string }>;
type AssessmentBase = Readonly<{
  assessmentVersion: 1;
  authority: "NONE";
  reasonCode: ReasonCode;
  reason: string;
  evidence: readonly Evidence[];
}>;
export type GoalIntentAssessment = AssessmentBase & (
  Readonly<{ kind: "STOP" }> |
  Readonly<{ kind: "CANDIDATE_BOUNDED_SCOPE"; candidateScope: readonly string[];
    requiresBinding: "RC02_REQUEST_ATTEMPT_GATE" }>
);

const ambiguous = /\b(?:handle this|as appropriate|whatever|anything|everything|fix it|clean up|make it better|unspecified|one of|any file|some files|whichever)\b|全部|何でも|適当に|適宜|いい感じ|任せ|よしなに/i;
const bounded = /\b(?:document|describe|write|record|draft|edit|update|review)\b|文書|ドキュメント|記録|追記|記載|説明|編集|レビュー/i;
const live = /\b(?:actual|live|production|external|tailnet|service|server|remote|origin|credential|secret|cpu type|vm)\b|本番|実環境|稼働|外部|実ポリシー|秘密鍵|認証情報/i;
const risky = /(?<![a-z])(?:commit|push|deploy|publish|apply|delete|remove|drop|erase|reset|clean|tag|restart|reboot|shutdown|execute|run|install|rotate|revoke|migrate|ssh|scp|sftp|rsync|sudo|systemctl|qm|pct|pwsh|powershell|bash|cmd|curl|wget|npm|pnpm|node|python)(?![a-z])|適用|反映|実行|削除|消去|公開|再起動|停止|投入|移行|接続|除去/i;
const change = /\b(?:change|modify|update)\b|変更|更新/i;
// Deliberately narrow: a negation anywhere in a clause must not suppress its actions.
const operationList = "(?:commit|push|deploy|publish|apply|delete|remove|restart|ssh)";
const prohibition = new RegExp(`^(?:do not|don't|never|no)\\s+${operationList}(?:\\s+(?:and|or)\\s+${operationList})*\\s*$|^${operationList}(?:\\s+(?:and|or)\\s+${operationList})*\\s+are prohibited$|^(?:commit|push)(?:\\s*[・/,、]\\s*(?:commit|push))*\\s*(?:は|を)?\\s*(?:禁止(?:です)?|不要(?:です)?|しない(?:でください)?|行わない)$`, "i");
const policyProhibition = /^do not apply the actual tailnet policy, commit or push$/i;
const command = /\b(?:git\s+\w+|ssh\s+(?!execution\b|example\b)\S+|(?:pwsh|powershell|bash|cmd|sudo|systemctl|npm|pnpm|node|python|curl|wget)\s+\S+)\b|[|`<]|(?<!-)>|\$\(/i;
const executable = /\.(?:exe|cmd|bat|ps1|sh)\b/i;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pure, fail-closed evidence only. No output is a gate or execution capability.
 * Malformed plain structured data returns STOP; no coercion or unknown-field stripping.
 * Confidence is neither accepted nor emitted. Candidate scope needs later independent
 * RC-02 request/attempt/gate binding AND host authorization; binding alone is not authority.
 */
export function assessGoalIntent(input: unknown): GoalIntentAssessment {
  const evidence: Evidence[] = [];
  const stop = (reasonCode: ReasonCode, reason: string): GoalIntentAssessment => freeze({
    assessmentVersion: 1 as const, kind: "STOP" as const, authority: "NONE" as const,
    reasonCode, reason, evidence,
  });
  let parsed: z.infer<typeof inputSchema>;
  try { parsed = parseStrict(inputSchema, input); }
  catch {
    evidence.push({ source: "input", code: "input:invalid", excerpt: "Expected only goal and editPaths as plain data." });
    return stop("INPUT_INVALID", "Malformed or unknown structured input; clarify the request.");
  }
  const { goal, editPaths } = parsed;
  if (!editPaths.length) {
    evidence.push({ source: "editPaths", code: "edit_paths:empty", excerpt: "" });
    return stop("SCOPE_MISSING", "Explicit file targets are required.");
  }
  if (!exactScopeSchema.safeParse(editPaths).success) {
    evidence.push({ source: "editPaths", code: "edit_paths:invalid", excerpt: editPaths.join(",") });
    return stop("SCOPE_INVALID", "Scope is unsafe, ambiguous, aliased, duplicate or not ordinal-sorted.");
  }
  // Mask only the declared scope, not arbitrary filenames that could hide commands.
  let text = goal;
  for (const path of editPaths) text = text.replace(new RegExp(`(?<![\\w./-])${escapeRegex(path)}(?![\\w/-]|\\.[\\w.])`, "g"), "__scope_reference__");
  if (executable.test(text)) {
    evidence.push({ source: "goal", code: "goal:operation", excerpt: text });
    return stop("LIVE_OPERATION_REQUESTED", "Executable intent is outside candidate file scope.");
  }
  if (/[\w./\\:-]+\.[a-z0-9]{1,8}\b/i.test(text)) {
    evidence.push({ source: "goal", code: "goal:path-ambiguity", excerpt: text });
    return stop("SCOPE_INVALID", "Goal references an undeclared or ambiguous file target.");
  }
  if (ambiguous.test(text)) {
    evidence.push({ source: "goal", code: "goal:open-ended", excerpt: text });
    return stop("INTENT_UNRESOLVED", "Open-ended intent cannot establish bounded scope.");
  }
  let hasBoundedIntent = false;
  let operationDetected = false;
  let unresolved = false;
  for (const clause of text.split(/[。.!?；;\r\n]+|\b(?:then|but|after that|afterwards)\b|その後|続いて/i)) {
    const part = clause.trim();
    if (!part) continue;
    if (prohibition.test(part) || policyProhibition.test(part)) {
      evidence.push({ source: "goal", code: "goal:prohibition", excerpt: part });
      continue;
    }
    const documentIntent = bounded.test(part);
    // Only explicit narrative examples/history, not a document keyword anywhere.
    const narrative = /^(?:write|document|describe|record)\b/i.test(part) &&
      /\b(?:example|history|historical)\b/i.test(part) && !live.test(part) &&
      !command.test(part) && !/\b(?:and|also)\s+(?:run|execute|apply|deploy|push|commit|restart)\b/i.test(part);
    const narrativeOnly = narrative && (part.match(new RegExp(risky.source, "gi")) ?? [])
      .every(word => /^(?:ssh|delete|remove|publish)$/i.test(word));
    const operation = command.test(part) || executable.test(part) ||
      (risky.test(part) && !narrativeOnly) || (change.test(part) && (!documentIntent || live.test(part)));
    if (operation) {
      operationDetected = true;
      evidence.push({ source: "goal", code: "goal:operation", excerpt: part });
    } else if (documentIntent && !/^(?:do not|don't|never|no)\b/i.test(part)) {
      hasBoundedIntent = true;
      evidence.push({ source: "goal", code: narrativeOnly ? "goal:document-context" : "goal:bounded-edit-intent", excerpt: part });
    } else {
      unresolved = true;
      evidence.push({ source: "goal", code: "goal:unresolved-operation", excerpt: part });
    }
  }
  if (operationDetected) return stop("LIVE_OPERATION_REQUESTED", "Operation intent is outside candidate file scope; no authority is granted.");
  if (unresolved || !hasBoundedIntent) return stop("INTENT_UNRESOLVED", "Cannot establish exclusively bounded editing or documentation intent.");
  evidence.push({ source: "editPaths", code: "edit_paths:explicit", excerpt: editPaths.join(",") });
  return freeze({ assessmentVersion: 1 as const, kind: "CANDIDATE_BOUNDED_SCOPE" as const,
    authority: "NONE" as const, reasonCode: "BOUNDED_SCOPE_CANDIDATE" as const,
    reason: "Heuristic candidate only; requires independent RC-02 binding and host authorization.",
    candidateScope: [...editPaths], requiresBinding: "RC02_REQUEST_ATTEMPT_GATE" as const, evidence });
}
