import { afterAll, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deployment, deploymentFor, sameDeploymentPath } from "../src/config/deployment.js";
import { isReviewWorkspace } from "../src/mcp/workspace-info.js";
import { Workspace } from "../src/workspace/manager.js";
import { boundedFinalizationRoot, startProductionBoundedTask, runProductionBoundedCampaigns } from "../src/mcp/server.js";
import { BoundedCampaigns } from "../src/mcp/bounded-campaign.js";
import { assertSemanticTransport } from "../src/mcp/semantic-session.js";

// Exercise the Linux production policy using only scratch roots on either OS.
vi.mock("../src/config/deployment.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/config/deployment.js")>();
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linux-portability-"));
  return { ...actual, deployment: Object.freeze({ ...actual.deploymentFor("linux"),
    executionRoot: path.join(root, "execution"), reviewRoot: path.join(root, "review") }) };
});

fs.mkdirSync(deployment.executionRoot); fs.mkdirSync(deployment.reviewRoot);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => fs.rmSync(path.dirname(deployment.executionRoot), { recursive: true, force: true }));

it("keeps fixed Windows placement and disables Linux production candidate execution", () => {
  expect(deploymentFor("win32").executionRoot).toBe("C:\\work\\codex-with-chatgpt");
  expect(deploymentFor("win32").localExecutionEnabled).toBe(true);
  expect(deploymentFor("linux").executionRoot).toBe("/srv/ai-orchestration/codex-with-chatgpt");
  const run = vi.spyOn(BoundedCampaigns.prototype, "run"), start = vi.spyOn(BoundedCampaigns.prototype, "start");
  runProductionBoundedCampaigns();
  expect(() => startProductionBoundedTask({} as never)).toThrow("isolated Executor");
  expect(run).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});

it("separates Review and Execution, including aliases and missing roots", () => {
  const alias = path.join(path.dirname(deployment.reviewRoot), "alias");
  fs.symlinkSync(deployment.reviewRoot, alias, process.platform === "win32" ? "junction" : "dir");
  expect(isReviewWorkspace(new Workspace(alias))).toBe(true);
  expect(isReviewWorkspace(new Workspace(deployment.executionRoot))).toBe(false);
  expect(boundedFinalizationRoot(alias, "codex-with-chatgpt")).toBeNull();
  expect(boundedFinalizationRoot(deployment.executionRoot, "codex-with-chatgpt")).toBe(deployment.executionRoot);
  expect(boundedFinalizationRoot(deployment.executionRoot, "unknown")).toBeNull();
  expect(sameDeploymentPath(alias, deployment.reviewRoot)).toBe(true);
  expect(sameDeploymentPath("relative", "relative")).toBe(false);
  expect(sameDeploymentPath(`${alias}-missing`, `${alias}-missing`)).toBe(false);
});

it.skipIf(process.platform !== "linux")("does not collapse distinct Linux directory case", () => {
  const upper = path.join(path.dirname(deployment.reviewRoot), "Review"); fs.mkdirSync(upper);
  expect(sameDeploymentPath(upper, deployment.reviewRoot)).toBe(false);
  expect(isReviewWorkspace(new Workspace(upper))).toBe(false);
});

function transport() {
  vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("OPENAI_BASE_URL", "");
  return {
    schema: { paths: { "/api/session": { post: { requestBody: { content: { "application/json": { schema: {
      properties: { model: { anyOf: [{ $ref: "#/components/schemas/Model.Ref" }] },
        permissions: { anyOf: [{ $ref: "#/components/schemas/Permission.Ruleset" }] } },
    } } } } } } }, components: { schemas: { "Model.Ref": {
      required: ["id", "providerID"], properties: { variant: { type: "string" } },
    } } } },
    integrations: { location: { directory: deployment.reviewRoot }, data: [
      { id: "openai", connections: [{ type: "credential", method: "oauth" }] },
    ] },
    agents: { location: { directory: deployment.reviewRoot }, data: [{ id: "c2c-semantic-reviewer", mode: "primary",
      system: "fixture review instructions", permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "*", resource: "*", effect: "deny" },
      ] }] },
  };
}
it("requires the reviewed version, schema, OAuth route and independent agent", () => {
  const t = transport();
  const check = (version = "2.0.22") => assertSemanticTransport(version, t.schema, t.integrations, t.agents, "fixture review instructions");
  expect(() => check()).not.toThrow();
  expect(() => check("2.0.24")).toThrow("SEMANTIC_MODEL_SCHEMA_MISMATCH");
  expect(() => check("2.1.0")).toThrow("SEMANTIC_MODEL_SCHEMA_MISMATCH");
  t.schema.components.schemas["Model.Ref"].required = ["id"];
  expect(() => check()).toThrow("SEMANTIC_MODEL_SCHEMA_MISMATCH");
});
it.each(["key", "command"])("rejects %s authentication metadata", method => {
  const t = transport(); t.integrations.data[0].connections[0].method = method;
  expect(() => assertSemanticTransport("2.0.22", t.schema, t.integrations, t.agents, "fixture review instructions")).toThrow("SEMANTIC_OAUTH_NOT_CONFIRMED");
});
it("rejects ambiguous authentication and wrong agent location", () => {
  const t = transport(); vi.stubEnv("OPENAI_API_KEY", "fixture-not-a-secret");
  expect(() => assertSemanticTransport("2.0.22", t.schema, t.integrations, t.agents, "fixture review instructions")).toThrow("SEMANTIC_AUTH_ROUTE_AMBIGUOUS");
  vi.stubEnv("OPENAI_API_KEY", ""); t.agents.location.directory = deployment.executionRoot;
  expect(() => assertSemanticTransport("2.0.22", t.schema, t.integrations, t.agents, "fixture review instructions")).toThrow("SEMANTIC_AGENT_UNAVAILABLE");
});
it("rejects a same-name agent with overridden instructions or tool permission", () => {
  const t = transport();
  const check = () => assertSemanticTransport("2.0.22", t.schema, t.integrations, t.agents, "fixture review instructions");
  t.agents.data[0].permissions.push({ action: "shell", resource: "*", effect: "allow" });
  expect(check).toThrow("SEMANTIC_AGENT_UNAVAILABLE");
  t.agents.data[0].permissions.pop(); t.agents.data[0].system = "overridden";
  expect(check).toThrow("SEMANTIC_AGENT_UNAVAILABLE");
});
