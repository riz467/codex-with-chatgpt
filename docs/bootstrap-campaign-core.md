# Bootstrap Campaign Core — IR-01 (offline v1)

`src/bootstrap-campaign/` implements the offline contract and fixed decision core for
[the bootstrap design](trust-control-plane-bootstrap-campaign-v1.md), especially §§4, 5,
11–13 and IR-01. This is **not a production bootstrap release or execution authorization**.

## Trust boundary and fixed executor

`BootstrapCampaignExecutor` is a synchronous in-process host component. It has no CLI,
HTTP server, MCP registration, adapter, shell, subprocess, network client, Git/SSH/PVE
target resolver, key generator, service activation or deployment connection. Its only
catalog is `TEST_READ_ONLY`, `TEST_MUTATION`, `TEST_HUMAN_CEREMONY`, all targeting the
literal `OFFLINE_FIXTURE`. Tests deliver observations in process; no target mutation is
performed. Phase names such as KEYING describe the model, not real actions.

The trusted composition host supplies a dedicated, already-open file-backed SQLite
connection, clock and local high-watermark contract. Database paths and SQL are not
operation inputs. The host must own the connection exclusively and protect its code,
clock, receipt-registration entry points and checkpoint under human-admin ACLs. This
library does not authenticate arbitrary callers: exposing its registration/cancellation/
observation methods to AI or HTTP would violate the contract.

The future adapter seam is the fixed decision containing campaign/step/operation IDs,
catalog enum and fixed target enum. `intent()` and `decision()` can report eligibility;
they are **not reusable execution capabilities**. Only `dispatch()` makes the exclusive
durable `STEP_DISPATCHED` claim, and returns only after SQLite COMMIT and checkpoint ack.
A future reviewed adapter integration must consume that live return once, within the
trusted host; cached decisions must never invoke adapters. IR-01 contains no such adapter.

## Strict immutable manifest

All §5 top-level fields are required, plus explicit nullable `continuation`. Every object
is closed. Missing/unknown fields, custom prototypes, accessors (without invoking their
getters), symbols, cycles, sparse/decorated arrays, undefined, bigint, nonfinite/fractional/
unsafe numbers, negative zero and invalid Unicode are rejected before schema parsing.
IDs use exact ASCII grammars (UUIDv4 campaign/nonce, fixture-only bootstrap domain);
there is no path/URL normalization or executable-path field. JSON wire parsing rejects
duplicate keys including escaped spelling aliases, BOM, trailing data, excessive size
and depth. Callers with raw JSON must pass its text to the parser: duplicate information
cannot be recovered from an object already processed by an unrelated JSON parser.

Sources, executor/catalog binding, validity, steps, mutation allowlist, ceremonies,
reconciliation, cutover and audit have closed typed contracts. Production policy,
CT manifests, artifacts, network, key topology, authority, post-create state and verification
are individually named version-1 `NOT_IMPLEMENTED` placeholders with a contract digest.
They cannot carry arbitrary objects and do not claim production predicates are implemented.
The domain, operation catalog and cutover receipt types prohibit treating this profile
as a production manifest. Supporting production requires separately reviewed contracts.

Validity is bounded to eight hours; clock skew and observation age are at most five
seconds and 300 seconds respectively. Actual dispatch uses strict expiry, with no skew
grace. Step timeout is at most 30 minutes, attempts are exactly one, and total serialized
timeout budget must fit the interval. Unmet time/capacity constraints fail closed.

## Canonical manifest hash

```
SHA256(UTF8("security-trust-bootstrap-campaign-v1\n" + canonicalJSON(manifest)))
```

Canonical JSON recursively sorts object keys, preserves array order, uses safe integer
JSON numbers, and adds neither BOM nor trailing newline. The manifest has no self-hash
field. This domain and the journal/catalog/operation/receipt domains are separate from
Typed Action and CT700 production Human Approval. Artifact content digests are supplied
bindings, not assertions that this core downloaded or built those artifacts.

## Authorization and replay

`BootstrapLocalAuthorizationReceipt`, domain `bootstrap-human-admin-local-v1`, records
independent human-admin PC confirmation. It binds campaign ID, exact manifest hash,
one-shot nonce, executor hash, bootstrap trust domain, authorized/expiry times, operator,
execution host, source evidence root, authorization text digest, nullable message reference
and local attestation digest. `productionApproval` must be false. No chat signature,
Passkey assertion, or CT700 approval is synthesized or accepted by this contract.

Campaign ID and nonce are reserved forever when preparing the campaign. Authorization
registration is exact-byte idempotent while admissible; changed receipts, expired receipt
registration and terminal/tombstoned replays fail. No extension, replacement, UPDATE,
DELETE, retry or reactivation API exists. Registration only records a host-verified
receipt; activation is separate and one-shot. Only the executor instance that newly
registered it can activate it. Reading or re-registering an existing receipt after restart
does not reacquire that authority. Activation appends a fresh execution identity.

`BEGIN IMMEDIATE`, unique campaign/nonce/execution identities and a global active-campaign
check serialize writers. At most one step is in flight; dependencies and phase membership
are checked under the same transaction. SQLite constraints and event state prohibit a
second dispatch, including across handles. Human-admin startup must fence the previous
executor before declaring it stopped; competing recovery conservatively terminates the
old run rather than granting a second owner.

## SQLite and journal integrity

Dedicated SQLite v1: WAL, synchronous FULL, foreign_keys ON, application_id `1111707697`,
user_version `1`, quick_check, foreign_key_check, exact sqlite_schema object/SQL manifest,
and no attached authority database or temporary schema objects. Only a genuinely empty
database with zero version/application ID and an empty high-watermark is initialized.
Existing schema mismatches are never migrated, repaired or reset.

Startup first distinguishes empty/unversioned databases from existing stores. Only the
empty case with checkpoint `{sequence:0,eventHash:<64 zeroes>}` may set persistent
`journal_mode=WAL` and create the trusted schema. Existing stores only query journal mode;
DELETE or any other non-WAL mode, wrong application ID/version or schema mismatch rejects
startup without mode repair or migration. `synchronous=FULL`, `foreign_keys=ON` and
`busy_timeout` are connection-local configuration, set on each connection and distinct
from persistent database settings. Regression tests compare DB bytes and introspected
settings/schema before and after rejected startup, including after closing the connection.

Tables: `campaigns`, `authorizations`, `activations`, `receipts`, `journal`, `tombstones`.
All have UPDATE/DELETE-aborting triggers. Identity uniqueness, references, typed/canonical
receipt bodies and their journal bindings are checked. One global monotonically increasing
journal sequence provides a total order across campaigns. Each event binds campaign/hash,
UTC timestamp, previous/event hash, campaign state, nullable step/operation IDs, evidence
hashes, and closed details (fixed reason, receipt hash, execution identity). Event hashing
uses `bootstrap-campaign-journal-v1`; the first previous hash is 64 zeroes.

**`audit.maxEvents = per-campaign event limit`.** Before each append, the same write
transaction counts journal rows for that campaign and requires `count + 1 <= maxEvents`.
All event kinds consume this budget, including preparation, recovery and terminal events.
The global journal sequence/hash chain continues across campaigns and is never compared
to this per-campaign limit. Other campaigns do not consume its budget, including after
restart; reaching the exact limit rejects the next append without increasing the count.

Inspection reconstructs states from the chain in a read transaction. Chain corruption,
gaps, time regression, mismatched rows/receipts, invalid transitions and checkpoint mismatch
stop admission. A DB write is acknowledged only after COMMIT and checkpoint acknowledgement.
Failure injection covers before COMMIT, after COMMIT and anchor-ack loss. Unknown outcome
never returns a successful decision; the instance is poisoned and cannot dispatch again.

`LocalHighWatermark` is an explicit host-owned `read`/monotonic compare-and-advance contract
for `{sequence,eventHash}`. It must be retained separately from database rollback. Tests
retain this checkpoint while restoring an older real SQLite database. A DB behind **or
ahead of** the checkpoint fails closed; the latter can indicate a lost COMMIT/anchor ack.
There is no automatic checkpoint catch-up/reset API. Tests use an in-memory checkpoint
retained across executor instances; this is a **local contract and rollback test**, not a
durable independent anchor implementation. IR-08 must implement protected persistence,
external acknowledgement and whole-host rollback protection. Rolling back both DB and
its only checkpoint cannot be detected by a hash chain alone.

## State model and crash matrix

The 17 states are PREPARED, WAITING_HUMAN_AUTHORIZATION, AUTHORIZED, PREFLIGHT, CREATING,
ISOLATION_VERIFY, BOOTSTRAPPING, KEYING, CROSS_PINNING, DEPLOYING, STARTING, VERIFYING,
E2E, READY_FOR_PASSKEY_CUTOVER, COMPLETE, BLOCKED, RECONCILE_REQUIRED. Normal phase
transitions are sequential; empty fixture phases are traversed and journaled. A phase
with unfinished steps or a waiting ceremony cannot exit. COMPLETE, BLOCKED and
RECONCILE_REQUIRED are terminal for that campaign.

Mutation progression is strictly:

```
NOT_STARTED -> INTENT_DURABLE -> DISPATCHED -> OBSERVED -> VERIFIED
```

Intent requires a fresh exact-bound precondition receipt, rechecked for age at dispatch.
Observation requires an exact input/postcondition/operation-bound receipt after dispatch.
Verification requires a separate typed receipt binding the observed receipt hash and
postcondition. Receipt acceptance here is a trusted offline fixture operation, not proof
of actual production state. Timeouts never become a retry permit.

| Stop boundary | Read-only startup / subsequent recovery |
| --- | --- |
| Before authorization | Reconstruct; later independent authorization may activate |
| Registered, not yet activated | Old receipt cannot activate; terminal BLOCKED, continuation required |
| Authorized, before first intent | Terminal BLOCKED, continuation required |
| Intent durable, no dispatch marker | RECONCILE_REQUIRED; absence of dispatch is not proof of no effect |
| Dispatched | RECONCILE_REQUIRED |
| Observed, not verified | RECONCILE_REQUIRED; no restart verification-only shortcut |
| All started mutations verified | BLOCKED / CONTINUATION_AUTHORIZATION_REQUIRED |
| Human ceremony wait | Same safe-boundary continuation rule; original authority does not resume |
| Terminal state | Remains terminal; inspection only |
| DB/chain/checkpoint unknown | No admission; separate recovery investigation required |

Construction and inspection do not dispatch or rewrite existing campaign state. `recover()`
records the terminal classification; attempting work through an unowned restarted instance
also enforces this classification. Uninterrupted execution continues under the initial
authorization as long as predicates, observations, expiry and storage remain valid.

## Bounded continuation

A continuation is a **new campaign manifest and nonce** with fresh Human authorization,
not an ACTIVE transition or a patch. Its typed link binds original and previous campaign
IDs/hashes, previous journal checkpoint, last verified checkpoint, exact verified
receipt/evidence roots, fresh observation root/time and exact remaining step IDs.

Only a safely BLOCKED `CONTINUATION_AUTHORIZATION_REQUIRED` predecessor qualifies.
The full step catalog/scope remains byte-identical; prior verified steps are inherited
as immutable receipt references and never dispatched. All fields except the new identity,
nonce, bounded validity and continuation link must match. Expiry cannot exceed the prior
expiry; clock/observation policy cannot be relaxed. Branching multiple continuations from
one predecessor is rejected. Reconciliation, target/scope changes and expiry extension
require a separately designed fresh campaign, not ordinary continuation.

## Cancellation, expiry and ceremonies

Cancellation is a closed human-admin local receipt bound to campaign/hash/nonce,
operator/host, time and attestation digest. Cancellation or expiry yields BLOCKED if
no uncertain mutation exists, otherwise RECONCILE_REQUIRED. In-flight progress markers
are preserved. Restoring the clock or re-registering old authorization cannot revive a
terminal run; clock rollback poisons admission.

Ceremony is a substatus within the current phase. Fixture tailnet enrollment, Passkey
enrollment and external E2E have fixed ceremony IDs, operator, expiry and expected evidence
digest. Completion must bind those plus campaign/hash, execution host, timestamp and
attestation digest. `completed=true`, wrong IDs/digests, stale or pre-wait receipts fail.
No login URL, credential or private key is stored. These receipts do not perform enrollment
or count as production Passkey evidence.

## Cutover model

At READY, an `OfflineCutoverModelReceipt` models the irreversible progression:
`BOOTSTRAP_DISABLED_PENDING -> PASSKEY_ONLY -> COMPLETE`. It binds the manifest's
required evidence root and disable-protocol hash. Both tombstones are durable,
append-only, trust-domain-scoped and permanently reject bootstrap registration,
activation and new bootstrap preparation in that domain. Pending cutover interruption
does not fall back to bootstrap. Completion requires PASSKEY_ONLY and the original live
owner. Checkpoints include tombstones and detect older DB rollback.

This fixture receipt explicitly has `productionPasskeyEvidence:false`. The core does
not execute or certify §13's live cutover, UV, six acceptance categories, external anchor,
revocation or reject probes. Those production implementations/evidence remain IR-08/11
and other IR dependencies; offline COMPLETE is only a modeled fixture result.

## Verification

`tests/bootstrap-campaign.test.ts` covers strict JSON/schema, canonical/hash domains,
authorization bindings/one-shot persistence, DAG/state, intent/dispatch concurrency,
all restart boundaries, continuation receipts/replay, ceremonies, cancel/expiry,
append-only storage, chain/schema tampering, checkpoint rollback, unknown COMMIT/anchor
failure, tombstones and the fixed public API surface. Existing tests are retained.

Run `pnpm typecheck`, `pnpm test -- tests/bootstrap-campaign.test.ts`, and `pnpm test`.
2026-10-01 hardening verification: typecheck PASS; focused 143/143 PASS; full suite
60 files, 1273/1273 PASS. Twelve regression cases cover campaign-local capacity and
startup no-repair. Existing rollback assertions are retained; their fixtures now copy
checkpointed WAL bytes instead of using `VACUUM INTO` (which produces DELETE mode).
No tests were removed, skipped or weakened.
Production mutation by this core: **0**.
