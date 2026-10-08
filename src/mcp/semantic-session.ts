import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { REVIEW_ROOT } from "./local-gateway.js";
import { deployment, sameDeploymentPath } from "../config/deployment.js";
import { terminateOwnedProcessAndWait } from "./owned-process.js";
import { assertOpencodeBinary, opencodeVersion } from "./opencode-binary.js";

const agentID = "c2c-semantic-reviewer";
const port = 41740;
const base = `http://127.0.0.1:${port}`;
const sourceAgent = path.join(deployment.configRoot, "agents", "c2c-semantic-reviewer.md");
const runtimeAgent = path.join(os.homedir(), ".config", "opencode", "agents", `${agentID}.md`);
const hash = (v: Buffer) => createHash("sha256").update(v).digest("hex");

export type SemanticDecision = {
  review_result: "PASS" | "NEEDS_WORK"; reason_category: string; summary: string;
  evidence_refs: number[]; unresolved_issues: string[];
};
export function validateSemantic(text: string, validRefs: readonly number[]): SemanticDecision {
  if (!text || text.length > 4096) throw new Error("SEMANTIC_RESULT_INVALID");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("SEMANTIC_RESULT_INVALID"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("SEMANTIC_RESULT_INVALID");
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).sort().join("|") !== ["evidence_refs", "reason_category", "review_result", "summary", "unresolved_issues"].join("|") ||
      !["PASS", "NEEDS_WORK"].includes(String(obj.review_result)) ||
      !["GOAL_SATISFIED", "GOAL_NOT_SATISFIED", "PARTIAL_IMPLEMENTATION", "BEHAVIOR_MISMATCH", "REQUIREMENT_AMBIGUOUS",
        "TEST_COVERAGE_INSUFFICIENT", "EVIDENCE_INSUFFICIENT", "SEMANTIC_REVIEW_INTERNAL_ERROR"].includes(String(obj.reason_category)) ||
      typeof obj.summary !== "string" || !obj.summary.trim() || obj.summary.length > 160 || /[\x00-\x1f\x7f]/.test(obj.summary) ||
      !Array.isArray(obj.evidence_refs) || !obj.evidence_refs.length || obj.evidence_refs.length > 10 ||
      new Set(obj.evidence_refs).size !== obj.evidence_refs.length ||
      obj.evidence_refs.some((id) => !Number.isInteger(id) || !validRefs.includes(id as number)) ||
      !Array.isArray(obj.unresolved_issues) || obj.unresolved_issues.length > 3 ||
      obj.unresolved_issues.some((v) => typeof v !== "string" || !v.trim() || v.length > 120 || /[\x00-\x1f\x7f]/.test(v)) ||
      (obj.review_result === "PASS" && (obj.reason_category !== "GOAL_SATISFIED" || obj.unresolved_issues.length !== 0)) ||
      (obj.review_result === "NEEDS_WORK" && (obj.reason_category === "GOAL_SATISFIED" || obj.unresolved_issues.length === 0))) {
    throw new Error("SEMANTIC_RESULT_INVALID");
  }
  return obj as SemanticDecision;
}

function assertAgent() {
  if (!fs.existsSync(sourceAgent) || !fs.existsSync(runtimeAgent) ||
      fs.lstatSync(runtimeAgent).isSymbolicLink() || hash(fs.readFileSync(sourceAgent)) !== hash(fs.readFileSync(runtimeAgent))) {
    throw new Error("SEMANTIC_AGENT_UNAVAILABLE");
  }
  return hash(fs.readFileSync(runtimeAgent));
}

export function assertSemanticTransport(version: unknown, schema: any, integrations: any, agents: any, expectedSystem: string) {
  // Match the proposal transport's reviewed releases; 2.0.24 needs separate qualification.
  const create = schema?.paths?.["/api/session"]?.post?.requestBody?.content?.["application/json"]?.schema;
  const model = schema?.components?.schemas?.["Model.Ref"];
  if (!["2.0.18", "2.0.22"].includes(String(version)) ||
      create?.properties?.model?.anyOf?.filter((item: any) => item.$ref === "#/components/schemas/Model.Ref").length !== 1 ||
      create?.properties?.permissions?.anyOf?.filter((item: any) => item.$ref === "#/components/schemas/Permission.Ruleset").length !== 1 ||
      !model?.required?.includes("id") || !model?.required?.includes("providerID") || model?.properties?.variant?.type !== "string") {
    throw new Error("SEMANTIC_MODEL_SCHEMA_MISMATCH");
  }
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) throw new Error("SEMANTIC_AUTH_ROUTE_AMBIGUOUS");
  const openai = integrations?.data?.filter((item: any) => item.id === "openai");
  if (!sameDeploymentPath(integrations?.location?.directory ?? "", REVIEW_ROOT) || openai?.length !== 1 ||
      openai[0].connections?.length !== 1 || openai[0].connections[0].type !== "credential" || openai[0].connections[0].method !== "oauth") {
    throw new Error("SEMANTIC_OAUTH_NOT_CONFIRMED");
  }
  const effective = agents?.data?.filter((item: any) => item.id === agentID);
  const rules = effective?.[0]?.permissions;
  const lastRule = Array.isArray(rules) ? rules.at(-1) : undefined;
  if (!sameDeploymentPath(agents?.location?.directory ?? "", REVIEW_ROOT) || effective?.length !== 1 ||
      effective[0].mode !== "primary" || !expectedSystem || effective[0].system?.trim() !== expectedSystem.trim() ||
      lastRule?.action !== "*" || lastRule?.resource !== "*" || lastRule?.effect !== "deny") {
    throw new Error("SEMANTIC_AGENT_UNAVAILABLE");
  }
}
async function ensureFreePort() {
  const server = net.createServer();
  try { await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve)); }
  catch { throw new Error("SEMANTIC_SERVER_UNAVAILABLE"); }
  finally { server.close(); }
}
export async function semanticSession(prompt: string, executionSessionId: string, validRefs: readonly number[]) {
  const exe = assertOpencodeBinary("reviewer");
  const agentHash = assertAgent();
  const source = fs.readFileSync(sourceAgent, "utf8");
  const expectedSystem = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]+)$/.exec(source)?.[1].trim();
  if (!expectedSystem) throw new Error("SEMANTIC_AGENT_UNAVAILABLE");
  await ensureFreePort();
  const password = randomBytes(32).toString("hex");
  const child = spawn(exe, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: REVIEW_ROOT, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password }, stdio: "ignore", windowsHide: true,
    detached: process.platform !== "win32",
  });
  let spawnFailed = false;
  child.once("error", () => { spawnFailed = true; });
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, { method, headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("SEMANTIC_API_UNAVAILABLE");
    const content = await res.text();
    if (content.length > 2_097_152) throw new Error("SEMANTIC_API_OVERSIZE");
    return JSON.parse(content) as Record<string, any>;
  };
  let sessionID = "";
  try {
    let ready = false;
    let version: unknown;
    for (let i = 0; i < 100; i++) {
      if (spawnFailed || child.exitCode !== null) break;
      try {
        const info = await api("GET", "/api/info");
        if (info.pid === child.pid && String(info.version).startsWith("2.")) { version = info.version; ready = true; break; }
      } catch { /* bounded startup */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) throw new Error("SEMANTIC_SERVER_UNAVAILABLE");
    if (version !== opencodeVersion) throw new Error("OPENCODE_BINARY_VERSION_MISMATCH");
    assertSemanticTransport(version, await api("GET", "/openapi.json"),
      await api("GET", "/api/integration"), await api("GET", "/api/agent"), expectedSystem);
    const created = await api("POST", "/api/session", { agent: agentID, model: { providerID: "openai", id: "gpt-6-sol", variant: "default" },
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      location: { directory: REVIEW_ROOT }, title: "Independent sealed-bundle semantic review" });
    sessionID = created.data?.id;
    if (!/^ses_[a-zA-Z0-9]+$/.test(sessionID) || sessionID === executionSessionId ||
        created.data?.agent !== agentID || !sameDeploymentPath(created.data?.location?.directory ?? "", REVIEW_ROOT) ||
        created.data?.model?.providerID !== "openai" || created.data?.model?.id !== "gpt-6-sol" ||
        created.data?.model?.variant !== "default") throw new Error("SEMANTIC_SESSION_INVALID");
    const sent = await api("POST", `/api/session/${sessionID}/prompt`, { text: prompt });
    const userID = sent.data?.id;
    if (!/^msg_[a-zA-Z0-9]+$/.test(userID) || sent.data?.sessionID !== sessionID || sent.data?.type !== "user") throw new Error("SEMANTIC_PROMPT_FAILED");
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("SEMANTIC_SERVER_UNAVAILABLE");
      const response = await api("GET", `/api/session/${sessionID}/message?order=asc&limit=100`);
      const messages = response.data as any[];
      const index = messages?.findIndex((m) => m.id === userID && m.type === "user") ?? -1;
      if (index < 0) throw new Error("SEMANTIC_TURN_MISSING");
      const turn = messages.slice(index + 1);
      const idle = turn.findIndex((m) => m.type === "idle");
      if (idle >= 0) {
        const done = turn.slice(0, idle).filter((m) => m.type === "assistant" && m.time?.completed && m.finish === "stop");
        if (turn[idle].outcome !== "succeeded" || done.length !== 1 || done[0].agent !== agentID ||
            turn.slice(0, idle).some((m) => m.type === "user" || m.type === "assistant" && m.content?.some((c: any) => c.type === "tool"))) throw new Error("SEMANTIC_TURN_INVALID");
        if (done[0].model?.providerID !== "openai" || done[0].model?.id !== "gpt-6-sol" ||
            done[0].model?.variant !== "default") throw new Error("SEMANTIC_RESPONSE_MODEL_MISMATCH");
        const texts = done[0].content?.filter((c: any) => c.type === "text") ?? [];
        if (texts.length !== 1) throw new Error("SEMANTIC_RESULT_INVALID");
        return { decision: validateSemantic(texts[0].text, validRefs), session_id: sessionID, reviewer_profile: agentID,
          reviewer_agent_sha256: agentHash, model: done[0].model ?? null, provider: done[0].provider ?? null,
          usage: done[0].tokens ?? null };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("SEMANTIC_TIMEOUT");
  } finally {
    await terminateOwnedProcessAndWait(child);
  }
}
