# Offline observability correction — no live authorization

This document records the observability-only release. The subsequent fresh-input correction
and deliberately blocked external-fencing gate are specified in linux-qualification-retest-boundary.md.
Statements below about unchanged input roots describe that earlier release, not the new retest inputs.

Historical Custody v2 installation outcome and original process settlement remain UNKNOWN.
This correction is not a cause-specific fix or evidence of successful qualification.
Production Dispatch stays CLOSED; authority NONE; Linux13, isolation and autonomous E2E stay NOT_RUN.

## Evidence contract

Exclusive per-operation journals use bounded, sanitized BEGIN/SUCCESS/FAIL/UNKNOWN/STATUS events,
fixed fields, process/parent/guest PID where acquired, exit/signal/timeout/disconnection classes,
output lengths and hashes (not bodies), file fsync and POSIX directory/parent fsync.
First failure is retained independently of rollback and append-only protection observations.
Guest evidence failures fence host execution; persistence failure prevents subsequent actions.
There is no automatic process kill or replay. Timeout does not prove settlement; wrapper exit
does not settle its children. Malformed guest failure receipts preserve uncertainty.
Crash before PID capture can leave BEGIN only; absence of a failure event is never success.
Windows directory durability differs from POSIX; no power-loss guarantee is claimed.

## Minimal residual-state gate — design only, not executed

1. Obtain separate Human authorization for read-only pve5/VM116/VM117 state observations,
   defining exact query scope, evidence destination, limits and stop conditions. Existing-log
   authorization and all old package authorizations are closed and cannot be reused.
2. Correlate retained claim/receipt identifiers and operation time with current host process
   identity (PID, boot ID, start time, parent, executable), descendants and relevant cgroups.
   A process name or recycled PID alone is insufficient. Do not expose argv/environment/credentials.
3. Observe both guests' existing process trees/cgroups and qualification units/spools without
   installing scripts, sending guest-exec workloads, restarting services or touching claims.
   The permitted read-only access mechanism must be explicitly approved; if unavailable, stop UNKNOWN.
4. Compare old/v2 claim, key and input metadata/hashes and protected service baselines with
   retained evidence. Never modify, unlock, repair, delete, reuse or print secret material.
5. Repeat the bounded relevant-state observation at the eventual new attempt's PRE boundary
   and enforce exclusive overlap prevention across old/new regions. A fresh pathname alone is
   not concurrency control. Any active/unattributable process, unit, work item, changing state,
   missing evidence or failed query blocks dispatch and requires Human decision.

Past termination can remain UNKNOWN even when no present overlapping execution is observed.
Human must review the observation coverage and residual uncertainty, explicitly accept any
remaining bounded risk, and separately authorize a newly reviewed exclusive attempt.
If absence of overlapping execution cannot be established sufficiently, remain blocked;
cleanup/kill is never implicit permission. No current-state observation can retroactively
convert historical rollback UNKNOWN to success.

## Next exact-SHA authorization scope

This artifact is NOT_READY_FOR_LIVE_REPLAY. Custody v2 roots and old fences are deliberately
unchanged; executing this package against retained state is prohibited. Before a future attempt,
approve and independently review any separate fresh-region/exclusivity preparation, preserve all
old custody, and build new exact commit/package pins if code changes. Require independent approval
and signing gates, residual-state Human decision, fresh both-target PRE, bounded install,
complete isolation probe, fixed13 at most once, signed evidence review and both POST/bounded
rollback scope. No permission extends to production, unrelated services, credentials, VM/network
changes, automatic retries or autonomous E2E claims. This document grants none of those actions.
