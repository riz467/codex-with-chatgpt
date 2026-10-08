import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Contract } from "./bounded-task.js";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export type ReferenceEvidence = {
  version: 1; baseline_head: string;
  references: { path: string; commit_sha: string; file_sha256: string; content_sha256: string;
    start_line: number; end_line: number; total_lines: number; content: string }[];
  unavailable: { path: string; reason: string }[];
};

// Controller-owned read scope. Never resolve a path supplied by reviewer text.
function referencePaths(contract: Contract): string[] {
  const extra = contract.execution_profile === "tracked_typescript_control_plane"
    ? ["tests/bounded-task.test.ts", "tests/bounded-control-plane-profile.test.ts", "tests/mcp-integration.test.ts", "tests/typed-actions.test.ts"]
    : contract.execution_profile === "tracked_typescript_dashboard"
      ? ["tests/dashboard.test.ts", "tests/dashboard-service.test.ts", "tests/dashboard-autonomous.test.ts"] : [];
  return [...new Set([...contract.edit_paths, ...extra])];
}

export function collectReferenceEvidence(repo: string, head: string, contract: Contract): ReferenceEvidence {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("REFERENCE_HEAD_INVALID");
  const result: ReferenceEvidence = { version: 1, baseline_head: head, references: [], unavailable: [] };
  let remaining = 384 * 1024;
  for (const name of referencePaths(contract)) {
    if (!name || /[\\:\x00-\x1f]/.test(name) || name.split("/").some(p => !p || p === "." || p === ".." || /secret|credential|token|\.env|\.key|\.pem/i.test(p))) {
      throw new Error("REFERENCE_SCOPE_INVALID");
    }
    try {
      const entry = execFileSync("git", ["-C", repo, "ls-tree", head, "--", name], { encoding: "utf8", timeout: 10000 });
      if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) throw new Error("REFERENCE_NOT_REGULAR");
      const bytes = execFileSync("git", ["-C", repo, "cat-file", "blob", `${head}:${name}`], { timeout: 10000, maxBuffer: 256 * 1024 });
      if (bytes.includes(0)) throw new Error("REFERENCE_NOT_TEXT");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      let content = "", count = 0;
      for (const line of lines.slice(0, 2000)) {
        const next = `${line}\n`;
        if (Buffer.byteLength(content) + Buffer.byteLength(next) > Math.min(128 * 1024, remaining)) break;
        content += next; count++;
      }
      if (!count && lines.length) throw new Error("REFERENCE_BUDGET_EXHAUSTED");
      remaining -= Buffer.byteLength(content);
      result.references.push({ path: name, commit_sha: head, file_sha256: hash(bytes), content_sha256: hash(content),
        start_line: 1, end_line: count, total_lines: lines.length, content });
      if (count < lines.length) result.unavailable.push({ path: name, reason: "REFERENCE_TRUNCATED" });
    } catch {
      result.unavailable.push({ path: name, reason: "REFERENCE_UNAVAILABLE" });
    }
  }
  return result;
}

export function referencePrompt(evidence: ReferenceEvidence, expanded: boolean): string {
  return JSON.stringify({ ...evidence, references: evidence.references.map(ref => {
    const content = expanded ? ref.content : ref.content.split("\n").slice(0, 200).join("\n");
    return { ...ref, content, content_sha256: hash(content), end_line: expanded ? ref.end_line : Math.min(ref.end_line, 200) };
  }) });
}
