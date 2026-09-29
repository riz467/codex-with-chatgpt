import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { BoundedTasks, type Contract } from "../src/mcp/bounded-task.js";
import { PasskeyFixture } from "../src/dashboard/passkey-fixture.js";
import { createHumanApprover } from "../src/human-approver/server.js";
import { authenticator } from "./fixtures/webauthn-simulator.js";

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })); });
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-passkey-link-")); roots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q"); git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "Old heading.\n"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture baseline");
  const contract: Contract = { repo: "fixture", goal: "Change heading", edit_paths: ["README.md"], acceptance_criteria: ["Reviewed heading exists"],
    task_kind: "text_change", execution_profile: "tracked_utf8_text", worker: "opencode",
    codex: { allowed: false, max_calls: 0 }, max_revisions: 1, timeout_ms: 60000 };
  const tasks = new BoundedTasks({ fixture: fs.realpathSync.native(repo) }, path.join(root, "ledger"), async () => ({
    worker: "opencode", session_id: "ses_mock", execution_id: "msg_mock", provider: "mock", model: "mock",
    usage: null, state: "completed", tools: 0,
    output: JSON.stringify({ edits: [{ path: "README.md", old_text: "Old heading.", new_text: "Reviewed heading." }] }) }));
  const started = tasks.start(contract); const result = await tasks.execute(started.task_id);
  expect(result.state).toBe("REVIEW_PENDING");
  expect(() => new PasskeyFixture(path.join(root, "not-accepted"), Date.now,
    () => tasks.acceptedSnapshot(started.task_id))).toThrow("ACCEPTED_REVIEW_REQUIRED");
  const review = { review_id: `review-${randomUUID()}`, task_id: started.task_id, revision: 1,
    contract_sha256: started.contract_sha256, manifest_sha256: result.manifest_sha256,
    reviewer: "chatgpt" as const, verdict: "PASS" as const, findings: [] };
  expect(tasks.submitReview(review).state).toBe("REVIEW_ACCEPTED"); // authorization is separately tested over HTTP MCP
  const fixture = new PasskeyFixture(path.join(root, "passkey"), Date.now, () => tasks.acceptedSnapshot(started.task_id));
  const server = createServer(createHumanApprover({ storePath: path.join(root, "credential.json"), fixture })).listen(0, "127.0.0.1");
  servers.push(server); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("NO_PORT");
  const post = (route: string, body: unknown) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path: route, method: "POST",
      headers: { Host: "localhost:48767", Origin: "http://localhost:48767", "Content-Type": "application/json" } }, res => {
      let data = ""; res.on("data", x => { data += x; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    }); req.on("error", reject); req.end(JSON.stringify(body));
  });
  const key = authenticator(), reg = await post("/registration/options", {});
  expect((await post("/registration/verify", { ceremony: reg.body.ceremony,
    credential: key.registration(reg.body.options.challenge, "http://localhost:48767", "localhost") })).status).toBe(200);
  const status = fixture.status(), binding = { request_id: status.request.request_id, request_sha256: status.request_sha256 };
  return { root, repo, tasks, fixture, key, post, binding, task_id: started.task_id, manifest_sha256: result.manifest_sha256 };
}

describe("accepted bounded task to existing passkey fixture binding (mock worker/reviewer)", () => {
  it("displays the accepted task and records one test-only completion for the same manifest", async () => {
    const x = await setup(), s = x.fixture.status();
    expect(s.request).toMatchObject({ kind: "ACCEPTED_BOUNDED_TASK_TEST_ONLY", task_id: x.task_id, revision: 1,
      manifest_sha256: x.manifest_sha256, review: "PASS", review_result: "PASS" });
    const accepted = x.tasks.acceptedSnapshot(x.task_id);
    expect(s.request).toMatchObject(accepted);
    expect(s.request).toHaveProperty("contract_sha256", accepted.contract_sha256);
    expect(s.request).toHaveProperty("diff_sha256", accepted.diff_sha256);
    expect(s.request).toHaveProperty("summary", accepted.summary);
    expect(s.request).toHaveProperty("review_id", accepted.review_id);
    expect(s.request_sha256).toBe(createHash("sha256").update(JSON.stringify(s.request)).digest("hex"));
    const ledger = path.join(x.root, "ledger", x.task_id, "task.json");
    const ledgerBefore = fs.readFileSync(ledger);
    expect(fs.existsSync(path.join(x.root, "passkey", "completion.json"))).toBe(false);
    const opts = await x.post("/passkey-fixture/options", x.binding);
    const response = await x.post("/passkey-fixture/verify", { ...x.binding, ceremony: opts.body.ceremony,
      credential: x.key.assertion(opts.body.options.challenge, "http://localhost:48767", "localhost") });
    expect(response.status).toBe(201);
    expect(x.fixture.status().completion?.binding).toEqual(accepted);
    expect(JSON.parse(fs.readFileSync(path.join(x.root, "passkey", "completion.json"), "utf8")).binding).toEqual(accepted);
    expect((await x.post("/passkey-fixture/options", x.binding)).status).toBe(409);
    expect(x.tasks.status(x.task_id).state).toBe("REVIEW_ACCEPTED");
    expect(fs.readFileSync(ledger).equals(ledgerBefore)).toBe(true);
  });
  it("refuses a changed diff after review and after authentication options", async () => {
    const x = await setup();
    const opts = await x.post("/passkey-fixture/options", x.binding);
    fs.writeFileSync(path.join(x.repo, "README.md"), "Unreviewed text.\n");
    expect(x.fixture.status().state).toBe("CHANGED");
    expect((await x.post("/passkey-fixture/verify", { ...x.binding, ceremony: opts.body.ceremony,
      credential: x.key.assertion(opts.body.options.challenge, "http://localhost:48767", "localhost") })).status).toBe(403);
    expect(fs.existsSync(path.join(x.root, "passkey", "completion.json"))).toBe(false);
  });
  it("rejects a changed review record, manifest, or task state after fixture creation", async () => {
    for (const target of ["revision-1-review.json", "revision-1-proposal.json", "task.json"]) {
      const x = await setup();
      const options = await x.post("/passkey-fixture/options", x.binding);
      expect(options.status).toBe(200);
      const file = path.join(x.root, "ledger", x.task_id, target);
      if (target === "task.json") {
        const task = JSON.parse(fs.readFileSync(file, "utf8"));
        task.state = "ESCALATE";
        fs.writeFileSync(file, JSON.stringify(task));
      } else fs.appendFileSync(file, " ");
      expect(x.fixture.status().state).toBe("CHANGED");
      expect((await x.post("/passkey-fixture/options", x.binding)).status).toBe(409);
      expect((await x.post("/passkey-fixture/verify", { ...x.binding, ceremony: options.body.ceremony,
        credential: x.key.assertion(options.body.options.challenge, "http://localhost:48767", "localhost") })).status).toBe(403);
      expect(fs.existsSync(path.join(x.root, "passkey", "completion.json"))).toBe(false);
    }
  });
});
