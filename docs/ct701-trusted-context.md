# CT701 Trusted Context Provider Core

This phase supplies a host-owned provider through the existing
`FinalizerServiceDependencies.provider` seam. Production configuration remains
`deny-all`. No network ingestion, HTTP authority API, CT702 client, adapter,
deployment or production database opening is added.

## Authority ownership and persistence

`TrustedContextStore` owns an injected, dedicated **file-backed SQLite connection**.
It must not share a connection or database with the execution ledger. The reserved
future host location is
`/var/lib/ct701-typed-action-finalizer-authority/authority.sqlite`; the module does
not open this or any caller-selected path. Tests inject temporary local databases.
Future host provisioning must protect that directory (service uid, 0700), database
and WAL/SHM (0600), reject symlinks and prevent untrusted filesystem writers.

Authority v1 has its own application ID (`1413563954`) and these tables:

| Table | Ownership / semantics |
| --- | --- |
| `targets` | independently current target generation; increases only |
| `requests` | request/attempt/action/target hashes, sequence, creation time and expected review/policy/generation/window binding |
| `reviews` | independent CT702 record for an attempt, full binding, result, integrity disposition and validity interval |
| `policies` | policy hash, permitted action/target/generation, window identity and interval |
| `approvals` | independently host-registered signed CT700 evidence; indexed by full evidence hash |
| `authority_revision` | monotonic store revision; triggers cover every authority insert/update |

Request/review/policy/approval records have a separate `current`, `stale` or
`superseded` state. Bodies and identities are immutable. Triggers forbid deletion
and reactivation. Changed evidence requires fresh immutable records and a fresh
bound attempt/approval; replacing old bodies to authorize an old permit is forbidden.

`bootstrapFixture` is an insert-only test/bootstrap seam for independent record
sets. There is no production registration API. In particular, its fixture result
and integrity fields are **not** a production CT702 provenance verifier. A future
ingestor must authenticate CT702 evidence independently before authoring those
records; copying a Human approval's review hash or HTTP PASS flag is insufficient.

Schema creation occurs only for a completely empty unversioned DB. Existing DBs
must match the exact table/index/trigger SQL manifest, application ID and version,
and pass `quick_check`, WAL, FULL synchronous and foreign-key checks. Changed
schemas/journal modes are rejected, never repaired. Schema verification runs at
fence/write acquisition and fence completion. The separate execution ledger
continues to own permanent consumption and reconciliation; this store has no
ledger deletion, restoration, release or retry operation.

## Fence and concurrency semantics

`withFence(identity, operation)` acquires **BEGIN IMMEDIATE on the authority DB**.
This is a deliberately coarse global writer fence, covering all target/request,
review, policy and generation updates. It remains held across asynchronous
operation, durable consumption in the separate ledger, and the existing service's
live handoff. Lock ordering is always **authority first, ledger second**.

The sequence is:

1. Acquire the SQLite writer reservation and verify schema/revision.
2. Strictly bind the identity and assemble/validate a fresh independent snapshot.
3. Run the operation in an AsyncLocalStorage-scoped ownership context.
4. Re-read and revalidate snapshot, trusted clock, revision and schema.
5. Commit the authority fence, then release it.

SQLite locking, rather than a process-local mutex, excludes writers in other
connections/processes. `busy_timeout=0` fails a competing update/fence immediately;
it cannot block Node's event loop waiting for an asynchronous owner. The caller
must handle contention explicitly; there is no automatic mutation retry.

A writer that wins first commits revocation before any finalizer snapshot, so the
finalizer rejects. A finalizer that wins first sees stable authority through the
operation; a competing update returns busy and has **not** revoked anything. It
may be submitted separately after the operation. A same-instance attempted write
poisons the active fence even if the callback catches the exception. Direct
same-connection changes increment revision and fail the fence; rollback cannot
undo the separate ledger's already-durable consumed identities.

AsyncLocalStorage only prevents access outside the owning operation, identity
substitution and detached work after release; it is not the cross-process lock.
Keep the SQLite connection private to its owning store. The store latches closed
on an unknown fence commit/rollback outcome. A hung operation retains its fence
until completion or process termination: there is no unsafe timed lease expiry
or forced release while live execution might still run.

## Independent binding and freshness

An HTTP/service `ContextIdentity` is only a lookup constraint. It supplies no
PASS/current/allowed/window/generation authority. The provider requires:

- exact requestHash, attemptHash/id/sequence, action and target binding;
- a current independent CT702 PASS record with verified-integrity disposition;
- CT702 evidence hash and all bindings equal the trusted request and registered
  Human approval, not CT702 evidence synthesized from that approval;
- current policy permitting the exact action kind and target, with equal hash,
  target generation and maintenance window identity;
- equality with the independent current target generation;
- a current registered Human envelope whose hash/jti/request identity match, and
  whose Ed25519 signature verifies against the copied host-owned public-key map.

At the trusted current time, `startsAt <= now < expiresAt` is mandatory for the
maintenance window. Human approval's complete interval must fit in that window.
Review must already be issued, unexpired, and after attempt creation but no later
than Human approval. Human approval must already be issued and unexpired.
The existing finalization/gate still enforce permit validity, signature and its
complete interval within Human, review and maintenance expiry. Backward clock
movement inside one fence fails closed; durable anti-clock-rollback infrastructure
across host restarts is outside this local-clock core.

`execution()` performs fresh SQL reads on **every invocation**, including both
sides of consumption. It never reuses the finalization snapshot or takes context
from signed permit JSON. Revocation between finalization and consume therefore
blocks consume; a detected violation after durable consumption produces the
existing gate's permanent reconciliation state, never a released identity.
The outer fence may itself reject after that decision; callers must not interpret
the exception or a failed HTTP response as permission to retry execution.

## Host-only revocation

The narrow operations are `staleRequest`, `supersedeRequest`, `revokeReview`,
`supersedeReview`, `revokePolicy`, `revokeHumanApproval`, and `advanceGeneration`.
They cannot set generic trusted booleans or reactivate a revoked record. Their
updates, generations and revisions survive restart. Revocation never removes or
restores consumed attempts in the separate authority ledger.

## Validation

`tests/typed-action-finalizer-trusted-context.test.ts` uses only ephemeral keys
and temporary persisted state. It covers invalid bindings/missing/stale/denied
records, maintenance boundaries, restart, terminal revocation, exact schema
rejection, fresh execution, poisoning/revision checks, separate-connection and
worker-thread SQLite exclusion, and permanent consumption across both DB restarts.

The end-to-end fixture drives the actual signer and durable execution gate with
the new provider and verifies service dependency injection without listening on a
network socket. Existing service/storage/signing and full regression suites remain
unchanged. There is no Git adapter connection or production config activation.
