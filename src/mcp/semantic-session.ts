import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { REVIEW_ROOT } from "./local-gateway.js";

const agentID = "c2c-semantic-reviewer";
const exe = "C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node_modules\\@opencode\\cli\\bin\\opencode.exe";
const port = 41740;
const base = `http://127.0.0.1:${port}`;
const sourceAgent = "C:\\work\\ai-orchestration-config\\agents\\c2c-semantic-reviewer.md";
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
  if (!fs.existsSync(exe) || !fs.existsSync(sourceAgent) || !fs.existsSync(runtimeAgent) ||
      fs.lstatSync(runtimeAgent).isSymbolicLink() || hash(fs.readFileSync(sourceAgent)) !== hash(fs.readFileSync(runtimeAgent))) {
    throw new Error("SEMANTIC_AGENT_UNAVAILABLE");
  }
  return hash(fs.readFileSync(runtimeAgent));
}
async function ensureFreePort() {
  const server = net.createServer();
  try { await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve)); }
  catch { throw new Error("SEMANTIC_SERVER_UNAVAILABLE"); }
  finally { server.close(); }
}
export async function semanticSession(prompt: string, executionSessionId: string, validRefs: readonly number[]) {
  const agentHash = assertAgent();
  await ensureFreePort();
  const password = randomBytes(32).toString("hex");
  const controller = new AbortController();
  const child = spawn(exe, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: REVIEW_ROOT, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password }, stdio: "ignore", windowsHide: true,
  });
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
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) break;
      try {
        const info = await api("GET", "/api/info");
        const agents = await api("GET", "/api/agent");
        if (info.pid === child.pid && String(info.version).startsWith("2.") &&
            agents.location?.directory?.toLowerCase() === REVIEW_ROOT.toLowerCase() &&
            agents.data?.some((a: any) => a.id === agentID && a.mode === "primary")) { ready = true; break; }
      } catch { /* bounded startup */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) throw new Error("SEMANTIC_SERVER_UNAVAILABLE");
    const created = await api("POST", "/api/session", { agent: agentID, location: { directory: REVIEW_ROOT }, title: "Independent sealed-bundle semantic review" });
    sessionID = created.data?.id;
    if (!/^ses_[a-zA-Z0-9]+$/.test(sessionID) || sessionID === executionSessionId ||
        created.data?.agent !== agentID || created.data?.location?.directory?.toLowerCase() !== REVIEW_ROOT.toLowerCase()) throw new Error("SEMANTIC_SESSION_INVALID");
    const sent = await api("POST", `/api/session/${sessionID}/prompt`, { text: prompt });
    const userID = sent.data?.id;
    if (!/^msg_[a-zA-Z0-9]+$/.test(userID) || sent.data?.sessionID !== sessionID) throw new Error("SEMANTIC_PROMPT_FAILED");
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
    controller.abort();
    if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 400)); if (child.exitCode === null) child.kill("SIGKILL"); }
  }
}
