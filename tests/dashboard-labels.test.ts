import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stateLabel, taskStateLabel, modeLabel, actorLabel, stageLabel, pipelineLabel, eventTypeLabel, eventSummaryLabel, healthLabel, actionLabel, displayValue, shortId, shortCommit, normalizeBoundedTask, buildBoundedStartRequest, submitBoundedStart, createBoundedStartController, boundedStatusRows } from "../src/dashboard/public/labels.js";

it("parses the dashboard app with the current Node runtime", () => {
  const appPath = fileURLToPath(new URL("../src/dashboard/public/app.js", import.meta.url));
  const result = spawnSync(process.execPath, ["--check", appPath], { shell: false, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it("wires the bounded start form and displays normalized lifecycle fields", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/dashboard/public/app.js", import.meta.url)), "utf8");
  expect(source).toContain("import { createBoundedStartController } from './labels.js';");
  expect(source).toContain("createBoundedStartController(fetch)");
  expect(source).toContain("controller.start(selectedRepo.value, goal.value, paths.value, criteria.value)");
  expect(source).toContain("['codex-with-chatgpt', 'codex-with-chatgpt-control-plane']");
  expect(source).toContain("section.append(heading, createBoundedStartForm(), details)");
  for (const field of ["review_reviewer", "latest_semantic_review_diagnostic_code", "commit_state", "local_commit", "authoritative_done"]) {
    expect(source).toContain(`['${field}',`);
    expect(source).toContain(`safe.${field}`);
  }
  expect(source).not.toContain("/api/bounded");
  expect(source).not.toContain("X-Bounded-Start-CSRF");
  expect(source).toContain("const approvalFields = ['task_id', 'run_id', 'authoritative_review_id', 'goal', 'review_evidence_hash', 'bundle_manifest_sha256', 'canonical_goal_hash'];");
});
it("submits the bounded form, ignores busy submissions, reports outcomes and re-enables the button", async () => {
  const source = readFileSync(fileURLToPath(new URL("../src/dashboard/public/app.js", import.meta.url)), "utf8");
  const start = source.indexOf("function createBoundedStartForm() {");
  const end = source.indexOf("const boundedFields =", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const elements: Array<ReturnType<typeof element>> = [];
  function element(tag: string) {
    return {
      tag, value: "", textContent: "", disabled: false, children: [] as unknown[],
      attributes: {} as Record<string, string>,
      listeners: {} as Record<string, (event: { preventDefault: () => void }) => Promise<void>>,
      append(...children: unknown[]) { this.children.push(...children); },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener(name: string, listener: (event: { preventDefault: () => void }) => Promise<void>) { this.listeners[name] = listener; }
    };
  }
  const document = {
    createElement(tag: string) { const created = element(tag); elements.push(created); return created; },
    createTextNode(text: string) { return { textContent: text }; }
  };
  const calls: unknown[][] = [];
  let finish!: (result: { kind: string; task_id?: string }) => void;
  const controller = {
    busy: false,
    start(...values: unknown[]) {
      calls.push(values);
      controller.busy = true;
      return new Promise<{ kind: string; task_id?: string }>(resolve => { finish = resolve; });
    }
  };
  const fakeFetch = () => { throw new Error("unexpected direct fetch"); };
  const createForm = new Function("document", "createBoundedStartController", "fetch",
    `${source.slice(start, end)}\nreturn createBoundedStartForm();`);
  const form = createForm(document, (fetcher: unknown) => {
    expect(fetcher).toBe(fakeFetch);
    return controller;
  }, fakeFetch);
  expect(form.tag).toBe("form");
  const select = elements.find(item => item.tag === "select")!;
  const options = elements.filter(item => item.tag === "option");
  expect(options.map(option => option.value)).toEqual(["codex-with-chatgpt", "codex-with-chatgpt-control-plane"]);
  const textareas = elements.filter(item => item.tag === "textarea");
  expect(textareas).toHaveLength(3);
  const button = elements.find(item => item.tag === "button")!;
  const status = elements.find(item => item.attributes.role === "status")!;
  select.value = options[1].value;
  [textareas[0].value, textareas[1].value, textareas[2].value] = ["Goal", "src/app.js", "Check behavior"];
  let prevented = 0;
  const submit = () => form.listeners.submit({ preventDefault: () => { prevented++; } });
  const first = submit();
  expect(button.disabled).toBe(true);
  expect(calls).toEqual([[select.value, "Goal", "src/app.js", "Check behavior"]]);
  await submit();
  expect(prevented).toBe(2);
  expect(calls).toHaveLength(1);
  controller.busy = false;
  finish({ kind: "started", task_id: "bounded-" + "b".repeat(32) });
  await first;
  expect(status.textContent).toContain("bounded-" + "b".repeat(32));
  expect(status.textContent).toContain("Updates appear automatically.");
  expect(button.disabled).toBe(false);
  const second = submit();
  expect(button.disabled).toBe(true);
  controller.busy = false;
  finish({ kind: "failed" });
  await second;
  expect(status.textContent).toBe("Bounded start failed.");
  expect(button.disabled).toBe(false);
  controller.start = async () => { throw new Error("private response detail"); };
  await submit();
  expect(status.textContent).toBe("Bounded start failed.");
  expect(button.disabled).toBe(false);
});


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
  it("distinguishes worker completion from local completion without changing API state", () => {
    const readOnly = { state: "DONE", mode: "read_only" };
    const change = { state: "DONE", mode: "change" };
    expect(taskStateLabel(readOnly.state, readOnly.mode)).toBe("\u8aad\u307f\u53d6\u308a\u5b8c\u4e86\uff08\u4f5c\u696d\u8005\uff09");
    expect(taskStateLabel(change.state, change.mode)).toBe("\u30ed\u30fc\u30ab\u30eb\u5b8c\u4e86\uff08Finalizer\u672a\u78ba\u8a8d\uff09");
    expect(taskStateLabel("DONE", "autonomous")).toBe("\u30ed\u30fc\u30ab\u30eb\u5b8c\u4e86\uff08Finalizer\u672a\u78ba\u8a8d\uff09");
    expect(taskStateLabel("DONE", undefined)).toBe("\u30ed\u30fc\u30ab\u30eb\u5b8c\u4e86\uff08Finalizer\u672a\u78ba\u8a8d\uff09");
    expect(taskStateLabel("READY_FOR_REVIEW", "change")).toBe(stateLabel("READY_FOR_REVIEW"));
    expect(readOnly.state).toBe("DONE");
    expect(change.state).toBe("DONE");
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
    task_id: `bounded-${"b".repeat(32)}`, state: "RUNNING", progress_mode: "EXECUTION",
    execution_profile: "tracked_typescript_dashboard", stop_reason_present: true,
    contract_sha256: hash, edit_paths: ["secret/path.ts"], latest_revision: 1,
    manifest_sha256: hash, verification_present: false, file_count: 2,
    worker: "opencode", review_verdict: "NEEDS_WORK"
  };
  const unknown = "\u672a\u78ba\u8a8d";
  it("formats only sanitized fields and bounded Japanese labels", () => {
    const safe = normalizeBoundedTask({ ...valid, session_id: "secret-session", execution_id: "secret-execution",
      provider: "secret-provider", model: "secret-model", usage: "secret-usage", tools: "secret-tools", artifact: "secret-artifact" });
    expect(safe).toEqual({
      task_id: valid.task_id, state: "\u5b9f\u884c\u4e2d", progress_mode: "実行中",
      execution_profile: "TypeScript ダッシュボード", stop_reason_present: "\u3042\u308a",
      contract_sha256: hash, edit_paths_count: "1", latest_revision: "1", manifest_sha256: hash,
      verification_present: "\u306a\u3057", file_count: "2", worker: "opencode", review_reviewer: unknown,
      review_verdict: "\u8981\u4fee\u6b63", latest_semantic_review_diagnostic_code: unknown,
      commit_state: unknown, local_commit: unknown, authoritative_done: unknown
    });
    expect(JSON.stringify(safe)).not.toContain("secret");
    expect(normalizeBoundedTask({ ...valid, state: "REVIEW_PENDING", review_verdict: "PASS" })).toMatchObject({ state: "\u30ec\u30d3\u30e5\u30fc\u5f85\u3061", review_verdict: "\u5408\u683c" });
    expect(normalizeBoundedTask({ ...valid, state: "REVIEW_ACCEPTED" }).state).toBe("\u30ec\u30d3\u30e5\u30fc\u627f\u8a8d\u6e08\u307f");
    expect(normalizeBoundedTask({ ...valid, state: "ESCALATE" }).state).toBe("\u8981\u78ba\u8a8d");
  });
  it("allowlists reviewers, semantic diagnostic codes and commit states", () => {
    for (const reviewer of ["chatgpt", "opencode-semantic"]) {
      expect(normalizeBoundedTask({ ...valid, review_reviewer: reviewer }).review_reviewer).toBe(reviewer);
    }
    for (const code of ["SEMANTIC_REVIEW_FAILED", "SEMANTIC_REVIEW_TIMEOUT", "SEMANTIC_REVIEW_INVALID"]) {
      expect(normalizeBoundedTask({ ...valid, latest_semantic_review_diagnostic_code: code }).latest_semantic_review_diagnostic_code).toBe(code);
    }
    for (const [state, label] of Object.entries({ NOT_PREPARED: "未準備", PREPARED: "準備済み", COMMITTED: "コミット済み" })) {
      expect(normalizeBoundedTask({ ...valid, commit_state: state }).commit_state).toBe(label);
    }
    for (const reviewer of ["CHATGPT", "codex", null]) {
      expect(normalizeBoundedTask({ ...valid, review_reviewer: reviewer }).review_reviewer).toBe(unknown);
    }
    for (const code of ["PASS", "FAIL", "SEMANTIC_REVIEW_PASSED", null]) {
      expect(normalizeBoundedTask({ ...valid, latest_semantic_review_diagnostic_code: code }).latest_semantic_review_diagnostic_code).toBe(unknown);
    }
    for (const state of ["PENDING", "FAILED", "prepared", null]) {
      expect(normalizeBoundedTask({ ...valid, commit_state: state }).commit_state).toBe(unknown);
    }
    expect(normalizeBoundedTask({ ...valid, local_commit: "a".repeat(40), authoritative_done: true }))
      .toMatchObject({ local_commit: "a".repeat(40), authoritative_done: "あり" });
    expect(normalizeBoundedTask({ ...valid, local_commit: "A".repeat(40), authoritative_done: "true" }))
      .toMatchObject({ local_commit: unknown, authoritative_done: unknown });
  });
  it("maps each safe progress mode and execution profile", () => {
    for (const [mode, label] of Object.entries({ AUTO_REVISION: "自動修正中", REVIEW_PENDING: "レビュー待ち",
      REVIEW_ACCEPTED: "レビュー承認済み", ESCALATE: "要確認" })) {
      expect(normalizeBoundedTask({ ...valid, progress_mode: mode }).progress_mode).toBe(label);
    }
    expect(normalizeBoundedTask({ ...valid, execution_profile: "tracked_typescript_control_plane" }).execution_profile)
      .toBe("TypeScript 制御プレーン");
  });
  it("fails closed on invalid or missing bounded values", () => {
    const safe = normalizeBoundedTask({ ...valid, task_id: "bounded-" + "A".repeat(32), state: "DONE",
      progress_mode: "FUTURE_MODE", execution_profile: "untracked_dashboard",
      stop_reason_present: "true", contract_sha256: "A".repeat(64), edit_paths: "secret/path.ts",
      latest_revision: 0, manifest_sha256: "g".repeat(64), verification_present: null,
      file_count: -1, worker: "codex", review_reviewer: "private", review_verdict: "FAIL",
      latest_semantic_review_diagnostic_code: "private", commit_state: "PENDING",
      local_commit: "A".repeat(40), authoritative_done: "true" });
    expect(Object.values(safe)).toEqual(Array(18).fill(unknown));
    expect(normalizeBoundedTask({ ...valid, latest_revision: 1.5 }).latest_revision).toBe(unknown);
    expect(normalizeBoundedTask({ ...valid, latest_revision: null }).latest_revision).toBe(unknown);
    expect(normalizeBoundedTask(null).task_id).toBe(unknown);
    expect(normalizeBoundedTask({ ...valid, progress_mode: null }).progress_mode).toBe(unknown);
    expect(normalizeBoundedTask({ ...valid, execution_profile: null }).execution_profile).toBe(unknown);
    expect(normalizeBoundedTask({}).progress_mode).toBe(unknown);
    expect(normalizeBoundedTask({}).execution_profile).toBe(unknown);
  });
});

describe("bounded start request", () => {
  const repo = "codex-with-chatgpt";
  const make = (r: unknown, goal: unknown, paths: unknown, criteria: unknown) =>
    buildBoundedStartRequest(r, goal, paths, criteria);
  it("normalizes only the four request fields", () => {
    expect(make(repo, "  Fix labels  ", " src/a.ts\r\n\n tests/a.test.ts ", " verify \n test ")).toEqual({
      repo, goal: "Fix labels", edit_paths: ["src/a.ts", "tests/a.test.ts"], acceptance_criteria: ["verify", "test"]
    });
    expect(make("codex-with-chatgpt-control-plane", "x", "a.ts", "y").repo).toBe("codex-with-chatgpt-control-plane");
    expect(make(repo, "x".repeat(2000), "a".repeat(240), "ok").goal).toHaveLength(2000);
    expect(make(repo, "x", "folder/with spaces.ts", "ok").edit_paths).toEqual(["folder/with spaces.ts"]);
  });
  it("rejects invalid repos, goals, paths and criteria", () => {
    for (const r of ["other", " codex-with-chatgpt", null]) expect(() => make(r, "x", "a.ts", "ok")).toThrow();
    for (const goal of [" ", "x".repeat(2001), null]) expect(() => make(repo, goal, "a.ts", "ok")).toThrow();
    for (const paths of ["", "\n", "a\nb\nc\nd", "/a", "../a", "a/../b", "a/./b", "a//b", "a/", ".hidden", "a/.hidden", "a\\b", "C:/a", "a:b", "a\tb", "a\u0000b", "a\u007fb", "a".repeat(241)]) {
      expect(() => make(repo, "x", paths, "ok")).toThrow();
    }
    for (const criteria of ["", " \n ", "a\nb\nc\nd\ne\nf\ng", "x".repeat(501)]) {
      expect(() => make(repo, "x", "a.ts", criteria)).toThrow();
    }
  });
});

describe("bounded start submission", () => {
  const token = "a".repeat(64);
  const task_id = `bounded-${"b".repeat(32)}`;
  const request = { repo: "codex-with-chatgpt", goal: "x", edit_paths: ["a.ts"], acceptance_criteria: ["ok"] };
  const session = (header: string | null, ok = true) => ({ ok, headers: { get: (name: string) => name === "X-Bounded-Start-CSRF" ? header : null } });
  it("GETs the header token and POSTs precisely the request JSON", async () => {
    const calls: unknown[][] = [];
    const fetcher = async (...args: unknown[]) => {
      calls.push(args);
      return calls.length === 1 ? session(token) : { ok: true, json: async () => ({ task_id, secret: "private" }) };
    };
    expect(await submitBoundedStart(fetcher, request)).toEqual({ task_id });
    expect(calls).toEqual([
      ["/api/bounded/start-session", { method: "GET", credentials: "same-origin", cache: "no-store" }],
      ["/api/bounded/start", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Bounded-Start-CSRF": token }, body: JSON.stringify(request) }]
    ]);
  });
  it("never uses a body token or POSTs without a valid header", async () => {
    for (const header of [null, "A".repeat(64), "a".repeat(63)]) {
      let calls = 0;
      const fetcher = async () => { calls++; return { ...session(header), json: async () => ({ csrf_token: token }) }; };
      await expect(submitBoundedStart(fetcher, request)).rejects.toThrow("Bounded start failed");
      expect(calls).toBe(1);
    }
  });
  it("turns every network, HTTP, JSON and task failure into the same generic error", async () => {
    const privateError = new Error("private response detail");
    const failures = [
      async () => { throw privateError; },
      async () => session(token, false),
      async (...args: unknown[]) => args[0] === "/api/bounded/start-session" ? session(token) : { ok: false },
      async (...args: unknown[]) => args[0] === "/api/bounded/start-session" ? session(token) : { ok: true, json: async () => { throw privateError; } },
      async (...args: unknown[]) => args[0] === "/api/bounded/start-session" ? session(token) : { ok: true, json: async () => ({ task_id: "bounded-" + "A".repeat(32), secret: "private" }) }
    ];
    for (const fetcher of failures) {
      try { await submitBoundedStart(fetcher, request); throw new Error("unexpected success"); }
      catch (error) { expect(error).toEqual(new Error("Bounded start failed")); }
    }
  });
});

describe("bounded start controller", () => {
  const repo = "codex-with-chatgpt";
  const task_id = `bounded-${"b".repeat(32)}`;
  const args = [repo, "  Fix labels  ", " src/a.ts ", " verify "] as const;

  it("sets busy synchronously, rejects concurrent starts without building or submitting, and returns only the task ID", async () => {
    const fetcher = () => { throw new Error("fetcher must not be called directly"); };
    let resolve!: (value: { task_id: string; secret: string }) => void;
    const pending = new Promise<{ task_id: string; secret: string }>(done => { resolve = done; });
    const calls: unknown[][] = [];
    const submitter = (...values: unknown[]) => { calls.push(values); return pending; };
    const controller = createBoundedStartController(fetcher, submitter);
    expect(controller.busy).toBe(false);
    const first = controller.start(...args);
    expect(controller.busy).toBe(true);
    expect(calls).toEqual([[fetcher, { repo, goal: "Fix labels", edit_paths: ["src/a.ts"], acceptance_criteria: ["verify"] }]]);
    expect(await controller.start("invalid repo", "", "", "")).toEqual({ kind: "busy" });
    expect(controller.busy).toBe(true);
    expect(calls).toHaveLength(1);
    resolve({ task_id, secret: "private response detail" });
    expect(await first).toEqual({ kind: "started", task_id });
    expect(controller.busy).toBe(false);
    expect(Object.keys(controller)).toEqual(["busy", "start"]);
  });

  it("fails closed on build errors without submitting, and allows a later start", async () => {
    const calls: unknown[][] = [];
    const submitter = async (...values: unknown[]) => { calls.push(values); return { task_id }; };
    const controller = createBoundedStartController(null, submitter);
    expect(await controller.start("invalid repo", "private goal", "a.ts", "ok")).toEqual({ kind: "failed" });
    expect(controller.busy).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await controller.start(...args)).toEqual({ kind: "started", task_id });
    expect(controller.busy).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("hides submit errors and malformed responses, resetting busy after each failure", async () => {
    for (const outcome of [Promise.reject(new Error("private response detail")), Promise.resolve({ task_id: "private", secret: "private response detail" })]) {
      const controller = createBoundedStartController(null, () => outcome);
      expect(await controller.start(...args)).toEqual({ kind: "failed" });
      expect(controller.busy).toBe(false);
    }
  });
});

describe("bounded status rows", () => {
  it("uses fixed labels and only normalized, allowlisted values", () => {
    const id = `bounded-${"b".repeat(32)}`;
    const rows = boundedStatusRows({ task_id: id, state: "RUNNING", progress_mode: "EXECUTION",
      review_reviewer: "opencode-semantic", review_verdict: "PASS",
      latest_semantic_review_diagnostic_code: "SEMANTIC_REVIEW_TIMEOUT", commit_state: "COMMITTED",
      local_commit: "a".repeat(40), authoritative_done: false,
      goal: "private goal", edit_paths: ["private/path"], sessions: "private sessions",
      execution_id: "private execution", provider: "private provider", model: "private model",
      usage: "private usage", findings: "private findings", artifacts: "private artifacts",
      acceptance_criteria: ["private criteria"], evidence: "private evidence" });
    expect(rows).toEqual([
      { label: "Task ID", value: id }, { label: "State", value: "実行中" },
      { label: "Progress", value: "実行中" }, { label: "Reviewer", value: "opencode-semantic" },
      { label: "Review result", value: "合格" },
      { label: "Semantic diagnostic", value: "SEMANTIC_REVIEW_TIMEOUT" },
      { label: "Commit state", value: "コミット済み" },
      { label: "Local commit", value: "a".repeat(40) },
      { label: "Authoritative DONE", value: "なし" }
    ]);
    expect(rows).toHaveLength(9);
    expect(JSON.stringify(rows)).not.toContain("private");
  });
  it("fails closed on unknown values and untrusted evidence", () => {
    const rows = boundedStatusRows({ task_id: "private", state: "DONE", progress_mode: "private",
      review_reviewer: "private", review_verdict: "private",
      latest_semantic_review_diagnostic_code: "private", semantic_diagnostic: "PASS",
      commit_state: "private", local_commit: "private", authoritative_done: "true", raw_evidence: "private" });
    expect(rows).toHaveLength(9);
    expect(rows.map(row => row.value)).toEqual(Array(9).fill("\u672a\u78ba\u8a8d"));
    expect(boundedStatusRows(null).map(row => row.value)).toEqual(Array(9).fill("\u672a\u78ba\u8a8d"));
    expect(JSON.stringify(rows)).not.toContain("private");
  });
});
