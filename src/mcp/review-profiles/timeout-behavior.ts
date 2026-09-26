// Fixture/domain-specific behavioral assertion. The original sealed goal, never
// the Review profile, supplies the requested numeric value.
export function timeoutBehavior(goal: string, test: Record<string, unknown>) {
  const changes = [...goal.matchAll(/(?:from\s+([\d,_]+)\s*(?:ms|milliseconds)?\s+to\s+(?:exactly\s+)?|([\d,_]+)\s*(?:ms|milliseconds)\s*(?:→|->)\s*)([\d,_]+)\s*(?:ms|milliseconds)/gi)];
  const targets = changes.map(change => Number(change[3].replaceAll(/[,_]/g, "")));
  const expected = targets.length && targets.every(value => value === targets[0]) ? targets[0] : NaN;
  if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(test.observed_timeout_ms) || test.observed_timeout_ms !== expected) {
    return { reason_category: Number.isSafeInteger(expected) ? "GOAL_NOT_SATISFIED" : "REQUIREMENT_AMBIGUOUS",
      unresolved_issues: ["Sealed behavioral observation does not establish the original goal's requested value."] };
  }
  return null;
}
