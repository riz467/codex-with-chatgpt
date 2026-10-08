import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import { EventEmitter } from "node:events";
import { semanticSession } from "../src/mcp/semantic-session.js";
import { REVIEW_ROOT } from "../src/mcp/local-gateway.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<object>(), spawn: mocks.spawn }));
vi.mock("../src/mcp/owned-process.js", () => ({ terminateOwnedProcessAndWait: mocks.stop }));

const selected = { providerID: "openai", id: "gpt-6-sol", variant: "default" };
const permissions = [{ action: "*", resource: "*", effect: "deny" }];
let version: string, responseModel: typeof selected, authMethod: string;
let calls: { url: string; body: any }[];
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("OPENAI_BASE_URL", "");
  calls = []; version = "2.0.22"; responseModel = { ...selected }; authMethod = "oauth";
  const agent = "---\nmode: primary\n---\nReview fixture instructions";
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  vi.spyOn(fs, "lstatSync").mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
  vi.spyOn(fs, "readFileSync").mockImplementation(((_file: unknown, encoding: unknown) =>
    encoding === "utf8" ? agent : Buffer.from(agent)) as typeof fs.readFileSync);
  vi.spyOn(fs.realpathSync, "native").mockImplementation(file => String(file));
  const socket = { once: vi.fn().mockReturnThis(), listen: vi.fn((_port, _host, ready) => ready()), close: vi.fn() };
  vi.spyOn(net, "createServer").mockReturnValue(socket as unknown as net.Server);
  mocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), { pid: 12345, exitCode: null }));
  mocks.stop.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname, body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: route, body });
    let value: unknown;
    if (route === "/api/info") value = { pid: 12345, version };
    else if (route === "/openapi.json") value = {
      paths: { "/api/session": { post: { requestBody: { content: { "application/json": { schema: { properties: {
        model: { anyOf: [{ $ref: "#/components/schemas/Model.Ref" }] },
        permissions: { anyOf: [{ $ref: "#/components/schemas/Permission.Ruleset" }] },
      } } } } } } } },
      components: { schemas: { "Model.Ref": { required: ["providerID", "id"], properties: { variant: { type: "string" } } } } },
    };
    else if (route === "/api/integration") value = { location: { directory: REVIEW_ROOT },
      data: [{ id: "openai", connections: [{ type: "credential", method: authMethod }] }] };
    else if (route === "/api/agent") value = { location: { directory: REVIEW_ROOT }, data: [{
      id: "c2c-semantic-reviewer", mode: "primary", system: "Review fixture instructions", permissions,
    }] };
    else if (route === "/api/session") value = { data: { id: "ses_review", ...body } };
    else if (route.endsWith("/prompt")) value = { data: { id: "msg_user", sessionID: "ses_review", type: "user" } };
    else if (route.endsWith("/message")) value = { data: [
      { id: "msg_user", type: "user" },
      { id: "msg_answer", type: "assistant", agent: "c2c-semantic-reviewer", time: { completed: 1 }, finish: "stop", model: responseModel,
        content: [{ type: "text", text: JSON.stringify({ review_result: "PASS", reason_category: "GOAL_SATISFIED",
          summary: "Fixture", evidence_refs: [1], unresolved_issues: [] }) }] },
      { type: "idle", outcome: "succeeded" },
    ] };
    else throw new Error(`Unexpected fixture route ${route}`);
    return new Response(JSON.stringify(value), { status: 200 });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("creates only the fixed reviewer/model with explicit deny-all and cleans up", async () => {
  await expect(semanticSession("sealed fixture", "ses_execution", [1])).resolves.toMatchObject({ decision: { review_result: "PASS" } });
  expect(calls.find(call => call.url === "/api/session")?.body).toMatchObject({
    agent: "c2c-semantic-reviewer", model: selected, permissions,
  });
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it.each(["providerID", "id", "variant"] as const)("rejects a response with the wrong %s", async key => {
  responseModel[key] = "wrong";
  await expect(semanticSession("sealed fixture", "ses_execution", [1])).rejects.toThrow("SEMANTIC_RESPONSE_MODEL_MISMATCH");
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it.each(["version", "auth"])("rejects %s mismatch before session creation or prompt", async field => {
  if (field === "version") version = "2.0.24"; else authMethod = "key";
  await expect(semanticSession("sealed fixture", "ses_execution", [1])).rejects.toThrow(/SEMANTIC_(MODEL_SCHEMA_MISMATCH|OAUTH_NOT_CONFIRMED)/);
  expect(calls.some(call => call.url === "/api/session" || call.url.endsWith("/prompt"))).toBe(false);
  expect(mocks.stop).toHaveBeenCalledOnce();
});
