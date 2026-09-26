import { describe, expect, it } from "vitest";
import { autonomousState } from "../src/mcp/autonomous-read-model.js";

describe("autonomous source-of-truth projection", () => {
  const run = { phase: "HUMAN_FINAL_APPROVAL", structural_result: "PASS", semantic_result: "PASS" };
  const result = { state: "HUMAN_FINAL_APPROVAL", review_result: "PASS" };
  it("never infers DONE from Review PASS or approval waiting", () => {
    expect(autonomousState(run, result, null, "rpc-1")).toMatchObject({ done: false, waiting: true, state: "HUMAN_FINAL_APPROVAL" });
    expect(autonomousState(run, result, { task_id: "rpc-2", state: "DONE" }, "rpc-1").done).toBe(false);
    expect(autonomousState(run, { state: "DONE", review_result: "PASS" }, null, "rpc-1").state).toBeNull();
    expect(autonomousState({ phase: "DONE" }, null, null, "rpc-1").state).toBeNull();
  });
  it("only the matching engine task ledger supplies DONE", () => {
    expect(autonomousState(run, result, { task_id: "rpc-1", state: "DONE" }, "rpc-1"))
      .toMatchObject({ done: true, waiting: false, state: "DONE", actor: "IDLE" });
  });
  it("a semantic veto does not become an approval wait", () => {
    expect(autonomousState({ phase: "ESCALATE", structural_result: "PASS", semantic_result: "NEEDS_WORK" },
      { state: "ESCALATE", review_result: "NEEDS_WORK" }, null, "rpc-1"))
      .toMatchObject({ done: false, waiting: false, state: "ESCALATE" });
  });
});
