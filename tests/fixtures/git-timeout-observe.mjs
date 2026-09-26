// Fixed mock of the Git subprocess. It never runs Git and reports the observed option, not an expected goal value.
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const [source, mode] = process.argv.slice(2);
if (!/^C:\\work\\(?:autonomous-semantic-(?:pass|wrong|insufficient|confirmed|success|accepted|mismatch|no-behavior)|autonomous-campaign-(?:success|recovered|gateway|wrong|wrong-review|human)|autonomous-consolidation-(?:success2?|wrong|retry|timeout))-fixture\\src\\workspace\\git\.ts$/.test(source) || !["git-timeout-mock", "typescript-parse"].includes(mode)) process.exit(2);
const text = fs.readFileSync(source, "utf8");
const sourceFile = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
if (sourceFile.parseDiagnostics.length) process.exit(3);
if (mode === "typescript-parse") { process.stdout.write(JSON.stringify({ test_kind: mode, result: "PASS" })); process.exit(0); }
const compiled = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
if (compiled.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) process.exit(4);
let observed = null;
const exports = {};
vm.runInNewContext(compiled.outputText, { exports, require(id) {
  if (id === "node:child_process") return { spawnSync(_name, _args, options) { observed = options?.timeout; return { status: 0, stdout: "ok", stderr: "" }; } };
  if (id.endsWith("ignore.js")) return {};
  throw new Error("Unexpected import");
} }, { timeout: 3000 });
if (exports.runGit("fixture", ["status"]).ok !== true || !Number.isSafeInteger(observed) || observed < 1 || observed > 120000) process.exit(5);
process.stdout.write(JSON.stringify({ test_kind: mode, result: "PASS", observed_timeout_ms: observed, assertion: "mocked spawnSync received timeout option" }));
