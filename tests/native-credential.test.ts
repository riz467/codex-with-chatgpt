import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { Credential } from "@opencode/core/credential";
import { Integration } from "@opencode/core/integration";
import { acquireNativeHostOAuthCredential, assertNativeCredentialCustody, assertNativeHostTurnCapability, nativeCredentialLayout,
  nativeCredentialGlobals, readActiveNativeOAuthCredential, type NativeHostTurnCapability } from "../src/linux-development/native-credential.js";
import { acquireProposalOAuthCredential, assertCurrentOAuthCredential, assertOAuthSecretsAbsent,
  assertOAuthWireIdentity, OAUTH_ENDPOINT, type HostOAuthHandle } from "../src/execution-orchestrator/development/opencode-oauth.js";
import { runNativeHostTurn } from "../src/execution-orchestrator/development/opencode-transport.js";
vi.mock("node:url", async importOriginal => {
  const actual = await importOriginal<typeof import("node:url")>();
  return { ...actual, fileURLToPath: vi.fn(actual.fileURLToPath) };
});

// Offline supported service-instance mocks only. These tests make no claim of
// enrollment, authentication, native E2E, Linux custody or OS containment.
const access = "offline_mock_access_1234567890", accountID = "offline_mock_account", refresh = "offline_mock_refresh";
function fixture() {
  const id = Credential.ID.make("cred_offline_test");
  const connection = { type: "credential" as const, id, method: "oauth" as const, label: "not public" };
  const record = new Credential.Info({ id, integrationID: Integration.ID.make("openai"), label: "not public",
    value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"),
      access, refresh, expires: Date.now() + 600_000, metadata: { accountID } }) });
  const deny = vi.fn(() => { throw new Error("Unexpected credential side effect"); });
  const integration: Pick<Integration.Interface, "connection"> = { connection: {
    active: vi.fn(() => Effect.succeed(connection)), resolve: deny, key: deny, activate: deny, update: deny, remove: deny, status: deny,
  } };
  const credentials: Pick<Credential.Interface, "get"> = { get: vi.fn(() => Effect.succeed(record)) };
  return { integration, credentials, connection, record, deny };
}
describe("offline pinned native credential service adapter", () => {
  it("reads active + get, strips public identity, and never resolves/refreshes", async () => {
    const f = fixture();
    const handle = await Effect.runPromise(readActiveNativeOAuthCredential(f.integration, f.credentials));
    assertCurrentOAuthCredential(handle);
    expect(JSON.stringify(handle)).toBe('{"kind":"HOST_OAUTH_CREDENTIAL_ONLY"}');
    expect(f.integration.connection.active).toHaveBeenCalledTimes(2);
    expect(f.credentials.get).toHaveBeenCalledWith(f.connection.id);
    expect(f.deny).not.toHaveBeenCalled();
    const headers = new Headers({ authorization: `Bearer ${access}`, "chatgpt-account-id": accountID,
      originator: "opencode", "x-codex-beta-features": "remote_compaction_v2" });
    expect(() => assertOAuthWireIdentity(handle, { url: OAUTH_ENDPOINT, method: "POST", model: "gpt-5.5", headers })).not.toThrow();
    for (const secret of [access, accountID]) expect(() => assertOAuthSecretsAbsent(handle, secret)).toThrow();
    expect(() => assertCurrentOAuthCredential(JSON.parse(JSON.stringify(handle)) as HostOAuthHandle)).toThrow();
  });
  it.each(["chatgpt-browser", "chatgpt-headless"])("supports pinned OAuth method %s", async methodID => {
    const f = fixture();
    vi.mocked(f.credentials.get).mockReturnValue(Effect.succeed(new Credential.Info({ ...f.record,
      value: { ...f.record.value as Credential.OAuth, methodID: Integration.MethodID.make(methodID) } })));
    expect(await Effect.runPromise(readActiveNativeOAuthCredential(f.integration, f.credentials))).toHaveProperty("kind", "HOST_OAUTH_CREDENTIAL_ONLY");
  });
  it.each(["missing", "env", "key", "needs_auth"])("rejects active %s without fallback", async variant => {
    const f = fixture();
    const active = variant === "missing" ? undefined : variant === "env" ? { type: "env" as const, name: "OPENAI_API_KEY" }
      : { ...f.connection, ...(variant === "key" ? { method: "key" as const } : { status: { status: "needs_auth" as const, message: access } }) };
    vi.mocked(f.integration.connection.active).mockReturnValue(Effect.succeed(active));
    await expect(Effect.runPromise(readActiveNativeOAuthCredential(f.integration, f.credentials))).rejects.toThrow("NATIVE_CREDENTIAL_UNAVAILABLE");
    expect(f.credentials.get).not.toHaveBeenCalled(); expect(f.deny).not.toHaveBeenCalled();
  });
  it.each(["missing", "wrong_integration", "wrong_id", "key", "unknown_method", "expired", "near_expiry", "missing_account"])("rejects record %s", async variant => {
    const f = fixture();
    const value = f.record.value as Credential.OAuth;
    const row = variant === "missing" ? undefined : new Credential.Info({ ...f.record,
      integrationID: Integration.ID.make(variant === "wrong_integration" ? "other" : "openai"),
      id: variant === "wrong_id" ? Credential.ID.make("cred_other") : f.record.id,
      value: variant === "key" ? Credential.Key.make({ type: "key", key: access }) : { ...value,
        methodID: Integration.MethodID.make(variant === "unknown_method" ? "unknown" : value.methodID),
        expires: variant === "expired" ? 1 : variant === "near_expiry" ? Date.now() + 40_000 : value.expires,
        metadata: variant === "missing_account" ? undefined : value.metadata } });
    vi.mocked(f.credentials.get).mockReturnValue(Effect.succeed(row));
    await expect(Effect.runPromise(readActiveNativeOAuthCredential(f.integration, f.credentials))).rejects.toThrow("NATIVE_CREDENTIAL_UNAVAILABLE");
    expect(f.deny).not.toHaveBeenCalled();
  });
  it("rejects a changed active selection and sanitizes upstream errors", async () => {
    const f = fixture();
    vi.mocked(f.integration.connection.active).mockReturnValueOnce(Effect.succeed(f.connection))
      .mockReturnValueOnce(Effect.succeed({ ...f.connection, id: Credential.ID.make("cred_other") }));
    await expect(Effect.runPromise(readActiveNativeOAuthCredential(f.integration, f.credentials))).rejects.toThrow("NATIVE_CREDENTIAL_UNAVAILABLE");
    vi.mocked(f.credentials.get).mockReturnValue(Effect.die(new Error(`${access} ${refresh} ${accountID}`)));
    vi.mocked(f.integration.connection.active).mockReturnValue(Effect.succeed(f.connection));
    try { await Effect.runPromise(readActiveNativeOAuthCredential(f.integration, f.credentials)); throw new Error("expected failure"); }
    catch (error) {
      expect(String(error)).toContain("NATIVE_CREDENTIAL_UNAVAILABLE");
      for (const secret of [access, refresh, accountID]) expect(String(error)).not.toContain(secret);
    }
  });
  it("fails closed when the pinned supported service method is missing", async () => {
    const f = fixture();
    for (const integration of [{}, { connection: {} }])
      await expect(Effect.runPromise(readActiveNativeOAuthCredential(integration as typeof f.integration, f.credentials)))
        .rejects.toThrow("NATIVE_CREDENTIAL_UNAVAILABLE");
    expect(f.credentials.get).not.toHaveBeenCalled();
  });
  it("keeps production closed and rejects serialized admission without HTTP", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not call"));
    try {
      expect(acquireProposalOAuthCredential).toThrow("PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE");
      const forged = { kind: "NATIVE_HOST_TURN_ONLY" } as NativeHostTurnCapability;
      expect(() => assertNativeHostTurnCapability(forged, "proposer")).toThrow();
      expect(await runNativeHostTurn("proposer", {}, {} as HostOAuthHandle, forged)).toEqual({
        result: "FAILED_BEFORE_DISPATCH", code: "NATIVE_HOST_TURN_BLOCKED" });
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it("pins private UID/home/SQLite independently of ambient HOME", async () => {
    expect(nativeCredentialLayout.uid).toBe(993); expect(nativeCredentialLayout.developerUid).toBe(994);
    expect(nativeCredentialGlobals.home).toBe("/var/lib/ai-linux-provider/home");
    expect(nativeCredentialLayout.database).toBe("/var/lib/ai-linux-provider/data/opencode.db");
    if (process.platform !== "linux") await expect(acquireNativeHostOAuthCredential()).rejects.toThrow("NATIVE_CREDENTIAL_UNAVAILABLE");
    const source = fs.readFileSync(new URL("../src/linux-development/native-credential.ts", import.meta.url), "utf8");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("connection.resolve(");
    expect(source).toContain("LayerNode.group([Integration.node, Credential.node])");
    expect(source).not.toContain("buildLocationServiceMap");
  });
});

describe("offline actual-layout observation mocks (not Linux certification)", () => {
  it.each(["safe_observation", "developer_uid", "home_mode", "database_mode", "database_link", "wal_mode",
    "runtime_writable", "dependency_writable", "ancestor_writable", "missing_worker"])("checks %s", async variant => {
    const actualUrl = await vi.importActual<typeof import("node:url")>("node:url");
    const realProcess = globalThis.process;
    const runtime = nativeCredentialLayout.runtime;
    const module = `${runtime}/dist/linux-development/native-credential.js`;
    vi.mocked(fileURLToPath).mockReturnValue(module);
    vi.stubGlobal("process", Object.create(realProcess, { platform: { value: "linux" },
      getuid: { value: () => variant === "developer_uid" ? 994 : 993 }, geteuid: { value: () => 993 } }));
    const directory = new Set(["/", "/var", "/var/lib", "/opt", "/opt/ai-linux-provider", runtime,
      nativeCredentialLayout.root, ...Object.values(nativeCredentialGlobals)]);
    const stat = vi.spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike) => {
      const p = String(name), privatePath = p === nativeCredentialLayout.root || p.startsWith(`${nativeCredentialLayout.root}/`);
      if (variant === "missing_worker" && p.endsWith("native-worker.js")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      let mode = privatePath ? directory.has(p) ? 0o700 : 0o600 : directory.has(p) ? 0o755 : 0o644;
      if ((variant === "home_mode" && p === nativeCredentialLayout.home) ||
        (variant === "database_mode" && p === nativeCredentialLayout.database) ||
        (variant === "wal_mode" && p.endsWith("-wal"))) mode = 0o644;
      if ((variant === "runtime_writable" && p === runtime) ||
        (variant === "dependency_writable" && p.endsWith("dependency.js")) ||
        (variant === "ancestor_writable" && p === "/opt")) mode = 0o777;
      return { uid: privatePath ? 993 : 0, mode, nlink: variant === "database_link" && p === nativeCredentialLayout.database ? 2 : 1,
        isSymbolicLink: () => false, isDirectory: () => directory.has(p), isFile: () => !directory.has(p) } as fs.Stats;
    }) as typeof fs.lstatSync);
    const readdir = vi.spyOn(fs, "readdirSync").mockReturnValue([
      { name: "dependency.js", isDirectory: () => false },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    try {
      if (variant === "safe_observation") expect(assertNativeCredentialCustody).not.toThrow();
      else expect(assertNativeCredentialCustody).toThrow("NATIVE_CREDENTIAL_UNAVAILABLE");
    } finally {
      stat.mockRestore(); readdir.mockRestore(); vi.unstubAllGlobals();
      vi.mocked(fileURLToPath).mockImplementation(actualUrl.fileURLToPath);
    }
  });
});
