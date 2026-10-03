import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { canonicalJson } from "../src/task-contract/contract.js";
import { assessProductionPromotion, certifyCandidate, exactCandidateVersionSchema, inspectCanaryGraph,
  observeCurrentProductionVersion, parseCompatibilityCertificate, resolveCandidateVersion }
  from "../src/execution-orchestrator/development/opencode-compatibility.js";
import { buildCompatibilityProbe } from "../src/execution-orchestrator/development/opencode-compatibility-probe.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: vi.fn() }));
const root = resolve(import.meta.dirname, "..");
const hash = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const sri = "sha512-" + "a".repeat(86) + "==";
const resolution = { candidateVersion: "2.0.23", integrity: sri,
  tarball: "https://registry.npmjs.org/@opencode/core/-/core-2.0.23.tgz", publishedAt: null };
const networkObservation = { backend: "NODE_PERMISSION_DENY", nodeVersion: "25.8.0",
  denied: { fetch: "ERR_ACCESS_DENIED", http: "ERR_ACCESS_DENIED", https: "ERR_ACCESS_DENIED", net: "ERR_ACCESS_DENIED" },
  candidateNetworkAttemptsAllowed: 0 };
const capabilities = {
  configIsolation: "PASS", externalPlugins: 0, wellKnown: 0, discoveredInstructions: 0, builtIns: 0,
  skills: 0, skillInstructions: 0, references: 0, referenceInstructions: 0, mcpServers: 0, mcpTools: 0,
  mcpInstructions: 0, effectivePermission: "DENY_ALL", agent: "dev2-proposal", modelVisibleTools: 0,
  codeModeTools: 0, hookAfterTools: 0, freshSession: true, oauthComposition: true, oauthModel: "gpt-5.5",
  oauthModelEnabled: true, provider: "openai", codexRoute: "https://chatgpt.com/backend-api/codex/responses",
  toolChoice: "none", instructions: "HOST_FIXED", userData: "SYNTHETIC_FIXTURE", credential: "SYNTHETIC_FIXTURE",
  providerCalls: 0, fakeProviderCalls: 1,
  networkIsolation: "NODE_PERMISSION_DENY", candidateNetworkAttemptsAllowed: 0,
  terminal: { started: 1, succeeded: 1, idle: true, assistantFinish: "stop", completedTimestamp: 123, pending: 0, toolActivity: 0 },
};
const temporary: string[] = [];
const temp = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "d1-compat-test-"))); temporary.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.mocked(spawnSync).mockReset();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function installFixture(scratch: string) {
  const packages: Record<string, unknown> = { "": { dependencies: { "@opencode/core": resolution.candidateVersion } } };
  for (const [name, version] of [["@opencode/core", "2.0.23"], ["@opencode/ai", "2.1.0"], ["@opencode/util", "2.2.0"], ["effect", "4.0.0-rc.113"]]) {
    const path = `node_modules/${name}`, dir = join(scratch, path); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, scripts: { install: "SHOULD_NEVER_RUN" } }));
    packages[path] = { version, integrity: sri, resolved: name === "@opencode/core" ? resolution.tarball :
      `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz` };
  }
  writeFileSync(join(scratch, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
}
function mockProcesses(mode: "pass" | "install-failed" | "crash" | "incompatible" | "wrong-version" | "tamper" |
  "network-unavailable" | "network-tamper" = "pass") {
  vi.mocked(spawnSync).mockImplementation(((executable: string, argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean }) => {
    expect(executable).toBe(process.execPath); expect(options.shell).toBe(false);
    expect(options.cwd.startsWith(root)).toBe(false);
    for (const key of ["OPENAI_API_KEY", "CHATGPT_TOKEN", "NODE_OPTIONS", "NPM_TOKEN", "PATH", "HTTPS_PROXY"])
      expect(options.env[key]).toBeUndefined();
    if (argv.includes("install")) {
      expect(options.env.HOME).toBe(options.cwd);
      expect([
        join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
      ]).toContain(argv[0]);
      expect(argv).toContain("--ignore-scripts"); expect(argv).toContain("--workspaces=false");
      expect(argv).toContain(`--userconfig=${join(options.cwd, "user.npmrc")}`);
      expect(argv).toContain(`--globalconfig=${join(options.cwd, "global.npmrc")}`);
      expect(readFileSync(join(options.cwd, "user.npmrc"), "utf8")).toBe("");
      expect(readFileSync(join(options.cwd, "global.npmrc"), "utf8")).toBe("");
      const manifest = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
      expect(manifest.dependencies["@opencode/core"]).toBe("2.0.23");
      expect(argv.join(" ")).not.toContain("pnpm");
      if (mode === "install-failed") return { status: 1 };
      installFixture(options.cwd);
    } else {
      expect(options.env.HOME).toBe(join(options.cwd, "runtime"));
      expect(argv.some(arg => /^--allow-(net|child-process|worker|addons)/.test(arg))).toBe(false);
      if (argv.at(-1) === join(options.cwd, "probe/preflight.mjs")) {
        return { status: 0, stdout: JSON.stringify(mode === "network-unavailable"
          ? { status: "PLATFORM_UNAVAILABLE", observation: null } : { status: "ENFORCED", observation: networkObservation }) };
      }
      expect(argv).toEqual(["--permission", `--allow-fs-read=${options.cwd}`, `--allow-fs-write=${join(options.cwd, "runtime")}`,
        `--allow-fs-write=${join(options.cwd, "probe/result.json")}`,
        join(options.cwd, "probe/entry.mjs"), "2.0.23"]);
      if (mode === "crash") return { status: null, error: new Error("timeout") };
      if (mode === "tamper") writeFileSync(join(options.cwd, "node_modules/effect/extra.js"), "tampered");
      writeFileSync(join(options.cwd, "probe/result.json"), JSON.stringify({ candidateVersion: mode === "wrong-version" ? "2.0.24" : "2.0.23",
        result: mode === "incompatible" ? "INCOMPATIBLE" : "COMPATIBLE", capabilities: mode === "incompatible" ? null : capabilities,
        networkObservation: mode === "network-tamper" ? { ...networkObservation, nodeVersion: "26.0.0" } : networkObservation }));
    }
    return { status: 0, stdout: "", stderr: "" };
  }) as typeof spawnSync);
}
function certificate() {
  const dir = temp(); installFixture(dir);
  return { domain: "RC02_OPENCODE_COMPATIBILITY_V1", candidateVersion: "2.0.23", result: "COMPATIBLE",
    probeVersion: "DL2-D.1/2", probeSha256: "b".repeat(64), ...inspectCanaryGraph(dir, resolution), capabilities: structuredClone(capabilities),
    networkObservation: structuredClone(networkObservation),
    isolation: "SCRATCH_PROCESS_WITH_NETWORK_PREFLIGHT", acquisitionPolicy: "SCRATCH_ONLY_IGNORE_SCRIPTS_RELEASE_AGE_EXEMPT" };
}

describe("D.1 version observation and resolution (no normal network)", () => {
  it("observes production exact pin without importing candidate core", () => {
    expect(observeCurrentProductionVersion().version).toBe("2.0.22");
  });
  it.each(["latest", "^2.0.23", "2.0", "02.0.23", "2.0.23;echo injected", "2.0.23\n", "--ignore-scripts=false", "file:../x", "2.0.23-01"])("rejects non-exact candidate %s", async version => {
    expect(exactCandidateVersionSchema.safeParse(version).success).toBe(false);
    await expect(certifyCandidate({ ...resolution, candidateVersion: version })).rejects.toThrow();
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it("resolves tag once, preserves exact version and registry integrity", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ "dist-tags": { latest: "2.0.23" }, versions: {
      "2.0.23": { name: "@opencode/core", version: "2.0.23", dist: { integrity: sri, tarball: resolution.tarball } },
    }, time: { "2.0.23": "2026-10-03T00:00:00.000Z" } })));
    vi.stubGlobal("fetch", fetcher);
    const result = await resolveCandidateVersion("latest");
    expect(result.candidateVersion).toBe("2.0.23"); expect(Object.isFrozen(result)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(spawnSync).not.toHaveBeenCalled();
  });
  it("rejects selector injection before lookup and mismatched registry version", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ versions: {
      "2.0.23": { name: "@opencode/core", version: "2.0.24", dist: { integrity: sri, tarball: resolution.tarball } },
    } })));
    vi.stubGlobal("fetch", fetcher);
    await expect(resolveCandidateVersion("latest && echo x")).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    await expect(resolveCandidateVersion("2.0.23")).rejects.toThrow("CANDIDATE_VERSION_MISMATCH");
  });
});

describe("D.1 scratch acquisition and subprocess protocol", () => {
  it("rejects a canonical temporary root before creating/installing a canary", async () => {
    for (const key of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(key, root);
    await expect(certifyCandidate(resolution)).rejects.toThrow("CANARY_MUST_BE_OUTSIDE_CANONICAL");
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it("keeps canonical/global policy and secrets outside the separate probe, binds actual companion versions", async () => {
    const paths = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].map(p => join(root, p));
    for (const path of [join(process.env.USERPROFILE ?? tmpdir(), ".npmrc"), join(dirname(process.execPath), "etc/npmrc")])
      if (existsSync(path)) paths.push(path);
    const before = paths.map(p => hash(readFileSync(p)));
    for (const key of ["OPENAI_API_KEY", "CHATGPT_TOKEN", "NODE_OPTIONS", "NPM_TOKEN", "HTTPS_PROXY"]) vi.stubEnv(key, "PRODUCTION_SECRET_TRAP");
    mockProcesses();
    const report = await certifyCandidate(resolution);
    expect(report.certificate.result).toBe("COMPATIBLE"); expect(report.productionPromotion.status).toBe("PROMOTION_STATUS_UNKNOWN");
    expect(report.certificate.packages.find(p => p.name === "@opencode/ai")?.version).toBe("2.1.0");
    expect(paths.map(p => hash(readFileSync(p)))).toEqual(before);
    expect(spawnSync).toHaveBeenCalledTimes(3);
    expect(Object.isFrozen(report.certificate.packages[0])).toBe(true);
    const cwd = (vi.mocked(spawnSync).mock.calls[0][2] as { cwd: string }).cwd;
    expect(existsSync(cwd)).toBe(false);
  });
  it.each([ ["install-failed", "ACQUISITION_FAILED"], ["crash", "PROBE_FAILED"], ["incompatible", "INCOMPATIBLE"],
    ["wrong-version", "PROBE_FAILED"], ["tamper", "PROBE_FAILED"], ["network-unavailable", "PROBE_FAILED"],
    ["network-tamper", "PROBE_FAILED"] ] as const)("classifies %s as %s", async (mode, result) => {
    mockProcesses(mode); const report = await certifyCandidate(resolution);
    expect(report.certificate.result).toBe(result); expect(report.certificate.capabilities).toBeNull();
    expect(report.productionPromotion.status).toBe("NOT_ELIGIBLE");
    if (mode === "network-unavailable") {
      expect(report.liveProbe).toBe("PLATFORM_UNAVAILABLE");
      expect(report.certificate.networkObservation).toBeNull();
      expect(spawnSync).toHaveBeenCalledTimes(2); // Acquisition + trusted preflight; no candidate process.
    }
  });
  it("rejects graph version/SRI mismatch and installed payload replacement", () => {
    const dir = temp(); installFixture(dir); const before = inspectCanaryGraph(dir, resolution);
    expect(() => inspectCanaryGraph(dir, { ...resolution, candidateVersion: "2.0.24" })).toThrow();
    expect(() => inspectCanaryGraph(dir, { ...resolution, integrity: "sha512-" + "b".repeat(86) + "==" })).toThrow();
    writeFileSync(join(dir, "node_modules/effect/replacement.js"), "changed");
    expect(inspectCanaryGraph(dir, resolution).graphSha256).not.toBe(before.graphSha256);
  });
  it("records npm aliases by published identity plus installation path, rejects ambiguous required packages", () => {
    const dir = temp(); installFixture(dir);
    const lockPath = join(dir, "package-lock.json"), lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const path = "node_modules/alias-fixture";
    mkdirSync(join(dir, path));
    writeFileSync(join(dir, path, "package.json"), JSON.stringify({ name: "original-fixture", version: "1.0.0" }));
    lock.packages[path] = { name: "original-fixture", version: "1.0.0", integrity: sri,
      resolved: "https://registry.npmjs.org/original-fixture/-/original-fixture-1.0.0.tgz" };
    writeFileSync(lockPath, JSON.stringify(lock));
    expect(inspectCanaryGraph(dir, resolution).packages.find(p => p.path === path)?.name).toBe("original-fixture");
    lock.packages[path].name = "effect";
    writeFileSync(join(dir, path, "package.json"), JSON.stringify({ name: "effect", version: "1.0.0" }));
    writeFileSync(lockPath, JSON.stringify(lock));
    expect(() => inspectCanaryGraph(dir, resolution)).toThrow("AMBIGUOUS_ADAPTER_GRAPH");
  });
  it("runs the fixed entrypoint and classifies missing candidate public APIs INCOMPATIBLE", async () => {
    const dir = temp(); installFixture(dir); const capsule = join(dir, "probe"); mkdirSync(capsule);
    const runtime = join(dir, "runtime"); mkdirSync(runtime);
    buildCompatibilityProbe(root, capsule, "2.0.23", inspectCanaryGraph(dir, resolution).packages);
    // A top-level candidate fixture would leave a marker if imported. On an
    // unavailable runtime even this code must never execute.
    const marker = join(runtime, "candidate-imported");
    writeFileSync(join(capsule, "opencode-core-adapter.js"), `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, String(process.permission.has('net')));
      throw new Error('MISSING_PUBLIC_API');`);
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const child = actual.spawnSync(process.execPath, ["--permission", `--allow-fs-read=${dir}`, `--allow-fs-write=${runtime}`,
      `--allow-fs-write=${join(capsule, "result.json")}`, join(capsule, "entry.mjs"), "2.0.23"],
    { cwd: dir, env: { TEMP: runtime, TMP: runtime, HOME: runtime }, shell: false, timeout: 30_000 });
    expect(child.status).toBe(0);
    const observed = JSON.parse(readFileSync(join(capsule, "result.json"), "utf8"));
    if (Number(process.versions.node.split(".")[0]) < 25) {
      expect(observed).toEqual({ candidateVersion: "2.0.23", result: "PROBE_FAILED", capabilities: null, networkObservation: null });
      expect(existsSync(marker)).toBe(false);
    } else {
      expect(observed.result).toBe("INCOMPATIBLE"); expect(observed.networkObservation.backend).toBe("NODE_PERMISSION_DENY");
      expect(readFileSync(marker, "utf8")).toBe("false");
    }
    const transport = readFileSync(join(capsule, "transport.js"), "utf8");
    expect(transport).not.toContain("dispatchProposal");
    expect(transport).not.toContain("review-context.js"); expect(transport).not.toContain("review-evidence.js");
    expect(transport).not.toContain("dispatchAdvisoryReview"); expect(transport).not.toContain("HOST_REVIEW_INSTRUCTION");
    expect(transport).not.toContain("assertReviewCoreBoundary"); expect(transport).not.toContain("assertAdmission");
    expect(transport).toContain("async function runEmbedded"); expect(transport).toContain("export { runEmbedded }");
    expect(transport).toContain("assertOAuthWireIdentity"); expect(transport).toContain("assertProposalCoreBoundary");
    expect(transport).toContain("version: z.literal(CANDIDATE_VERSION)");
  });
  it("loads the generated entrypoint through the candidate public-API fixture without review dependencies", async () => {
    const dir = temp(); installFixture(dir); const capsule = join(dir, "probe"); mkdirSync(capsule);
    const runtime = join(dir, "runtime"); mkdirSync(runtime);
    buildCompatibilityProbe(root, capsule, "2.0.23", inspectCanaryGraph(dir, resolution).packages);
    // Public-API fixture only: imports can link, but execution deliberately
    // fails at OAuth composition. This is not a mock compatibility success.
    writeFileSync(join(capsule, "opencode-core-adapter.js"), `export const AGENT = 'dev2-proposal', DENY = {},
      INTERNAL_PLUGINS = [], PROFILE_VERSION = '2.0.22';
      export const inspectPinnedCore = async () => ({}); export const assertCoreInspection = () => {};`);
    const modules = new Map<string, Set<string>>();
    for (const name of ["transport.js", "opencode-oauth.js"]) {
      const tree = ts.createSourceFile(name, readFileSync(join(capsule, name), "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith("@opencode/") && !specifier.startsWith("effect")) continue;
        const bindings = statement.importClause?.namedBindings;
        expect(bindings && ts.isNamedImports(bindings)).toBe(true);
        const names = modules.get(specifier) ?? new Set<string>();
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements)
          names.add((binding.propertyName ?? binding.name).text);
        modules.set(specifier, names);
      }
    }
    for (const [specifier, names] of modules) {
      const parts = specifier.split("/"), packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      const subpath = parts.slice(specifier.startsWith("@") ? 2 : 1).join("/");
      const packageDir = join(dir, "node_modules", packageName), file = subpath ? `${subpath}.js` : "index.js";
      mkdirSync(dirname(join(packageDir, file)), { recursive: true });
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module", exports: { ".": "./index.js", "./*": "./*.js" } }));
      writeFileSync(join(packageDir, file), [...names].map(name => name === "Credential"
        ? `export const Credential = { ID: { make() { throw new Error('PUBLIC_API_FIXTURE_REACHED_OAUTH_COMPOSITION'); } } };`
        : `export const ${name} = {};`).join("\n"));
    }
    const require = createRequire(import.meta.url);
    cpSync(dirname(require.resolve("zod/package.json")), join(dir, "node_modules/zod"), { recursive: true });
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    // Exercise module loading even on Node versions where the real entrypoint
    // correctly stops before imports because network permissions are unavailable.
    const load = actual.spawnSync(process.execPath, ["--permission", `--allow-fs-read=${dir}`, "--input-type=module", "-e",
      `const transport = await import(${JSON.stringify(pathToFileURL(join(capsule, "transport.js")).href)});
       if (typeof transport.runEmbedded !== 'function') process.exit(3);`],
    { cwd: dir, env: {}, shell: false, encoding: "utf8", timeout: 30_000 });
    expect(load.stderr).not.toContain("ERR_MODULE_NOT_FOUND"); expect(load.status).toBe(0);
    const child = actual.spawnSync(process.execPath, ["--permission", `--allow-fs-read=${dir}`, `--allow-fs-write=${runtime}`,
      `--allow-fs-write=${join(capsule, "result.json")}`, join(capsule, "entry.mjs"), "2.0.23"],
    { cwd: dir, env: { TEMP: runtime, TMP: runtime, HOME: runtime }, shell: false, encoding: "utf8", timeout: 30_000 });
    expect(child.status).toBe(0); expect(child.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    const observed = JSON.parse(readFileSync(join(capsule, "result.json"), "utf8"));
    if (Number(process.versions.node.split(".")[0]) >= 25) {
      expect(child.stderr).toContain("PUBLIC_API_FIXTURE_REACHED_OAUTH_COMPOSITION");
      expect(observed.result).toBe("INCOMPATIBLE");
    } else expect(observed.result).toBe("PROBE_FAILED");
    expect(existsSync(join(capsule, "review-context.js"))).toBe(false);
    expect(existsSync(join(capsule, "review-evidence.js"))).toBe(false);
  });
  it.each(["missing-import", "duplicate-import", "missing-function", "duplicate-function", "changed-branch", "extra-reference"])(
    "fails closed on review harness drift: %s", mode => {
      const fixture = temp(), capsule = join(fixture, "probe"); mkdirSync(capsule);
      const files = ["task-contract/contract", ...["opencode-core-adapter", "opencode-oauth", "opencode-transport",
        "proposal-input", "proposal"].map(name => `execution-orchestrator/development/${name}`)];
      for (const file of files) {
        const target = join(fixture, "src", `${file}.ts`); mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, "src", `${file}.ts`), target);
      }
      const path = join(fixture, "src/execution-orchestrator/development/opencode-transport.ts");
      let source = readFileSync(path, "utf8");
      if (mode === "missing-import") source = source.replace('from "./review-context.js"', 'from "./renamed-review-context.js"');
      if (mode === "duplicate-import") source += '\nimport { parseFindings as other } from "./review-evidence.js";';
      if (mode === "missing-function") source = source.replace("function assertReviewCoreBoundary", "function renamedReviewBoundary");
      if (mode === "duplicate-function") source += "\nfunction assertReviewCoreBoundary() {}";
      if (mode === "changed-branch") source = source.replace("review ? HOST_REVIEW_INSTRUCTION : HOST_INSTRUCTION", "review ? HOST_REVIEW_INSTRUCTION : prompt.system");
      if (mode === "extra-reference") source += "\nconst unexpected = HOST_REVIEW_INSTRUCTION;";
      writeFileSync(path, source);
      expect(() => buildCompatibilityProbe(fixture, capsule, "2.0.23", [])).toThrow("HOST_ADAPTER_HARNESS_DRIFT");
      expect(existsSync(join(capsule, "transport.js"))).toBe(false);
      expect(existsSync(join(capsule, "entry.mjs"))).toBe(false);
    });
  it("native realpath compatibility keeps filesystem reads/writes outside scratch denied", async () => {
    const dir = temp(), outside = temp(), secret = join(outside, "production-secret");
    const runtime = join(dir, "runtime"), packageFile = join(dir, "candidate-package.js");
    mkdirSync(runtime); writeFileSync(packageFile, "candidate");
    writeFileSync(join(dir, "fixture.mjs"), "export default 'SCRATCH_IMPORT';");
    writeFileSync(secret, "PRODUCTION_SECRET_TRAP");
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const code = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      import { spawnSync } from 'node:child_process';
      fs.realpath = Object.assign(fs.realpath.native, { native: fs.realpath.native });
      fs.realpathSync = Object.assign(fs.realpathSync.native, { native: fs.realpathSync.native });
      syncBuiltinESMExports();
      if ((await import('./fixture.mjs')).default !== 'SCRATCH_IMPORT') process.exit(4);
      fs.realpathSync(${JSON.stringify(dir)});
      for (const operation of [() => fs.readFileSync(${JSON.stringify(secret)}),
        () => fs.writeFileSync(${JSON.stringify(secret)}, 'changed'), () => fs.realpathSync(${JSON.stringify(secret)}),
        () => fs.writeFileSync(${JSON.stringify(packageFile)}, 'changed'),
        () => fs.readFileSync(${JSON.stringify(join(root, "package.json"))}),
        () => spawnSync(process.execPath, ['-e', 'process.exit(0)'])]) {
        let denied = false;
        try { operation(); } catch(e) { denied = e.code === 'ERR_ACCESS_DENIED'; }
        if (!denied) process.exit(3);
      }`;
    const child = actual.spawnSync(process.execPath, ["--permission", `--allow-fs-read=${dir}`, `--allow-fs-write=${runtime}`,
      "--input-type=module", "-e", code], { cwd: dir, env: {}, shell: false, timeout: 10_000 });
    expect(child.status).toBe(0); expect(readFileSync(secret, "utf8")).toBe("PRODUCTION_SECRET_TRAP");
    expect(readFileSync(packageFile, "utf8")).toBe("candidate");
  });
  it("host CLI requires explicit acquisition opt-in", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const child = actual.spawnSync(process.execPath, [join(root, "scripts/verify-opencode-compatibility.mjs"), "latest"],
      { cwd: root, shell: false, encoding: "utf8", timeout: 10_000 });
    expect(child.status).toBe(2); expect(child.stderr).toContain("--acquire --candidate");
  });
});

describe("D.1 strict capability evidence and promotion separation", () => {
  it.each(["externalPlugins", "wellKnown", "discoveredInstructions", "builtIns", "skills", "skillInstructions", "references",
    "referenceInstructions", "mcpServers", "mcpTools", "mcpInstructions", "modelVisibleTools", "codeModeTools", "hookAfterTools", "providerCalls", "candidateNetworkAttemptsAllowed"])("rejects nonzero %s", key => {
    const c = certificate(); (c.capabilities as Record<string, unknown>)[key] = 1;
    expect(() => parseCompatibilityCertificate(c)).toThrow();
  });
  it.each([["configIsolation", "FAIL"], ["effectivePermission", "ALLOW"], ["freshSession", false], ["oauthComposition", false],
    ["oauthModelEnabled", false], ["oauthModel", "gpt-4.1"], ["codexRoute", "https://api.openai.com/v1/responses"],
    ["toolChoice", "auto"], ["instructions", "PROJECT"], ["credential", "PRODUCTION"], ["userData", "REAL_DATA"],
    ["fakeProviderCalls", 0], ["networkIsolation", "UNKNOWN"], ["networkIsolation", "APPLICATION_FAKE_ONLY"]])("rejects invalid %s", (key, value) => {
    const c = certificate(); (c.capabilities as Record<string, unknown>)[key as string] = value;
    expect(() => parseCompatibilityCertificate(c)).toThrow();
  });
  it.each(["started", "succeeded", "idle", "assistantFinish", "completedTimestamp", "pending", "toolActivity"])("requires public terminal observation %s", key => {
    const c = certificate(); delete (c.capabilities.terminal as Record<string, unknown>)[key];
    expect(() => parseCompatibilityCertificate(c)).toThrow();
  });
  it.each(["authorized", "approved", "permit", "promoted", "productionCurrent"])("rejects authority field %s", key => {
    expect(() => parseCompatibilityCertificate({ ...certificate(), [key]: true })).toThrow();
  });
  it("binds graph/candidate and recursively freezes strict data including nested capabilities", () => {
    const c = certificate(), parsed = parseCompatibilityCertificate(c);
    expect(Object.isFrozen(parsed.capabilities?.terminal)).toBe(true);
    expect(() => parseCompatibilityCertificate({ ...c, candidateVersion: "2.0.24" })).toThrow();
    expect(() => parseCompatibilityCertificate({ ...c, graphSha256: "0".repeat(64) })).toThrow();
    expect(() => parseCompatibilityCertificate({ ...c, capabilities: null })).toThrow();
    expect(() => parseCompatibilityCertificate({ ...c, networkObservation: null })).toThrow();
    const missingPayloadIdentity = structuredClone(c);
    missingPayloadIdentity.packages.find(p => p.name === "effect")!.contentSha256 = null;
    missingPayloadIdentity.graphSha256 = hash(canonicalJson(missingPayloadIdentity.packages));
    expect(() => parseCompatibilityCertificate(missingPayloadIdentity)).toThrow();
    const getter = Object.defineProperty({}, "result", { enumerable: true, get: () => { throw new Error("must not execute"); } });
    expect(() => parseCompatibilityCertificate(getter)).toThrow("Invalid JSON property");
  });
  it("compatible/release-age waiting remains compatible and eligibility has no mutation operation", () => {
    const c = parseCompatibilityCertificate(certificate());
    const observation = { candidateVersion: "2.0.23", publishedAt: 1000, observedAt: 1001,
      minimumReleaseAgeMinutes: 1440, policySource: "OBSERVED_NORMAL_PNPM_POLICY" };
    expect(assessProductionPromotion(c, observation)).toEqual({ status: "PROMOTION_WAITING", reason: "WAITING_RELEASE_AGE" });
    expect(c.result).toBe("COMPATIBLE");
    expect(assessProductionPromotion(c, { ...observation, observedAt: 1000 + 1440 * 60_000 })).toEqual({ status: "ELIGIBLE_FOR_HUMAN_REVIEW" });
    expect(assessProductionPromotion(c)).toEqual({ status: "PROMOTION_STATUS_UNKNOWN" });
    expect(assessProductionPromotion(c, { ...observation, candidateVersion: "2.0.24" }).status).toBe("PROMOTION_STATUS_UNKNOWN");
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

// Explicit opt-in only; uses the real fixed npm CLI, registry and child process.
it.skipIf(process.env.RC02_OPENCODE_COMPATIBILITY_INTEGRATION !== "1" || Number(process.versions.node.split(".")[0]) < 25)("D.1 registry/install pinned baseline through local fake terminal", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawnSync).mockImplementation(((...args: Parameters<typeof spawnSync>) => {
    const result = actual.spawnSync(...args);
    // Opt-in diagnostic only, in a process with synthetic credentials only.
    if ((args[1] as string[]).some(arg => arg.endsWith("entry.mjs")) && result.stderr?.length)
      console.error(String(result.stderr));
    return result;
  }) as typeof spawnSync);
  const candidate = await resolveCandidateVersion("2.0.22");
  const report = await certifyCandidate(candidate);
  expect(report.certificate.result).toBe("COMPATIBLE");
  expect(report.certificate.capabilities?.providerCalls).toBe(0);
  expect(report.certificate.capabilities?.fakeProviderCalls).toBe(1);
}, 600_000);
