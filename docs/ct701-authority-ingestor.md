# CT701 Production-oriented Trusted Authority Ingestor Core

## IR-04 update

The current protocol is documented in [CT701 currentness coordinator](ct701-currentness-coordinator.md).
Authority schema is now **v3**. Host-installed `reviewPeer` makes
`adoptIndependentReview` asynchronous: durable original publication intent,
CT702 reservation, CT701 activation COMMIT, then exact publication ACK.
Without that peer ingestion denies by default. The previous synchronous behavior
below is available only with explicit `isolatedIngestion: true` for legacy offline
validation fixtures and cannot establish production consume readiness.
Revocation uses `admitReviewInvalidation` and exact ACK reconciliation; the live
consume path requires a durable CT702 barrier. The remaining sections describe
the underlying verification contract and the earlier v2 implementation history.
IR-05 transport, IR-09 real adapters and live deployment remain unimplemented.

This in-process core connects CT702 signed review evidence and CT700 signed Human
Approval to the durable CT701 Trusted Context Store. Production activation is a
separate task. No HTTP, network, caller paths, deployment configuration, production
keys, execution bridge or PVE operations are introduced.

## Host installation and caller surface

The host constructs `TrustedContextStore({ database, ingestor })` using its dedicated
file-backed SQLite connection. The `AuthorityIngestorHost` installation supplies:

- `currentAuthority(identity)`: a synchronous independently obtained snapshot of
  the current request, current policy, current target generation and CT702 trusted
  review context. Its strict request/policy wrappers require `current: true`.
- `trustedReviewKeys` and `trustedHumanKeys`: copied public-key maps.
- `now()`: trusted current time in epoch milliseconds.

`createTrustedAuthorityIngestor(store)` exposes exactly:

```ts
adoptIndependentReview({ identity, evidence })
registerHumanApproval({ identity, evidence })
```

`identity` contains only `actionId`, `targetId`, `requestHash`, `attemptId` and
`attemptHash`. `evidence` is respectively the strict CT702 or CT700 signed envelope.
Unknown fields, caller booleans, paths, arbitrary records, SQL and table selectors
are rejected. The host dependencies cannot be supplied or overridden per call.
Validation helpers are internal pure functions; the store never accepts a
prepared authority record from a caller. `bootstrapFixture()` remains exclusively
a test/bootstrap seam and is not called by either production route. Bootstrap
reviews and approvals cannot be promoted into production adoption identities.

## Authority ownership and locking contract

Every operation acquires `BEGIN IMMEDIATE` on the authority DB **before** acquiring
host authority or changing records. The synchronous host snapshot must be owned by
the host, independently validated, and stable under this lock. Host adapters must
serialize their authority changes with this store and persist stale/superseded/
revoked states before exposing replacements. Independently mutable remote sources
are not supported by this core. An external source changing without this protocol
would not provide the required fence.

The SQLite RESERVED writer lock, not a process-local mutex, orders different
connections/processes. `busy_timeout=0` fails a contending operation closed; it may
retry the identical operation after the winner commits. Existing finalization
fences exclude ingestion and revocation throughout their awaited operations.
Same-store mutation during a finalization fence poisons that fence. Reentrant
writers are rejected. No ingestor operation acquires the execution ledger lock;
the authority-first lock order is preserved.

## CT702 verification and authority construction

The locked host snapshot is strictly parsed, and all caller lookup constraints
must match the host request. All CT702 action/request/attempt binding fields must
match that request, including sequence. Its independent review hash must match the
host review context's expected hash. `verifyIndependentReview()` then performs the
existing Ed25519, expected key ID, current review ID, evidence/manifest hash,
binding and freshness checks. The trusted context requires current review and
host-verified bundle integrity. Valid signed `FAIL` and `NEEDS_WORK` are rejected
for adoption. Future-issued reviews are rejected even inside verifier skew.

The review record is constructed from the host request binding and verified
CT702 result/timestamps. `evidenceIntegrityValid` is set only after the host's
integrity assertion has passed strict parsing and the verifier has matched it to
the signed evidence. Its DB state becomes current only through this transaction.
Signed caller JSON is never copied into a trusted review record wholesale.

### Policy, generation and window binding

CT702 v1 signs requestHash, attemptHash and their action/attempt identity, but does
**not** contain separate policy hash, generation or maintenance-window fields.
Those values come from the independently verified host request authority; the
typed request hash commits to these request preconditions. The host is responsible
for providing the canonical request/attempt authority rather than arbitrary hash
claims. The request's expected review evidence hash ties that request to CT702.
This is transitive request-hash binding, not a claim that absent CT702 fields were
directly signed.

The host policy must be current and allowed, and exactly match request policy
hash, action kind, target ID, generation and maintenance-window ID. The current
target generation must also match. The trusted clock must be inside the window;
the entire review lifetime must fit within it, and the review must follow attempt
creation. Existing DB generation must equal the snapshot, never be rewritten by
adoption. An existing policy-hash body is immutable, including its target/window;
a changed policy authority requires a new policy identity.

## Schema v2 and permanent identities

`application_id=1413563954` continues to identify the dedicated authority database;
`user_version` is now **2**. Verification requires the exact v2 SQL manifest,
application ID, version, integrity, WAL/FULL and foreign-key settings, with no temp
objects. Only an empty, unversioned database is initialized. Old v1 and unexpected
schemas are rejected, never migrated or repaired. The existing version-tampering
test now uses v1 as the rejected version (v2 is the valid schema).

New tables:

| Table | Permanent identity constraints |
| --- | --- |
| `review_adoptions` | Primary key attempt hash; UNIQUE review ID, CT702 jti, review evidence hash, full signed envelope hash |
| `human_registrations` | Primary key Human evidence hash; UNIQUE Human jti |

The envelope hash is the domain-separated SHA-256 of canonical strict signed
CT702 JSON, including its signature (`AI_WORKSPACE_CT701_REVIEW_ADOPTION_ENVELOPE_V1`).
Canonical JSON property reordering does not create a different identity.
All new identity rows prohibit UPDATE and DELETE, and insertions advance the
authority revision. Existing authority bodies remain immutable and their
revocations terminal. Uniqueness and triggers survive restart.

An identical, still-current and still-valid review returns `already-adopted`;
a fresh adoption returns `adopted`. A different envelope for the same attempt
fails even if it has the same review evidence. Review IDs, jtis and evidence hashes
cannot alias another adoption. Changing review evidence requires a fresh attempt,
fresh review ID, fresh jti and fresh evidence. Duplicate success does not extend
freshness or undo revocation. Bodies must still exactly match existing records.

## Transactions and uncertain outcomes

Target authority, request, review, policy and review adoption identity are inserted
in one transaction. Any verification, conflict, uniqueness, schema or write failure
rolls back all of them. Human evidence and its identity likewise commit together.
No success is returned until COMMIT returns successfully. Any COMMIT error marks
the store unavailable even if rollback succeeds. Rollback failure also marks it
unavailable. The caller receives an exception, not an adoption success.

Reconciliation requires closing/reopening the store, verifying the durable schema,
and retrying the exact evidence against current authority. A committed operation
then resolves idempotently; an uncommitted operation can be adopted normally.
An expired or revoked record remains rejected. There is no blind success or
automatic uncertain-commit retry inside the core.

## CT700 Human Approval registration

Registration first requires a production review adoption identity. It reads the
current request, review, policy and generation directly under the same DB lock.
It reconstructs the strict Human trusted context, rechecks PASS, integrity,
bindings, review freshness, request chronology and maintenance validity, then uses
`verifyTypedActionApproval()` for Ed25519 and exact Human request/attempt/review
hash/policy/generation/window binding. Approval issuance must follow review issuance
and be no later than the current clock.

The authenticated strict signed Human body is stored unchanged as immutable
evidence. A fresh registration returns `registered`; an identical valid duplicate
returns `already-registered`, with its evidence hash. An existing jti cannot be
reused by a different envelope. A revoked approval cannot be registered again.

`staleRequest`, `supersedeRequest`, `revokeReview`, `supersedeReview`, `revokePolicy`,
`revokeHumanApproval` and `advanceGeneration` retain their existing semantics.
Reopening does not revive any of them. Request/review/policy invalidation or a
generation advance blocks subsequent registration; Human revocation blocks
re-registering that evidence. The provider also checks these conditions at every
finalization/execution context read.

## Provider and Finalizer integration

Adopted rows are the same typed records consumed by `createTrustedContextProvider`.
It independently verifies registered Human signatures and reconstructs trusted
Finalizer contexts inside the existing authority fence. Integration tests begin
with an empty authority DB: finalization fails before adoption, fails before Human
registration, then succeeds through the existing signer after both are valid.

Ingestion issues **no execution permission**. The existing CT701 ledger still
consumes Human jti, permit jti and attemptHash exactly once. No generic authority
mutation API is exported. The only caller capability methods are the two
purpose-specific operations above.

## Verification

`tests/typed-action-authority-ingestor.test.ts` exercises signed PASS/FAIL/NEEDS_WORK,
forgery, key pinning, all review and Human bindings, host policy/clock failures,
durable identity conflicts, revocation, restart, concurrent worker adoption,
competing connections/fences, partial writes, both possible unknown-commit outcomes,
schema tampering without repair, provider/Finalizer/ledger integration and the
restricted caller surface. Existing CT702 and CT701 tests remain enabled.

Run `pnpm typecheck` and `pnpm test`.
