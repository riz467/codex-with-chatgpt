# VM116 live preparation — one consolidated Human approval proposal

Baseline code688e490fb36034df6b36e1609d82eb7dc23c0db1 already includes e0d5f4ef
fixed Linux CLI and9afd8f24 custody diagnostic. This is a proposal, not an EXEC permit.
No new Phase, no production/Qualification change. Current live prep remains BLOCKED.

## Gate 0: existing Bridge auth discrepancy (UNKNOWN, no adoption)

Target `/var/lib/ai-control/.local/state/codex-with-chatgpt/auth/0aa1228228bc.json`.
This is the Bridge OAuth server's client registrations and hashed access/refresh-token
state, NOT OpenCode provider OAuth custody. Verified deployed compiled code has the
AuthStore reader, secure JSON writer, refresh-grant handler and bearer guard.
Writes can originate from registration, issue, refresh, revoke or unpair. Local source
AuthStore.refresh revokes the prior refresh hash and calls issueTokens/save; expired
records are pruned during save. This describes possible writers, not actual attribution.

Last prior digest ea066897a2a3ba93cf451bdc8d65e608a8d6879608b66b426293fcc9ac3dbeb2.
Current digest258aa8ebe23adc7fd098cc42ac0c9e845143339fa4de34972866f8eb4ff343ee.
Observed UID999/GID988/mode0600/nlink1/inode262172/device2049/1337bytes;
mtime2026-10-10T14:49:54.305239Z, ctime2026-10-10T14:49:54.306239Z, stable over2seconds.
Prior saved manifest has UID/GID/mode/bytes/digest, not inode/mtime/ctime. Missing
historical metadata cannot be reconstructed or claimed unchanged.

Bounded14:30–15:10UTC Bridge journal had0records; fixed app-log tail contained no
recognized auth/service-operation event in the window. The examined implementation
does not emit successful-refresh audit evidence. Therefore normal rotation, its
caller and exact mutation cause remain UNKNOWN. No further credential inspection.
Health200 and missing-bearer MCP401 demonstrate liveness/rejection only, NOT valid
credential acceptance, refresh success or authority. No token used for a live test.

**Required Human decision before protected-region live writes:** identify the external
client/operation at14:49:54UTC from Human-controlled records, or explicitly choose an
incident handling route. Do not treat an unexplained hash as acceptable baseline.
No auth file restoration, rotation, revoke, chmod, Bridge restart or old-baseline edit
is proposed. Restoring old rotating state can revive old auth or discard current state.

## Conditional minimal manifest proposal (not implemented/applied)

Only after legitimate writer/event is independently established:

- Keep unit/drop-in/binary/ExecStart/script/package/config/reference closures exact.
- For this one approved mutable auth-state path, keep expected owner/group0600,
  regular/non-symlink/nlink1/parent custody, and bounded file size. Record PRE and POST
  content digest/metadata separately as observations, not static equality proof.
- A content change must have independently authenticated update evidence tying time,
  exact file, before/after digests, allowed writer and operation. No event => BLOCKED.
  mtime alone or a caller-supplied receipt is not that evidence. Refresh currently lacks
  that audit, so simply excluding the digest would weaken protection and is prohibited.
- Stop on other file/type/ownership/permission/network/service identity drift. Retain
  original canonical manifests and UNKNOWN receipts; use a separate versioned proposed
  manifest/policy and exact-SHA review/approval, not an in-place reinterpretation.

Adding successful auth-update audit would require a separate reviewed Bridge code
change/deployment and might restart it, so it is outside this no-service-change scope.
Until independently attributable evidence exists, keep static digest comparison closed.

## Gate 1: exact account/path provisioning (Human privilege, no secrets)

Target only VM116, current2vCPU/2048MiB unchanged. No VM117 operations. Proposed new
principal `ai-linux-provider` and private primary group of the same name; system account,
nologin, no password, no sudo/PVE/privileged supplementary group. Proposed fixed
UID993/GID984 and the user/group name were unoccupied in the bounded read-only
preflight; all proposed roots were absent. These IDs are NOT reserved. Recheck before
Human-approved creation and stop on any collision. There is no executable approval
until these IDs and package manifest SHA are bound to the reviewed EXEC artifact.
Existing `ai-linux-dev`994:985 remains only Human editing/SSH identity.

New paths only (abort if unexpectedly present):

| Path | Owner | Mode | Boundary |
|---|---|---|---|
| `/var/lib/ai-linux-provider` | new custodian UID:GID | 0700 | private home |
| home `/state`, `/native`, `/tasks`, `/tmp` | same custodian | 0700 | trusted host-only state/session/task data, never untrusted-code execution |
| `/opt/ai-linux-provider` and `/runtime` | root:root | 0755, non-writable by nonroot | immutable reviewed release and dependency closure |
| runtime regular code/manifest files | root:root | 0644 (0755 only fixed executables) | no developer-controlled config/plugins/dependency links escaping closure |
| `/var/lib/ai-linux-results` | root:root | 0755 | no generic writes |
| results `/receipt-001` | custodian UID:985 | 02750 | root-provisioned fixed result root, dev group read only |
| results `/receipt-001/result.json` | custodian UID:985 | 0640 | sanitized fixed public result only, no DB/log/prompt/token |

The result root uses existing dev GID985 read permission, not a new supplementary-group
grant. Root provisions its setgid directory; the custodian cannot change other task
roots. Writer must create exclusive regular files, verify inherited group985/nlink1,
fsync, and secret-filter content before publishing. The helper/handoff is NOT implemented.
No generic root wrapper, systemd resident service, extra listener or port is requested.

Runtime files must be a bounded allowlist from a separately built/pinned capsule:
source/compiled task+native adapter closure, exact package.json/lock, @opencode/core/ai/
util2.0.22 + effect pinned versions, all transitive runtime payload, native Linux modules,
Node executable identity and manifest. Current VM116 checkout has fixture zod only.
Do not copy Windows node_modules or run lifecycle installs/heavy build on VM116.
Retain current fixture checkout e0d5f4ef; new root-owned release does not overwrite it,
existing staging source, Bridge or Tunnel. This document supplies no fabricated capsule SHA.

## Gate 2: trusted host wiring and Human authentication (later separate approvals)

Missing code is real work, not a merge: closed credential acquisition, supported native
Credential/Integration enrollment, authenticated task admission, separate process
proposer/reviewer composition, sanitized result handoff. Pure offline callbacks are
not authenticated native sessions or restart-safe admission. Existing opaque credential
composition/no-tools/fixed endpoint/no-refresh/no-retry APIs must be reused.

Before enrollment, root-managed code/profile must reject developer checkout configs,
ancestor discovery, hooks, plugins, tools, environment credentials and endpoint/model
selection. Retrieval uses pinned supported APIs in custodian-owned native state; no
SQLite direct edit/schema guess. Validate current expiry privately; fail closed if
unauthenticated/expired/missing/UNKNOWN. Never put credentials in task/API input.

Human authenticates *on Linux as custodian*, from separately verified management
console/session; Win11 is browser/SSH only. ai-linux-dev receives neither sudo/su rights
nor provider DB permissions. The exact Human auth entry must be pinned before approval;
ordinary generic OpenCode project launch is not an acceptable bounded worker shortcut.
Native provider database/WAL/SHM and temporary files must remain in private0700 roots
with owner-only file permissions, no token/device-code output to AI logs or receipts.
Use supported OpenCode enrollment/refresh management, not manual file edits or HQO copy.
OAuth/provider operations are specifically NOT authorized by this preparation document.

Legacy HQO root→pve5→QGA can still read or replace this state/code. Temporary Human
risk acceptance must name that risk and recovery route; no complete isolation claim.
Do not revoke the shared root key or terminate sessions as part of this proposal.

## Gate 3: estimated resource budget (not measured AI consumption)

Latest light-load sample: VM116 MemTotal1.921GiB, MemAvailable1.502GiB; current process
RSS peak97.6MiB is NOT native AI peak. pve5 reservations11GiB/total15.347GiB.

Planning envelope: **one native worker process at a time**, proposer then fully settled
close before reviewer in a distinct process/session. Tentative per-worker MemoryHigh
512MiB/MemoryMax640MiB/MemorySwapMax0, CPUQuota100%, process/task and wall-time caps
must be reviewed in the actual launcher; these are proposed upper limits, not an RSS
prediction or claim that the core fits. Estimate nominal worker RSS256–512MiB with low
confidence, dependency/database startup peak unknown. Reserve >=512MiB guest headroom
and current~429MiB base consumption. With640MiB cap, budget is1581MiB (~1.54GiB) versus
1.921GiB guestMemTotal; concurrency2 would consume2221MiB (~2.17GiB) including that headroom,
so **concurrency1 only**. No heavy full-repo test/build on VM116.

First separately approved run records process RSS/VmHWM, private DB overhead, PSI and
cgroup.memory.peak/oom events. Stop on budget exceed/pressure/OOM or unsettled exit;
do not auto increase limits, swap, retry or run reviewer while proposer settlement is
unknown. No denial/approval override using estimate metadata. Provider deadline45sec
per one-shot call; task launcher wall-time budget must account for settle/close with
no automatic retries. RSS compliance must be observed, not inferred from CLI version.

If actual serial peak needs4GiB VM116, +2GiB would reduce pve5 configured overhead to
2.347GiB (<3GiB proposed goal). Retain current specs; submit a separate configuration/
reservation-release/migration proposal supported by actual peak, at least0.653GiB
reservation relief for the3GiB goal. Documented CT107→pve1 frees2GiB only after its
own backup/performance/impact/recovery authorization. No low-RSS VM117 budget reuse.

## Stop, preservation, recovery and approval wording

Before any write: Gate0 settled and approved, independent Human privileged recovery
verified, new principal IDs/paths/SHA/capsule/runtime/launcher/profile exact and reviewed,
fresh fixed-reference PRE plus explicit mutable-state policy established.

Failure before process launch leaves new files/accounts/evidence preserved and blocks
dispatch. Failure after intent/launch/credential operation yields UNKNOWN/no replay;
record sanitized code/phase/PID and exact evidence, no secret exception bodies. Do not
delete claim/root or restore old SQLite/token state. No retry/reload/restart broadens
authority. If a new worker needs termination, target/settlement requires a reviewed
Human recovery operation; do not stop existing Bridge/Gateway/Dashboard/Tunnel.

Single request bundle must ask Human explicitly for: (A) accepted explanation and
versioned protection policy, (B) new account IDs and exact new-file capsule install,
(C) fixed auth entry and Human enrollment, (D) public-data one-turn proposal/reviewer
with resource/effect budgets. Each stage has an independent STOP gate. Currently this
is **APPROVAL_PREPARATION_INCOMPLETE**, not permission to execute stages A–D.
HQO shutdown remains Human-window-only after real Linux task/review/status succeeds.
