export const phases = ["PREFLIGHT", "CREATING", "ISOLATION_VERIFY", "BOOTSTRAPPING", "KEYING", "CROSS_PINNING",
  "DEPLOYING", "STARTING", "VERIFYING", "E2E"] as const;
export const states = ["PREPARED", "WAITING_HUMAN_AUTHORIZATION", "AUTHORIZED", ...phases,
  "READY_FOR_PASSKEY_CUTOVER", "COMPLETE", "BLOCKED", "RECONCILE_REQUIRED"] as const;
export type State = typeof states[number];
export type StepState = "NOT_STARTED" | "INTENT_DURABLE" | "DISPATCHED" | "OBSERVED" | "VERIFIED";
export const terminal = (state: State): boolean => ["COMPLETE", "BLOCKED", "RECONCILE_REQUIRED"].includes(state);
export function assertTransition(from: State, to: State): void {
  if (terminal(from)) throw new Error("Terminal campaign");
  if (to === "BLOCKED" || to === "RECONCILE_REQUIRED") return;
  const normal: readonly State[] = ["PREPARED", "WAITING_HUMAN_AUTHORIZATION", "AUTHORIZED", ...phases,
    "READY_FOR_PASSKEY_CUTOVER", "COMPLETE"];
  if (normal.indexOf(to) !== normal.indexOf(from) + 1) throw new Error("Invalid state transition");
}
