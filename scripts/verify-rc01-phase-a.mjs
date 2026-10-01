import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Read-only live-state observer. Never creates, restores or removes production files.
const repo = fileURLToPath(new URL("../", import.meta.url));
const option = process.argv.slice(2).join(" ");
const phaseD15 = option === "--d1.5";
const phaseD1 = option === "--d1" || phaseD15;
const phaseC = option === "--c" || phaseD1;
const phaseB2 = option === "--b2" || phaseC;
const phaseB1 = option === "--b1" || phaseB2;
if (process.argv.length > 2 && !phaseB1) throw new Error("Usage: verify-rc01-phase-a.mjs [--b1|--b2|--c|--d1|--d1.5]");
const work = "C:\\work";
const live = process.platform === "win32" ? [
  "ai-orchestration-review", "pve-doc", "ai-orchestration-config",
].map((name) => path.join(work, name)) : [];
const pointers = [path.join(repo, "CURRENT_REVIEW.json"),
  ...(process.platform === "win32" ? [path.join(work, "ai-orchestration-review", "CURRENT_REVIEW.json")] : [])];

function snapshot() {
  const result = new Map();
  function walk(file) {
    let stat;
    try { stat = fs.lstatSync(file, { bigint: true }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      result.set(file, "absent");
      return;
    }
    const metadata = [stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.nlink].join(":");
    if (stat.isSymbolicLink()) result.set(file, `${metadata}:${fs.readlinkSync(file)}`);
    else if (stat.isDirectory()) {
      result.set(file, metadata);
      for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name));
    } else if (stat.isFile()) result.set(file, `${metadata}:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`);
    else throw new Error(`BLOCKED: cannot observe special file ${file}`);
  }
  for (const root of [...live, ...pointers]) walk(root);
  return result;
}

let child;
let blocked;
const watchers = [];
function block(reason) {
  if (blocked) return;
  blocked = `BLOCKED: ${reason}`;
  console.error(blocked);
  if (child?.pid) {
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  }
}
function sameOrChild(root, file) {
  const rel = path.relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function watch(directory, recursive, relevant) {
  const watcher = fs.watch(directory, { recursive }, (event, name) => {
    if (!name) { block("live-state watcher returned an unidentified event"); return; }
    const file = path.resolve(directory, String(name));
    if (relevant(file)) block(`live-state filesystem event (${event}): ${file}`);
  });
  watcher.on("error", (error) => block(`live-state watcher failed: ${error.message}`));
  watchers.push(watcher);
}
function watchEntry(target) {
  // A shallow parent watch covers removal/replacement and currently absent roots/pointers.
  // If ancestors are absent, watch the nearest existing ancestor without creating anything.
  let parent = path.dirname(target);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error(`BLOCKED: no watchable ancestor for ${target}`);
    parent = next;
  }
  watch(parent, false, (file) => sameOrChild(file, target));
}
function check(before) {
  const after = snapshot();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));
  if (changed.length) block(`live-state differences: ${changed.slice(0, 10).join(", ")}`);
  if (pointers.some((file) => fs.existsSync(file))) block("CURRENT_REVIEW.json exists");
  if (blocked) throw new Error(blocked);
  console.log(`Live-state check PASS: ${live.length} hashed/event-monitored roots; ${after.size} entries; 0 differences; CURRENT_REVIEW absent`);
}
async function run(args) {
  if (blocked) throw new Error(blocked);
  console.log(`\n> pnpm ${args.join(" ")}`);
  const exit = await new Promise((resolve, reject) => {
    // Commands are fixed below, not caller-controlled shell input.
    child = process.platform === "win32"
      ? spawn("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", `pnpm ${args.join(" ")}`], { cwd: repo, stdio: "inherit" })
      : spawn("pnpm", args, { cwd: repo, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  child = undefined;
  return exit;
}

try {
  if (pointers.some((file) => fs.existsSync(file))) throw new Error("BLOCKED: CURRENT_REVIEW.json exists before tests");
  // Observe transient create/delete events too; hash comparisons alone cannot see these.
  // Each protected root is watched individually. Legacy fixture roots are not observed.
  for (const root of live) {
    watchEntry(root);
    if (fs.existsSync(root)) watch(root, true, () => true);
  }
  for (const pointer of pointers) watchEntry(pointer);
  console.log("Capturing read-only live-state baseline before starting tests...");
  const before = snapshot();
  check(before);
  for (const args of [
    ["exec", "vitest", "run", "tests/scratch-containment.test.ts"],
    ["exec", "vitest", "run", "tests/synthetic-review.test.ts",
      ...(phaseB1 ? ["tests/autonomous-approval.test.ts", "tests/review-workspace-info.test.ts"] : [])],
    ...(phaseB2 || phaseC || phaseD1 ? [
      ["exec", "vitest", "run", "tests/local-gateway.test.ts", "-t", "RC-01_B2"],
      ["exec", "vitest", "run", "tests/mcp-integration.test.ts", "-t", "RC-01_B2"],
    ] : []),
    ...(phaseC || phaseD1 ? [
      ["exec", "vitest", "run", "tests/repo-research.test.ts"],
      ["exec", "vitest", "run", "tests/mcp-integration.test.ts", "-t", "searches"],
    ] : []),
    ...(phaseD1 ? [["exec", "vitest", "run", "tests/autonomous-mcp-approval.test.ts", "tests/dashboard-approval.test.ts", "tests/autonomous-gateway.test.ts"]] : []),
    ...(phaseD15 ? [["exec", "vitest", "run", "tests/dashboard-verified-health.test.ts", "tests/status-codex-interactive-worker.test.ts",
      "tests/worker-exit-telemetry.test.ts", "tests/local-gateway.test.ts", "tests/dashboard-autonomous.test.ts"]] : []),
    ["exec", "vitest", "run", "tests/review-semantic.test.ts", ...(phaseB1 ? ["tests/review-structural.test.ts"] : [])],
    ["typecheck"],
    // The normal tsconfig excludes tests; additionally check the new test boundary.
    ["exec", "tsc", "--noEmit", "-p", "tests/tsconfig.rc01.json"],
  ]) {
    check(before);
    const exit = await run(args);
    check(before);
    if (exit !== 0) throw new Error(`Command failed (${exit}): pnpm ${args.join(" ")}`);
  }
   console.log(`RC-01 Phase ${phaseD15 ? "D1.5 + D2a" : phaseD1 ? "D1" : phaseC ? "C" : phaseB2 ? "B2" : phaseB1 ? "B1" : "A"} PASS; full suite deliberately not selected by this phased runner.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const watcher of watchers) watcher.close();
}
