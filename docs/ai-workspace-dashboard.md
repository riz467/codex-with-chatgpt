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

## Japanese UI and future event display

The browser UI prioritizes Japanese labels. Internal state, mode, actor, pipeline values and API responses remain in English; the browser's `labels.js` maps display text without rewriting evidence. Unknown values remain visible rather than being dropped. The top status bar uses only the snapshot's current task and confirmed actor (otherwise it says a task is running without naming an actor). The Dashboard remains **read-only**.

Currently the screen uses a snapshot delivered over SSE, with server-side filesystem watching and polling fallback. Rendering is split by screen section so that a future, separately specified Orchestrator-to-Dashboard direct real-time event stream can update individual sections. This change does not introduce new event types or change SSE, polling, the collector, or task state.

## v0.2 verified health (read-only)

`/api/status` retains existing health fields and adds `health.verified_health` with bounded `status`, `summary`, optional PID/SessionId and heartbeat observation time. The browser displays these fields in System Health; existing snapshot SSE and polling carry updates without a new event type. `verified` means the fixed service identity or process/session evidence was checked; `ready` for the Codex worker additionally requires a fresh heartbeat, matching process/PID, pinned executable/command, expected user SID, a valid running InteractiveToken task configuration, and a matching nonzero active **or disconnected** interactive session. A fresh heartbeat or a PID by itself is never readiness. The dashboard task is checked against its pinned task configuration, loopback listener and process identity without recursively calling `/api/status`.

Bridge health requires HTTP 200, the expected `c2c-bridge` service identity and an `ok` status from fixed loopback ports. Tunnel verification requires the fixed executable and tunnel command/config; if Windows redacts process details, a single named process is shown only as `degraded` (partially unconfirmed), never verified. `unknown` means evidence is missing, contradictory or inaccessible, not necessarily that the service is stopped. No command lines, SIDs, credentials, raw logs or tokens are returned. The Dashboard remains **read-only** and never starts, stops or configures processes or tasks.

## API and SSE

All routes are GET only: `/health` (fixed minimal identity), `/api/status` (snapshot), `/api/tasks` (recent list), `/api/tasks/:taskId` (single allowlisted task), `/api/events/:taskId` (sanitized audit and state transitions), `/events` (SSE `snapshot` with snapshot plus sanitized events; `unavailable` on read failure). Non-GET methods return 405. Invalid IDs return 400, missing IDs 404, duplicate IDs across allowlisted repos 409. No caller-supplied repo or filesystem path is accepted. `event: snapshot` is emitted on changes; clients should reconnect using EventSource. `unavailable` does not carry error details.

## Security limits

Only pinned repo/Review/worker roots are read; path validation rejects traversal and link/reparse-point components. Secret-like edit paths are omitted. Responses use explicit field projection rather than serializing evidence. Events allowlist audit action names, expose only normalized actor and fixed summaries, and discard malformed lines. HTML uses DOM `textContent` rather than task-controlled HTML. CSP restricts resources to same-origin. Bind is fixed at `127.0.0.1`; v0.1 has **no authentication**, so do not expose it to LAN or public internet. The runtime account must already have appropriate read access to the evidence.

## Not in v0.1 / v0.2 ideas

No control plane, Cloudflare route, token analytics, Git mutation or arbitrary command interface. A future, separately approved control plane would require independent authentication, authorization, CSRF protection, audit trail and explicit human gates; never enable actions by simply adding buttons to this read-only process. v0.2 observation improvements: verified worker-process/session and tunnel health via constrained OS diagnostics, validated review-bundle summary, more precise audit event taxonomy, pagination, and consistency markers for evidence in mid-write.
# Autonomous projection

The existing `/events` SSE snapshot also carries `autonomous_runs` from the fixed Review workspace's run ledgers. The projection is read-only: phase, bounded decision, actor, structural/semantic verdict, human-action flag and numeric OpenCode/Codex-invocation/Review usage. Review worker progress distinguishes structural from semantic review while active; missing events or progress remain unknown and never imply DONE. Only the existing engine task ledger can establish DONE. This does not grant the Dashboard execution or approval authority. Production Dashboard is not restarted by local fixture tests.

## Final approval fixture and production hold

The screen includes a conditional final-approval section displaying the exact goal, task/run/Review IDs, evidence SHA-256, bundle manifest SHA-256 and canonical goal SHA-256. A click plus confirmation sends only `FINAL_DONE_APPROVAL` to the separate `/approval/final` endpoint; it does not invoke Complete or write the ledger. The endpoint checks loopback, Origin, Fetch Metadata, an in-memory short-lived one-time session/CSRF token, and the current authoritative PASS before storing an audit record and a single-use current approval in the fixed Review `rpc-jobs/human-approvals` area. The MCP Complete path checks and consumes that record. These routes return `APPROVAL_NOT_CONFIGURED` by default in the production Dashboard; fixture instances opt in explicitly for integration tests.

**This is not yet human provenance for production.** Same-user agents with local HTTP or filesystem access can reproduce a click's requests or forge evidence; `isTrusted`/CSRF/loopback do not distinguish a human from that process. Production enablement requires a separate OS principal and protected evidence storage or independent trusted authentication inaccessible to the AI process, then forgery tests. Do not restart or expose the production Dashboard on the assumption that the button alone meets this requirement. All other monitoring API/SSE routes remain read-only.
