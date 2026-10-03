import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Promotion requires a reviewed exact pin AND an installed-content digest AND
// the capability checks in the adapter. A version string alone never suffices.
// SRI identifies the published tarball (pnpm lock); contentSha256 independently
// identifies installed files: sorted path + NUL + byte length + NUL + bytes.
export const EXPECTED_PACKAGES = Object.freeze([
  { name: "@opencode/core", version: "2.0.22", entry: "@opencode/core/config",
    integrity: "sha512-C9iv0UOYB/iPzNwxDZIxYokSGfIVVwagwVuOTJDXMN2NMspkd+fAXwBLJHaQQYQuDGzFO2Q9BmKhTIqGWftABw==",
    contentSha256: "af992a3c3e79ede672fd123cd766bdf5bf3caed3014506228d44041a54ad0495" },
  { name: "@opencode/ai", version: "2.0.22", entry: "@opencode/ai",
    integrity: "sha512-wdD2ut4G/areDkA9bYizYiho6C1sRQ6mPqMSji93XzadavbkIcbhU/VyodOmExtZtOg2IjheJCUVCpDXQ8n8FA==",
    contentSha256: "51ccdd3f4abf4791828e3e2740d7149389f31b98c4415e6d403b8cf0b5101ee2" },
  { name: "@opencode/util", version: "2.0.22", entry: "@opencode/util/global",
    integrity: "sha512-nipMu7ZAM9gCOKwH06eqAUVgATR+5XbqXEKSN+ECYLgm9PStsmxraxDN93gJLV3bYzpR+9Ow0Be/s0ZYKUxPKg==",
    contentSha256: "e730c24a4dfa9dfec9e0ca240568d9a4630968b1f0dcbf20af8c7d2186d4fb01" },
  { name: "effect", version: "4.0.0-rc.112", entry: "effect",
    integrity: "sha512-wXxwuh1Ywnv4cPRM3Wfa0vDwuOHnZ1TsTgHJkG9XgzND6inhBH9n1vBxhg3iIXOia/OrpmvVmd3lrD4vq6bF3A==",
    contentSha256: "e5112bac6ad91f25cc3eb577c95344496d39f80e883f537d438f0dc025f63e1b" },
].map(row => Object.freeze(row)));
const packageSchema = z.object({ name: z.string(), version: z.string(), integrity: z.string(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type PackageIdentity = z.infer<typeof packageSchema>;

/** Checks data, does not certify a runtime or authorize dispatch. */
export function assertPackageIdentities(input: unknown): PackageIdentity[] {
  const rows = z.array(packageSchema).length(EXPECTED_PACKAGES.length).parse(input);
  for (const [i, row] of rows.entries()) {
    const { entry: _entry, ...expected } = EXPECTED_PACKAGES[i];
    if (Object.keys(expected).some(key => row[key as keyof PackageIdentity] !== expected[key as keyof PackageIdentity]))
      throw new Error("Pinned package identity mismatch");
  }
  return rows;
}

export function inspectInstalledPackages(): PackageIdentity[] {
  // Both source and compiled adapters live three levels below this repo root.
  const root = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8").replaceAll("\r\n", "\n");
  const packages = EXPECTED_PACKAGES.map(expected => {
    if (manifest.dependencies?.[expected.name] !== expected.version) throw new Error("Non-exact dependency pin");
    const search = createRequire(import.meta.url).resolve.paths(expected.name) ?? [];
    const directory = search.map(base => join(base, expected.name)).find(base => existsSync(join(base, "package.json")));
    if (!directory) throw new Error("Missing repository dependency");
    const packageRoot = realpathSync(directory);
    const local = relative(realpathSync(join(root, "node_modules")), packageRoot);
    if (isAbsolute(local) || local === ".." || local.startsWith("..\\") || local.startsWith("../"))
      throw new Error("Non-repository dependency");
    const installed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const key = expected.name.startsWith("@") ? `'${expected.name}@${expected.version}'` : `${expected.name}@${expected.version}`;
    const prefix = `  ${key}:\n    resolution: {integrity: `;
    const matching = lock.split(prefix);
    if (matching.length !== 2) throw new Error("Missing/ambiguous package integrity");
    const integrity = matching[1].split("}", 1)[0];
    const hash = createHash("sha256");
    const walk = (directory: string, prefix = "") => {
      for (const name of readdirSync(directory).sort()) {
        // pnpm's dependency links are outside the published package payload.
        if (name === "node_modules") continue;
        const path = join(directory, name), stat = lstatSync(path), key = prefix + name;
        if (stat.isSymbolicLink()) throw new Error("Linked package payload");
        if (stat.isDirectory()) walk(path, key + "/");
        else if (stat.isFile()) {
          const bytes = readFileSync(path);
          hash.update(`${key}\0${bytes.length}\0`).update(bytes);
        } else throw new Error("Unsupported package entry");
      }
    };
    walk(packageRoot);
    return { name: installed.name, version: installed.version, integrity, contentSha256: hash.digest("hex") };
  });
  return assertPackageIdentities(packages);
}

function immutable<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** No caller-controlled profile, credentials, path, session, or prompt.
 * D0 has no send API. This observation certificate is neither authority nor an
 * execution/dispatch permit, and never reads or advances a Development store.
 * D1 must separately implement bounded transport and recheck its live boundary.
 */
export async function certifyOpenCodeCore(input: unknown = {}) {
  try {
    z.object({}).strict().parse(input);
    const packages = inspectInstalledPackages();
    const adapter = await import("./opencode-core-adapter.js");
    const observation = adapter.assertCoreInspection(await adapter.inspectPinnedCore());
    // Catch ordinary replacement/tampering during the scoped inspection as well.
    assertPackageIdentities(inspectInstalledPackages());
    return immutable({
      kind: "OPENCODE_CORE_CERTIFICATION_ONLY" as const, result: "COMPATIBLE" as const, compatible: true as const,
      observedVersion: packages[0].version, packages,
      configSources: observation.configEntries, configDiscovery: observation.configOptions,
      wellKnown: observation.wellKnown, externalPluginOperations: observation.externalOperations,
      internalPlugins: observation.plugins, instructionDiscovery: observation.discovery,
      instructionBuiltIns: observation.builtIns, skills: observation.skills, references: observation.references,
      mcpServers: observation.mcpServers, mcpTools: observation.mcpTools, mcpInstructions: observation.mcpInstructions,
      instructionEntries: observation.instructionEntries, effectivePermission: "DENY_ALL" as const,
      effectiveRules: observation.agent.permissions, agent: observation.agent.id,
      directTools: 0, codeModeTools: 0, preparedTools: 0,
      contextProvenance: {
        system: "HOST_FIXED" as const, user: "HOST_SYNTHETIC_FIXTURE" as const,
        metadata: { source: "opencode.prompt.identity" as const, text: adapter.MODEL_IDENTITY },
        absentSources: observation.sessionInstructions, renderedInstructions: observation.renderedSessionInstructions,
      },
      nativeSessionId: observation.nativeSessionId, preparedRequest: observation.prepared,
      preparedHttpRequest: observation.wire, activity: observation.activity,
      networkEnforcement: "APPLICATION_NO_NETWORK_DRY_PROFILE_ONLY" as const,
      osProviderOnlyEgress: "NOT_ESTABLISHED" as const,
    });
  } catch {
    // Never return upstream exception messages: they can contain paths or secrets.
    return immutable({ kind: "OPENCODE_CORE_CERTIFICATION_ONLY" as const, result: "FAIL_CLOSED" as const,
      compatible: false as const, code: "PROPOSAL_CORE_PROFILE_UNSAFE" as const });
  }
}
