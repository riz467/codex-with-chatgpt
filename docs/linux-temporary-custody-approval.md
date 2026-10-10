# HQO-independent Linux development — Human gates, not authorization

Human chose **consider temporary development risk**, not approval to provision a user,
place credentials, start OpenCode, call a provider, or change VM resources.
Production CLOSED / authority NONE; formal Qualification LIVE_BLOCKED unchanged.

## Proposed minimal privileged change (separate exact approval needed)

Target only VM116. Preserve ai-linux-dev994:985 and existing four services/source/state.
No VM117 arbitrary executor, additional listener, resident service, sudo grant, root-key
copy/revocation, shared HumanAdmin deployment or guest CPU/RAM/disk change.

1. Human management creates a distinct nonprivileged `ai-linux-provider` system user
   and private primary group, supplementary groups empty, shell nologin, no password.
   Allocate an unused UID/GID and record exact values before approval; never assume a
   UID, reuse an existing account, or change UID994. Abort on name/path collision.
2. New home `/var/lib/ai-linux-provider`0700 owned by that custodian. No credential
   file should be manually synthesized: OpenCode V2 keeps saved credentials in its
   SQLite database, not a new auth.json. The earlier host-oauth.json metadata path
   is a proposed envelope diagnostic, not an implemented enrollment source.
3. New `/opt/ai-linux-provider/runtime` tree is root-owned, non-group/world-writable,
   with manifest-pinned source, compiled code, package lock and full runtime dependency
   closure. Neither developer nor credential UID may edit it. Provision from a newly
   reviewed exact commit/build manifest, not this mutable developer checkout.
   The installed CLI binary alone is NOT the embedded core dependency closure.
4. New task/evidence directories distinguish custodian-private native runtime state
   from public sanitized results. Do not chmod/copy the SQLite database for developers.
   Define the bounded result handoff independently; ai-linux-dev cannot read private
   native session DB/logs just because it needs a task result.
5. Human-authentication entry uses independently controlled Human management console,
   switching only to the custodian user for the pinned authentication program. Do NOT
   add sudo to ai-linux-dev, broad su wrappers, AI tools or arbitrary config/plugin
   loading. No authentication entry is deployed by this change.
6. A pinned host enrollment adapter must retrieve only the active current OAuth
   connection through supported pinned OpenCode Credential/Integration APIs in the
   custodian context, yielding the existing opaque HostOAuthHandle privately.
   Native SQLite shape/version must not be guessed or manually edited. No access,
   refresh, accountID or authorization URL/code enters public receipts/console logs.
   Existing acquireProposalOAuthCredential() remains closed until this separate
   adapter and its host enforcement are implemented/reviewed/approved.

Before EXEC: approve exact account/path ownership, source/build/dependency SHAs,
new-file allowlist, fresh protective PRE, resource stop limits, fixed authentication
entry and recovery route. This document contains no EXEC script and no enabling flag.
Credential/provider gates are not unlocked by the metadata diagnostic or task API.

## Explicit residual risks requiring Human acceptance

- HQO shared root SSH→pve5→QGA can read/replace guest credentials/runtime despite0700.
  This proposal does not prevent that. Other-node transit and existing privileged
  sessions are also not settled. It is **not complete credential isolation**.
- Separate UID/private permissions isolate ordinary developer files only after actual
  host policy verifies groups/ACL/capabilities/ptrace and process ownership. They do
  not prove generic-agent or untrusted-executor isolation.
- Dev task library supplied with trusted callbacks assumes a trusted host caller.
  Structural/in-process injection is not an OS admission boundary or a provider permit.
- VM117 remains unqualified for arbitrary candidate execution. DATA-only materialization
  is the current safe seam. No generated scripts/tests/build hooks run automatically.
- Provider cost/network egress and OAuth enrollment/refresh are external effects. Human
  authorization for provisioning does not authorize model prompts or hidden retries.

If accepted temporarily, label each result DEVELOPMENT_WITH_LEGACY_ROOT_RESIDUAL_RISK,
never Production or formal Qualification. Human must define permitted public task
data, provider/model, one-turn budget/timeouts and no-replay handling separately.

## Human authentication and first real task — separate later gates

1. Independent Human management recovery must be usable before provisioning. Win11
   direct development SSH PASS proves only nonprivileged entry, not root recovery.
2. Human logs into OpenCode from Linux under the dedicated custodian with Win11 browser
   only. Never send OAuth values, device codes or private DB to HQO/chat/Git.
   Confirm pinned version/profile and no discovered project/ancestor/plugin code first.
   No casual generic `opencode run` as a compatibility test; ordinary V2 defaults
   retry timed-out requests. Existing host transport remains one-shot/no tools.
3. Tools-disabled, public-data-only provider proposal is bounded to one call, with a
   durable host intent before send. Native semantic reviewer uses a separate native
   session/process with separately bound context/evidence. Timeout/UNKNOWN stops,
   no replay, resume or background retry.
4. Persist sanitized result and hashes in Linux DevelopmentStore. Reopen status from
   another Linux process and from Win11 direct SSH. A passing fake/offline callback
   result is not a native-session/provider E2E result.
5. Only then design/approve a code execution boundary (not VM117 by assumption), and
   a Human HQO-stop/recovery window. Do not turn off HQO from an AI tool.

## Resource decision, based on read-only observation

2026-10-10 UTC / 2026-10-11 JST, three samples over about10seconds:

| Target | logical CPU / configured RAM | busy CPU | MemAvailable | swap used | root FS free |
|---|---|---:|---:|---:|---:|
| VM116 | 2 / 2GiB | 0.25% | 1.502GiB | 0 | 24.711GiB |
| VM117 | 2 / 4GiB | 0.10% | 3.440GiB | 0 | 26.214GiB |
| pve5 | 8 / guest reservations11GiB | 1.508% | 6.226GiB | 29.12MiB | 49.950GiB |
| pve1 | 8 / guest reservations4.75GiB | 2.800% | 12.353GiB | 40.13MiB | 47.090GiB |
| pve2 | 8 / guest reservations3.25GiB | 1.599% | 12.397GiB | 0 | 42.359GiB |

Current VM116 top observed process RSS92.2MiB, observed VmHWM97.6MiB. Those are NOT
OpenCode/proposer/reviewer task peaks. Parallel AI load, longer-term p95/p99, OOM margin
and thermal/storage latency under work remain NOT_RUN/UNKNOWN. CPU/memory/io PSI and
diskstats rates are saved in the external resource evidence; no disk benchmark writes.

No increase is justified solely by this light-load sample. Start future bounded proposal
and review serially after auth gates; sample per-process RSS/PSI/cgroup.memory.peak with
explicit limits before approving concurrency. No heavy all-repo test on the Control Plane.

Planning constraint: pve5 total15.347GiB minus current configured reservations11GiB
leaves4.347GiB for host/QEMU/cache/backup overhead. Adding2GiB to VM116 would reduce
it to2.347GiB, below pve-doc's proposed3GiB target. If actual measured peak requires
4GiB VM116, do NOT simply resize: evaluate freeing >=0.653GiB reservations or another
placement first; existing guests have service/recovery and separate migration gates.
The documented CT107→pve1 candidate frees2GiB but requires its own performance,
backup/recovery and interruption approval. VM117's low RSS is not free4GiB budget.
pve3 stays Win11 Human-only; pve4 is not an opportunistic target. No migration proposed
as already approved and no resource/config change was performed.
