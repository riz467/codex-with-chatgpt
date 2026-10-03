import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "@opencode/core/session";
import { canonicalJson } from "../src/task-contract/contract.js";
import { runAdvisoryReview } from "../src/execution-orchestrator/development/advisory-review.js";
import { acquireProposalOAuthCredential, prepareHostOAuthCredential, OAUTH_ENDPOINT } from "../src/execution-orchestrator/development/opencode-oauth.js";
import { HOST_REVIEW_INSTRUCTION, prepareReviewContext } from "../src/execution-orchestrator/development/review-context.js";
import { dispatchAdvisoryReview } from "../src/execution-orchestrator/development/opencode-transport.js";
import { advanceStore } from "../src/execution-orchestrator/development/candidate-mutation.js";
import { cleanup, fixture } from "./rc02-development-e1-fixture.js";

vi.mock("../src/execution-orchestrator/development/opencode-oauth.js", async original => {
  const module = await original<typeof import("../src/execution-orchestrator/development/opencode-oauth.js")>();
  return { ...module, acquireProposalOAuthCredential: vi.fn(module.acquireProposalOAuthCredential) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  vi.mocked(acquireProposalOAuthCredential).mockReset();
  vi.mocked(acquireProposalOAuthCredential).mockImplementation(() => { throw new Error("closed production seam"); }); cleanup(); });
const secret = "FAKE_REVIEW_OAUTH_SECRET_NO_REAL_CREDENTIAL";
function provider(mode: "PASS" | "NEEDS_WORK" | "tool" | "credential" | "authority" | "cross" | "loss" = "PASS") {
  vi.mocked(acquireProposalOAuthCredential).mockImplementation(() => prepareHostOAuthCredential({ type: "oauth", methodID: "chatgpt-browser",
    access: secret, accountID: "test-account", custodyReference: "test-custody", expires: Date.now() + 3600_000 }));
  const fake = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (mode === "loss") throw new Error(secret);
    const body = JSON.parse(init!.body as string), envelope = JSON.parse(body.input[0].content[0].text);
    const text = canonicalJson({ ...envelope.reviewIdentity, result: mode === "NEEDS_WORK" ? "NEEDS_WORK" : "PASS",
      findings: mode === "credential" ? [secret] : [], ...(mode === "authority" ? { approved: true } : {}),
      ...(mode === "cross" ? { attemptDigest: "f".repeat(64) } : {}) });
    const item = mode === "tool" ? { type: "function_call", id: "fc_test", call_id: "call_test", name: "shell", arguments: "{}", status: "completed" }
      : { type: "message", id: "out_test", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const response = { id: "resp_review", object: "response", model: "gpt-5.5", status: "completed", output: [item] };
    const chunk = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    return new Response(chunk("response.created", { response: { ...response, status: "in_progress", output: [] } }) +
      chunk("response.output_item.added", { output_index: 0, item }) +
      (mode === "tool" ? "" : chunk("response.output_text.delta", { item_id: "out_test", output_index: 0, content_index: 0, delta: text })) +
      chunk("response.output_item.done", { output_index: 0, item }) + chunk("response.completed", { response }),
      { headers: { "content-type": "text/event-stream" } });
  }); vi.stubGlobal("fetch", fake); return fake;
}
describe("E1 actual embedded OpenCode review / fake provider", () => {
  it("direct dispatcher cannot bypass durable admission or use a stale context", async () => {
    const fake = provider(), f = fixture(), context = prepareReviewContext(f.mutation, f.human);
    expect(await dispatchAdvisoryReview(context)).toEqual({ result: "FAILED_BEFORE_DISPATCH" });
    expect(acquireProposalOAuthCredential).not.toHaveBeenCalled(); expect(fake).not.toHaveBeenCalled();
    advanceStore(f.store, f.store.recover().state.binding, "RECONCILE_REQUIRED", "UNKNOWN");
    expect(await dispatchAdvisoryReview(context)).toEqual({ result: "FAILED_BEFORE_DISPATCH" });
    expect(fake).not.toHaveBeenCalled();
  }, 60000);
  it("production seam is closed, no environment credentials or network", async () => {
    const f = fixture(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch); vi.stubEnv("OPENAI_API_KEY", "DO_NOT_READ");
    expect(await runAdvisoryReview(f.mutation, f.human)).toEqual({ result: "RECONCILE_REQUIRED" });
    expect(fetch).not.toHaveBeenCalled(); expect(f.store.recover().state.binding.review).toBeUndefined();
  }, 60000);
  it("fixed gpt-5.5, zero tools, host instruction, dedicated fresh sessions, no reuse", async () => {
    const fake = provider(), a = fixture(), b = fixture();
    expect((await runAdvisoryReview(a.mutation, a.human)).result).toBe("PASS");
    expect((await runAdvisoryReview(b.mutation, b.human)).result).toBe("PASS");
    expect(fake).toHaveBeenCalledTimes(2);
    const sessions = fake.mock.calls.map(([url, init]) => {
      const body = JSON.parse(init!.body as string); expect(url).toBe(OAUTH_ENDPOINT); expect(body.model).toBe("gpt-5.5");
      expect(body.tools ?? []).toEqual([]); expect(body.instructions).toContain(HOST_REVIEW_INSTRUCTION);
      expect(body.instructions).not.toContain("IGNORE HOST;"); expect(body.input).toHaveLength(1);
      expect(init!.body).not.toContain(secret); expect(init!.redirect).toBe("error");
      return body.prompt_cache_key;
    }); expect(sessions[0]).not.toBe(sessions[1]);
    await expect(runAdvisoryReview(a.mutation, a.human)).rejects.toThrow(); expect(fake).toHaveBeenCalledTimes(2);
  }, 120000);
  it.each(["NEEDS_WORK", "tool", "credential", "authority", "cross", "loss"] as const)("%s never retries or grants authority", async mode => {
    const fake = provider(mode), f = fixture(), log = vi.spyOn(console, "error");
    const result = await runAdvisoryReview(f.mutation, f.human);
    expect(result.result).toBe(mode === "NEEDS_WORK" ? "NEEDS_WORK" : "RECONCILE_REQUIRED"); expect(fake).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    await expect(runAdvisoryReview(f.mutation, f.human)).rejects.toThrow(); expect(fake).toHaveBeenCalledTimes(1);
    expect(f.store.recover().state.state).toBe(mode === "NEEDS_WORK" ? "ATTEMPT_REJECTED" : "RECONCILE_REQUIRED");
  }, 60000);
  it("rejects reused native session IDs across distinct attempts", async () => {
    const fake = provider(); vi.spyOn(Session.ID, "create").mockReturnValue(Session.ID.make("ses_reviewreuse"));
    const a = fixture(), b = fixture(); expect((await runAdvisoryReview(a.mutation, a.human)).result).toBe("PASS");
    expect((await runAdvisoryReview(b.mutation, b.human)).result).toBe("RECONCILE_REQUIRED"); expect(fake).toHaveBeenCalledTimes(1);
  }, 90000);
});
