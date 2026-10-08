import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stateLabel, taskStateLabel, modeLabel, actorLabel, stageLabel, pipelineLabel, eventTypeLabel, eventSummaryLabel, healthLabel, actionLabel, displayValue, shortId, shortCommit, normalizeBoundedTask, buildBoundedStartRequest, submitBoundedStart, createBoundedStartController, createBoundedStartSubmitHandler, boundedStatusRows, boundedBoardBucket, boundedTrackingRows } from "../src/dashboard/public/labels.js";

it("parses the dashboard app with the current Node runtime", () => {
  const appPath = fileURLToPath(new URL("../src/dashboard/public/app.js", import.meta.url));
  const result = spawnSync(process.execPath, ["--check", appPath], { shell: false, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it("wires the bounded start form and displays normalized lifecycle fields", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/dashboard/public/app.js", import.meta.url)), "utf8");
  expect(source).toContain("import { createBoundedStartController, boundedBoardBucket, boundedTrackingRows } from './labels.js';");
  expect(source).toContain("createBoundedStartController(fetch)");
  expect(source).toContain("controller.start(selectedRepo.value, goal.value, paths.value, criteria.value)");
  expect(source).toContain("['codex-with-chatgpt', 'codex-with-chatgpt-control-plane']");
  expect(source).toContain("details.append(summary, list); section.append(heading, createBoundedStartForm(), tracking, details);");
  expect(source.match(/const list = document.createElement\('div'\); list.id = 'bounded-opencode-tasks';/g)).toHaveLength(1);
  expect(source.match(/const tracking = document.createElement\('div'\); tracking.id = 'bounded-tracking-fields';/g)).toHaveLength(1);
  expect(source.match(/details.append\(summary, list\)/g)).toHaveLength(1);
  expect(source.match(/section.append\(heading, createBoundedStartForm\(\), tracking, details\)/g)).toHaveLength(1);
  for (const field of ["review_reviewer", "latest_semantic_review_diagnostic_code", "commit_state", "local_commit", "authoritative_done"]) {
    expect(source).toContain(`['${field}',`);
    expect(source).toContain(`safe.${field}`);
  }
  expect(source).not.toContain("/api/bounded/start");
  expect(source).toContain("/api/bounded/campaigns");
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
  const labels = elements.filter(item => item.tag === "label");
  expect(labels).toHaveLength(4);
  labels.forEach((label, index) => {
    expect(label.children).toHaveLength(3);
    expect((label.children[0] as { textContent: string }).textContent).toBe(
      ["Repository", "Goal", "Edit paths (one per line)", "Acceptance criteria (one per line)"][index]);
    expect((label.children[1] as { tag: string }).tag).toBe("br");
    expect(label.children[2]).toBe(index === 0 ? select : textareas[index - 1]);
  });
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
    for (const code of ["SEMANTIC_REVIEW_FAILED", "SEMANTIC_REVIEW_TIMEOUT", "SEMANTIC_REVIEW_INVALID", "SEMANTIC_PROCESS_REQUIRES_INSPECTION"]) {
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

describe("bounded start submit handler", () => {
  const args = ["codex-with-chatgpt", "Goal", "src/app.js", "Check behavior"] as const;
  const task_id = `bounded-${"b".repeat(32)}`;

  it("prevents default, starts with exactly four read values and restores disabled state on success", async () => {
    const effects: unknown[][] = [];
    const controller = createBoundedStartController(null, async (_fetcher: unknown, request: unknown) => {
      effects.push(["submit", request]);
      return { task_id, secret: "private response detail" };
    });
    const handler = createBoundedStartSubmitHandler(controller,
      () => { effects.push(["read"]); return args; },
      value => { effects.push(["disabled", value]); },
      value => { effects.push(["status", value]); });
    await handler({ preventDefault: () => { effects.push(["preventDefault"]); } });
    expect(effects).toEqual([
      ["preventDefault"], ["disabled", true], ["status", ""], ["read"],
      ["submit", { repo: args[0], goal: args[1], edit_paths: [args[2]], acceptance_criteria: [args[3]] }],
      ["status", `${task_id} Updates appear automatically.`], ["disabled", false]
    ]);
    expect(JSON.stringify(effects)).not.toContain("private response detail");
  });

  it("reports one generic failure and restores disabled state for failed results and thrown errors", async () => {
    for (const start of [
      async () => ({ kind: "failed", detail: "private response detail" }),
      async () => { throw new Error("private response detail"); }
    ]) {
      const effects: unknown[][] = [];
      const handler = createBoundedStartSubmitHandler({ busy: false, start },
        () => { effects.push(["read"]); return args; },
        value => { effects.push(["disabled", value]); },
        value => { effects.push(["status", value]); });
      await handler();
      expect(effects).toEqual([
        ["disabled", true], ["status", ""], ["read"],
        ["status", "Bounded start failed."], ["disabled", false]
      ]);
      expect(JSON.stringify(effects)).not.toContain("private response detail");
    }
  });

  it("prevents default but does not read or update anything when already busy", async () => {
    const effects: unknown[][] = [];
    const handler = createBoundedStartSubmitHandler({ busy: true, start: () => { throw new Error("unexpected start"); } },
      () => { effects.push(["read"]); return args; },
      value => { effects.push(["disabled", value]); },
      value => { effects.push(["status", value]); });
    await handler({ preventDefault: () => { effects.push(["preventDefault"]); } });
    expect(effects).toEqual([["preventDefault"]]);
  });

  it("ignores submissions throughout a pending start, then restores state on completion", async () => {
    const effects: unknown[][] = [];
    let resolve!: (value: { task_id: string }) => void;
    const pending = new Promise<{ task_id: string }>(done => { resolve = done; });
    const controller = createBoundedStartController(null, () => pending);
    const handler = createBoundedStartSubmitHandler(controller,
      () => { effects.push(["read"]); return args; },
      value => { effects.push(["disabled", value]); },
      value => { effects.push(["status", value]); });
    const first = handler({ preventDefault: () => { effects.push(["preventDefault"]); } });
    expect(controller.busy).toBe(true);
    expect(effects).toEqual([["preventDefault"], ["disabled", true], ["status", ""], ["read"]]);
    await handler({ preventDefault: () => { effects.push(["preventDefault"]); } });
    expect(effects).toEqual([["preventDefault"], ["disabled", true], ["status", ""], ["read"], ["preventDefault"]]);
    resolve({ task_id });
    await first;
    expect(controller.busy).toBe(false);
    expect(effects.slice(-2)).toEqual([["status", `${task_id} Updates appear automatically.`], ["disabled", false]]);
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

 describe("bounded board classification and tracking rows", () => {
  const task_id = `bounded-${"b".repeat(32)}`;
  const local_commit = "a".repeat(40);
  const base = { task_id, authoritative_done: false };

  it("classifies processing, review waiting, local completion and attention", () => {
    expect(boundedBoardBucket({ ...base, state: "RUNNING" })).toBe(0);
    expect(boundedBoardBucket({ ...base, state: "REVIEW_PENDING" })).toBe(1);
    expect(boundedBoardBucket({ ...base, state: "REVIEW_ACCEPTED", commit_state: "PREPARED" })).toBe(1);
    expect(boundedBoardBucket({ ...base, state: "REVIEW_ACCEPTED", commit_state: "COMMITTED", local_commit })).toBe(2);
    expect(boundedBoardBucket({ ...base, state: "ESCALATE" })).toBe(3);
  });

  it("fails closed on unknown identity, state, DONE or inconsistent commit evidence", () => {
    const accepted = { ...base, state: "REVIEW_ACCEPTED", commit_state: "COMMITTED", local_commit };
    for (const change of [
      { task_id: "private" }, { state: "DONE" }, { authoritative_done: true },
      { authoritative_done: undefined }, { authoritative_done: "false" },
      { local_commit: "A".repeat(40) }, { local_commit: null },
      { commit_state: "UNKNOWN" }
    ]) expect(boundedBoardBucket({ ...accepted, ...change })).toBe(3);
    expect(boundedBoardBucket({ ...base, state: "REVIEW_PENDING", commit_state: "COMMITTED", local_commit })).toBe(3);
    expect(boundedBoardBucket({ ...base, state: "RUNNING", commit_state: "COMMITTED", local_commit })).toBe(3);
    expect(boundedBoardBucket({ ...base, state: "REVIEW_ACCEPTED", commit_state: "PREPARED", local_commit })).toBe(3);
    expect(boundedBoardBucket(null)).toBe(3);
  });

  it("returns fixed normalized lifecycle rows without private fields", () => {
    const rows = boundedTrackingRows({ ...base, state: "REVIEW_ACCEPTED", progress_mode: "REVIEW_ACCEPTED",
      latest_revision: 2, verification_present: true, review_reviewer: "chatgpt", review_verdict: "PASS",
      latest_semantic_review_diagnostic_code: "SEMANTIC_REVIEW_TIMEOUT", commit_state: "COMMITTED", local_commit,
      goal: "private goal", edit_paths: ["private path"], sessions: "private sessions",
      execution_id: "private execution", provider: "private provider", model: "private model",
      usage: "private usage", findings: "private findings", artifacts: "private artifacts",
      acceptance_criteria: ["private criteria"], raw_diagnostics: "private diagnostics", evidence: "private evidence" });
    expect(rows).toEqual([
      { label: "Task ID", value: task_id }, { label: "State", value: "レビュー承認済み" },
      { label: "Progress", value: "レビュー承認済み" }, { label: "Revision", value: "2" },
      { label: "Verification", value: "あり" }, { label: "Reviewer", value: "chatgpt" },
      { label: "Review result", value: "合格" },
      { label: "Semantic diagnostic", value: "SEMANTIC_REVIEW_TIMEOUT" },
      { label: "Commit state", value: "コミット済み" }, { label: "Local commit", value: local_commit },
      { label: "Authoritative DONE", value: "なし" }
    ]);
    expect(JSON.stringify(rows)).not.toContain("private");
  });

  it("fails closed on malformed tracking values and never echoes untrusted data", () => {
    const rows = boundedTrackingRows({ task_id: "private", state: "private", progress_mode: "private",
      latest_revision: "private", verification_present: "private", review_reviewer: "private",
      review_verdict: "private", latest_semantic_review_diagnostic_code: "private",
      commit_state: "private", local_commit: "private", authoritative_done: "private",
      raw_diagnostics: "private", evidence: "private" });
    expect(rows.map(row => row.label)).toEqual(["Task ID", "State", "Progress", "Revision", "Verification",
      "Reviewer", "Review result", "Semantic diagnostic", "Commit state", "Local commit", "Authoritative DONE"]);
    expect(rows.map(row => row.value)).toEqual(Array(11).fill("未確認"));
    expect(boundedTrackingRows(null).map(row => row.value)).toEqual(Array(11).fill("未確認"));
    expect(JSON.stringify(rows)).not.toContain("private");
  });
});

describe("bounded board and tracking source-slice rendering", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/dashboard/public/app.js", import.meta.url)), "utf8");
  class FakeElement {
    id = "";
    className = "";
    textContent = "";
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    classList = { add: (name: string) => { this.className += ` ${name}`; } };
    constructor(readonly tag: string) {}
    append(...children: FakeElement[]) {
      for (const child of children) { child.parent = this; this.children.push(child); }
    }
    replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
    }
    querySelectorAll(selector: string): FakeElement[] {
      return this.children.flatMap(child => [
        ...(selector.startsWith(".") && child.className.split(" ").includes(selector.slice(1)) ? [child] : []),
        ...child.querySelectorAll(selector)
      ]);
    }
    insertAdjacentElement(position: string, element: FakeElement) {
      if (position !== "afterend" || !this.parent) throw new Error("unexpected insertion");
      const siblings = this.parent.children;
      siblings.splice(siblings.indexOf(this) + 1, 0, element);
      element.parent = this.parent;
    }
    closest(selector: string): FakeElement | null {
      for (let node: FakeElement | null = this; node; node = node.parent) {
        if (selector === "section" && node.tag === "section") return node;
      }
      return null;
    }
    addEventListener(_name: string, _listener: () => void) {}
  }
  const setup = () => {
    const root = new FakeElement("main");
    const status = new FakeElement("div"); status.id = "status-bar";
    const autonomousSection = new FakeElement("section");
    const autonomous = new FakeElement("div"); autonomous.id = "autonomous";
    autonomousSection.append(autonomous); root.append(status, autonomousSection);
    const $ = (id: string): FakeElement | undefined => {
      const find = (node: FakeElement): FakeElement | undefined =>
        node.id === id ? node : node.children.map(find).find(Boolean);
      return find(root);
    };
    const document = {
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (text: string) => { const node = new FakeElement("#text"); node.textContent = text; return node; }
    };
    const cell = (tag: string, value: unknown) => {
      const node = document.createElement(tag); node.textContent = displayValue(value); return node;
    };
    const clear = (node: FakeElement) => node.replaceChildren();
    const pair = (node: FakeElement, label: string, value: unknown) => {
      const row = document.createElement("div"); row.className = "pair";
      row.append(cell("small", label), cell("strong", value)); node.append(row);
    };
    return { root, $, document, cell, clear, pair };
  };

  it("routes only bounded entries through the evidence-aware bucket helper", () => {
    const start = source.indexOf("const boardBuckets =");
    const end = source.indexOf("async function refreshAuthorityStatus()", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const dom = setup();
    const renderBoard = new Function("document", "$", "cell", "clear", "displayValue", "normalizeBoundedTask",
      "shortId", "taskStateLabel", "boundedBoardBucket", "showBoundedReviewSummary",
      `${source.slice(start, end)}\nreturn renderTaskBoard;`)(dom.document, dom.$, dom.cell, dom.clear,
      displayValue, normalizeBoundedTask, shortId, taskStateLabel, boundedBoardBucket, () => {});
    const id = `bounded-${"b".repeat(32)}`;
    const committed = { task_id: id, state: "REVIEW_ACCEPTED", commit_state: "COMMITTED",
      local_commit: "a".repeat(40), authoritative_done: false };
    const pending = { ...committed, state: "REVIEW_PENDING", commit_state: undefined, local_commit: undefined };
    renderBoard({ recent_tasks: [{ task_id: "recent-done", state: "DONE", mode: "change", repo: "public" }],
      bounded_tasks: [{ ...committed, state: "RUNNING", commit_state: undefined, local_commit: undefined },
        pending, committed, { ...pending, commit_state: "COMMITTED", local_commit: committed.local_commit }] });
    const buckets = dom.$("task-board")!.querySelectorAll(".task-board-bucket");
    expect(buckets.map(bucket => bucket.children[0].textContent)).toEqual([
      "処理中 (1)", "レビュー待ち (1)", "ローカル完了（Finalizer未確認） (2)", "要確認 (1)"
    ]);
    renderBoard({ recent_tasks: [], bounded_tasks: [pending] });
    expect(dom.$("task-board")!.querySelectorAll(".task-board-bucket").map(bucket => bucket.children[0].textContent))
      .toEqual(["処理中 (0)", "レビュー待ち (1)", "ローカル完了（Finalizer未確認） (0)", "要確認 (0)"]);
  });

  it("replaces normalized tracking rows on running, committed, empty and running renders", () => {
    const start = source.indexOf("const boundedFields =");
    const end = source.indexOf("const approvalFields =", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const dom = setup();
    const renderTasks = new Function("document", "$", "cell", "clear", "pair", "normalizeBoundedTask",
      "boundedTrackingRows", "createBoundedStartForm", `${source.slice(start, end)}\nreturn renderBoundedTasks;`)(
        dom.document, dom.$, dom.cell, dom.clear, dom.pair, normalizeBoundedTask, boundedTrackingRows,
        () => dom.document.createElement("form"));
    const running = { task_id: `bounded-${"b".repeat(32)}`, state: "RUNNING", progress_mode: "EXECUTION",
      authoritative_done: false, goal: "private goal", evidence: "private evidence" };
    const committed = { ...running, state: "REVIEW_ACCEPTED", progress_mode: "REVIEW_ACCEPTED",
      commit_state: "COMMITTED", local_commit: "a".repeat(40) };
    const rows = () => dom.$("bounded-tracking-fields")!.children.map(row => ({
      label: row.children[0].textContent, value: row.children[1].textContent
    }));
    for (const task of [running, committed]) {
      renderTasks([task]);
      expect(rows()).toEqual(boundedTrackingRows(task).map(({ label, value }) => ({ label, value })));
      expect(JSON.stringify(rows())).not.toContain("private");
    }
    renderTasks([]);
    expect(dom.$("bounded-opencode-summary")!.textContent).toBe("Tasks (0)");
    expect(dom.$("bounded-tracking-fields")!.children).toHaveLength(1);
    expect(dom.$("bounded-tracking-fields")!.children[0].tag).toBe("p");
    expect(dom.$("bounded-tracking-fields")!.children[0].textContent).toBe("表示できるタスクはありません");
    renderTasks([running]);
    expect(rows()).toEqual(boundedTrackingRows(running).map(({ label, value }) => ({ label, value })));
    expect(dom.$("bounded-tracking-fields")!.children).toHaveLength(11);
  });


describe("autonomous campaigns rendering", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/dashboard/public/app.js", import.meta.url)), "utf8");
  it("shows the Japanese empty message, preserves populated cards, and retains the projection on failed fetches", async () => {
    type Node = { tag: string; id: string; textContent: string; children: Node[];
      append: (...children: Node[]) => void; replaceChildren: () => void;
      insertAdjacentElement: (position: string, element: Node) => void };
    const nodes = new Map<string, Node>();
    const createElement = (tag: string): Node => {
      const node: Node = {
        tag, id: "", textContent: "", children: [],
        append(...children) { this.children.push(...children); },
        replaceChildren() { this.children = []; },
        insertAdjacentElement(position, element) {
          expect(position).toBe("afterend");
          nodes.set(element.id, element);
        }
      };
      return node;
    };
    const anchor = createElement("section"); anchor.id = "bounded-opencode";
    nodes.set(anchor.id, anchor);
    const $ = (id: string) => nodes.get(id);
    const cell = (tag: string, value: unknown) => {
      const node = createElement(tag); node.textContent = displayValue(value); return node;
    };
    const clear = (node: Node) => node.replaceChildren();
    const pair = (root: Node, label: string, value: unknown) => {
      const row = createElement("div");
      row.append(cell("small", label), cell("strong", value)); root.append(row);
    };
    let campaigns: unknown = [];
    let ok = true;
    const calls: unknown[][] = [];
    const fetcher = async (...args: unknown[]) => {
      calls.push(args);
      return { ok, json: async () => campaigns };
    };
    const start = source.indexOf("let campaignFetchRunning = false;");
    const end = source.indexOf("const approvalFields =", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const renderCampaigns = new Function("document", "$", "cell", "clear", "pair", "fetch",
      `${source.slice(start, end)}\nreturn renderCampaigns;`)(
        { createElement }, $, cell, clear, pair, fetcher) as () => Promise<void>;
    await renderCampaigns();
    const section = $("bounded-campaigns")!;
    expect(section.children.map(child => [child.tag, child.textContent])).toEqual([
      ["h2", "Autonomous campaigns (local commits only)"],
      ["p", "現在実行中のキャンペーンはありません"]
    ]);
    campaigns = [{ campaign_id: "campaign-1", state: "RUNNING", task_ids: ["task-1"] }];
    await renderCampaigns();
    expect($("bounded-campaigns")).toBe(section);
    expect(section.children).toHaveLength(2);
    expect(section.children[0].textContent).toBe("Autonomous campaigns (local commits only)");
    expect(section.children[1].children.map(row => [row.children[0].textContent, row.children[1].textContent]))
      .toEqual([
        ["campaign_id", "campaign-1"], ["state", "RUNNING"], ["current_task", "未確認"],
        ["task_ids", "task-1"], ["stop_reason", "未確認"], ["impact_paths", "未確認"],
        ["human_action", "未確認"],
        ["Budget", "3 tasks × at most 3 revisions; 45 minutes; repeated failure limit 2"]
      ]);
    ok = false;
    await renderCampaigns();
    expect(section.children[1].children[1].children[1].textContent).toBe("RUNNING");
    ok = true;
    campaigns = [];
    await renderCampaigns();
    expect(section.children.map(child => child.tag)).toEqual(["h2", "p"]);
    expect(section.children[1].textContent).toBe("現在実行中のキャンペーンはありません");
    expect(calls).toEqual(Array(4).fill(["/api/bounded/campaigns", { credentials: "same-origin", cache: "no-store" }]));
  });
});
});
