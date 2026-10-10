import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Logger, Stream } from "effect";
import { Credential } from "@opencode/core/credential";
import { Integration } from "@opencode/core/integration";
import { Database } from "@opencode/core/database/database";
import { Global } from "@opencode/util/global";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { AppProcess } from "@opencode/util/process";
import { prepareHostOAuthCredential, type HostOAuthHandle } from "../execution-orchestrator/development/opencode-oauth.js";
import { admitFixedNative, nativeHash } from "./native-admission.js";
import { assertAuthenticatedNativeWorkerTurn } from "./native-receipt.js";

/** Host-only interface. Enrollment is a later human operation through supported
 * OpenCode APIs in this exact private store. No autoOAuth, SQL, auth.json, HOME,
 * environment key, refresh, or provider call is used by this module. */
export const nativeCredentialLayout = Object.freeze({
  uid: 993, developerUid: 994,
  root: "/var/lib/ai-linux-provider",
  home: "/var/lib/ai-linux-provider/home",
  database: "/var/lib/ai-linux-provider/data/opencode.db",
  runtime: "/opt/ai-linux-provider/runtime",
});
const root = nativeCredentialLayout.root;
export const nativeCredentialGlobals: Global.Interface = Object.freeze({
  home: nativeCredentialLayout.home, data: `${root}/data`, cache: `${root}/cache`,
  config: `${root}/config`, state: `${root}/state`, tmp: `${root}/tmp`,
  bin: `${root}/bin`, log: `${root}/log`, repos: `${root}/repos`,
});
const unsafe = () => new Error("NATIVE_CREDENTIAL_UNAVAILABLE");
declare const admissionBrand: unique symbol;
export interface NativeHostTurnCapability { readonly kind: "NATIVE_HOST_TURN_ONLY"; readonly [admissionBrand]: true }
const admissions = new WeakMap<NativeHostTurnCapability, { role: "proposer" | "reviewer"; identity: string; used: boolean }>();

/** In-process host seam. Reads the actual fixed root authorization/manifest;
 * never accepts an authorization string/object or a metadata report. Launcher
 * still owns durable no-replay admission and kernel containment. */
export function acquireNativeHostTurnCapability(role: "proposer" | "reviewer"): NativeHostTurnCapability {
  try {
    if (role !== "proposer" && role !== "reviewer") throw unsafe();
    assertNativeCredentialCustody();
    assertAuthenticatedNativeWorkerTurn(role);
    const identity = nativeHash(JSON.stringify(admitFixedNative()));
    const handle = Object.freeze({ kind: "NATIVE_HOST_TURN_ONLY" as const }) as NativeHostTurnCapability;
    admissions.set(handle, { role, identity, used: false });
    return handle;
  } catch { throw unsafe(); }
}
export function assertNativeHostTurnCapability(handle: NativeHostTurnCapability, role: "proposer" | "reviewer", consume = false): void {
  try {
    const entry = admissions.get(handle);
    if (!entry || entry.role !== role || (consume && entry.used)) throw unsafe();
    assertNativeCredentialCustody();
    assertAuthenticatedNativeWorkerTurn(role);
    if (nativeHash(JSON.stringify(admitFixedNative())) !== entry.identity) throw unsafe();
    if (consume) entry.used = true;
  } catch { throw unsafe(); }
}

/** Supported-service adapter, exposed for offline service-instance tests and
 * trusted in-process composition ONLY. A credential is not an admission permit.
 * Do not expose this adapter through RPC or accept caller-provided services.
 * active() in pinned 2.0.22 reads the stored selection; resolve() may refresh and
 * is deliberately never called. No list fallback if active is absent/invalid. */
export function readActiveNativeOAuthCredential(
  integration: Pick<Integration.Interface, "connection">,
  credentials: Pick<Credential.Interface, "get">,
): Effect.Effect<HostOAuthHandle> {
  return Effect.gen(function* () {
    if (typeof integration?.connection?.active !== "function" || typeof credentials?.get !== "function")
      return yield* Effect.die(unsafe());
    const active = yield* integration.connection.active(Integration.ID.make("openai"));
    if (!active || active.type !== "credential" || active.method !== "oauth" || active.status)
      return yield* Effect.die(unsafe());
    const record = yield* credentials.get(active.id);
    if (!record || record.id !== active.id || record.integrationID !== "openai" || record.value.type !== "oauth")
      return yield* Effect.die(unsafe());
    const value = record.value;
    // Copy only access/account/currentness into the opaque host record. Refresh
    // and labels never enter the transport. Unknown methods fail closed.
    const handle = prepareHostOAuthCredential({ type: "oauth", methodID: value.methodID,
      access: value.access, expires: value.expires, accountID: value.metadata?.accountID,
      custodyReference: "native-private-supported-store" });
    const current = yield* integration.connection.active(Integration.ID.make("openai"));
    if (!current || current.type !== "credential" || current.id !== active.id || current.method !== "oauth" || current.status)
      return yield* Effect.die(unsafe());
    return handle;
  }).pipe(Effect.catchCause(() => Effect.die(unsafe())));
}

/** Actual fixed filesystem observations, NOT admission authority. These checks
 * do not certify ACLs, capabilities, mount immutability, ptrace or race freedom;
 * the launcher must independently enforce those and durable attempt admission.
 * No metadata diagnostic/risk-acceptance document is accepted as a permit. */
export function assertNativeCredentialCustody(): void {
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 993 || process.geteuid?.() !== 993) throw unsafe();
    const check = (name: string, owner: number, mode?: number, directory = false) => {
      const s = fs.lstatSync(name);
      if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) ||
        (!directory && s.nlink !== 1) || s.uid !== owner ||
        (mode === undefined ? (s.mode & 0o7022) !== 0 : (s.mode & 0o7777) !== mode)) throw unsafe();
    };
    const ancestors = (name: string, privateTree: boolean) => {
      for (let p = path.posix.dirname(name); ; p = path.posix.dirname(p)) {
        const privatePath = privateTree && (p === root || p.startsWith(`${root}/`));
        check(p, privatePath ? 993 : 0, privatePath ? 0o700 : undefined, true);
        if (p === "/") break;
      }
    };
    for (const dir of [root, ...Object.values(nativeCredentialGlobals)]) {
      check(dir, 993, 0o700, true); ancestors(dir, true);
    }
    check(nativeCredentialLayout.database, 993, 0o600); ancestors(nativeCredentialLayout.database, true);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const name = nativeCredentialLayout.database + suffix;
      try { check(name, 993, 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const module = fileURLToPath(import.meta.url);
    if (!module.startsWith(`${nativeCredentialLayout.runtime}/`)) throw unsafe();
    ancestors(nativeCredentialLayout.runtime, false);
    // Complete deployed dependency/role code inventory, not just this entrypoint.
    // The deployment must be a root-controlled non-symlink runtime tree.
    const visit = (dir: string) => {
      check(dir, 0, undefined, true);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) visit(name); else check(name, 0);
      }
    };
    visit(nativeCredentialLayout.runtime);
    for (const role of ["native-credential", "native-launcher", "native-worker", "native-admission", "native-receipt", "native-cli"])
      check(`${nativeCredentialLayout.runtime}/dist/linux-development/${role}.js`, 0);
  } catch { throw unsafe(); }
}

/** Fixed trusted-host acquisition. No knobs and no ambient credential fallback.
 * Compiles ONLY Credential/Integration and their storage/bus dependencies. It
 * never acquires Config, Plugin, Location discovery or an OAuth implementation.
 * The empty Integration state has no env methods or refresh implementations.
 * Handles cannot survive serialization or process boundaries; acquire inside
 * the admitted private worker, never in a developer process then send over IPC. */
export async function acquireNativeHostOAuthCredential(): Promise<HostOAuthHandle> {
  try {
    assertNativeCredentialCustody();
    const deny = () => Effect.die(unsafe());
    const layer = LayerNode.compile(LayerNode.group([Integration.node, Credential.node]), { replacements: [
      Global.node.replace(Global.layerWith(nativeCredentialGlobals)),
      Database.node.replace(Database.configured({ path: nativeCredentialLayout.database })),
      Credential.node.replace(Credential.node.mapLayer(base => Layer.effect(Credential.Service,
        Effect.map(Credential.Service, service => ({ ...service, create: deny, activate: deny, update: deny, remove: deny }))
      ).pipe(Layer.provide(base)))),
      AppProcess.node.replace(Layer.succeed(AppProcess.Service, { spawn: deny, exitCode: deny,
        streamString: () => Stream.die(unsafe()), streamLines: () => Stream.die(unsafe()), lines: deny, string: deny,
        run: deny, runStream: () => Stream.die(unsafe()) })),
    ] });
    const handle = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      return yield* readActiveNativeOAuthCredential(yield* Integration.Service, yield* Credential.Service);
    }).pipe(Effect.provide(layer), Effect.provide(Logger.layer([])))));
    assertNativeCredentialCustody();
    return handle;
  } catch { throw unsafe(); }
}
