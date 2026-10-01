# IR-04 CT701 currentness coordinator (offline implementation)

This is production-oriented protocol core, **not deployed or production-ready**.
IR-05 authenticated transport, IR-06 approved packaging, IR-07 key helpers and
IR-09 real target adapters remain separate. No production credential or live
service is installed. `src/bridge/` remains the unrelated ChatGPT/C2C/MCP bridge.

## Composition and authority

Install a fixed host-owned `ReviewCoordinatorPeer` on `TrustedContextStore` and
`createTrustedContextProvider`. The peer is an in-process/transport-independent
capability; no header, source IP, caller PASS/current flag or config plugin
establishes its identity. The CT702 HTTP server's authentication default is deny-all.
`createTrustedAuthorityIngestor().adoptIndependentReview()` uses the coordinator
when a peer is installed and is asynchronous. Without a peer it denies ingestion.
`isolatedIngestion: true` is an explicit legacy offline validation fixture seam;
its adoptions have **no production readiness identity** and cannot pass the new
service consume path. `bootstrapFixture` likewise cannot establish readiness.

The independently maintained request, policy, generation, signed review and signed
Human approval are still verified separately. CT702 signature/evidence/chronology
checks and authority-first lock ordering remain in force. Authority and execution
ledger are different dedicated databases. Never share their connections.

## Activation

1. Acquire CT701 authority `BEGIN IMMEDIATE`; verify independent host authority,
   strict signed CT702 envelope and complete pending-publication chronology.
2. Commit an immutable publication intent containing review ID, material root,
   evidence hash, signed-publication sequence, envelope hash, attempt hash and
   original acknowledgement UUID. This commit is **not activation**.
3. Under another authority-first writer reservation, acquire CT702's exact
   `PUBLICATION` reservation. It prevents local invalidation/supersession between
   signature retrieval, CT701 adoption and publication acknowledgement.
4. Persist request/review/policy/target/adoption records and the coordination commit
   together. **This durable CT701 COMMIT is production activation.**
5. Send the original publication acknowledgement to CT702. Its short transaction
   resolves the publication reservation and appends PUBLICATION_ACKNOWLEDGED
   atomically. CT701 persists the exact receipt separately.

Signature retrieval, CT702 SIGNED_PENDING_PUBLICATION, and CT702
PUBLICATION_ACKNOWLEDGED by themselves do not activate production authority.
Activation survives a lost ACK response. Consumption remains closed until the
original ACK is reconciled. `reconcileReviewAcknowledgement(reviewId,
'PUBLICATION')` replays only the persisted original request; it does not adopt or
renew evidence. CT702 returns the original historical acknowledgement prefix even
if subsequent invalidation is pending. A fresh readiness check will reject that
pending state. No fresh UUID is allocated on repeated activation.

## Revocation and replacement

`admitReviewInvalidation(reviewId)` acquires the same authority writer lock used
by consume/handoff, reads the CT702 pending event, and verifies the exact published
predecessor sequence, history prefix, intent hash and replacement identity. It
records the immutable revocation intent and marks the review stale/superseded in
one transaction. **That durable CT701 COMMIT is production revocation.** Only then
is `acknowledgeInvalidation` sent with the original UUID/sequence/intent/replacement.
Its response is persisted independently. Loss never restores currentness.

Contending admission returns busy (zero SQLite lock timeout), not successful
revocation. A handoff already owning the authority fence precedes that admission;
the exact admission can be explicitly resubmitted after it settles. A revocation
that owns the fence first excludes new handoff and commits before it can enter.
CT702 pending intent alone is not production revocation, but rejects readiness.

Replacement activation requires prior production revocation of the old current
review on that target. The two transactions can leave a deny-only gap, never a
reactivation window. This first core deliberately serializes more coarsely than
individual actions: only one current review per target can be newly activated.
An old or revoked review cannot be re-adopted. ACK reconciliation is historical
and never changes authority back to current.

## CT702 reservation state machine

Reservations are immutable rows independent of append-only review events:

```
absent -- exact acquire / short COMMIT --> HELD
HELD -- exact readiness resolution / short COMMIT --> RESOLVED
HELD -- exact publication ACK + publication event / short COMMIT --> RESOLVED
```

Every reservation binds kind, barrier UUID, review ID, expected current event
sequence, signed-publication sequence, material root and evidence hash.
READINESS requires PUBLICATION_ACKNOWLEDGED as the last event; INVALIDATION_PENDING
or SUPERSESSION_PENDING rejects it. PUBLICATION requires SIGNED_PENDING_PUBLICATION.
Exact repeated acquisition returns HELD or RESOLVED; RESOLVED never authorizes
consumption. Conflicting reuse or a second outstanding reservation is rejected.

The initial implementation uses a **global CT702 ordering fence**: an unresolved
reservation blocks every new review event (enforced by a SQL trigger), including
replacement acceptance, signing/publication, invalidation and supersession. This
is deliberately conservative and matches the coarse CT701 writer fence. Reads and
exact reconciliation still work. The barrier stores no lease and has no timeout
release. Restart preserves every reservation/resolution.

`events.seq` is global across reviews. Numeric gaps due to another review are
legitimate; expected per-review transitions and exact sequence identities must
match. Missing/reordered chronology and mismatched current/publication sequences
are rejected. Resolution binds the complete original reservation, resolution UUID,
disposition and custody handoff hash (null only for explicit abandonment).

CT702 commits before responding and never holds its SQLite transaction while
waiting for CT701 or a network callback. CT701 may hold its authority fence while
awaiting CT702, but there is no reverse CT702→CT701 lock dependency.

## Per-consume protocol and durable obligations

Inside `TrustedContextStore.withFence()` / provider identity scope:

1. Derive readiness identity from the committed adoption and publication receipt.
2. In the separate ledger commit a unique, immutable barrier intent **before** the
   remote acquire. Any repeat consume for that attempt finds the obligation and
   stops; it does not generate/send a substitute barrier.
3. Acquire CT702 readiness and compare every response binding and HELD state.
4. Run the existing independent execution verification before and after one-shot
   Human JTI / permit JTI / attempt-hash consumption.
5. In the consumption transaction allocate a global monotonic safe-integer fencing
   token and immutable full handoff identity. No live handoff escapes before COMMIT.
6. Mint an in-memory one-use handoff and call `IsolatedExecutionBridge.handoff()`.
7. Validate and persist the exact durable custody receipt, then commit an exact
   barrier resolution intent before sending it. Validate its response and persist
   the resolution ACK. Only then return and release the authority fence.

No `finally` block releases the remote reservation on exception, timeout or
disconnect. CT702 unavailable, malformed/mismatched response, missing ACK, sequence
error or unknown state returns fail-closed without new handoff. An acquire response
loss consumes no identities. Handoff/resolve response loss retains consumption,
token and original handoff and records RECONCILE_REQUIRED. There is no redispatch
or automatic mutation retry, including after restart or completed execution.

`reconcileExecutionObligation` is an explicit host-only recovery operation under
the authority fence. It can run after authority expiry/revocation. For consumed
handoffs it reads Bridge custody by exact handoff ID/hash, stores that receipt and
resolves the original barrier. It cannot mint a live handoff. If there is no
handoff, it reconciles only the original acquire, quarantines the permit and
records ABANDONED before resolving. A generation rejection/no Bridge custody after
consumption stays blocked for further host investigation; it is not a retry route.
Previously persisted resolutions are resent byte-identically. Remote unknown
COMMIT requires reopening a validated store and explicit reconciliation.

## Schemas and boundaries

* Authority application ID 1413563954: **v3** (was v2), immutable
  `coordination_intents`, `coordination_commits`, `coordination_acks`.
* Ledger application ID 1413563953: **v2** (was v1), immutable
  `execution_barriers`, `barrier_resolutions`, `barrier_resolution_acks`,
  `handoffs`, `custody_receipts`.
* CT702: **7023** (was 7022), immutable `reservations`, `resolutions` and event fence.

Existing mismatched DBs are rejected, never migrated/repaired. Only explicitly
provisioned empty stores use new schemas. Unknown COMMIT never returns execution
success. Whole-store rollback protection/independent anchors are IR-08, not a
property provided by a local SQLite file alone.

Focused offline coverage: `tests/ir04-coordination.test.ts` and
`tests/ir04-protected-bridge.test.ts`, including cross-connection/worker contention,
restart, sequence identity, publication/invalidation ACK loss, barrier acquire and
resolve loss, unknown COMMIT, and permanent one-shot dispatch. Existing CT701 and
CT702 suites continue to validate their independent contracts.

Offline verification on 2026-10-01 (Windows, working-tree implementation):
After separating durable custody acknowledgement from executor settlement:
IR-04 focused suites **49 passed**; `pnpm typecheck` **PASS**.
Post-fix full `pnpm test` (confirmed final execution results supplied by the user):
**PASS** — Test Files: **66 passed (66)**; Tests: **1464 passed (1464)**;
failed: **0**; skipped: **0**; exit code: **0**; duration: **310.34s**.
The full regression also passed
`acknowledges custody and releases currentness locks while a blocked executor retains the target fence`.
These results include ephemeral fixture keys/databases and software-only ceremony
tests in the existing regression suite, not production key or Passkey operations.
No production package freeze, deployment, commit or push is part of this result.
