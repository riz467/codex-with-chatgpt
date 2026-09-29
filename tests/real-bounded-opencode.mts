// Explicit-only real-worker probe. Requires a precommitted, dedicated fixture seed;
// this script never creates a commit, calls Codex, pushes or records DONE.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { BoundedTasks, type Contract } from "../src/mcp/bounded-task.js";

const parent = "C:\\Users\\workspace\\AppData\\Local\\Temp\\opencode";
const agentSource = path.join("C:", "work", "ai-orchestration-config", "agents", "c2c-bounded-proposer.md");
const adapter = path.join("C:", "work", "ai-orchestration-config", "scripts", "bounded-opencode-proposal.ps1");
const pwsh = path.join("C:", "Program Files", "PowerShell", "7", "pwsh.exe");
const seed = process.env.C2C_BOUNDED_FIXTURE_SEED;
if (process.env.C2C_BOUNDED_REAL_E2E !== "1") throw new Error("REAL_E2E_EXPLICIT_OPT_IN_REQUIRED");
if (!seed || !fs.existsSync(seed) || !fs.realpathSync.native(seed).toLowerCase().startsWith(fs.realpathSync.native(parent).toLowerCase() + path.sep))
  throw new Error("DEDICATED_PRECOMMITTED_TEMP_FIXTURE_SEED_REQUIRED");
if (!fs.existsSync(agentSource) || !fs.existsSync(adapter) || !fs.existsSync(pwsh))
  throw new Error("DEDICATED_OPENCODE_ADAPTER_OR_AGENT_UNAVAILABLE");
const seedGit = (...args: string[]) => execFileSync("git", ["-C", seed, ...args], { encoding: "utf8" }).trim();
if (seedGit("status", "--porcelain=v1", "-uall") ||
    seedGit("ls-files").split("\n").sort().join("\n") !== ".opencode/agents/c2c-bounded-proposer.md\nREADME.md" ||
    fs.readFileSync(path.join(seed, "README.md"), "utf8") !== "Old heading.\n" ||
    !fs.readFileSync(path.join(seed, ".opencode", "agents", "c2c-bounded-proposer.md")).equals(fs.readFileSync(agentSource)))
  throw new Error("FIXTURE_SEED_NOT_CLEAN_OR_NOT_DEDICATED");
const root = path.join(parent, `bounded-real-${randomUUID()}`);
const repo = path.join(root, "fixture");
const resultFile = path.join(root, "result.json");
fs.mkdirSync(root, { recursive: true });
execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--no-hardlinks", seed, repo]);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git("config", "core.autocrlf", "false");
if (git("status", "--porcelain=v1", "-uall")) throw new Error("CLONED_FIXTURE_NOT_CLEAN");
const actualRepo = fs.realpathSync.native(repo);
const contract: Contract = { repo: "fixture", goal: "In README.md, replace the exact words Old heading. with Reviewed heading. Do not change anything else.",
  edit_paths: ["README.md"], acceptance_criteria: ["README.md contains Reviewed heading. and no Old heading."],
  task_kind: "text_change", execution_profile: "tracked_utf8_text", worker: "opencode",
  codex: { allowed: false, max_calls: 0 }, max_revisions: 1, timeout_ms: 180000 };
const controller = new BoundedTasks({ fixture: actualRepo }, path.join(root, "ledger"));
const started = controller.start(contract);
try {
  const observed = await controller.execute(started.task_id);
  const status = controller.status(started.task_id);
  const bundle = controller.artifacts(started.task_id, 1);
  if (observed.state !== "REVIEW_PENDING" || status.codex_calls !== 0 || bundle.worker.worker !== "opencode" ||
      fs.readFileSync(path.join(repo, "README.md"), "utf8") !== "Reviewed heading.\n") throw new Error("INTEGRATION_ASSERTION_FAILED");
  const evidence = { kind: "REAL_OPENCODE_FIXTURE", root, task_id: started.task_id, contract_sha256: started.contract_sha256,
    state: observed.state, revision: observed.revision, manifest_sha256: observed.manifest_sha256,
    worker: bundle.worker, verify: bundle.verify, files: bundle.files, codex_calls: status.codex_calls,
    codex_usage: status.codex_usage, fixture_head: git("rev-parse", "HEAD"), fixture_git_status: git("status", "--short"),
    agent_sha256: createHash("sha256").update(fs.readFileSync(agentSource)).digest("hex") };
  fs.writeFileSync(resultFile, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ result: "PASS", evidence: resultFile, task_id: started.task_id,
    provider: bundle.worker.provider, model: bundle.worker.model, usage: bundle.worker.usage }));
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({ kind: "REAL_OPENCODE_FIXTURE", result: "FAIL", root,
    task_id: started.task_id, state: controller.status(started.task_id).state,
    stop_reason: controller.status(started.task_id).stop_reason,
    error: error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN" }, null, 2));
  console.error(`REAL_OPENCODE_FIXTURE_FAILED: ${error instanceof Error ? error.message : "UNKNOWN"}; evidence=${resultFile}`);
  process.exitCode = 1;
}
