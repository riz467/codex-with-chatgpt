import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJson, freeze, parseStrict } from "../../task-contract/contract.js";
import { buildCompatibilityProbe } from "./opencode-compatibility-probe.js";
import { networkObservationSchema, parseNetworkObservation } from "./opencode-compatibility-sandbox.js";

// Host-only reporting API. No production installer, credential handle, mutable
// runtime, git operation or promotion callback is accepted by this module.
// Native canonicalization expands Windows 8.3 aliases before permission grants
// are built; otherwise the ESM loader can resolve the same file to a long path
// that is absent from the permission allowlist.
const root = realpathSync.native(fileURLToPath(new URL("../../../", import.meta.url)));
const registry = "https://registry.npmjs.org";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const numeric = "(?:0|[1-9][0-9]*)";
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
export const exactCandidateVersionSchema = z.string().max(160).regex(new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`));
const integritySchema = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/);
const resolutionSchema = z.object({ candidateVersion: exactCandidateVersionSchema, integrity: integritySchema,
  tarball: z.string().url().refine(url => {
    const u = new URL(url);
    return u.origin === registry && !u.username && !u.password && u.pathname.startsWith("/@opencode/core/-/") && !u.search && !u.hash;
  }), publishedAt: z.string().datetime().nullable() }).strict();
export type CandidateResolution = Readonly<z.infer<typeof resolutionSchema>>;

export function observeCurrentProductionVersion() {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return freeze({ package: "@opencode/core" as const,
    version: exactCandidateVersionSchema.parse(manifest.dependencies?.["@opencode/core"]),
    manifestSha256: sha(readFileSync(join(root, "package.json"))),
    lockSha256: sha(readFileSync(join(root, "pnpm-lock.yaml"))) });
}

/** Registry observation only. A tag is resolved once and never enters a certificate. */
export async function resolveCandidateVersion(input: unknown): Promise<CandidateResolution> {
  const selector = z.string().max(160).parse(input);
  if (!exactCandidateVersionSchema.safeParse(selector).success && !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(selector))
    throw new Error("INVALID_CANDIDATE_SELECTOR");
  const response = await fetch(`${registry}/@opencode%2fcore`, {
    headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("REGISTRY_LOOKUP_FAILED");
  const text = await response.text();
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("REGISTRY_METADATA_TOO_LARGE");
  const metadata = JSON.parse(text);
  const version = exactCandidateVersionSchema.parse(exactCandidateVersionSchema.safeParse(selector).success
    ? selector : metadata["dist-tags"]?.[selector]);
  const row = metadata.versions?.[version];
  if (row?.name !== "@opencode/core" || row.version !== version) throw new Error("CANDIDATE_VERSION_MISMATCH");
  const published = metadata.time?.[version];
  return freeze(parseStrict(resolutionSchema, { candidateVersion: version, integrity: row.dist?.integrity,
    tarball: row.dist?.tarball, publishedAt: z.string().datetime().safeParse(published).success ? published : null }));
}

const identitySchema = z.object({ path: z.string().min(1), name: z.string().min(1), version: exactCandidateVersionSchema,
  integrity: integritySchema, resolved: z.string().url(), contentSha256: digest.nullable() }).strict();
const adapterPackages = ["@opencode/core", "@opencode/ai", "@opencode/util", "effect"];
export type CanaryPackageIdentity = z.infer<typeof identitySchema>;
const capabilitiesSchema = z.object({
  configIsolation: z.literal("PASS"), externalPlugins: z.literal(0), wellKnown: z.literal(0),
  discoveredInstructions: z.literal(0), builtIns: z.literal(0), skills: z.literal(0), skillInstructions: z.literal(0),
  references: z.literal(0), referenceInstructions: z.literal(0), mcpServers: z.literal(0), mcpTools: z.literal(0),
  mcpInstructions: z.literal(0), effectivePermission: z.literal("DENY_ALL"), agent: z.literal("dev2-proposal"),
  modelVisibleTools: z.literal(0), codeModeTools: z.literal(0), hookAfterTools: z.literal(0), freshSession: z.literal(true),
  oauthComposition: z.literal(true), oauthModel: z.literal("gpt-5.5"), oauthModelEnabled: z.literal(true),
  provider: z.literal("openai"), codexRoute: z.literal("https://chatgpt.com/backend-api/codex/responses"),
  toolChoice: z.literal("none"), instructions: z.literal("HOST_FIXED"), userData: z.literal("SYNTHETIC_FIXTURE"),
  credential: z.literal("SYNTHETIC_FIXTURE"), providerCalls: z.literal(0), fakeProviderCalls: z.literal(1),
  networkIsolation: z.literal("NODE_PERMISSION_DENY"), candidateNetworkAttemptsAllowed: z.literal(0),
  terminal: z.object({ started: z.literal(1), succeeded: z.literal(1), idle: z.literal(true),
    assistantFinish: z.literal("stop"), completedTimestamp: z.number().finite().nonnegative(),
    pending: z.literal(0), toolActivity: z.literal(0) }).strict(),
}).strict();
export const compatibilityCertificateSchema = z.object({
  domain: z.literal("RC02_OPENCODE_COMPATIBILITY_V1"), candidateVersion: exactCandidateVersionSchema,
  result: z.enum(["COMPATIBLE", "INCOMPATIBLE", "PROBE_FAILED", "ACQUISITION_FAILED"]),
  probeVersion: z.literal("DL2-D.1/2"), probeSha256: digest.nullable(),
  packages: z.array(identitySchema), lockSha256: digest.nullable(), graphSha256: digest.nullable(),
  capabilities: capabilitiesSchema.nullable(),
  networkObservation: networkObservationSchema.nullable(),
  isolation: z.literal("SCRATCH_PROCESS_WITH_NETWORK_PREFLIGHT"),
  acquisitionPolicy: z.literal("SCRATCH_ONLY_IGNORE_SCRIPTS_RELEASE_AGE_EXEMPT"),
}).strict().superRefine((x, ctx) => {
  if (x.result === "COMPATIBLE" && (!x.networkObservation || !x.capabilities || !x.probeSha256 || !x.lockSha256 || !x.graphSha256 ||
    adapterPackages.some(name => !x.packages.some(p => p.name === name && p.contentSha256 !== null))))
    ctx.addIssue({ code: "custom", message: "Missing capability or graph evidence" });
  if (x.result !== "COMPATIBLE" && x.capabilities !== null) ctx.addIssue({ code: "custom", message: "Failure has no capabilities" });
  const cores = x.packages.filter(p => p.name === "@opencode/core");
  if (cores.some(p => p.version !== x.candidateVersion) || (x.result === "COMPATIBLE" && cores.length !== 1))
    ctx.addIssue({ code: "custom", message: "Candidate version mismatch" });
  if (new Set(x.packages.map(p => p.path)).size !== x.packages.length)
    ctx.addIssue({ code: "custom", message: "Duplicate package identity" });
  if (x.graphSha256 !== null && x.graphSha256 !== sha(canonicalJson(x.packages)))
    ctx.addIssue({ code: "custom", message: "Graph digest mismatch" });
});
export function parseCompatibilityCertificate(input: unknown) { return freeze(parseStrict(compatibilityCertificateSchema, input)); }

/** Trust-neutral observed age DATA; never authorizes mutation. The caller must
 * supply actual normal-policy observations, not a guessed default age. */
export function assessProductionPromotion(certificate: unknown, input: unknown = null) {
  const cert = parseCompatibilityCertificate(certificate);
  if (cert.result !== "COMPATIBLE") return freeze({ status: "NOT_ELIGIBLE" as const });
  const age = z.object({ candidateVersion: exactCandidateVersionSchema, publishedAt: z.number().int().safe().nonnegative(),
    observedAt: z.number().int().safe().nonnegative(), minimumReleaseAgeMinutes: z.number().int().safe().nonnegative(),
    policySource: z.literal("OBSERVED_NORMAL_PNPM_POLICY") }).strict().safeParse(input);
  if (!age.success || age.data.candidateVersion !== cert.candidateVersion || age.data.observedAt < age.data.publishedAt)
    return freeze({ status: "PROMOTION_STATUS_UNKNOWN" as const });
  return freeze(age.data.observedAt - age.data.publishedAt < age.data.minimumReleaseAgeMinutes * 60_000
    ? { status: "PROMOTION_WAITING" as const, reason: "WAITING_RELEASE_AGE" as const }
    : { status: "ELIGIBLE_FOR_HUMAN_REVIEW" as const });
}

function contained(base: string, path: string) {
  const rel = relative(realpathSync.native(base), realpathSync.native(path));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) throw new Error("SCRATCH_ESCAPE");
}
function outsideCanonical(path: string) {
  const rel = relative(root, path);
  return isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\");
}
function contentIdentity(directory: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules") continue;
      const path = join(dir, name), stat = lstatSync(path), key = prefix + name;
      if (stat.isSymbolicLink()) throw new Error("LINKED_PACKAGE_CONTENT");
      if (stat.isDirectory()) walk(path, key + "/");
      else if (stat.isFile()) { const bytes = readFileSync(path); hash.update(`${key}\0${bytes.length}\0`).update(bytes); }
      else throw new Error("INVALID_PACKAGE_CONTENT");
    }
  };
  walk(directory);
  return hash.digest("hex");
}

/** Observe the actual npm scratch graph, including transitive dependencies.
 * Lock SRI is package-manager-verified during acquisition; content hash is an
 * independent installed-payload identity for the four adapter packages. Other
 * graph nodes explicitly carry null content identity, plus observed manifest
 * version and registry SRI; absent platform optionals are in the lock digest.
 * The child has no write permission on ANY installed package. */
export function inspectCanaryGraph(scratch: string, resolution: CandidateResolution) {
  const lockBytes = readFileSync(join(scratch, "package-lock.json"));
  const lock = JSON.parse(lockBytes.toString());
  if (lock.lockfileVersion !== 3) throw new Error("UNSUPPORTED_SCRATCH_LOCK");
  const packages: CanaryPackageIdentity[] = [];
  for (const key of Object.keys(lock.packages).sort()) {
    if (key === "") continue;
    if (!/^node_modules\/(?:[A-Za-z0-9@_.-]+\/)*[A-Za-z0-9_.-]+$/.test(key) || key.split("/").some(s => s === "." || s === ".."))
      throw new Error("INVALID_LOCK_PATH");
    const row = lock.packages[key], dir = join(scratch, key);
    if (!existsSync(dir)) { if (row.optional) continue; throw new Error("MISSING_PACKAGE"); }
    contained(scratch, dir);
    if (row.link) throw new Error("LINKED_PACKAGE");
    const local = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    // npm aliases have a different installation path; lock v3 records the
    // published name explicitly (e.g. string-width-cjs -> string-width).
    const name = row.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (local.name !== name || local.version !== row.version) throw new Error("INSTALLED_VERSION_MISMATCH");
    const u = new URL(row.resolved);
    if (u.origin !== registry || u.username || u.password || u.search || u.hash) throw new Error("NON_REGISTRY_PACKAGE");
    packages.push(parseStrict(identitySchema, { path: key, name, version: row.version, integrity: row.integrity,
      resolved: row.resolved, contentSha256: adapterPackages.includes(name) ? contentIdentity(dir) : null }));
  }
  for (const name of adapterPackages) {
    const rows = packages.filter(p => p.name === name);
    // Fail closed on ambiguous module graphs rather than using a different
    // root copy from the one the candidate adapter actually consumes.
    if (rows.length !== 1 || rows[0].path !== `node_modules/${name}`) throw new Error("AMBIGUOUS_ADAPTER_GRAPH");
  }
  const core = packages.find(p => p.name === "@opencode/core")!;
  if (core.version !== resolution.candidateVersion || core.integrity !== resolution.integrity || core.resolved !== resolution.tarball)
    throw new Error("CANDIDATE_IDENTITY_MISMATCH");
  return { packages, lockSha256: sha(lockBytes), graphSha256: sha(canonicalJson(packages)) };
}

function environment(scratch: string): NodeJS.ProcessEnv {
  // No ambient PATH, NODE_OPTIONS, proxy, npm token, provider key or HOME.
  const env: NodeJS.ProcessEnv = { HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
    TMP: scratch, TEMP: scratch, TMPDIR: scratch, XDG_CONFIG_HOME: scratch, XDG_DATA_HOME: scratch,
    XDG_CACHE_HOME: scratch, XDG_STATE_HOME: scratch, NO_COLOR: "1" };
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

/** Explicit opt-in acquisition. Only a strict exact resolution record is accepted.
 * npm is the host Node distribution's fixed CLI (never PATH or candidate data).
 * Its isolated scratch policy deliberately has no pnpm release-age gate. */
export async function certifyCandidate(input: unknown) {
  const resolution = parseStrict(resolutionSchema, input);
  const production = observeCurrentProductionVersion();
  const protectedFiles = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].map(p => [p, sha(readFileSync(join(root, p)))]);
  const parent = realpathSync.native(tmpdir());
  if (!outsideCanonical(parent)) throw new Error("CANARY_MUST_BE_OUTSIDE_CANONICAL");
  const scratch = realpathSync.native(mkdtempSync(join(parent, "rc02-opencode-canary-")));
  if (!outsideCanonical(scratch)) {
    rmSync(scratch, { recursive: true, force: true }); throw new Error("CANARY_MUST_BE_OUTSIDE_CANONICAL");
  }
  let result: "COMPATIBLE" | "INCOMPATIBLE" | "PROBE_FAILED" | "ACQUISITION_FAILED" = "ACQUISITION_FAILED";
  let graph: { packages: CanaryPackageIdentity[]; lockSha256: string | null; graphSha256: string | null } = {
    packages: [], lockSha256: null, graphSha256: null };
  let probeSha256: string | null = null, capabilities: z.infer<typeof capabilitiesSchema> | null = null;
  let networkObservation: z.infer<typeof networkObservationSchema> | null = null;
  let liveProbe: "PLATFORM_UNAVAILABLE" | "NOT_RUN" | "COMPLETED" = "NOT_RUN";
  try {
    const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(npm)) throw new Error("HOST_NPM_UNAVAILABLE");
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
      "@opencode/core": resolution.candidateVersion,
      // Host validation library only; companions/effect come from the candidate.
      zod: JSON.parse(readFileSync(join(root, "node_modules/zod/package.json"), "utf8")).version,
    } }), { flag: "wx" });
    for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(join(scratch, name), "", { flag: "wx" });
    const env = environment(scratch);
    const installed = spawnSync(process.execPath, [npm, "install", "--ignore-scripts", "--no-audit", "--no-fund",
      "--package-lock=true", "--workspaces=false", `--registry=${registry}`, `--userconfig=${join(scratch, "user.npmrc")}`,
      `--globalconfig=${join(scratch, "global.npmrc")}`, `--cache=${join(scratch, "cache")}`, `--prefix=${scratch}`],
    { cwd: scratch, env, shell: false, timeout: 180_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true });
    if (installed.error || installed.status !== 0) throw new Error("ACQUISITION_FAILED");
    graph = inspectCanaryGraph(scratch, resolution);
    result = "PROBE_FAILED";
    const capsule = join(scratch, "probe"); mkdirSync(capsule);
    probeSha256 = buildCompatibilityProbe(root, capsule, resolution.candidateVersion, graph.packages);
    const runtime = join(scratch, "runtime"); mkdirSync(runtime);
    const permissionArgs = ["--permission", `--allow-fs-read=${scratch}`, `--allow-fs-write=${runtime}`,
      `--allow-fs-write=${join(capsule, "result.json")}`];
    // Trusted preflight is a separate process with the SAME executable, grants
    // and environment. Its evidence cannot be supplied/rewritten by candidate
    // code. Acquisition is finished and the installed graph is sealed already.
    const preflight = spawnSync(process.execPath, [...permissionArgs, join(capsule, "preflight.mjs")],
      { cwd: scratch, env: environment(runtime), shell: false, timeout: 15_000,
        maxBuffer: 16384, encoding: "utf8", windowsHide: true });
    liveProbe = "PLATFORM_UNAVAILABLE";
    if (preflight.error || preflight.status !== 0) throw new Error("NETWORK_ISOLATION_UNAVAILABLE");
    const network = parseStrict(z.object({ status: z.enum(["ENFORCED", "PLATFORM_UNAVAILABLE"]),
      observation: networkObservationSchema.nullable() }).strict(), JSON.parse(preflight.stdout));
    if (network.status !== "ENFORCED" || !network.observation) throw new Error("NETWORK_ISOLATION_UNAVAILABLE");
    networkObservation = parseNetworkObservation(network.observation);
    liveProbe = "NOT_RUN";
    const child = spawnSync(process.execPath, [...permissionArgs, join(capsule, "entry.mjs"), resolution.candidateVersion],
    { cwd: scratch, env: environment(runtime), shell: false, timeout: 90_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true });
    if (child.error || child.status !== 0) throw new Error("PROBE_PROCESS_FAILED");
    const observation = parseStrict(z.object({ candidateVersion: exactCandidateVersionSchema,
      result: z.enum(["COMPATIBLE", "INCOMPATIBLE", "PROBE_FAILED"]), capabilities: capabilitiesSchema.nullable(),
      networkObservation: networkObservationSchema.nullable() }).strict(),
    JSON.parse(readFileSync(join(capsule, "result.json"), "utf8")));
    if (observation.candidateVersion !== resolution.candidateVersion) throw new Error("PROBE_VERSION_MISMATCH");
    if (canonicalJson(observation.networkObservation) !== canonicalJson(networkObservation))
      throw new Error("PROBE_NETWORK_OBSERVATION_MISMATCH");
    if (canonicalJson(inspectCanaryGraph(scratch, resolution)) !== canonicalJson(graph)) throw new Error("GRAPH_CHANGED");
    if (observation.result === "COMPATIBLE" && !observation.capabilities) throw new Error("MISSING_CAPABILITIES");
    result = observation.result;
    capabilities = result === "COMPATIBLE" ? observation.capabilities : null;
    liveProbe = "COMPLETED";
  } catch { capabilities = null; } finally { rmSync(scratch, { recursive: true, force: true }); }
  if (protectedFiles.some(([p, hash]) => sha(readFileSync(join(root, p))) !== hash) ||
    production.version !== observeCurrentProductionVersion().version) throw new Error("CANONICAL_CHANGED");
  const certificate = parseCompatibilityCertificate({ domain: "RC02_OPENCODE_COMPATIBILITY_V1",
    candidateVersion: resolution.candidateVersion, result, probeVersion: "DL2-D.1/2", probeSha256, ...graph, capabilities, networkObservation,
    isolation: "SCRATCH_PROCESS_WITH_NETWORK_PREFLIGHT", acquisitionPolicy: "SCRATCH_ONLY_IGNORE_SCRIPTS_RELEASE_AGE_EXEMPT" });
  return freeze({ certificate, liveProbe, productionPromotion: assessProductionPromotion(certificate) });
}
