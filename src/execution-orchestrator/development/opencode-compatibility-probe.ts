import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { CanaryPackageIdentity } from "./opencode-compatibility.js";
import { NETWORK_PREFLIGHT_SOURCE } from "./opencode-compatibility-sandbox.js";

/** Host-owned adapter conformance capsule. No candidate source is transformed.
 * Reuses the CURRENT D0/D1 security assertions instead of certifying a weaker
 * substitute adapter. Only dispatch admission is omitted; runEmbedded remains
 * intact. The pinned-package assertion is replaced by host-observed scratch
 * identities, and its version literal is bound to the exact candidate. All
 * capability, wire, OAuth, model and terminal assertions remain unchanged.
 * Transpilation happens in the parent WITHOUT importing any OpenCode module.
 */
export function buildCompatibilityProbe(root: string, output: string, candidate: string, packages: CanaryPackageIdentity[]) {
  const files = new Map<string, string>();
  files.set("network-preflight.mjs", NETWORK_PREFLIGHT_SOURCE);
  files.set("preflight.mjs", `import { preflightNetworkIsolation } from './network-preflight.mjs';
process.stdout.write(JSON.stringify(await preflightNetworkIsolation()));\n`);
  const source = (name: string) => readFileSync(join(root, "src", name), "utf8");
  const dev = (name: string) => source(`execution-orchestrator/development/${name}.ts`);
  const compile = (name: string, text: string) => files.set(name, ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText);
  const replaceOnce = (text: string, before: string, after: string) => {
    if (text.split(before).length !== 2) throw new Error("HOST_ADAPTER_HARNESS_DRIFT");
    return text.replace(before, after);
  };
  const contract = source("task-contract/contract.ts");
  compile("contract.js", contract.slice(0, contract.indexOf("const hash =")));
  compile("opencode-core-adapter.js", dev("opencode-core-adapter"));
  compile("opencode-oauth.js", replaceOnce(dev("opencode-oauth"), "../../task-contract/contract.js", "./contract.js"));
  const original = dev("opencode-transport");
  const tree = ts.createSourceFile("transport.ts", original, ts.ScriptTarget.Latest, true);
  let removed = 0;
  const transport = tree.statements.filter(statement => {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "dispatchProposal") { removed++; return false; }
    return true;
  }).map(statement => statement.getFullText(tree)).join("");
  if (removed !== 1) throw new Error("HOST_ADAPTER_HARNESS_DRIFT");
  let harness = replaceOnce(transport, "../../task-contract/contract.js", "./contract.js");
  harness = replaceOnce(harness, "./opencode-core-profile.js", "./identities.js");
  harness = replaceOnce(harness, "version: z.literal(PROFILE_VERSION)", "version: z.literal(CANDIDATE_VERSION)");
  harness = `import { CANDIDATE_VERSION } from './identities.js';\n${harness}\nexport { runEmbedded };`;
  compile("transport.js", harness);
  // Only the instruction constant is needed; production candidate/request
  // admission and filesystem code do not enter this synthetic probe.
  const inputTree = ts.createSourceFile("input.ts", dev("proposal-input"), ts.ScriptTarget.Latest, true);
  const instruction = inputTree.statements.filter(s => ts.isVariableStatement(s) &&
    s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "HOST_INSTRUCTION"));
  if (instruction.length !== 1) throw new Error("HOST_INSTRUCTION_MISSING");
  compile("proposal-input.js", instruction[0].getText(inputTree));
  // parseProposal and prepareProposalInput only appeared in the removed dispatch
  // function/type annotation and are eliminated by the TS emitter.
  const proposalTree = ts.createSourceFile("proposal.ts", dev("proposal"), ts.ScriptTarget.Latest, true);
  const limit = proposalTree.statements.filter(s => ts.isVariableStatement(s) &&
    s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "MAX_PROPOSAL_BYTES"));
  if (limit.length !== 1) throw new Error("HOST_PROPOSAL_LIMIT_MISSING");
  compile("proposal.js", limit[0].getText(proposalTree));
  files.set("identities.js", `export const CANDIDATE_VERSION = ${JSON.stringify(candidate)};\n` +
    `export const inspectInstalledPackages = () => ${JSON.stringify([
      ...packages.filter(p => p.name === "@opencode/core"), ...packages.filter(p => p.name !== "@opencode/core"),
    ])};\n`);
  files.set("entry.mjs", `
import fs, { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { preflightNetworkIsolation } from './network-preflight.mjs';
// Node's JS realpath walks/lstats every ancestor on Windows, which would
// require read grants outside scratch. The native implementation enforces the
// same permission on the requested path without broadening those grants.
fs.realpath = Object.assign(fs.realpath.native, { native: fs.realpath.native });
fs.realpathSync = Object.assign(fs.realpathSync.native, { native: fs.realpathSync.native });
syncBuiltinESMExports();
const candidateVersion = ${JSON.stringify(candidate)};
if (process.argv.length !== 3 || process.argv[2] !== candidateVersion) process.exit(2);
// No candidate import, including top-level package code, precedes this check.
// The original global fetch is exercised before the synthetic terminal exists.
const network = await preflightNetworkIsolation();
if (network.status !== 'ENFORCED') {
  writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify({ candidateVersion,
    result: 'PROBE_FAILED', capabilities: null, networkObservation: null }), { flag: 'wx' });
  process.exit(0);
}
let calls = 0;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://chatgpt.com/backend-api/codex/responses' || ++calls !== 1 || init?.method !== 'POST')
    throw new Error('UNEXPECTED_FETCH');
  const body = JSON.parse(init.body);
  if (body.model !== 'gpt-5.5' || (body.tools?.length ?? 0) !== 0 || (body.tool_choice ?? 'none') !== 'none')
    throw new Error('INVALID_FAKE_REQUEST');
  const item = { type: 'message', id: 'out_fixture', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'fixture', annotations: [] }] };
  const response = { id: 'resp_fixture', object: 'response', model: 'gpt-5.5', status: 'completed', output: [item] };
  const chunk = (type, data) => 'event: ' + type + '\\ndata: ' + JSON.stringify({ type, ...data }) + '\\n\\n';
  return new Response(chunk('response.created', { response: { ...response, status: 'in_progress', output: [] } }) +
    chunk('response.output_item.added', { output_index: 0, item }) +
    chunk('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'fixture' }) +
    chunk('response.output_item.done', { output_index: 0, item }) + chunk('response.completed', { response }),
    { headers: { 'content-type': 'text/event-stream' } });
};
let result = 'INCOMPATIBLE', capabilities = null;
try {
  const core = await import('./opencode-core-adapter.js');
  core.assertCoreInspection(await core.inspectPinnedCore());
  const oauth = await import('./opencode-oauth.js');
  const transport = await import('./transport.js');
  const credential = oauth.prepareHostOAuthCredential({ type: 'oauth', methodID: 'chatgpt-browser',
    access: 'D1_COMPATIBILITY_SYNTHETIC_FIXTURE_ONLY', expires: Date.now() + 3600000,
    accountID: 'synthetic-account', custodyReference: 'synthetic-custody' });
  const terminal = transport.assertProposalTerminal(await transport.runEmbedded(
    { user: 'D1 synthetic fixture user DATA only.' }, credential, () => {}));
  if (calls !== 1 || terminal.assistants[0].text !== 'fixture') throw new Error('FAKE_TERMINAL_MISMATCH');
  // D1 counts one admitted transport turn. In this process that turn terminates
  // in the host fixture above: fakeProviderCalls=1, actual providerCalls=0.
  capabilities = {
    configIsolation: 'PASS', externalPlugins: 0, wellKnown: 0, discoveredInstructions: 0, builtIns: 0,
    skills: 0, skillInstructions: 0, references: 0, referenceInstructions: 0, mcpServers: 0, mcpTools: 0,
    mcpInstructions: 0, effectivePermission: 'DENY_ALL', agent: 'dev2-proposal', modelVisibleTools: 0,
    codeModeTools: 0, hookAfterTools: 0, freshSession: true, oauthComposition: true,
    oauthModel: 'gpt-5.5', oauthModelEnabled: true, provider: 'openai',
    codexRoute: 'https://chatgpt.com/backend-api/codex/responses', toolChoice: 'none',
    instructions: 'HOST_FIXED', userData: 'SYNTHETIC_FIXTURE', credential: 'SYNTHETIC_FIXTURE',
    providerCalls: 0, fakeProviderCalls: calls,
    networkIsolation: 'NODE_PERMISSION_DENY', candidateNetworkAttemptsAllowed: 0,
    terminal: { started: terminal.started, succeeded: terminal.successfulTerminals, idle: terminal.idle,
      assistantFinish: terminal.assistants[0].finish, completedTimestamp: terminal.assistants[0].completed,
      pending: terminal.pending, toolActivity: terminal.toolActivity },
  };
  result = 'COMPATIBLE';
} catch (error) {
  // Only synthetic fixture data can reach this child's bounded stderr. The
  // parent discards it; upstream exceptions never enter a certificate/report.
  console.error('COMPATIBILITY_PROBE_INVARIANT_FAILED', error);
}
writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify({ candidateVersion, result, capabilities,
  networkObservation: network.observation }), { flag: 'wx' });
`);
  const hash = createHash("sha256");
  for (const [name, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${name}\0${Buffer.byteLength(text)}\0`).update(text);
    writeFileSync(join(output, name), text, { flag: "wx" });
  }
  return hash.digest("hex");
}
