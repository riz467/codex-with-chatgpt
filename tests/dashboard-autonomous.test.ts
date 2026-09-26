import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { Collector } from "../src/dashboard/collector.js";
import { REVIEW_ROOT } from "../src/mcp/local-gateway.js";

describe("read-only autonomous dashboard projection", () => {
  it.skipIf(!fs.existsSync(`${REVIEW_ROOT}\\rpc-jobs\\auto-4b089f56be4c411db2689c3889860815`))(
    "projects sealed lifecycle and usage without promoting approval to DONE", () => {
      const run = new Collector().autonomousRuns(200).find(row => row.run_id === "auto-4b089f56be4c411db2689c3889860815");
      expect(run).toMatchObject({ phase: "HUMAN_FINAL_APPROVAL", actor: "HUMAN", human_action_required: true,
        done: false, review_phase: { structural: "PASS", semantic: "PASS" } });
      expect(run?.usage).toMatchObject({ opencode: { input: 3821, output: 205 }, codex_invocations: 1,
        review: { input: 1540, output: 63, cache_read: 141 } });
      expect(run?.events.some(event => event.event_type === "human.final_approval_waiting")).toBe(true);
    });
  it.skipIf(!fs.existsSync(`${REVIEW_ROOT}\\rpc-jobs\\auto-177630f1a7434cbaa94714cb1b36bd06`))(
    "shows the rejected semantic result without inferring DONE from structural PASS", () => {
      const runs = new Collector().autonomousRuns(200);
      expect(runs.find(row => row.run_id === "auto-177630f1a7434cbaa94714cb1b36bd06"))
        .toMatchObject({ phase: "ESCALATE", done: false, human_action_required: false,
          review_phase: { structural: "PASS", semantic: "NEEDS_WORK" } });
      expect(runs.find(row => row.run_id === "auto-32c1d0813c5d4ee4b3a07d96ee29352e"))
        .toMatchObject({ done: true, human_action_required: false });
    });
});
