# AI Workspace Dashboard v0.1

## Purpose and boundary

Local, read-only view of the existing orchestration evidence. It is **not** an orchestrator. It neither persists task state nor creates a dashboard database. It cannot create, retry, approve, stop, complete or review tasks, execute commands, or perform Git operations.

## Start

Manual foreground development: from this repository run `corepack pnpm build`, then `corepack pnpm dashboard` (or `corepack pnpm dashboard:dev`). Manual production-style launch, without pnpm: run `& 'C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node.exe' 'C:\work\codex-with-chatgpt\scripts\run-ai-workspace-dashboard.mjs'` as `workspace` with **no additional arguments**. Stop that foreground process with Ctrl+C. Do not run it alongside the Scheduled Task. Visit **http://127.0.0.1:48766/** on the Windows Server 2022 host. The port differs from the Bridge ports 48765 and 54108. Loopback only: do not publish through Cloudflare or a LAN reverse proxy; this version has no authentication. On a remote workstation use an operator-managed local-only transport rather than exposing the HTTP listener.

## Optional independent Scheduled Task (not installed by this change)

On the target VM, after `corepack pnpm build`, run **elevated as the `workspace` account**:

```powershell
& 'C:\work\codex-with-chatgpt\scripts\install-ai-workspace-dashboard.ps1'
& 'C:\work\codex-with-chatgpt\scripts\start-ai-workspace-dashboard.ps1'
& 'C:\work\codex-with-chatgpt\scripts\status-ai-workspace-dashboard.ps1'
& 'C:\work\codex-with-chatgpt\scripts\stop-ai-workspace-dashboard.ps1'  # only when intentionally stopping Dashboard
```

Install registers **only** `AI-Workspace-Dashboard`: `AtStartup`, `workspace`/S4U, Highest, hidden, IgnoreNew, three 1-minute restart attempts, no execution time limit, no network dependency and no battery stop. It does **not** start the task. If an existing same-name task differs, it refuses to replace or operate it. Start waits for readiness and fails closed; stop requests termination only for the verified Dashboard task. Status prints task state, fixed-action check, correlated process/listener PID, HTTP codes for `/health` and `/api/status`, and readiness; it never prints API response bodies or command lines. After a reboot, verify recovery with `status-ai-workspace-dashboard.ps1` and check **GET http://127.0.0.1:48766/health** returns `{"ok":true,"service":"ai-workspace-dashboard"}`. Task Scheduler restarts the process on failure within its configured retry limit; check the task history if it fails repeatedly. S4U read access to the allowlisted evidence must be validated on the target account before relying on the service.

The pinned launcher directly runs built Node runtime, forces the fixed repo working directory and rejects extra arguments. Neither installation nor any lifecycle script edits the Gateway, Review Bridge, Codex Worker task, AutoLogon, Cloudflare or firewall. No credentials are stored in scripts or logs. A process on port 48766 is **not** considered this Dashboard unless the fixed Scheduled Task action, process executable/command line, loopback listener PID and health identity all match.

## Data sources and screen

The fixed `pve-doc` and `ai-orchestration-config` `.ai/tasks/<id>/status.json` ledgers, their state transitions, optional `audit/coordinator-actions.jsonl`, completion decision/integration evidence, the existing Review Bridge `rpc-jobs` registry, worker heartbeat and queue, and the two local Bridge `/health` probes are used. The existing Gateway path/ledger lookup, status/result and stop-reason normalization are reused where available. No source is modified. A watcher triggers prompt refresh and a three-second poll covers missed Windows watcher events. No raw task goals, commands, diffs, audit targets/results, logs, tokens or file bodies are exposed. The review bundle shown is a **pointer**, not a content inspection or integrity guarantee.

One page shows **System Health**, **Current Task**, **Latest Task** (historical), **Pipeline** (Research / Scope / Plan / Execute / Verify / Review / Done), **Live Events** and the 20 most recent unambiguous **Recent Tasks**. Current Task requires an existing running registered job (excluding stopped ledger states); next priority is a correlated claimed queue request with a matching claim hash, no result, a fresh heartbeat, and ledger state `EXECUTING`. Otherwise it says **No active task**. `NEEDS_APPROVAL`, `READY_FOR_REVIEW`, `DONE`, and `BLOCKED` never appear as Current Task. Pipeline and events explicitly identify whether they refer to the current task or the latest historical task. Review is `waiting` only at `READY_FOR_REVIEW`; approval for insufficient evidence instead marks unfinished verification `incomplete` and review `not_started`. Pipeline is derived on demand, not stored.

Missing evidence stays `unknown`/null. Worker status stays `unknown` because `heartbeat_fresh` is **not** proof of a matching process, configured Scheduled Task or interactive logon. PID and SessionId from a heartbeat are labeled **Last known**, not current; the last heartbeat age and task elapsed time are formatted as durations. Tunnel and interactive session are `unknown` without independent verification. Execution and Review Bridge health uses local HTTP only.

## API and SSE

All routes are GET only: `/health` (fixed minimal identity), `/api/status` (snapshot), `/api/tasks` (recent list), `/api/tasks/:taskId` (single allowlisted task), `/api/events/:taskId` (sanitized audit and state transitions), `/events` (SSE `snapshot` with snapshot plus sanitized events; `unavailable` on read failure). Non-GET methods return 405. Invalid IDs return 400, missing IDs 404, duplicate IDs across allowlisted repos 409. No caller-supplied repo or filesystem path is accepted. `event: snapshot` is emitted on changes; clients should reconnect using EventSource. `unavailable` does not carry error details.

## Security limits

Only pinned repo/Review/worker roots are read; path validation rejects traversal and link/reparse-point components. Secret-like edit paths are omitted. Responses use explicit field projection rather than serializing evidence. Events allowlist audit action names, expose only normalized actor and fixed summaries, and discard malformed lines. HTML uses DOM `textContent` rather than task-controlled HTML. CSP restricts resources to same-origin. Bind is fixed at `127.0.0.1`; v0.1 has **no authentication**, so do not expose it to LAN or public internet. The runtime account must already have appropriate read access to the evidence.

## Not in v0.1 / v0.2 ideas

No control plane, Cloudflare route, token analytics, Git mutation or arbitrary command interface. A future, separately approved control plane would require independent authentication, authorization, CSRF protection, audit trail and explicit human gates; never enable actions by simply adding buttons to this read-only process. v0.2 observation improvements: verified worker-process/session and tunnel health via constrained OS diagnostics, validated review-bundle summary, more precise audit event taxonomy, pagination, and consistency markers for evidence in mid-write.
