# Retest boundary — OFFLINE_PREPARED / LIVE_BLOCKED

This is an offline-only custody separation and conservative EXEC refusal, not live permission.
Historical execution and process settlement remain UNKNOWN. Production CLOSED / authority NONE.
No new Phase, lock protocol, dispatch feature, signing authority or live fencing verifier is added.

## Path and collision matrix

| Item | Retained release | Retained Custody v2 | Fresh retest |
| --- | --- | --- | --- |
| pve5 public inputs/receipts/host claim | `/var/tmp/ai-linux-qualification-release` | `/var/tmp/ai-linux-qualification-custody-v2-release` | `/var/tmp/ai-linux-qualification-retest-20261010-release` |
| guest public inputs/PRE/CREATED/events | `/var/lib/ai-linux-qualification-approved-input` | `/var/lib/ai-linux-qualification-custody-v2-input` | `/var/lib/ai-linux-qualification-retest-20261010-input` |
| host private campaign keys | respective host root `/private-campaign-keys` | same suffix in v2 root | same suffix in fresh root, no key reuse |
| HQO package/evidence | existing release directories | `release-custody-v2` | separately generated `release-retest-boundary-20261010`; exclusive operation journal |

New host and guest input roots remain root0700; public inputs/claims/receipts root0600.
Exclusive mkdir/O_EXCL, O_NOFOLLOW, owner/mode/nlink/inode/size/SHA checks remain.
Equal/ancestor/descendant prior input paths are rejected. Old public runtime donation remains
read-only, digest-verified, copied to distinct files, never private keys. Both old host regions
are pinned and tree-hashed; both old guest input regions are retained in protected baseline.
No prior file is repaired, overwritten, chmodded, unlocked or deleted.

**Shared workload targets intentionally remain unchanged, not falsely declared disjoint:**
VM117 account ai-qualification-executor, evidence group, `/opt/ai-linux-qualification`,
`/var/lib/ai-linux-qualification-executor`, `/etc/ai-linux-qualification-broker`,
`/var/lib/ai-linux-qualification-broker` (claims/requests/results), broker and executor@ units;
VM116 account ai-qualification-controller, `/opt/ai-linux-qualification-controller`,
`/var/lib/ai-linux-qualification-controller` (task/ledger/results),
`/etc/ai-linux-qualification-controller`, controller unit. They are absent-target installation
gates, not shared lifetime exclusion. Renaming accounts/runtime/units/protocol would be unnecessary
scope expansion and would not fence an old root/QGA process. They stay blocked pending external
fencing and a separate reviewed enabling change.

## Old execution entry points and guarantee limits

| Entry | Existing behavior | What it does NOT guarantee |
| --- | --- | --- |
| HQO run-approved.py, shell/OpenCode launches, SSH children | local exclusive journal/PRE, SHA pin, explicit approval | old already-running SSH/adapter can resume; arbitrary root transport not disabled |
| pve-operation.py over SSH streamed modules/runpy | per-root durable O_EXCL host claim | old in-memory code/child after its claim is not stopped by new claim |
| pve5 Qga.python/guest-exec | PID/status and timeout/UNKNOWN, no replay | guest child can outlive wrapper or SSH; QGA socket/root authority still reachable |
| guest deploy.py EXEC and subprocesses | per-input CREATED O_EXCL, fixed absent targets, baseline/resource gates | fresh input claim does not block old installer; list-units and absent paths are snapshots |
| controller CLI/service run, submit, dispatch | durable ledger dispatch intent; recovery collects rather than redispatching intent | distinct tasks/regions, previously QUEUED work and paused process are not globally excluded |
| broker / executor requests | exclusive per-task request/claim and fixed authenticated execution | old broker credentials, requests or an unobserved executor job may still act |
| systemd units/cgroups/pending jobs | qualification templates Restart=no, not enabled; process-tree KillMode | current drop-ins, transient jobs, timers, queued starts, external schedulers or process launchers not checked |

References: scripts/linux-qualification/{run-approved.py,pve-operation.py,deploy.py,*.service};
src/linux-qualification/{run.ts,controller.ts,broker.ts,worker.ts,cli.ts,broker-protocol.ts}.
No claim is made about OpenCode auto-resume, HQO scheduled tasks or live systemd configuration;
they are external launch sources requiring explicit identification. A fresh lock ignored by old
code is not fencing. Human approval or a JSON statement of process absence is not fencing either.

## Implemented denial boundary

evidence.require_external_fence() always raises sanitized UNKNOWN/settled=false. No flag,
environment variable, receipt file, Human reference or new lock can turn it into PASS.
It guards HQO EXEC before remote PRE/transfer, direct host main before access/claim/key generation,
host preparation before mkdir, guest EXEC before package/claim/account actions, and fixed-unit
start before dispatch. HQO journals preserve external-fence as first unknown step; direct host
failure output is sanitized. Pure custody and control-flow helpers remain offline testable.
Read-only PRE is not authorization to EXEC. Lower-level upload primitives are not an independently
authorized execution interface. Root could alter code; this refusal is not a sandbox for root.

Existing code has no trusted technical observer/control mechanism capable of proving all old
root/QGA launch sources disabled and descendants settled. Therefore live enabling is deliberately
NOT implemented. Technical prevention of old re-entry must precede any new EXEC gate implementation.

## Minimum future Human-approved external fencing procedure — design only

Do not execute any step with this offline authorization. Do not guess PID or stop unrelated service.
The operations below require a new, bounded authorization with exact identified targets and effects.

1. Freeze new qualification submissions at each identified HQO orchestration/scheduler entry;
   administratively prevent its old adapter/SSH launches and resumptions. Scope only qualification
   sessions/jobs, not global OpenCode or Windows runtime. Inventory any other principal with old
   execution authority. A session being idle is not an enforced launch prohibition.
2. On pve5, identify original qualification host executions/SSH descendants by boot ID, PID,
   start ticks, parent and executable/cgroup, correlated with retained operation timestamps and
   hashes. On guests identify QGA-launched wrappers, descendants, relevant cgroups and unit jobs.
   No argv/environment/secret bodies in evidence. If an identity cannot be uniquely established,
   do not kill a plausible Python PID: remain LIVE_BLOCKED.
3. Separately authorize stopping only positively identified old qualification execution trees
   (HQO transport, pve5 adapter, guest wrappers/children), with identity recheck to prevent PID reuse.
   Kill/stop is not performed here. Confirm descendants and pending QGA operations are settled,
   not just the wrapper. Preserve claims, keys, inputs and evidence in place. No cleanup/replay.
4. Separately authorize prevention of only old qualification unit/job restart sources: if present,
   exact broker/controller/executor-instance jobs and their launchers, including timers/recovery
   paths. Do not blindly mask all units: new units use the same names. Prevent old launch sources
   while retaining the ability to run a later exact-SHA controlled invocation. Restart=no in the
   template is insufficient; verify effective live properties and queued jobs. If a launcher or
   principal cannot be exclusively constrained without altering protected existing services or
   shared SSH/QGA/ACL authority, remain blocked and request that explicit narrow design/approval;
   do not introduce broad ACL/network/credential changes as an implicit fallback.
5. Hold technical prevention continuously across read-only checks, new PRE and bounded execution.
   Identify the enforcing component, target principal/entry, prohibited old action, validity scope
   and revocation behavior. It must act on old code too. A signed Human statement without that
   mechanism cannot satisfy it. Shared root/QGA authority and unaccounted launch sources leave
   this step unresolved in the present implementation.
6. Save sanitized independently reviewed control/settlement evidence. A later enabling code change
   must verify enforceable current fencing and fail closed on loss/expiry/UNKNOWN, with new tests,
   review and package SHA. Removing the unconditional guard is not an authorized local toggle.

## Finite read-only verification plan — no commands executed here

Fix and review exact query content before access. Use existing management route, identify pve5
and VM116/117 hostname/name against placement records. Proposed bounded observations:

- HQO: qualification launch sessions/scheduled tasks and identified transport process trees;
  executable/PID/parent/start and control status, excluding command lines and environment.
- pve5/guests: boot ID, bounded /proc PID metadata, start ticks, parent, executable and cgroup;
  relevant unit Load/Active/SubState, MainPID/ControlPID, Restart/NRestarts,
  pending list-jobs entries and relevant cgroup membership; no process action.
- Old host/guest paths: lstat owner/mode/inode/nlink/size and bounded SHA inventories,
  fixed claim/ledger/spool status parsed into approved fields only, never credential payloads.
- Both protected baselines using existing readonly snapshot methods; compare with retained
  evidence, independently classify change vs known uncertainty, never overwrite prior evidence.
- If minimal QGA guest-exec is approved, only fixed read-only enumeration code, python -I -B,
  bounded timeout/output; no installer import execution, uploads, account/unit creation or probes.

One bounded collection plus a PRE-boundary recheck under continuous fencing, not indefinite
historical log追跡. Incomplete process attribution, queued/runnable old work, missing coverage,
changing baseline, lost fencing or query timeout stops UNKNOWN. Current absence alone cannot
prove historical termination or prevent later re-entry. Historical UNKNOWN stays unchanged.

## Approval and remaining blockers

This source/package is OFFLINE_PREPARED, LIVE_BLOCKED. No live fencing has been applied or verified.
Further approvals are distinct: fixed read-only queries; precisely identified old-process stop
and restart/submission prevention (if needed); separately reviewed live fence verifier; then new
exact commit/package Human approval for PRE→limited EXEC→full isolation probe→fixed13 once→signed
results/review→both POST/bounded rollback. Independent signing gates remain mandatory.
Old package/approval is never reused. Qualification success is not Linux autonomous AI E2E proof.
