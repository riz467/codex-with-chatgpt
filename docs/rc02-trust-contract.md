# RC-02 task trust contract foundation

Phase 1 implements pure contract validation and conservative lifecycle preconditions.
It **does not enforce production behavior yet**. No existing entrypoint, agent,
engine, schema, retry path, completion writer, CT service or package uses this code.
There is no migration, deployment, authority activation or host adapter here.

## Authority ownership

AI/caller data is evidence or a candidate, never authority. Execution owns candidate
execution evidence; CT702 owns independent Review truth; CT700 owns Human Approval;
CT701 owns currentness, permit/finalization and protected authoritative completion.
Local ledger DONE, Dashboard state and CURRENT_REVIEW are projections/navigation.
Keys, protected records, databases, signatures, authenticated transport, fencing,
replay consumption and receipt verification are not implemented by this foundation.

`src/task-contract` imports only Zod, deterministic Node hashing and its own modules.
It has no filesystem, process, environment, network or current-clock access and
does not import any role's authority implementation.

## Versioned request / attempt / gate

This is a separate RC02 version **2** wire domain, not an extension that makes old
v03 or bounded-v2 ledgers valid. Strict shapes reject unknown fields, malformed
hashes, non-JSON objects, hidden properties, getters and custom prototypes.

Request binds task/repository, goal digest, acceptance-criteria digest, profile ID
and digest, policy digest, explicit target generation, exact scope/digest and
`v03_exact_text` or `bounded_v2_range_edit`. These edit formats remain distinct.
Attempt binds task/request, attempt ID/hash/sequence, baseline identity and immutable
input snapshot digest. The gate binds the same identities plus explicit decision,
reason code/reason, permitted operation names and evidence identifiers.

Scope paths are portable ASCII relative paths, at most 240 characters, strictly
ordinal-sorted (not locale-sorted), unique also under case folding, with 1–20 paths.
Absolute/drive paths, backslashes, empty/dot segments, trailing dots, Windows device
names and `.git`/`.ai` segments are rejected. The parser never repairs or reorders
scope. This lexical contract is not proof of filesystem safety or file existence.

SHA-256 inputs are UTF-8 `DOMAIN + LF + canonical JSON`; object keys are sorted,
array order is preserved. Domains are `RC02_EDIT_SCOPE_V2`, `RC02_REQUEST_V2` and
`RC02_ATTEMPT_V2`. Request/attempt hashing excludes only its own hash field.
Goal/criteria/profile/policy/baseline/snapshot digests are opaque identities here:
future hosts must independently compute/verify their source material.

`validateTaskBinding(candidate, hostExpected)` recomputes scope/request/attempt
digests, validates cross-object binding, then compares the complete contract with
independent host expectations. A caller must never supply both arguments at a
production seam. This pure API cannot prove where `hostExpected` originated.
Matching ALLOW returns a frozen copy tagged **BINDING_ONLY**, not authorization.
STOP gates cannot list allowed operations. ALLOW requires BOUNDED_EDIT and the
fixed edit-kind-specific operation list, but that list grants no capability.

## Lifecycle and legacy compatibility

`operationEligibility` accepts strict local snapshots and returns one of:

| Disposition | Meaning |
| --- | --- |
| INSPECTION_ALLOWED | READ, DISPLAY or VERIFY_HISTORICAL only; caller still needs safe read access |
| DENIED | No operation eligibility |
| REQUIRES_FRESH_REQUEST | Legacy or superseded evidence needs a new immutable request/attempt and fresh authority |
| REQUIRES_HOST_AUTHORIZATION | Local preconditions only; independent host checks are still mandatory |

There is no sensitive-operation ALLOW result and no execution capability. State,
mutation outcome and freshness supplied to this function are not trusted proofs.
Matching mutation preconditions require EXECUTION_RESERVED, RESERVED identity,
NOT_STARTED outcome and exact host binding. Known verification/review preconditions
require CONFIRMED outcome. APPROVE/FINALIZE at REVIEW_PENDING only request independent
authority processing; no Review signature, approval or completion is verified here.

Missing/null legacy gate permits read/display/historical verification only. Legacy
mutation, retry and authoritative finalization are denied. Existing records are
never rewritten or given a synthetic ALLOW. Old READY/PASS/DONE/bundles can be audit
material, not a substitute for a fresh request, attempt, Review and approval.

BLOCKED, FAILED_KNOWN, VERIFY_FAILED_KNOWN, RECONCILE_REQUIRED and LOCAL_DONE have no
resume edge. Consumed/quarantined execution identities cannot become sensitive-
operation eligible again. They are not the separate CT701 completion identity.
Superseded evidence requires fresh request/attempt and fresh authority.

`assertExecutionTransition` checks structural ordering, not storage, reservation,
gate provenance or authorization. Its forward path is:

```text
REQUEST_FIXED -> ATTEMPT_FIXED -> GATE_VALIDATED -> EXECUTION_RESERVED
  -> MUTATION_IN_PROGRESS -> MUTATION_CONFIRMED -> VERIFICATION_PASSED
  -> REVIEW_PENDING
```

Known pre-mutation failure may stop as FAILED_KNOWN; known verification failure as
VERIFY_FAILED_KNOWN. Unknown outcomes require RECONCILE_REQUIRED. There is no local
edge to authoritative DONE. `stateForMutationOutcome` maps CONFIRMED,
FAILED_WITHOUT_MUTATION and NOT_STARTED conservatively; all unknown/unsupported
values map to RECONCILE_REQUIRED. NOT_STARTED does not allocate a reservation.

## No automatic retry and unknown outcomes

RETRY_VERIFY and REDISPATCH are explicit denied operation labels, not capabilities.
No model judgment or failure state authorizes them. This slice implements no
explicit verification re-run either. A future separately reviewed operation would
need immutable same request/attempt, known mutation outcome, no redispatch and
explicit human action or independently authorized reconciliation.

UNKNOWN/RECONCILE_REQUIRED denies mutation, verification execution, approval,
finalization and retry; read-only audit remains possible. Investigation does not
release consumed identities or rearm execution. A future recovery seam may query
an already committed exact receipt or record known-result disposition under
independent authority; this foundation implements neither recovery nor storage.

## Review / Approval / Permit / DONE

Review PASS is not approval; a signed approval is not a permit; an issued permit,
durable consumption or custody receipt is not completion. LOCAL_DONE is not
authoritative DONE. `classifyAuthorityObservation` accepts only non-authoritative
candidate observations and always returns UNVERIFIED / isApproval=false. Even an
APPROVAL_SIGNED observation is not verified approval by this API. DONE exists as a
separate authority vocabulary; no function in this module can establish it.
Caller PASS/current/policyAllowed/DoneApproved fields are rejected, not trusted.

Future CT701 integration must independently verify exact bindings, current Review
generation, policy/target generation, active keys, validity and one-shot replay
consumption at its protected commit boundary. This code provides none of those
authority observations from local state and never accepts a boolean override.

## Research boundary

`parseResearchOperation` accepts exactly ReadCatalogFile, ObserveStatus, ReadHead,
ReadBoundedHistory, ReadBoundedDiff and ReadTrackedBlob with opaque inventory/catalog
IDs. No executable, shell, command, argv, cwd, environment, remote, URL, path or Git
configuration selector is accepted. fetch, ls-remote, push, commit, checkout, reset,
clean, arbitrary Git and network operations do not exist in this union.

Parsing an identifier does not prove inventory ownership. A future host adapter
must resolve IDs locally, enforce path/secret/reparse safety, fixed argv and bounded
outputs/time/tool budgets. No adapter or Git execution is implemented. Remote
freshness would require a separate bounded capability, never broader researcher
permissions.

## Verification is not authorization

Exact patch/content, commit/HEAD/index, bundle/seal and explicit line-ending checks
remain valuable future verification primitives. This slice does not extract or
execute the existing v03 completion checks. It only documents their separation:
CONTENT_VERIFIED is not APPROVED, CURRENT or DONE. Caller PASS/DoneApproved and local
completion writers must be retired in later slices, without losing content binding.

The three RC02 test files use only in-memory fixtures and deterministic
hashes. They do not use files, Git, child processes, network, environment mutation,
production state or current host identity. Passing these tests proves foundation
behavior only, not production enforcement, authority isolation or deployment safety.
