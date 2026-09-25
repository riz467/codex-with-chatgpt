import { describe, expect, it } from "vitest";
import { stateLabel, modeLabel, actorLabel, stageLabel, pipelineLabel, eventTypeLabel, eventSummaryLabel, healthLabel, actionLabel, displayValue, shortId, shortCommit } from "../src/dashboard/public/labels.js";

describe("dashboard display labels (API values remain unchanged)", () => {
  it("translates state, mode, actor, pipeline stage and status", () => {
    expect(stateLabel("DONE")).toBe("完了");
    expect(stateLabel("NEEDS_APPROVAL")).toBe("確認待ち");
    expect(modeLabel("read_only")).toBe("読み取り専用");
    expect(modeLabel("change")).toBe("変更あり");
    expect(actorLabel("CODEX")).toBe("Codex");
    expect(actorLabel("SYSTEM")).toBe("システム");
    expect(stageLabel("Scope")).toBe("対象確定");
    expect(pipelineLabel("not_started")).toBe("未開始");
    expect(healthLabel("healthy")).toBe("正常");
  });
  it("translates event types and only known safe summary templates", () => {
    expect(eventTypeLabel("state_transition")).toBe("状態変更");
    expect(eventSummaryLabel("State → PLANNING")).toBe("状態 → 計画中");
    expect(eventSummaryLabel("execute recorded")).toBe("実行を記録");
    expect(eventSummaryLabel("custom summary")).toBe("custom summary");
  });
  it("shows missing values as unconfirmed and preserves unknown values", () => {
    for (const label of [stateLabel, modeLabel, actorLabel, stageLabel, pipelineLabel, eventTypeLabel]) {
      expect(label(null)).toBe("未確認");
      expect(label("unknown")).toBe("未確認");
      expect(label("FUTURE_VALUE")).toBe("FUTURE_VALUE");
    }
    expect(displayValue(null)).toBe("未確認");
    expect(actionLabel("READY_FOR_REVIEW", null)).toBe("未確認");
    expect(actionLabel("READY_FOR_REVIEW", "future action")).toBe("future action");
    expect(actionLabel("READY_FOR_REVIEW", "Perform independent review of the verified changes.")).toBe("検証済みの変更を独立してレビューしてください。");
  });
  it("shortens task IDs and commits without losing their original value in the data", () => {
    const task = "rpc-this-is-a-very-long-task-identifier", commit = "a".repeat(40);
    expect(shortId(task)).toBe("rpc-this-is-…entifier");
    expect(shortId("rpc-small")).toBe("rpc-small");
    expect(shortCommit(commit)).toBe("aaaaaaaaaaaa…");
    expect(shortCommit(null)).toBe("未確認");
  });
});
