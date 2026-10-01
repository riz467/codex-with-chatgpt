# CT701 isolated Finalizer HTTP service

This v1 is **isolated loopback/test code**, not a production-exposed listener.
It performs no adapter execution. Deployment, mTLS/reverse proxy, Tailscale
policy and the production Execution Bridge are separate phases.

## Bootstrap

`src/typed-action-finalizer/server.ts` exports `createFinalizerService(config,
hostDependencies)`. `listen()` binds only to `127.0.0.1`; `close()` drains HTTP
requests before closing SQLite. Port 0 supports isolated tests.

The strict configuration accepts exactly:

```json
{
  "host": "127.0.0.1",
  "port": 7010,
  "databasePath": "/var/lib/ct701-typed-action-finalizer/ledger.sqlite",
  "signingKeyPath": "/etc/ct701-typed-action-finalizer/signing-key.pem",
  "finalizerKeyId": "ct701-finalizer-v1",
  "trustedHumanKeyPath": "/etc/ct701-typed-action-finalizer/ct700-public.pem",
  "trustedHumanKeyId": "ct700-human-v1",
  "bridgeTokenPath": "/etc/ct701-typed-action-finalizer/bridge-token",
  "trustedContextProvider": { "kind": "host-injected" }
}
```

Paths are fixed CT701-owned locations, not arbitrary config/HTTP paths.
Host-only DI permits ephemeral KeyObjects, a temporary database, a clock,
provider, bridge and credential in tests. The bridge credential is a random
base64url secret (at least 32 random bytes), supplied only at bootstrap.
Keys are read once, require Ed25519, and are never returned. File loading rejects
symlink ancestry and nonregular/oversized files; Unix private files must be
owned by the process uid with no group/other access. Windows ACL provisioning
is the host's responsibility. Existing SQLite schema is verified by the store;
tampering causes startup failure, not repair.

`cli.ts` takes one host-owned config filename. The standalone CLI can use
`trustedContextProvider.kind: "deny-all"` for health-only isolation. It cannot
issue or consume permits in that mode. `host-injected` requires embedding with
an actual provider; absent dependencies fail closed. There is no network-fetch,
caller-selectable plugin or authority-file provider.

## Trusted provider and live handoff

`TrustedContextProvider` receives a fixed request/attempt/Human evidence
identity. `finalization()` independently obtains Human trusted context, CT702
review and policy context. `execution()` obtains a fresh trusted execution
snapshot on **both** sides of durable consumption. HTTP booleans are never
authority. The provider must authenticate evidence provenance and maintain an
exclusive target/request/review/policy/generation fence through `withFence()`.
Neither signed Human evidence nor signed permit JSON establishes freshness.

Only the host-injected `IsolatedExecutionBridge.handoff()` receives the live
successful gate decision's permit, under that fence, exactly once. In this
phase it is an isolated seam, not an adapter implementation. HTTP success is
a notification that this live handoff occurred, **not an execution capability**.
A future bridge must enter through this boundary for every execution and must
never accept cached HTTP JSON/evidence as permission to run an adapter.
No bridge injection means consumption is rejected. Handoff exceptions quarantine
the permanently consumed identity.

Loopback is not authentication against other local users/processes. Mutation
routes additionally require `Authorization: Bearer <bridge credential>`;
this isolation credential is not a claim of production authentication.

## API

All responses are JSON, `no-store`, `nosniff`, with no CORS grants, static files,
stack traces or internal exception details. POST requires JSON, a 64 KiB body
limit and exact schemas. Origin-bearing requests and query parameters are rejected.

| Method / path | Body / result |
| --- | --- |
| `GET /health` | Secret-free isolated status |
| `POST /api/typed-action-finalizations` | Exactly `boundRequest`, `boundAttempt`, `humanApproval`; returns `permitId`, `permitJti`, `evidenceId` |
| `GET /api/typed-action-permits/:id` | UUID permit ID; returns persisted signed `envelope`, evidence hash and lifecycle state |
| `POST /api/typed-action-permits/:id/consume` | Bridge credential; `{permitJti, attemptHash}` |
| `POST /api/typed-action-permits/:id/reconcile` | Bridge credential; `{permitJti, attemptHash, category}` |
| `POST /api/typed-action-permits/:id/execution-verified` | Bridge credential; `{permitJti, attemptHash}` |

The service allocates permit UUID, random 32-byte jti and issuance time. Permit
expiry is capped at 60 seconds and Human/review/maintenance expiry. Existing
Core/kernel perform actual request/attempt rehash, signature, review/policy,
generation, maintenance and expiry verification. Evidence is committed before
its identifiers escape; repeated issuance is permanently rejected.

Consume loads **persisted** evidence, verifies it through the existing gate,
and atomically consumes Human jti, permit jti and attemptHash in the existing
SQLite store. Exactly one live handoff may return
`{state:"CONSUMED_FOR_EXECUTION", executionMayStart:true}`. Duplicates return
false, including after restart and across competing service connections.
Unknown storage outcomes and post-consume freshness changes return
`RECONCILE_REQUIRED`, never a retry permit. If reconciliation persistence itself
fails, the service latches closed with 503 for all requests. The host must
restore storage and reconcile before restarting; restart is not a recovery or
retry authorization for an unresolved storage outage.

Reconciliation accepts only the existing fixed `ReconciliationCategory` enum,
checks persisted identity and all three consumed keys in a transaction, and
cannot reactivate anything. Internal unknown-outcome quarantine remains able
to quarantine issuance even when consumption was not acknowledged.
Execution verification requires the correct persisted identity, consumed state,
no reconciliation and no previous verification. It records a result only.

No generic signer, execution API, arbitrary command/ref/URL/path selector,
MCP registration or deployment integration is provided.
