import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { afterEach, expect, it } from "vitest";
import { NETWORK_PREFLIGHT_SOURCE, parseNetworkObservation }
  from "../src/execution-orchestrator/development/opencode-compatibility-sandbox.js";

const dirs: string[] = [];
function fixture(extra = "") {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "compat-network-"))); dirs.push(dir);
  const runtime = join(dir, "runtime"); mkdirSync(runtime);
  writeFileSync(join(dir, "network.mjs"), NETWORK_PREFLIGHT_SOURCE);
  writeFileSync(join(dir, "entry.mjs"), `import { preflightNetworkIsolation, isNetworkPermissionDenial } from './network.mjs';
    ${extra || "console.log(JSON.stringify(await preflightNetworkIsolation()));"}`);
  return { dir, args: ["--permission", `--allow-fs-read=${dir}`, `--allow-fs-write=${runtime}`, join(dir, "entry.mjs")] };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const eligible = Number(process.versions.node.split(".")[0]) >= 25 && process.allowedNodeEnvironmentFlags.has("--allow-net");
const observation = { backend: "NODE_PERMISSION_DENY", nodeVersion: "25.8.0",
  denied: { fetch: "ERR_ACCESS_DENIED", http: "ERR_ACCESS_DENIED", https: "ERR_ACCESS_DENIED", net: "ERR_ACCESS_DENIED" },
  candidateNetworkAttemptsAllowed: 0 };

it("unavailable runtime never claims enforced network isolation", () => {
  const f = fixture();
  const result = spawnSync(process.execPath, f.args, { cwd: f.dir, env: {}, encoding: "utf8", shell: false, timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  if (!eligible) expect(report).toEqual({ status: "PLATFORM_UNAVAILABLE", observation: null });
  else { expect(report.status).toBe("ENFORCED"); expect(parseNetworkObservation(report.observation).backend).toBe("NODE_PERMISSION_DENY"); }
});

it.each(["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "ERR_TLS_CERT_ALTNAME_INVALID"])(
  "%s is not network-denial evidence (including fetch cause wrapping)", code => {
    const f = fixture(`
      const bad = { code: ${JSON.stringify(code)}, permission: 'Net' };
      if (isNetworkPermissionDenial(bad) || isNetworkPermissionDenial({ cause: bad })) process.exit(3);
      if (isNetworkPermissionDenial({ code: 'ERR_ACCESS_DENIED', permission: 'FileSystemRead' })) process.exit(4);
      if (!isNetworkPermissionDenial({ cause: { code: 'ERR_ACCESS_DENIED', permission: 'Net' } })) process.exit(5);`);
    expect(spawnSync(process.execPath, f.args, { cwd: f.dir, env: {}, shell: false, timeout: 10_000 }).status).toBe(0);
  });

it.each(["fetch", "http", "https", "net"])("rejects tampered %s observation", key => {
  expect(() => parseNetworkObservation({ ...observation, denied: { ...observation.denied, [key]: "ECONNREFUSED" } })).toThrow();
});
it("network evidence is strict, immutable and never application-fake-only", () => {
  expect(Object.isFrozen(parseNetworkObservation(observation).denied)).toBe(true);
  for (const patch of [{ backend: "UNKNOWN" }, { backend: "APPLICATION_FAKE_ONLY" }, { nodeVersion: "24.16.0" },
    { candidateNetworkAttemptsAllowed: 1 }, { allowNet: true }])
    expect(() => parseNetworkObservation({ ...observation, ...patch })).toThrow();
});

// Actual escape attempts only run on a runtime with the deny capability. They
// target an accepting host listener, so a DNS/refused-connection false positive
// cannot pass. Normal tests never require registry/external networking.
it.skipIf(!eligible)("fetch/http/https/net are permission-denied and never reach an accepting host listener", async () => {
  let accepted = 0;
  const server = createServer(socket => { accepted++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(43219, "127.0.0.1", resolve); });
  try {
    const f = fixture();
    const report = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, f.args, { cwd: f.dir, env: {}, shell: false, timeout: 15_000 });
      let stdout = "", stderr = "";
      child.stdout.on("data", x => { stdout += x; }); child.stderr.on("data", x => { stderr += x; });
      child.once("error", reject); child.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    const result = JSON.parse(report);
    expect(result.status).toBe("ENFORCED");
    expect(parseNetworkObservation(result.observation).denied).toEqual(observation.denied);
    expect(accepted).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
