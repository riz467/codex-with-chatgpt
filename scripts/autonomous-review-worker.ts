// Review-plane structural worker. All evidence reads go through a review-bound MCP Bridge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { REVIEW_ROOT } from "../src/mcp/local-gateway.js";
import { getReviewProfile } from "../src/mcp/review-profiles.js";
import { evaluateStructural, structuralVerdict } from "../src/mcp/review-structural.js";
import { semanticPacket, finalSemanticVerdict, shouldStartSemantic, requireSemanticProfile } from "../src/mcp/review-semantic.js";
import { semanticSession } from "../src/mcp/semantic-session.js";

const digest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

export async function reviewBundle(repoKey: string, taskId: string, expectedHead: string) {
  if (!/^rpc-[a-f0-9]{32}$/.test(taskId) || !/^[a-f0-9]{40}$/.test(expectedHead)) {
    throw new Error("INVALID_REVIEW_REQUEST");
  }
  const profile = getReviewProfile(repoKey);
  const workspace = profile.workspace;
  const jobId = `review-${randomUUID()}`;
  const authFile = path.join(os.tmpdir(), `review-auth-${randomUUID()}.json`);
  const lockFile = path.join(REVIEW_ROOT, "rpc-jobs", "review-locks", `${taskId}.lock`);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const lock = fs.openSync(lockFile, "wx");
  let bridge: Awaited<ReturnType<typeof startBridge>>;
  try { bridge = await startBridge({ workspaceRoot: REVIEW_ROOT, port: 0, persistRuntime: false, authStoreFile: authFile }); }
  catch (error) { fs.closeSync(lock); fs.unlinkSync(lockFile); throw error; }
  const client = new Client({ name: "autonomous-structural-review", version: "1" });
  const issues: string[] = [];
  const progressFile = path.join(REVIEW_ROOT, "rpc-jobs", "review-progress", `${taskId}.json`);
  const progress = (phase: string) => {
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    const next = `${progressFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(next, JSON.stringify({ task_id: taskId, review_job_id: jobId, phase, updated_at: new Date().toISOString() }), { flag: "wx" });
    fs.renameSync(next, progressFile);
  };
  let bundle = "";
  let integrityValid = false;
  let manifestHash = "";
  let semanticRecord: Record<string, unknown> | undefined;
  let finalDecision: { review_result: "PASS" | "NEEDS_WORK"; reason_category: string; unresolved_issues: string[]; done_eligible: boolean } | undefined;
  try {
    const token = bridge.authStore.issueTokens({ clientId: "autonomous-structural-review", scopes: ["workspace.read", "review.read"] });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
    }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError || !result.structuredContent) throw new Error(`REVIEW_BRIDGE_${name}_FAILED`);
      return result.structuredContent as Record<string, unknown>;
    };
    const read = async (ref: string) => {
      const record = await call("read_file", { path: ref });
      if (typeof record.content !== "string" || record.truncated === true || record.content.length > 65536) throw new Error("REVIEW_EVIDENCE_INCOMPLETE");
      return record.content;
    };
    const info = await call("workspace_info");
    if (info.workspaceRoot !== REVIEW_ROOT || info.readOnly !== true) throw new Error("REVIEW_WORKSPACE_MISMATCH");
    const pointer = JSON.parse(await read("CURRENT_REVIEW.json")) as Record<string, unknown>;
    if (pointer.task_id !== taskId || pointer.source_workspace !== workspace || pointer.source_head !== expectedHead ||
      typeof pointer.review_bundle !== "string" || !/^reviews\/[a-zA-Z0-9._-]+$/.test(pointer.review_bundle)) {
      throw new Error("REVIEW_POINTER_MISMATCH");
    }
    bundle = pointer.review_bundle;
    progress("STRUCTURAL_REVIEW");
    const integrity = await call("verify_bundle_integrity", { bundle });
    integrityValid = integrity.valid === true && integrity.bundle === bundle && Array.isArray(integrity.issues) && integrity.issues.length === 0;
    if (!integrityValid) issues.push("BUNDLE_INTEGRITY_INVALID");
    // Raw-byte integrity is delegated to the existing Review Bridge, not inferred from read_file text.
    if (integrityValid) {
      const metadata = JSON.parse(await read(`${bundle}/review-bundle.json`)) as Record<string, unknown>;
      const status = JSON.parse(await read(`${bundle}/status.json`)) as Record<string, unknown>;
      const seal = JSON.parse(await read(`${bundle}/audit/review-seal.json`)) as Record<string, unknown>;
      const evidence = new Map<string, string>();
      for (const ref of profile.requiredEvidence) {
        try { evidence.set(ref, await read(`${bundle}/${ref}`)); }
        catch (error) { if ((error as Error).message !== "REVIEW_BRIDGE_read_file_FAILED") throw error; issues.push("EVIDENCE_MISSING"); }
      }
      let manifest: { files?: { path: string; sha256: string }[] } = {};
      try { manifest = JSON.parse(evidence.get("manifest.json") ?? "") as typeof manifest; } catch { issues.push("EVIDENCE_MISSING"); }
      // read_file normalizes line endings; raw-byte manifest SHA belongs to verify_bundle_integrity.
      manifestHash = typeof metadata.manifest_sha256 === "string" ? metadata.manifest_sha256 : "";
      const autoRunId = `auto-${taskId.slice(4)}`;
      const autoRun = JSON.parse(await read(`rpc-jobs/${autoRunId}/autonomous-run.json`)) as Record<string, unknown>;
      const decisions = (await read(`rpc-jobs/${autoRunId}/decision-history.jsonl`)).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      issues.push(...evaluateStructural({ taskId, head: expectedHead, workspace,
        bundle: path.join(REVIEW_ROOT, bundle.replaceAll("/", path.sep)), metadata, status, seal, manifest, evidence, autoRun, decisions }, profile));
      const structural = structuralVerdict(true, issues);
      if (shouldStartSemantic(!!profile.semanticReview, structural)) {
        progress("SEMANTIC_REVIEW");
        const { prompt, refs } = semanticPacket(status, metadata, evidence, profile);
        const executionSession = autoRun.session_id;
        if (typeof executionSession !== "string" || !/^ses_[a-zA-Z0-9]+$/.test(executionSession)) throw new Error("SEMANTIC_BINDING_INVALID");
        const reviewed = await semanticSession(prompt, executionSession, refs);
        const testRecord = JSON.parse(evidence.get("audit/autonomous-tests.json") ?? "{}") as Record<string, unknown>;
        finalDecision = finalSemanticVerdict(structural, reviewed.decision, taskId, bundle, String(metadata.task_id), pointer.review_bundle as string,
          executionSession, reviewed.session_id, refs, profile, testRecord, String(status.goal));
        semanticRecord = { ...reviewed, reviewed_manifest_sha256: manifestHash, execution_session_id: executionSession };
      }
    }
    // The pointer can move during review. In that case no verdict is accepted for this task.
    const latest = JSON.parse(await read("CURRENT_REVIEW.json")) as Record<string, unknown>;
    if (latest.task_id !== taskId || latest.review_bundle !== bundle) throw new Error("REVIEW_POINTER_CHANGED");
    if (integrityValid && latest.canonical_goal_sha256 !==
        (JSON.parse(await read(`${bundle}/review-bundle.json`)) as Record<string, unknown>).canonical_goal_sha256) {
      throw new Error("SEMANTIC_GOAL_BINDING_CHANGED");
    }
    if (profile.semanticReview && integrityValid) {
      const rechecked = await call("verify_bundle_integrity", { bundle });
      if (rechecked.valid !== true || rechecked.bundle !== bundle || !Array.isArray(rechecked.issues) || rechecked.issues.length ||
          (JSON.parse(await read(`${bundle}/review-bundle.json`)) as Record<string, unknown>).manifest_sha256 !== manifestHash) {
        throw new Error("SEMANTIC_BUNDLE_CHANGED");
      }
    }
    const verdict = structuralVerdict(integrityValid, issues);
    // Legacy profiles are retained for historical fixture evidence. No *new* structural-only PASS is emitted.
    const final = finalDecision ?? requireSemanticProfile(verdict, !!profile.semanticReview);
    if (profile.semanticReview && verdict.review_result === "PASS" && !finalDecision) throw new Error("SEMANTIC_REVIEW_UNAVAILABLE");
    const result = {
      ...verdict, ...final, task_id: taskId, bundle_id: bundle, review_job_id: jobId,
      summary: final.review_result === "PASS" ? "Independent structural and semantic review passed; human approval pending." :
        semanticRecord ? "Semantic review found an unresolved goal or behavioral evidence issue." : "Independent structural review found unresolved evidence or policy issues.",
      reviewed_at: new Date().toISOString(),
      evidence_ref: `rpc-jobs/${jobId}/result.json`, manifest_sha256: manifestHash,
      canonical_goal_sha256: integrityValid ? (JSON.parse(await read(`${bundle}/review-bundle.json`)) as Record<string, unknown>).canonical_goal_sha256 : null,
      ...(profile.semanticReview ? { structural_result: verdict.review_result, semantic_result: semanticRecord ? final.review_result : "NOT_RUN", semantic_review: semanticRecord ?? null } : {}),
    };
    const dir = path.join(REVIEW_ROOT, "rpc-jobs", jobId);
    fs.mkdirSync(dir, { recursive: false });
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result), { flag: "wx" });
    const evidence_sha256 = digest(fs.readFileSync(path.join(dir, "result.json")));
    // The immutable result is audit history; only this atomic per-task pointer
    // identifies the current approval candidate. A subsequent review supersedes it.
    const authorityDir = path.join(REVIEW_ROOT, "rpc-jobs", "authoritative");
    fs.mkdirSync(authorityDir, { recursive: true });
    const authorityPath = path.join(authorityDir, `${taskId}.json`);
    const pending = `${authorityPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(pending, JSON.stringify({ task_id: taskId, review_job_id: jobId, bundle_id: bundle,
      manifest_sha256: manifestHash, canonical_goal_sha256: result.canonical_goal_sha256, evidence_sha256 }), { flag: "wx" });
    fs.renameSync(pending, authorityPath);
    progress("REVIEW_COMPLETE");
    return { ...result, evidence_sha256 };
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
    await client.close();
    await bridge.close();
    try { fs.unlinkSync(authFile); } catch { /* temporary auth store may not have been created */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/, ""))) {
  reviewBundle(process.argv[2], process.argv[3], process.argv[4]).then(
    (result) => { process.stdout.write(JSON.stringify(result) + "\n"); },
    (error) => { process.stderr.write(`${error instanceof Error ? error.message : "REVIEW_FAILED"}\n`); process.exitCode = 2; },
  );
}
