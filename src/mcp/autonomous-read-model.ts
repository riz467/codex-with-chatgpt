// Read-only projection: the engine task ledger alone owns DONE. Neither a
// Review PASS nor an autonomous result may promote an execution task to DONE.
type Row = Record<string, unknown> | null;

export function autonomousState(run: Row, result: Row, task: Row, taskId: string) {
  const phase = typeof run?.phase === "string" ? run.phase : null;
  const done = task?.task_id === taskId && task.state === "DONE";
  const waiting = phase === "HUMAN_FINAL_APPROVAL" && result?.review_result === "PASS" && !done;
  const actor = done ? "IDLE" : phase === "EXECUTE" ? "CODEX" :
    phase === "REVIEWING" || phase === "REVIEW_HANDOFF" ? "REVIEW" :
    waiting ? "HUMAN" : phase === "RESEARCH" || phase === "PLAN" || phase === "VERIFY" ? "OPENCODE" : "UNKNOWN";
  const candidate = typeof result?.state === "string" ? result.state : phase;
  return { phase, done, waiting, actor,
    state: done ? "DONE" : candidate === "DONE" ? null : candidate,
    review_phase: { structural: run?.structural_result ?? null, semantic: run?.semantic_result ?? null } };
}
