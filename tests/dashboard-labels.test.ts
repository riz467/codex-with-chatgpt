import { describe, expect, it } from "vitest";
import { stateLabel, modeLabel, actorLabel, stageLabel, pipelineLabel, eventTypeLabel, eventSummaryLabel, healthLabel, actionLabel, displayValue, shortId, shortCommit, normalizeBoundedTask } from "../src/dashboard/public/labels.js";

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

describe("bounded dashboard task normalization", () => {
  const hash = "a".repeat(64);
  const valid = {
    task_id: `bounded-${"b".repeat(32)}`, state: "RUNNING", stop_reason_present: true,
    contract_sha256: hash, edit_paths: ["secret/path.ts"], latest_revision: 1,
    manifest_sha256: hash, verification_present: false, file_count: 2,
    worker: "opencode", review_verdict: "NEEDS_WORK"
  };
  const unknown = "\u672a\u78ba\u8a8d";
  it("formats only sanitized fields and bounded Japanese labels", () => {
    const safe = normalizeBoundedTask({ ...valid, session_id: "secret-session", execution_id: "secret-execution",
      provider: "secret-provider", model: "secret-model", usage: "secret-usage", tools: "secret-tools", artifact: "secret-artifact" });
    expect(safe).toEqual({
      task_id: valid.task_id, state: "\u5b9f\u884c\u4e2d", stop_reason_present: "\u3042\u308a",
      contract_sha256: hash, edit_paths_count: "1", latest_revision: "1", manifest_sha256: hash,
      verification_present: "\u306a\u3057", file_count: "2", worker: "opencode", review_verdict: "\u8981\u4fee\u6b63"
    });
    expect(JSON.stringify(safe)).not.toContain("secret");
    expect(normalizeBoundedTask({ ...valid, state: "REVIEW_PENDING", review_verdict: "PASS" })).toMatchObject({ state: "\u30ec\u30d3\u30e5\u30fc\u5f85\u3061", review_verdict: "\u5408\u683c" });
    expect(normalizeBoundedTask({ ...valid, state: "REVIEW_ACCEPTED" }).state).toBe("\u30ec\u30d3\u30e5\u30fc\u627f\u8a8d\u6e08\u307f");
    expect(normalizeBoundedTask({ ...valid, state: "ESCALATE" }).state).toBe("\u8981\u78ba\u8a8d");
  });
  it("fails closed on invalid or missing bounded values", () => {
    const safe = normalizeBoundedTask({ ...valid, task_id: "bounded-" + "A".repeat(32), state: "DONE",
      stop_reason_present: "true", contract_sha256: "A".repeat(64), edit_paths: "secret/path.ts",
      latest_revision: 0, manifest_sha256: "g".repeat(64), verification_present: null,
      file_count: -1, worker: "codex", review_verdict: "FAIL" });
    expect(Object.values(safe)).toEqual(Array(11).fill(unknown));
    expect(normalizeBoundedTask({ ...valid, latest_revision: 1.5 }).latest_revision).toBe(unknown);
    expect(normalizeBoundedTask({ ...valid, latest_revision: null }).latest_revision).toBe(unknown);
    expect(normalizeBoundedTask(null).task_id).toBe(unknown);
  });
});
