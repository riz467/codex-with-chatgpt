# IR-04 Protected Execution Bridge core

`src/protected-execution-bridge/` is a separate protected-host core. It is **offline,
not deployed**, and contains no Git/PVE/apt/service mutation adapter. `src/bridge/`
continues to implement ChatGPT/C2C/MCP and is not an execution component.

## Live capability and exact binding

The CT701 execution coordinator extends the existing `IsolatedExecutionBridge`
handoff seam with the complete verified permit payload plus handoff UUID, barrier
UUID, monotonic fencing token and signed permit evidence hash. This binds action
ID/kind, target ID, request hash, attempt ID/hash/sequence, target generation,
policy hash, maintenance window, independent review hash, Human evidence hash/JTI,
permit ID/JTI and expiry. The canonical handoff hash has its own domain.

The ledger creates the handoff in the same transaction as permanent consumption.
Only a known successful live gate call mints a frozen one-use object tracked by an
internal WeakSet. Bridge claims it once. JSON, copies, GET permit responses, receipt
lookups and restart-loaded rows do not belong to that set and cannot execute.
The mint function is an internal trusted-code composition seam, not an HTTP/RPC
API; host code/package integrity is part of the TCB. IR-05 must preserve these
semantics at a future authenticated transport boundary instead of exposing mint.

## Durable custody

Dedicated file-backed SQLite application ID **1413563955**, schema **v1**, WAL/FULL,
foreign keys, zero writer wait, exact schema/integrity verification. No migration,
repair or state deletion. The default executor is absent and **deny-all**.

* `attempts`: permanent attempt-hash PK, unique attempt ID, handoff ID and fencing
  token; immutable full binding and custody receipt. Duplicate accepted attempts
  are rejected permanently, even when byte-identical, completed or reconciled.
* `targets`: per-target monotonic high-watermark and exclusive active handoff.
  Custody requires no active handoff and a strictly greater token. Clearing an
  active fence requires a durable verified outcome or explicit reconciliation.
* `outcomes`: immutable VERIFIED or RECONCILE_REQUIRED.
* `reconciliations`: immutable exact handoff/host-observation evidence hash.

Under BEGIN IMMEDIATE the Bridge verifies live identity/expiry, duplicate absence,
target fencing and host-owned target generation. It persists tombstone, target
fence and exact custody receipt atomically. Only a known successful COMMIT can
invoke the executor. Lost/unknown COMMIT quarantines the instance and invokes no
executor. Reopening reveals a pending custody obligation, never a runnable queue.

The injected host `generation()` must be serialized with the target's durable
exclusive fence; independently mutable inventory is not a supported adapter.
`execute()` is a bounded typed host seam, not a shell/command/path RPC. This core
returns durable custody independently of executor settlement, allowing CT701 to
resolve CT702 readiness and release its authority fence while execution remains
behind the Bridge target fence. The live one-shot settlement task is owned by the
Bridge; it is never reconstructed on restart. Real scheduling/target enforcement
is IR-09. Verified completion commits an outcome and clears only that exact active
fence. Throw, timeout/unknown outcome or unexpected result records
RECONCILE_REQUIRED and keeps the target fenced. No connection/lease timer releases
it. Process death after custody also leaves it fenced. Settlement persistence
failures quarantine the instance and are contained by the Bridge; they cannot
retract acknowledged custody or trigger redispatch. Unknown COMMIT requires
explicit investigation after reopening.

## Receipts and reconciliation

Custody receipt: exact handoff UUID/hash, attempt hash, target ID, fencing token,
`CUSTODY_DURABLE`. It is historical custody, **not proof of mutation success**.
Read-only `receipt(id,hash)` also reports recorded outcome, or RECONCILE_REQUIRED
when execution could have been interrupted. It never invokes an adapter.

After a lost custody response CT701 retains consumption and never reallocates a
token or resends handoff. Explicit reconciliation reads this exact receipt, then
resolves the original CT702 barrier. Subsequent production revocation cannot
cancel a mutation already accepted into durable custody.

`reconcileTarget` requires a host-injected read-only actual-state investigation
that proves terminal state with an evidence hash. It records that observation and
clears only the matching active fence. This seam must prove that **all** executors
across processes have terminated; local inactivity or elapsed time is insufficient.
Completed/reconciled tombstones remain forever; no resume/redispatch method exists.
An absent observation adapter leaves the target blocked.

## Remaining work

IR-05 mTLS/Tailscale identity/transport; IR-06 production packaging and protected
host lifecycle; IR-07 production key helper; IR-08 independent rollback/receipt
anchor; IR-09 real adapters, target-side generation/fencing/credential enforcement.
No production key/certificate, live deployment, systemd activation, PVE mutation,
Passkey operation or production cutover has been performed.
