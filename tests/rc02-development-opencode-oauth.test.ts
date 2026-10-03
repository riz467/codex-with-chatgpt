import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireProposalOAuthCredential, assertCurrentOAuthCredential, assertOAuthSecretsAbsent, assertOAuthWireIdentity,
  OAUTH_ENDPOINT, OAUTH_PROPOSAL_MODEL, prepareHostOAuthCredential }
  from "../src/execution-orchestrator/development/opencode-oauth.js";

const input = () => ({ type: "oauth", methodID: "chatgpt-browser", access: "TEST_HOST_ACCESS_TOKEN_ONLY",
  expires: Date.now() + 3600_000, accountID: "test-account", custodyReference: "host-custody-ref" });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("D1 host-owned ChatGPT OAuth seam", () => {
  it.each(["chatgpt-browser", "chatgpt-headless"])("requires validated %s identity and issues only an opaque handle", methodID => {
    const h = prepareHostOAuthCredential({ ...input(), methodID });
    expect(h).toEqual({ kind: "HOST_OAUTH_CREDENTIAL_ONLY" });
    expect(Object.isFrozen(h)).toBe(true);
    expect(() => assertCurrentOAuthCredential(h)).not.toThrow();
    expect(JSON.stringify(h)).not.toContain(input().access);
    for (const fake of [structuredClone(h), JSON.parse(JSON.stringify(h)), { ...h }])
      expect(() => assertCurrentOAuthCredential(fake)).toThrow("PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE");
  });
  it.each(["key", "api-key", undefined])("rejects credential type %s", type => {
    expect(() => prepareHostOAuthCredential({ ...input(), type })).toThrow("PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE");
  });
  it.each(["oauth", "openai", "api-key", "browser", undefined])("rejects method %s", methodID => {
    expect(() => prepareHostOAuthCredential({ ...input(), methodID })).toThrow("PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE");
  });
  it("rejects unknown fields, refresh tokens, getters, missing account and unknown/expired currentness", () => {
    for (const bad of [{ ...input(), refresh: "DO_NOT_ACCEPT_REFRESH" }, { ...input(), accountID: "" },
      { ...input(), expires: 0 }, { ...input(), expires: undefined }, { ...input(), expires: Date.now() + 10_000 },
      { ...input(), model: "gpt-4.1" }, Object.create(input())])
      expect(() => prepareHostOAuthCredential(bad)).toThrow("PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE");
    let reads = 0;
    expect(() => prepareHostOAuthCredential({ ...input(), get access() { reads++; return input().access; } })).toThrow();
    expect(reads).toBe(0);
    const now = Date.now(), h = prepareHostOAuthCredential(input());
    vi.spyOn(Date, "now").mockReturnValue(now + 3600_000);
    expect(() => assertCurrentOAuthCredential(h)).toThrow("PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE");
  });
  it("does not acquire from environment, HOME or global OpenCode credentials and never refreshes", () => {
    for (const key of ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "CHATGPT_ACCESS_TOKEN", "OPENAI_REFRESH_TOKEN",
      "HOME", "USERPROFILE", "OPENCODE_CONFIG_CONTENT"])
      vi.stubEnv(key, "UNTRUSTED_EXTERNAL_CREDENTIAL_SOURCE");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => acquireProposalOAuthCredential()).toThrow("PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("compares exact OAuth bearer/account headers and rejects API-key routes or wrong models", () => {
    const value = input(), h = prepareHostOAuthCredential(value);
    const wire = { url: OAUTH_ENDPOINT, method: "POST", model: OAUTH_PROPOSAL_MODEL, headers: new Headers({
      authorization: `Bearer ${value.access}`, "chatgpt-account-id": value.accountID,
      originator: "opencode", "x-codex-beta-features": "remote_compaction_v2",
    }) };
    expect(() => assertOAuthWireIdentity(h, wire)).not.toThrow();
    for (const bad of [{ ...wire, url: "https://api.openai.com/v1/chat/completions" },
      { ...wire, url: "https://api.openai.com/v1/responses" }, { ...wire, model: "gpt-4.1" },
      { ...wire, model: "gpt-5.6" }, { ...wire, method: "GET" }])
      expect(() => assertOAuthWireIdentity(h, bad)).toThrow("PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE");
    for (const key of ["authorization", "chatgpt-account-id", "originator", "x-codex-beta-features"]) {
      const headers = new Headers(wire.headers); headers.set(key, "wrong");
      expect(() => assertOAuthWireIdentity(h, { ...wire, headers })).toThrow();
      headers.delete(key);
      expect(() => assertOAuthWireIdentity(h, { ...wire, headers })).toThrow();
    }
  });
  it("rejects credential echoes without putting secrets in error output", () => {
    const value = input(), h = prepareHostOAuthCredential(value);
    for (const secret of [value.access, value.custodyReference, value.accountID]) {
      try { assertOAuthSecretsAbsent(h, `response ${secret}`); throw new Error("unexpected pass"); }
      catch (error) { expect(String(error)).toBe("Error: PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE"); }
    }
  });
});
