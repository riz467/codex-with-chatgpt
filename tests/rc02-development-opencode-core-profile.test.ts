import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { certifyOpenCodeCore, inspectInstalledPackages, assertPackageIdentities, EXPECTED_PACKAGES }
  from "../src/execution-orchestrator/development/opencode-core-profile.js";
import { assertCoreInspection, inspectPinnedCore, SYSTEM, USER_DATA, MODEL_IDENTITY, INTERNAL_PLUGINS }
  from "../src/execution-orchestrator/development/opencode-core-adapter.js";

describe("D0 pinned no-network core certification", () => {
  let observation: ReturnType<typeof assertCoreInspection>;
  let certificate: Awaited<ReturnType<typeof certifyOpenCodeCore>>;
  const fetchGuard = vi.fn(() => Promise.reject(new Error("Network forbidden in D0")));
  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchGuard);
    vi.stubEnv("OPENAI_API_KEY", "D0_REAL_CREDENTIAL_MARKER_MUST_NOT_LEAK");
    observation = assertCoreInspection(await inspectPinnedCore());
    certificate = await certifyOpenCodeCore();
  }, 60_000);
  afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("certifies a real pinned core-local composition, not a mocked certificate", () => {
    expect(certificate.result).toBe("COMPATIBLE");
    expect(certificate.compatible).toBe(true);
    expect(fetchGuard).not.toHaveBeenCalled();
  });
  it("observes exact direct pins, tarball integrity and installed package bytes", () => {
    const packages = inspectInstalledPackages();
    expect(packages).toEqual(EXPECTED_PACKAGES.map(({ entry: _, ...row }) => row));
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const row of packages) expect(manifest.dependencies[row.name]).toBe(row.version);
    expect(packages[0].version).toBe("2.0.22");
  });
  it.each(["version", "integrity", "contentSha256", "name"])("rejects changed package %s", field => {
    const packages = inspectInstalledPackages();
    packages[0][field as keyof typeof packages[0]] = field === "contentSha256" ? "0".repeat(64) : "unexpected";
    expect(() => assertPackageIdentities(packages)).toThrow();
  });
  it("rejects missing or extra package identities", () => {
    const packages = inspectInstalledPackages();
    expect(() => assertPackageIdentities(packages.slice(1))).toThrow();
    expect(() => assertPackageIdentities([...packages, packages[0]])).toThrow();
  });
  it.each(["provider", "model", "agent", "tool", "tools", "plugin", "config", "instruction", "mcp",
    "cwd", "env", "environment", "executable", "argv", "shell", "session", "candidate", "prompt", "timeout"])
  ("rejects caller-selected %s before acquiring core services", async field => {
    expect(await certifyOpenCodeCore({ [field]: "caller-choice" })).toEqual({
      kind: "OPENCODE_CORE_CERTIFICATION_ONLY", result: "FAIL_CLOSED", compatible: false,
      code: "PROPOSAL_CORE_PROFILE_UNSAFE",
    });
  });
  it.each([null, [], "profile", 1])("rejects a non-object request: %j", async input => {
    expect((await certifyOpenCodeCore(input)).result).toBe("FAIL_CLOSED");
  });
  it("disables project and global config and admits only one fixed memory document", () => {
    expect(observation.configOptions).toEqual({ project: false, global: false });
    expect(observation.configEntries).toHaveLength(1);
    expect(observation.compatibility).toEqual({ claude: [], agents: [] });
    const keys = Object.keys(observation.configEntries[0].info as object).sort();
    expect(keys).toEqual(["agents", "default_agent", "snapshots"]);
  });
  it("has no WellKnown entries, refresh, remote pulls or plugin operations", () => {
    expect(observation.wellKnown).toEqual([]);
    expect(observation.activity.wellKnownRefresh).toBe(0);
    expect(observation.externalOperations).toEqual([]);
  });
  it("activates only the explicitly composed pinned builtin inventory", () => {
    expect(observation.plugins.map(p => p.id).sort()).toEqual([...INTERNAL_PLUGINS].sort());
    expect(observation.plugins.every(p => p.source.type === "builtin" && p.state.status === "active")).toBe(true);
  });
  it("disables independent instruction discovery including ancestor/global AGENTS", () => {
    expect(observation.discovery).toEqual({ project: false, global: false, entries: [],
      sources: [{ key: "core/instructions", value: { _tag: "Removed" } }] });
    expect(observation.activity.forbiddenReads).toBe(0);
  });
  it("excludes candidate-like config, plugin, skills, AGENTS and package fixtures", () => {
    expect(observation.activity.forbiddenReads).toBe(0);
    expect(JSON.stringify(observation.prepared)).not.toContain("D0_HOSTILE_PROJECT_INSTRUCTION_DO_NOT_INCLUDE");
    expect(observation.externalOperations).toEqual([]);
  });
  it("uses empty builtins, skill, reference and MCP instruction services", () => {
    for (const key of ["builtIns", "skillInstructions", "referenceInstructions", "mcpInstructions"] as const)
      expect(observation[key]).toEqual([]);
    expect(observation.skills).toEqual([]);
    expect(observation.references).toEqual([]);
    expect(observation.activity.skillPull).toBe(0);
    expect(observation.activity.processes).toBe(0);
  });
  it("has zero MCP servers and tools, including code-mode catalogs", () => {
    expect(observation.mcpServers).toEqual([]);
    expect(observation.mcpTools).toEqual([]);
    expect(observation.codeMode).toBeNull();
    expect(observation.selectedCodeMode).toBeNull();
  });
  it("uses fresh native sessions without history, inbox or instruction entries", () => {
    expect(observation.sessionHistory).toEqual([]);
    expect(observation.sessionInbox).toEqual([]);
    expect(observation.instructionEntries).toEqual([]);
    expect(observation.entryInstructions).toEqual([]);
    expect(certificate.compatible && certificate.nativeSessionId).not.toBe(observation.nativeSessionId);
  });
  it("loads and renders actual SessionContext with no extra visible instructions", () => {
    expect(observation.loadedInitial).toBe("");
    expect(observation.loadedMessages).toEqual([]);
    expect(observation.renderedSessionInstructions).toBe("");
    expect(observation.sessionInstructions).toEqual([
      { key: "core/codemode", value: { _tag: "Removed" } },
      { key: "core/instructions", value: { _tag: "Removed" } },
    ]);
  });
  it("fixes the agent and applies final complete deny to both agent and session", () => {
    expect(observation.agent.id).toBe("dev2-proposal");
    expect(observation.agent.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    expect(observation.sessionPermissions).toEqual(observation.agent.permissions);
    expect(observation.directTools).toEqual([]);
    expect(observation.selectedTools).toEqual([]);
  });
  it("inspects post-context/model/HTTP-hook output, not just the tool registry", () => {
    expect(observation.hookTools).toEqual({});
    expect(observation.prepared.tools).toEqual([]);
    expect(observation.prepared.toolChoice).toEqual({ type: "none" });
    expect(observation.prepared.system.map(p => p.text)).toEqual([SYSTEM, MODEL_IDENTITY]);
    expect(observation.wire.body.messages).toEqual([
      { role: "system", content: `${SYSTEM}\n${MODEL_IDENTITY}` }, { role: "user", content: USER_DATA },
    ]);
    expect(observation.wire.body).not.toHaveProperty("tools");
    expect(observation.wire.body).not.toHaveProperty("tool_choice");
    expect(observation.activity.httpInspections).toBe(1);
  });
  it("never calls a provider/client/fetch or exposes host paths and credentials", () => {
    expect(observation.activity.network).toBe(0);
    expect(observation.activity.providerExecutions).toBe(0);
    expect(fetchGuard).not.toHaveBeenCalled();
    const visible = JSON.stringify([observation.prepared, observation.wire]);
    for (const marker of [...observation.forbiddenMarkers, "D0_REAL_CREDENTIAL_MARKER_MUST_NOT_LEAK"])
      expect(visible).not.toContain(marker);
  });
  it("returns immutable inspection evidence without authority or store capability", () => {
    expect(certificate.kind).toBe("OPENCODE_CORE_CERTIFICATION_ONLY");
    expect(Object.isFrozen(certificate)).toBe(true);
    if (!certificate.compatible) throw new Error("Certification failed");
    expect(Object.isFrozen(certificate.preparedRequest.system[0])).toBe(true);
    for (const key of ["authorized", "approval", "permit", "dispatch", "execute", "DoneApproved", "store"])
      expect(certificate).not.toHaveProperty(key);
    expect(certificate.osProviderOnlyEgress).toBe("NOT_ESTABLISHED");
  });

  // Mutated observations test strict fail-closed policy; they cannot issue a
  // certificate or inject anything into the production composition.
  const cases: [string, (x: any) => void][] = [
    ["project config", x => { x.configOptions.project = true; }],
    ["global config", x => { x.configOptions.global = true; }],
    ["extra config document", x => { x.configEntries.push({ type: "document", info: {} }); }],
    ["host config override", x => { x.configEntries[0].info.plugins = ["evil"]; }],
    ["WellKnown config", x => { x.wellKnown.push({ origin: "https://evil.invalid" }); }],
    ["external plugin operation", x => { x.externalOperations.push({ type: "add", target: "evil" }); }],
    ["non-builtin plugin", x => { x.plugins[0].source = { type: "package", package: "evil" }; }],
    ["unknown builtin", x => { x.plugins[0].id = "unknown"; }],
    ["duplicate builtin", x => { x.plugins[1] = x.plugins[0]; }],
    ["failed builtin", x => { x.plugins[0].state.status = "failed"; }],
    ["instruction discovery", x => { x.discovery.project = true; }],
    ["global instructions", x => { x.discovery.global = true; }],
    ["discovered AGENTS", x => { x.discovery.entries.push({ content: "evil" }); }],
    ["builtin environment", x => { x.builtIns.push({ key: "environment" }); }],
    ["skill", x => { x.skills.push({ id: "evil" }); }],
    ["skill instruction", x => { x.skillInstructions.push("evil"); }],
    ["reference", x => { x.references.push({ id: "evil" }); }],
    ["reference instruction", x => { x.referenceInstructions.push("evil"); }],
    ["MCP server", x => { x.mcpServers.push({ name: "evil" }); }],
    ["MCP tool", x => { x.mcpTools.push({ name: "evil" }); }],
    ["MCP instruction", x => { x.mcpInstructions.push("evil"); }],
    ["instruction entry", x => { x.instructionEntries.push({ key: "api/evil" }); }],
    ["unknown source", x => { x.sessionInstructions.push({ key: "evil", value: "evil" }); }],
    ["non-absent source", x => { x.sessionInstructions[0].value = { _tag: "Unavailable" }; }],
    ["loaded context", x => { x.loadedInitial = "evil"; }],
    ["existing history", x => { x.sessionHistory.push({ role: "user" }); }],
    ["wrong agent", x => { x.agent.id = "build"; }],
    ["permission allow", x => { x.agent.permissions[0].effect = "allow"; }],
    ["session override", x => { x.sessionPermissions.push({ action: "shell", resource: "*", effect: "allow" }); }],
    ["direct tool", x => { x.directTools.push({ name: "shell" }); }],
    ["code-mode tool", x => { x.codeMode = { tools: ["shell"] }; }],
    ["selected tool", x => { x.selectedTools.push({ name: "shell" }); }],
    ["hook-added tool even if filtered later", x => { x.hookTools.shell = {}; }],
    ["hook-added system", x => { x.hookSystem.push({ type: "text", text: "evil" }); }],
    ["prepared tool", x => { x.prepared.tools.push({ name: "shell" }); }],
    ["automatic tool choice", x => { x.prepared.toolChoice.type = "auto"; }],
    ["native HTTP tool injection", x => { x.wire.body.tools = [{ type: "function" }]; }],
    ["native HTTP context injection", x => { x.wire.body.messages[0].content += "evil"; }],
    ["HTTP route injection", x => { x.wire.url = "https://evil.invalid"; }],
    ["model route injection", x => { x.prepared.route.baseURL = "https://evil.invalid"; }],
    ["HTTP header injection", x => { x.wire.headers["x-evil"] = "secret"; }],
    ["network attempt", x => { x.activity.network = 1; }],
    ["provider request", x => { x.activity.providerExecutions = 1; }],
    ["filesystem read", x => { x.activity.forbiddenReads = 1; }],
    ["unknown observation field", x => { x.authorized = true; }],
  ];
  it.each(cases)("fails closed on %s", (_name, mutate) => {
    const data = structuredClone(observation);
    mutate(data);
    expect(() => assertCoreInspection(data)).toThrow();
  });
  it("contains no CLI/environment-flag or external orchestration dependency", () => {
    const source = ["opencode-core-profile.ts", "opencode-core-adapter.ts"].map(name =>
      readFileSync(new URL(`../src/execution-orchestrator/development/${name}`, import.meta.url), "utf8")).join("\n");
    expect(source).not.toMatch(/ai-orchestration-config|\.ps1|OPENCODE_DISABLE|OPENCODE_PURE|\.\.\.process\.env|shell:\s*true/);
    expect(source).not.toMatch(/from ["']node:child_process|sessions\.(prompt|resume)\(/);
  });
});
