import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DateTime, Effect, Layer, Logger, Scope } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { AbsolutePath } from "@opencode/core/schema";
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform";
import { Global } from "@opencode/util/global";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { Config } from "@opencode/core/config";
import { ConfigPluginSource } from "@opencode/core/config/plugin/source";
import { WellKnown } from "@opencode/core/wellknown";
import { InstructionDiscovery } from "@opencode/core/instruction-discovery";
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins";
import { Instructions } from "@opencode/core/instructions/index";
import { SkillDiscovery } from "@opencode/core/skill/discovery";
import { SkillInstructions } from "@opencode/core/skill/instructions";
import { Skill } from "@opencode/core/skill";
import { ReferenceInstructions } from "@opencode/core/reference/instructions";
import { Reference } from "@opencode/core/reference";
import { McpInstructions } from "@opencode/core/mcp/instructions";
import { Mcp } from "@opencode/core/mcp/index";
import { InstructionEntry } from "@opencode/core/session/instruction-entry";
import { InstructionState } from "@opencode/core/session/instruction-state";
import { Bus } from "@opencode/core/bus";
import { Database } from "@opencode/core/database/database";
import { ModelsDev } from "@opencode/core/models-dev";
import { PersistentPty } from "@opencode/core/persistent-pty/index";
import { Environment } from "@opencode/core/environment/index";
import { buildLocationServiceMap, LocationServiceMap } from "@opencode/core/location-services";
import { Location } from "@opencode/core/location";
import { Plugin } from "@opencode/core/plugin";
import { Agent } from "@opencode/core/agent";
import { Tool } from "@opencode/core/tool";
import { Session } from "@opencode/core/session";
import { SessionMessage } from "@opencode/core/session/message";
import { SessionExecution } from "@opencode/core/session/execution";
import { SessionContext } from "@opencode/core/session/context";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { MAX_STEPS_PROMPT } from "@opencode/core/session/runner/max-steps";
import { SessionModelTransport } from "@opencode/core/session/model-transport";
import { App } from "@opencode/core/app";
import { LayerNodePlatform as CorePlatform } from "@opencode/core/effect/app-node-platform";
import { RequestExecutorService } from "@opencode/ai/route/executor-service";
import { Provider } from "@opencode/core/provider";
import { Model } from "@opencode/core/model";
import { AGENT, DENY, INTERNAL_PLUGINS, PROFILE_VERSION } from "./opencode-core-adapter.js";
import { inspectInstalledPackages } from "./opencode-core-profile.js";
import { canonicalJson, freeze, parseStrict } from "../../task-contract/contract.js";
import { HOST_INSTRUCTION, prepareProposalInput } from "./proposal-input.js";
import { acquireProposalOAuthCredential, assertCurrentOAuthCredential, assertOAuthSecretsAbsent, assertOAuthWireIdentity,
  oauthCredentialComposition, OAUTH_BASE_URL, OAUTH_PROPOSAL_MODEL, OAUTH_MODEL_IDENTITY, type HostOAuthHandle } from "./opencode-oauth.js";
import { MAX_PROPOSAL_BYTES, parseProposal } from "./proposal.js";
import { HOST_REVIEW_INSTRUCTION, inspectReviewContext, assertReviewDispatchCurrent, type ReviewContext } from "./review-context.js";
import { parseFindings } from "./review-evidence.js";
import { assertNativeHostTurnCapability, type NativeHostTurnCapability } from "../../linux-development/native-credential.js";
import { prepareFixedNativeData, parseFixedNativeResponse } from "../../linux-development/native-fixed-data.js";
import { assertAuthenticatedNativeWorkerTurn } from "../../linux-development/native-receipt.js";
import type { NativeWorkerInput } from "../../linux-development/native-worker.js";

const configContent = JSON.stringify({ default_agent: AGENT,
  agents: { [AGENT]: { system: HOST_INSTRUCTION, permissions: [DENY], steps: 1 } }, snapshots: false });
const attempts = new Set<string>(), nativeSessions = new Set<string>();
const empty = z.array(z.never()).length(0);
const boundarySchema = z.object({
  version: z.literal(PROFILE_VERSION), config: z.literal(configContent), project: z.literal(false), global: z.literal(false),
  wellKnown: empty, externalOperations: empty, plugins: z.array(z.string()),
  discoveryProject: z.literal(false), discoveryGlobal: z.literal(false), discoveryEntries: empty,
  builtIns: empty, skills: empty, skillInstructions: empty, references: empty, referenceInstructions: empty,
  mcpServers: empty, mcpTools: empty, mcpInstructions: empty,
  directTools: empty, selectedTools: empty, codeMode: z.null(), selectedCodeMode: z.null(),
  agentPermissions: z.tuple([z.object({ action: z.literal("*"), resource: z.literal("*"), effect: z.literal("deny") }).strict()]),
  sessionPermissions: z.tuple([z.object({ action: z.literal("*"), resource: z.literal("*"), effect: z.literal("deny") }).strict()]),
  instructions: z.literal(""), instructionEntries: empty, entryInstructions: empty,
}).strict();

/** Observation validator only, never an approval or dispatch permit. */
export function assertProposalCoreBoundary(input: unknown): void {
  const x = parseStrict(boundarySchema, input);
  if (!isDeepStrictEqual([...x.plugins].sort(), [...INTERNAL_PLUGINS].sort())) throw new Error("Core plugin inventory changed");
}

function assertReviewCoreBoundary(input: unknown): void {
  const config = JSON.stringify({ default_agent: AGENT,
    agents: { [AGENT]: { system: HOST_REVIEW_INSTRUCTION, permissions: [DENY], steps: 1 } }, snapshots: false });
  const x = parseStrict(boundarySchema.extend({ config: z.literal(config) }), input);
  if (!isDeepStrictEqual([...x.plugins].sort(), [...INTERNAL_PLUGINS].sort())) throw new Error("Core plugin inventory changed");
}

const terminalSchema = z.object({
  nativeSessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/), submittedUserId: z.string().regex(/^msg_[A-Za-z0-9]+$/),
  submittedText: z.string(),
  users: z.array(z.object({ id: z.string(), text: z.string() }).strict()).length(1),
  assistants: z.array(z.object({ id: z.string(), text: z.string(), finish: z.literal("stop"),
    completed: z.number().finite().nonnegative() }).strict()).length(1),
  successfulTerminals: z.literal(1), started: z.literal(1), idle: z.literal(true), pending: z.literal(0),
  toolActivity: z.literal(0), errors: z.literal(0), cancellations: z.literal(0), providerCalls: z.literal(1),
}).strict();
/** No inference of idle from an assistant message. All observations are required. */
export function assertProposalTerminal(input: unknown) {
  const x = parseStrict(terminalSchema, input);
  if (x.users[0].id !== x.submittedUserId || x.users[0].text !== x.submittedText ||
    x.assistants[0].id === x.submittedUserId) throw new Error("Submitted turn mismatch");
  return freeze(x);
}

/** Monotone observation accumulator: even transient tool input/pending/result
 * activity remains a failure after it disappears from the final snapshot.
 * This helper consumes evidence DATA only, never grants authority.
 */
export function createProposalActivityObserver() {
  let toolActivity = 0, errors = 0, cancellations = 0, started = 0, successfulTerminals = 0;
  return Object.freeze({
    observe(type: string) {
      if (type.includes(".tool.")) toolActivity++;
      if (/failed|retry|compaction|synthetic|shell|skill/.test(type)) errors++;
      if (/interrupted|cancelled/.test(type)) cancellations++;
      if (type === "session.execution.started") started++;
      if (type === "session.execution.succeeded") successfulTerminals++;
    },
    snapshot: () => freeze({ toolActivity, errors, cancellations, started, successfulTerminals }),
  });
}

/** Fixed embedded transport. No provider/config/credential/session knobs.
 * hostExpected must originate independently. This module issues no authority.
 * A process-local fence is not durable recovery: the live credential path stays
 * closed until a protected host source and restart-safe attempt admission exist.
 * A lost process must never reconstruct/retry a dispatched attempt.
 */
export async function dispatchProposal(input: unknown, hostExpected: unknown) {
  let accepted = false;
  let code = "INVALID_PROPOSAL_REQUEST";
  try {
    const prompt = prepareProposalInput(input, hostExpected);
    const a = prompt.binding.attempt;
    // Fence synchronously before the first await, shared across all invocations.
    // Include logical ID as well as digest to prevent resealing the same attempt.
    const keys = [a.id, a.digest, a.sessionId, a.executionId, a.candidateId];
    code = "ATTEMPT_ALREADY_USED";
    if (keys.some(key => attempts.has(key))) throw new Error("Attempt already used");
    keys.forEach(key => attempts.add(key));
    code = "PROVIDER_CREDENTIAL_BOUNDARY_UNSAFE";
    const credential = acquireProposalOAuthCredential();
    assertCurrentOAuthCredential(credential);
    assertOAuthSecretsAbsent(credential, canonicalJson(prompt));
    code = "PROPOSAL_CORE_PROFILE_UNSAFE";
    inspectInstalledPackages();
    const terminal = await runEmbedded(prompt, credential, () => { accepted = true; });
    code = "INVALID_PROPOSAL_RESULT";
    const checked = assertProposalTerminal(terminal);
    assertOAuthSecretsAbsent(credential, checked.assistants[0].text);
    const proposal = parseProposal(checked.assistants[0].text, prompt.binding, hostExpected);
    return freeze({ kind: "PROPOSAL_ONLY" as const, result: "PROPOSAL_RECEIVED" as const, proposal,
      evidence: { nativeSessionId: checked.nativeSessionId, nativeUserMessageId: checked.submittedUserId,
        nativeAssistantMessageId: checked.assistants[0].id, completed: checked.assistants[0].completed,
        terminal: "SUCCEEDED_IDLE" as const, providerTurns: 1 as const },
      osProviderOnlyEgress: "NOT_ESTABLISHED" as const });
  } catch {
    // Never expose upstream exceptions, requests, headers, credentials or text.
    return freeze({ kind: "PROPOSAL_TRANSPORT_FAILURE_ONLY" as const,
      result: accepted ? "DISPATCH_OUTCOME_UNKNOWN" as const : "FAILED_BEFORE_DISPATCH" as const, code,
      osProviderOnlyEgress: "NOT_ESTABLISHED" as const });
  }
}

/** Dedicated fresh review session using the same closed OAuth/core composition.
 * The only public input is an opaque host-built context, never provider/session knobs. */
export async function dispatchAdvisoryReview(handle: ReviewContext) {
  let accepted = false;
  try {
    const prompt = inspectReviewContext(handle);
    assertReviewDispatchCurrent(handle);
    const key = `review:${prompt.binding.attempt.id}:${prompt.binding.attempt.digest}`;
    if (attempts.has(key)) throw new Error("Review replay");
    attempts.add(key);
    const credential = acquireProposalOAuthCredential();
    assertCurrentOAuthCredential(credential);
    assertOAuthSecretsAbsent(credential, prompt.user);
    inspectInstalledPackages();
    const terminal = assertProposalTerminal(await runEmbedded(prompt, credential, () => { accepted = true; }, true,
      () => assertReviewDispatchCurrent(handle)));
    assertReviewDispatchCurrent(handle);
    assertOAuthSecretsAbsent(credential, terminal.assistants[0].text);
    const findings = parseFindings(terminal.assistants[0].text, prompt.binding, prompt.digest);
    return freeze({ result: "REVIEW_RECEIVED" as const, findings,
      nativeSessionId: terminal.nativeSessionId, model: OAUTH_PROPOSAL_MODEL });
  } catch {
    return freeze({ result: accepted ? "REVIEW_OUTCOME_UNKNOWN" as const : "FAILED_BEFORE_DISPATCH" as const });
  }
}

/** Trusted in-process worker seam only. Existing public production dispatch and
 * OAuth acquisition remain unconditionally closed. Both opaque handles must be
 * acquired inside the private admitted worker; serialized objects are rejected.
 * Proposer input must contain genuine request/candidate handles; reviewer input
 * must be a genuine ReviewContext. hostExpected is independently host-sourced.
 * This does not certify authentication, kernel containment or native E2E. */
export async function runNativeHostTurn(role: "proposer" | "reviewer", hostFixedInput: unknown,
  credential: HostOAuthHandle, capability: NativeHostTurnCapability, hostExpected?: unknown) {
  let accepted = false;
  try {
    if (role !== "proposer" && role !== "reviewer") throw new Error("Invalid native role");
    assertNativeHostTurnCapability(capability, role, true);
    assertCurrentOAuthCredential(credential);
    const review = role === "reviewer";
    const prompt = review ? inspectReviewContext(hostFixedInput as ReviewContext) : prepareProposalInput(hostFixedInput, hostExpected);
    const recheck = () => {
      assertNativeHostTurnCapability(capability, role);
      if (review) assertReviewDispatchCurrent(hostFixedInput as ReviewContext);
    };
    recheck();
    assertOAuthSecretsAbsent(credential, canonicalJson(prompt));
    inspectInstalledPackages();
    const terminal = assertProposalTerminal(await runEmbedded(prompt, credential, () => { accepted = true; }, review, recheck));
    recheck();
    assertOAuthSecretsAbsent(credential, terminal.assistants[0].text);
    const evidence = { nativeSessionId: terminal.nativeSessionId, nativeUserMessageId: terminal.submittedUserId,
      nativeAssistantMessageId: terminal.assistants[0].id, completed: terminal.assistants[0].completed,
      terminal: "SUCCEEDED_IDLE" as const, providerTurns: 1 as const };
    if (review) {
      const context = inspectReviewContext(hostFixedInput as ReviewContext);
      return freeze({ result: "REVIEW_RECEIVED" as const,
        findings: parseFindings(terminal.assistants[0].text, context.binding, context.digest), evidence });
    }
    return freeze({ result: "PROPOSAL_RECEIVED" as const,
      proposal: parseProposal(terminal.assistants[0].text, prompt.binding, hostExpected), evidence });
  } catch {
    return freeze({ result: accepted ? "DISPATCH_OUTCOME_UNKNOWN" as const : "FAILED_BEFORE_DISPATCH" as const,
      code: "NATIVE_HOST_TURN_BLOCKED" as const });
  }
}

/** Fixed DATA-only native path reuses the same pinned one-turn embedded core.
 * No synthetic FAST evidence or serialized ReviewContext is constructed. */
export async function runNativeFixedDataTurn(input: NativeWorkerInput, credential: HostOAuthHandle, capability: NativeHostTurnCapability) {
  let accepted = false;
  try {
    const prompt = prepareFixedNativeData(input), role = prompt.input.role;
    assertNativeHostTurnCapability(capability, role, true);
    const recheck = () => { assertNativeHostTurnCapability(capability, role); assertAuthenticatedNativeWorkerTurn(role, prompt.inputDigest); };
    recheck(); assertCurrentOAuthCredential(credential); assertOAuthSecretsAbsent(credential, canonicalJson(prompt));
    inspectInstalledPackages();
    const terminal = assertProposalTerminal(await runEmbedded(prompt, credential, () => { accepted = true; }, role === "reviewer", recheck, true));
    recheck(); assertOAuthSecretsAbsent(credential, terminal.assistants[0].text);
    const data = parseFixedNativeResponse(prompt.input, terminal.assistants[0].text);
    return freeze({ result: "NATIVE_FIXED_DATA_RECEIVED" as const, sessionId: terminal.nativeSessionId,
      proposal: "proposal" in data ? data.proposal : null, review: "review" in data ? data.review : null,
      providerTurns: 1 as const, terminal: "SUCCEEDED_IDLE" as const });
  } catch { return freeze({ result: accepted ? "DISPATCH_OUTCOME_UNKNOWN" as const : "FAILED_BEFORE_DISPATCH" as const, code: "NATIVE_FIXED_DATA_BLOCKED" as const }); }
}

async function runEmbedded(prompt: { user: string; system: string }, credential: HostOAuthHandle, markAccepted: () => void,
  review = false, assertAdmission?: () => void, fixedData = false) {
  const system = fixedData ? prompt.system : review ? HOST_REVIEW_INSTRUCTION : HOST_INSTRUCTION;
  const configContent = JSON.stringify({ default_agent: AGENT,
    agents: { [AGENT]: { system, permissions: [DENY], steps: 1 } }, snapshots: false });
  const root = mkdtempSync(join(tmpdir(), "dl2-d1-")), project = join(root, "project");
  const paths: Global.Interface = { home: join(root, "home"), data: join(root, "data"), cache: join(root, "cache"),
    config: join(root, "config"), state: join(root, "state"), tmp: join(root, "tmp"), bin: join(root, "bin"),
    log: join(root, "log"), repos: join(root, "repos") };
  const die = () => Effect.die(new Error("Forbidden core activity"));
  let sessions: Session.Interface | undefined, bus: Bus.Interface | undefined, database: Database.Interface | undefined;
  let pluginSource: ConfigPluginSource.Interface | undefined, execution: SessionExecution.Interface | undefined;
  let recheck: (() => Effect.Effect<void, unknown>) | undefined;
  let nativeId: string | undefined, nativeProjectId: string | undefined;
  let providerCalls = 0;
  const activity = createProposalActivityObserver();
  const noInstructions = { load: () => Effect.succeed([]) };
  const wellKnown: WellKnown.Interface = { entries: () => Effect.succeed([]), snapshot: () => [],
    refresh: () => die(), add: () => die(), remove: () => die(), resolve: () => Effect.succeed([]) };
  const noPty: PersistentPty.Interface = { list: () => Effect.succeed([]), get: die, create: die, write: die,
    resize: die, control: die, input: die, snapshot: die, read: die, remove: die, shutdown: () => Effect.void,
    handoff: die, attach: die };
  try {
    for (const dir of [project, ...Object.values(paths)]) mkdirSync(dir, { recursive: true });
    const replacements = [
      ...oauthCredentialComposition(credential),
      App.node.replace(App.configured({ name: "dev2-d1", version: PROFILE_VERSION, channel: "proposal" })),
      Plugin.node.replace(Plugin.node.mapLayer(layer => Layer.effect(Plugin.Service, Effect.map(Plugin.Service, service => ({
        ...service, activate: (generations: readonly Plugin.Generation[], failures?: readonly import("@opencode/core/plugin/service").Failure[]) => {
          if (failures?.length || generations.some(p => p.source?.type !== "builtin")) return die();
          return service.activate(generations.filter(p => INTERNAL_PLUGINS.includes(p.id)));
        },
      }))).pipe(Layer.provide(layer)))),
      Global.node.replace(Global.layerWith(paths)),
      Database.node.replace(Database.configured({ path: ":memory:" }).mapLayer(layer => Layer.effect(Database.Service,
        Effect.map(Database.Service, service => { database = service; return service; })).pipe(Layer.provide(layer)))),
      Bus.node.replace(Bus.node.mapLayer(layer => Layer.effect(Bus.Service,
        Effect.map(Bus.Service, service => { bus = service; return service; })).pipe(Layer.provide(layer)))),
      Session.node.replace(Session.node.mapLayer(layer => Layer.effect(Session.Service,
        Effect.map(Session.Service, service => { sessions = service; return service; })).pipe(Layer.provide(layer)))),
      SessionExecution.node.replace(SessionExecution.node.mapLayer(layer => Layer.effect(SessionExecution.Service,
        Effect.map(SessionExecution.Service, service => { execution = service; return service; })).pipe(Layer.provide(layer)))),
      Config.node.replace(Config.configured({ project: false, global: false, content: configContent })),
      ConfigPluginSource.node.replace(ConfigPluginSource.empty.mapLayer(layer => Layer.effect(ConfigPluginSource.Service,
        Effect.map(ConfigPluginSource.Service, service => { pluginSource = service; return service; })).pipe(Layer.provide(layer)))),
      // Seed the pinned offline catalog BEFORE plugin transforms run. Routing,
      // OAuth model filtering and account headers remain the pinned plugin's job.
      Provider.node.replace(LayerNode.make({ service: Provider.Service, tag: Provider.node.tag,
        deps: [Provider.node.mapLayer(layer => layer), ModelsDev.node],
        layer: Layer.effect(Provider.Service, Effect.gen(function* () {
        const service = yield* Provider.Service, catalog = yield* ModelsDev.Service;
        const openai = (yield* catalog.get()).find(p => p.info.id === "openai");
        if (!openai) return yield* die();
        yield* service.transform(editor => editor.add({ info: { ...openai.info,
          settings: { ...openai.info.settings, transport: "http" } }, models: openai.models }));
        return service;
      })) })),
      SessionRunnerModel.node.replace(SessionRunnerModel.node.mapLayer(layer => Layer.effect(SessionRunnerModel.Service,
        Effect.map(SessionRunnerModel.Service, service => ({ resolve: (session, available) => Effect.gen(function* () {
          assertCurrentOAuthCredential(credential);
          if (session.model?.providerID !== "openai" || session.model.id !== OAUTH_PROPOSAL_MODEL) return yield* die();
          const resolved = yield* service.resolve(session, available);
          if (resolved.model.provider !== "openai" || resolved.model.id !== OAUTH_PROPOSAL_MODEL ||
            resolved.model.route.endpoint.baseURL !== OAUTH_BASE_URL || resolved.transport !== "http") return yield* die();
          return resolved;
        }) }))).pipe(Layer.provide(layer)))),
      SessionContext.node.replace(SessionContext.node.mapLayer(layer => Layer.effect(SessionContext.Service,
        Effect.map(SessionContext.Service, service => ({ ...service, request: { ...service.request,
          primary: input => Effect.gen(function* () {
            // 2.0.22's steps=1 appends a summary instruction as an artificial
            // assistant message. Recognize that EXACT pinned sentinel only;
            // remove it before hooks/lowering so it cannot override JSON output.
            const last = input.messages.at(-1);
            if (input.messages.length !== 2 || !isDeepStrictEqual(JSON.parse(JSON.stringify(last)),
              { role: "assistant", content: [{ type: "text", text: MAX_STEPS_PROMPT }] })) return yield* die();
            const prepared = yield* service.request.primary({ ...input, messages: input.messages.slice(0, -1), toolChoice: "none" });
            if (Object.keys(prepared.event.tools).length || prepared.request.tools.length || (input.tools?.definitions.length ?? 0) ||
              prepared.request.model.provider !== "openai" || prepared.request.model.id !== OAUTH_PROPOSAL_MODEL ||
              prepared.request.model.route.endpoint.baseURL !== OAUTH_BASE_URL)
              return yield* die();
            return prepared;
          }),
        } }))).pipe(Layer.provide(layer)))),
      WellKnown.node.replace(Layer.succeed(WellKnown.Service, wellKnown)),
      InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })),
      InstructionBuiltIns.node.replace(Layer.succeed(InstructionBuiltIns.Service, noInstructions)),
      SkillInstructions.node.replace(Layer.succeed(SkillInstructions.Service, noInstructions)),
      ReferenceInstructions.node.replace(Layer.succeed(ReferenceInstructions.Service, noInstructions)),
      McpInstructions.node.replace(Layer.succeed(McpInstructions.Service, noInstructions)),
      SkillDiscovery.node.replace(Layer.succeed(SkillDiscovery.Service, { pull: die })),
      ModelsDev.node.replace(ModelsDev.configured({ fetch: false, snapshot: true })),
      PersistentPty.node.replace(Layer.succeed(PersistentPty.Service, noPty)),
      SessionModelTransport.node.replace(Layer.succeed(SessionModelTransport.Service, {
        bind: () => { throw new Error("WebSocket prohibited"); }, close: () => Effect.void, closeAll: Effect.void,
      })),
      LayerNodePlatform.httpClient.replace(Layer.succeed(HttpClient.HttpClient, HttpClient.make(die))),
      Environment.node.replace(Environment.node.mapLayer(layer => Layer.effect(Environment.Service,
        Effect.map(Environment.Service, service => ({ ...service, spawner: { ...service.spawner, spawn: die } }))).pipe(Layer.provide(layer)))),
      CorePlatform.requestExecutor.replace(Layer.succeed(RequestExecutorService, {
        execute: (request, middleware) => {
          const send = (req: HttpClientRequest.HttpClientRequest) => Effect.gen(function* () {
            if (!recheck || providerCalls !== 0) return yield* die();
            yield* recheck();
            const web = yield* HttpClientRequest.toWeb(req);
            const text = yield* Effect.promise(() => web.text());
            if (Buffer.byteLength(text) > 2 * 1024 * 1024) return yield* die();
            const body = z.object({ model: z.literal(OAUTH_PROPOSAL_MODEL),
              instructions: z.literal(`${system}\n${OAUTH_MODEL_IDENTITY}`),
              input: z.tuple([z.object({ type: z.literal("message"), role: z.literal("user"), content: z.tuple([
                z.object({ type: z.literal("input_text"), text: z.literal(prompt.user) }).strict(),
              ]) }).strict()]), stream: z.literal(true),
              include: z.tuple([z.literal("reasoning.encrypted_content")]),
              reasoning: z.object({ effort: z.literal("medium"), summary: z.literal("auto") }).strict(),
              store: z.literal(false), prompt_cache_key: z.string(), tools: z.array(z.never()).length(0).optional(),
              tool_choice: z.literal("none").optional() }).strict().parse(JSON.parse(text));
            assertOAuthWireIdentity(credential, { url: web.url, method: web.method, model: body.model, headers: web.headers });
            assertOAuthSecretsAbsent(credential, text);
            if ((body.tools?.length ?? 0) !== 0 || !nativeId || body.prompt_cache_key !== nativeId)
              return yield* die();
            const expectedHeaders = {
              // OAuth/account values were compared privately above.
              authorization: web.headers.get("authorization"), "chatgpt-account-id": web.headers.get("chatgpt-account-id"),
              originator: "opencode", "x-codex-beta-features": "remote_compaction_v2", "session-id": nativeId,
              "content-length": String(Buffer.byteLength(text)),
              "content-type": "application/json", "user-agent": "opencode/proposal/2.0.22/dev2-d1",
              "x-opencode-client": "dev2-d1", "x-opencode-project": nativeProjectId,
              "x-opencode-session": nativeId, "x-opencode-session-id": nativeId,
              "x-session-affinity": nativeId, "x-session-id": nativeId,
            };
            if (!/^[a-f0-9]{40}$/.test(expectedHeaders["x-opencode-project"] ?? "") ||
              !isDeepStrictEqual(Object.fromEntries(web.headers), expectedHeaders)) return yield* die();
            // The last boundary after hooks/middleware. No redirect, retry,
            // provider discovery, sockets or other application HTTP paths.
             providerCalls++;
             assertAdmission?.();
            const response = yield* Effect.promise(() => fetch(web.url, { method: "POST", body: text,
              headers: web.headers, redirect: "error", signal: AbortSignal.timeout(30_000) }));
            if (!response.ok || !response.body) return yield* die();
            // Hard bound the provider stream before core parsing; headers never
            // enter evidence, and a lost/truncated response is always UNKNOWN.
            const reader = response.body.getReader(), chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              while (true) {
                const chunk = yield* Effect.promise(() => reader.read());
                if (chunk.done) break;
                bytes += chunk.value.length;
                if (bytes > MAX_PROPOSAL_BYTES * 4) return yield* die();
                chunks.push(chunk.value);
              }
            } finally { yield* Effect.promise(() => reader.cancel().catch(() => undefined)); }
            return HttpClientResponse.fromWeb(req, new Response(Buffer.concat(chunks), { status: 200,
              headers: { "content-type": "text/event-stream" } }));
          }).pipe(Effect.orDie);
          return (middleware ? middleware(request, send) : send(request)).pipe(Effect.orDie);
        },
      })),
    ];
    return await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const map = yield* LocationServiceMap.Service;
      const location = Location.Ref.make({ directory: AbsolutePath.make(project) });
      const context = yield* map.contextEffect(location);
      return yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service;
        yield* plugins.awaitActivation;
        const agents = yield* Agent.Service;
        yield* agents.transform(editor => editor.update(Agent.ID.make(AGENT), agent => { agent.permissions = [DENY]; }));
        const sessionService = sessions, busService = bus, db = database, cp = pluginSource, exec = execution;
        if (!sessionService || !busService || !db || !cp || !exec) return yield* die();
        const models = yield* Model.Service, providers = yield* Provider.Service;
        const assertOAuthModel = () => Effect.gen(function* () {
          assertCurrentOAuthCredential(credential);
          const model = yield* models.get(Provider.ID.openai, Model.ID.make(OAUTH_PROPOSAL_MODEL));
          const apiKeyModel = yield* models.get(Provider.ID.openai, Model.ID.make("gpt-4.1"));
          const provider = yield* providers.get(Provider.ID.openai);
          if (!model?.enabled || apiKeyModel?.enabled || model.limit.context !== 400000 || model.cost.length !== 0 ||
            provider?.settings?.baseURL !== OAUTH_BASE_URL || provider.settings.transport !== "http" ||
            !(yield* models.available()).some(m => m.providerID === "openai" && m.id === OAUTH_PROPOSAL_MODEL)) return yield* die();
        });
        yield* assertOAuthModel();
        const session = yield* sessionService.create({ location, agent: Agent.ID.make(AGENT), title: review ? "E1 advisory review" : "D1 proposal", permissions: [DENY],
          model: { providerID: Provider.ID.openai, id: Model.ID.make(OAUTH_PROPOSAL_MODEL) } });
        if (nativeSessions.has(session.id)) return yield* die();
        nativeSessions.add(session.id);
        nativeId = session.id;
        nativeProjectId = session.projectID;
        if ((yield* sessionService.context(session.id)).length || (yield* sessionService.inbox(session.id)).length) return yield* die();
        const ctx = yield* SessionContext.Service;
        const selected = yield* ctx.select(session.id);
        yield* InstructionState.prepare(db.db, busService, selected.instructions, session.id);
        const config = yield* Config.Service, discovery = yield* InstructionDiscovery.Service;
        const tools = yield* Tool.Service, skills = yield* Skill.Service, refs = yield* Reference.Service;
        const mcp = yield* Mcp.Service, entries = yield* InstructionEntry.Service;
        const scope = yield* Scope.Scope;
        const check = () => Effect.gen(function* () {
          yield* assertOAuthModel();
          const packages = inspectInstalledPackages();
          const configEntries = yield* config.entries();
          const agent = yield* agents.get(Agent.ID.make(AGENT));
          if (!agent || configEntries.length !== 1 || configEntries[0].type !== "document" || !isDeepStrictEqual(JSON.parse(JSON.stringify(configEntries[0].info)), JSON.parse(configContent)) ||
            agent.system !== system || agent.steps !== 1) return yield* die();
          const inventory = yield* plugins.list();
          if (inventory.some(p => p.source?.type !== "builtin" || p.state.status !== "active")) return yield* die();
          const selection = yield* ctx.select(session.id), snapshot = yield* tools.snapshot(agent.permissions);
          (fixedData ? (input: unknown) => {
            const x = parseStrict(boundarySchema.extend({ config: z.literal(configContent) }), input);
            if (!isDeepStrictEqual([...x.plugins].sort(), [...INTERNAL_PLUGINS].sort())) throw new Error("Core plugin inventory changed");
          } : review ? assertReviewCoreBoundary : assertProposalCoreBoundary)(JSON.parse(JSON.stringify({ version: packages[0].version, config: configContent, project: false, global: false,
            wellKnown: yield* wellKnown.entries(), externalOperations: yield* cp.operations(), plugins: inventory.map(p => p.id),
            discoveryProject: discovery.project, discoveryGlobal: discovery.global, discoveryEntries: yield* discovery.list(),
            builtIns: yield* noInstructions.load(), skills: yield* skills.list(), skillInstructions: yield* noInstructions.load(),
            references: yield* refs.list(), referenceInstructions: yield* noInstructions.load(),
            mcpServers: yield* mcp.servers(), mcpTools: yield* mcp.tools(), mcpInstructions: yield* noInstructions.load(),
            directTools: snapshot.definitions, selectedTools: selection.tools.definitions,
            codeMode: snapshot.codeModeCatalog ?? null, selectedCodeMode: selection.tools.codeModeCatalog ?? null,
            agentPermissions: agent.permissions, sessionPermissions: selection.session.permissions,
            instructions: Instructions.renderInitial(selection.instructions, {}), instructionEntries: yield* entries.list(session.id),
            entryInstructions: yield* entries.load(session.id) })));
        }).pipe(Effect.provideService(Scope.Scope, scope));
        recheck = check;
        yield* check();
        yield* busService.listen(event => Effect.sync(() => {
          const data = event.data as { sessionID?: string };
          if (data.sessionID !== session.id) return;
          activity.observe(event.type);
        }));
        const userId = SessionMessage.ID.create();
        // Conservatively fence as UNKNOWN BEFORE native admission, not merely
        // after the HTTP response. No continuation/resume API is called.
        assertAdmission?.();
        markAccepted();
        yield* sessionService.prompt({ sessionID: session.id, id: userId, text: prompt.user });
        yield* sessionService.wait(session.id);
        const history = yield* sessionService.context(session.id);
        const users = history.filter(m => m.type === "user"), assistants = history.filter(m => m.type === "assistant");
        let { errors, toolActivity } = activity.snapshot();
        const idle = history.at(-1);
        if (history.length !== 3 || history[0].type !== "user" || history[1].type !== "assistant" ||
          idle?.type !== "idle" || idle.outcome !== "succeeded") errors++;
        for (const m of assistants) {
          if (m.error || m.retry || m.content.some(c => c.type !== "text")) errors++;
          toolActivity += m.content.filter(c => c.type === "tool").length;
        }
        return { nativeSessionId: session.id, submittedUserId: userId, submittedText: prompt.user,
          users: users.map(m => ({ id: m.id, text: m.text })),
          assistants: assistants.map(m => ({ id: m.id, text: m.content.filter(c => c.type === "text").map(c => c.text).join(""),
            finish: m.finish, completed: m.time.completed ? DateTime.toEpochMillis(m.time.completed) : undefined })),
          ...activity.snapshot(), idle: !(yield* exec.isActive(session.id)), pending: (yield* sessionService.inbox(session.id)).length,
          toolActivity, errors, providerCalls };
      }).pipe(Effect.provideContext(context));
    }).pipe(Effect.provide(buildLocationServiceMap(replacements)), Effect.provide(Logger.layer([])), Effect.timeout("45 seconds"))));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
