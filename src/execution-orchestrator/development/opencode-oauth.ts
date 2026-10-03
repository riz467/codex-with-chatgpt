import { z } from "zod";
import { Effect, Layer } from "effect";
import { Credential } from "@opencode/core/credential";
import { Integration } from "@opencode/core/integration";
import { freeze, parseStrict } from "../../task-contract/contract.js";

// Host policy for the pinned 2.0.22 OAuth profile. Changes require compatibility
// re-certification; never accept provider/model/endpoint selection in a request.
export const OAUTH_PROPOSAL_MODEL = "gpt-5.5";
export const OAUTH_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OAUTH_ENDPOINT = `${OAUTH_BASE_URL}/responses`;
export const OAUTH_MODEL_IDENTITY = "# Your Model\n- Name: GPT-5.5\n- Provider ID: openai\n- Model ID: gpt-5.5";
const schema = z.object({ type: z.literal("oauth"), methodID: z.enum(["chatgpt-browser", "chatgpt-headless"]),
  access: z.string().min(16).max(16384).regex(/^[A-Za-z0-9._~+-]+$/),
  expires: z.number().int().safe().positive(), accountID: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  custodyReference: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/),
}).strict();
declare const brand: unique symbol;
export interface HostOAuthHandle { readonly kind: "HOST_OAUTH_CREDENTIAL_ONLY"; readonly [brand]: true }
const credentials = new WeakMap<HostOAuthHandle, Readonly<z.infer<typeof schema>>>();
const unsafe = () => new Error("PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE");

/** Trusted-host enrollment adapter ONLY, not a proposal caller API. Authenticity
 * and custody of these values are the independent host's responsibility. This
 * constructor checks structure/currentness, not authentication or authority.
 * No refresh token enters D1: custodyReference remains with this private record.
 */
export function prepareHostOAuthCredential(input: unknown): HostOAuthHandle {
  try {
    const value = freeze(parseStrict(schema, input));
    if (value.expires <= Date.now() + 60_000) throw unsafe();
    const handle = Object.freeze({ kind: "HOST_OAUTH_CREDENTIAL_ONLY" as const }) as HostOAuthHandle;
    credentials.set(handle, value);
    return handle;
  } catch { throw unsafe(); }
}
function inspect(handle: HostOAuthHandle) {
  const value = credentials.get(handle);
  // A full bounded turn must fit before expiry. No refresh network is allowed.
  if (!value || value.expires <= Date.now() + 60_000) throw unsafe();
  return value;
}
export function assertCurrentOAuthCredential(handle: HostOAuthHandle): void { inspect(handle); }

/** Closed production seam. Only a future fixed, trusted host custody adapter may
 * issue this handle; never read env, HOME, or OpenCode global auth here.
 */
export function acquireProposalOAuthCredential(): HostOAuthHandle { throw unsafe(); }

export function assertOAuthSecretsAbsent(handle: HostOAuthHandle, text: string): void {
  const value = inspect(handle);
  if ([value.access, value.custodyReference, value.accountID].some(secret => text.includes(secret))) throw unsafe();
}

/** Public Effect service composition, not private patching. The actual pinned
 * OpenAI plugin consumes this connection and performs OAuth routing/filtering.
 * Base credential storage is replaced entirely; enrollment/refresh/mutations
 * are inaccessible. No synthetic refresh token can be used by the core.
 */
export function oauthCredentialComposition(handle: HostOAuthHandle) {
  inspect(handle);
  const die = () => Effect.die(unsafe());
  const connection = { type: "credential" as const, id: Credential.ID.make("cred_d1_host_oauth"),
    label: "D1 host OAuth", method: "oauth" as const };
  return [
    Credential.node.replace(Layer.succeed(Credential.Service, {
      all: () => Effect.succeed([]), list: () => Effect.succeed([]), get: () => Effect.succeed(undefined),
      create: die, activate: die, update: die, remove: die,
    })),
    Integration.node.replace(Integration.node.mapLayer(layer => Layer.effect(Integration.Service,
      Effect.map(Integration.Service, service => ({ ...service,
        get: id => service.get(id).pipe(Effect.map(info => info && ({ ...info,
          connections: id === "openai" ? [connection] : [] }))),
        list: () => service.list().pipe(Effect.map(rows => rows.map(info => ({ ...info,
          connections: info.id === "openai" ? [connection] : [] })))),
        connection: {
          active: id => Effect.sync(() => { inspect(handle); return id === "openai" ? connection : undefined; }),
          resolve: input => Effect.sync(() => {
            const value = inspect(handle);
            if (input.type !== "credential" || input.id !== connection.id || input.method !== "oauth") throw unsafe();
            return Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make(value.methodID),
              access: value.access, expires: value.expires, refresh: "", metadata: { accountID: value.accountID } });
          }),
          key: die, activate: die, update: die, remove: die, status: die,
        },
        oauth: { connect: die, status: die, complete: die, cancel: die },
        command: { connect: die, status: die, cancel: die },
      }))).pipe(Layer.provide(layer)))),
  ];
}

/** Final lowered request assertion. Header values are compared privately and
 * never returned as evidence. No API-key fallback or redirects exist.
 */
export function assertOAuthWireIdentity(handle: HostOAuthHandle, input: {
  url: string; method: string; model: string; headers: Headers;
}) {
  const value = inspect(handle);
  if (input.url !== OAUTH_ENDPOINT || input.method !== "POST" || input.model !== OAUTH_PROPOSAL_MODEL ||
    input.headers.get("authorization") !== `Bearer ${value.access}` ||
    input.headers.get("chatgpt-account-id") !== value.accountID || input.headers.get("originator") !== "opencode" ||
    input.headers.get("x-codex-beta-features") !== "remote_compaction_v2") throw unsafe();
}
