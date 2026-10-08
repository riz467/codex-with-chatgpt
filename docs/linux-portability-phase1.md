# Linux Migration Phase 1 — isolated source changes

## Baseline (2026-10-08)

- Original worktree: `C:/work/codex-with-chatgpt`, branch `ai-workspace`, clean.
- Source HEAD: `00672b0bb93a9225dbb197b9b07e3f3bfc7b6243`.
- Remote `ai-workspace`: `9d6878772c21b2072db4f21f4adc0ee48b9c1b43`; local ahead 93.
- Remote default `main`: `9663b88753e35c76796c5bce000293e0bd22cd9e`.
- Preservation branch: `preservation/linux-phase1-20261008` at the source HEAD.
- Implementation worktree: `C:/work/ai-linux-phase1`, branch `linux-portability-phase1`.
- Original `dist` and `.tooling/ai-workspace-execution-runtime/dist`: 286 files each,
  aggregate SHA-256 `87283b753bcc73230818a7ff9ce1e502bf20d284e3ca3c5a044f774f1bb4d251`.
  Digest is SHA-256 of sorted native-relative `path:sha256(file)` lines joined with LF.
  This preserves runtime separately from source; it does not assert runtime equals HEAD.

## Scope and placement

`src/config/deployment.ts` is release-managed configuration. Its fixed repository
aliases and executable locations are not MCP/Dashboard inputs, environment overrides,
or candidate repository configuration. Windows locations remain compatible. Linux
locations are proposed under `/srv/ai-orchestration`, with OpenCode at
`/opt/opencode/bin/opencode`. These are source defaults, not a deployment claim.
Actual directory ownership, service accounts and read/write ACLs require deployment
approval and validation in the next phase.

Review identity resolves filesystem aliases and preserves Linux case. Missing roots
establish no identity. A symlink alias of Review cannot acquire bounded finalization
rights. Fixed profile/repository mappings, scope validation and authenticated reviewer
client binding remain in use.

Linux production bounded dispatch and startup scheduling remain closed until a
credential-free Executor transport exists. Production verification also checks this
gate before reading/running candidate tools. Fixtures can exercise the existing
controller with explicitly injected local test dependencies. The ordinary Windows
production path retains its current behavior, subject to the stricter checks below.

## Changed code and why

| Files | Purpose |
|---|---|
| `src/config/deployment.ts` | Fixed placement and canonical identity comparison |
| `src/mcp/local-gateway.ts`, `src/mcp/workspace-info.ts` | Shared roots and OS-independent Review identity |
| `src/mcp/server.ts`, `src/bridge/server.ts` | Use fixed identity for recovery/finalization/startup; close Linux production execution |
| `src/mcp/bounded-process-lock.ts` | Bind new owners to hostname and OS; retain legacy/foreign locks for inspection |
| `src/mcp/bounded-task.ts` | Centralized proposer paths, explicit unsupported-Linux rejection, case-correct tool containment |
| `src/mcp/owned-process.ts` | Windows taskkill and private POSIX process-group termination |
| `src/mcp/semantic-session.ts` | Fixed executable/agent paths, private group lifecycle with bounded exit wait, and fail-closed compatibility checks |
| `tests/linux-portability.test.ts`, `tests/owned-process.test.ts` | Fixed Linux policy fixtures and process-group tests |
| `tests/bounded-worker-termination.test.ts` | taskkill failure remains a non-retryable inspection condition |
| `tests/semantic-session-transport.test.ts` | Offline transport fixture checks fixed model, pre-prompt version/auth refusal, response-model mismatch and cleanup |
| Existing lock/campaign/Review/finalization tests | New owner provenance, OS-independent identity and scratch placement instead of live Windows paths |
| `tests/verification-policy.test.ts` | Case-alias negative test works in a differently named worktree; no verification-policy relaxation |

No new dependency. Reuse: bounded campaign budgets/deadlines, lifecycle serialization,
repo reservations, sealed failed-diff recovery, immutable revision evidence,
independent review, typed commit and receipt reconciliation. No new scheduler,
retry engine, generic shell API or SDK replacement.

## Lock migration and process limits

New lock owners include hostname and platform. A foreign or legacy owner is never
reclaimed merely because its PID is absent locally. **This intentionally means old
Windows locks without provenance also require inspection**, even if their PID died.
Do not delete/rewrite them automatically. Hostname is provenance against accidental
cross-host migration, not cryptographic machine identity. State must not be shared
between hosts or PID namespaces; next-phase cutover must establish a single writer.
Unconfirmed proposer tree termination is persisted as
`PROCESS_TERMINATION_REQUIRES_INSPECTION`; the campaign stops and retains its repo
reservation. Ordinary failure recovery must not release that reservation or dispatch
another task while surviving descendants remain possible.

POSIX children owned by the semantic transport run in a private process group;
cleanup signals the group, including when the leader has exited. This does not contain
a malicious descendant that creates a new session. VM704/cgroup containment remains
a separate prerequisite, not supplied by this helper.

Do not copy Windows OAuth stores, PID locks or active ledgers to Linux. Workspace IDs
and repo-lock keys remain existing formats. Preserve historical ledgers read-only;
plan identity/history mapping, reconcile uncertain commits, and explicitly fence old
writers before adopting Linux state.

## OpenCode compatibility findings

| Component | Evidence / Phase 1 decision |
|---|---|
| Human CLI | Installed package metadata says 2.0.24; not used as proof of server compatibility |
| Human background | Not contacted/restarted; not a proposer/reviewer endpoint |
| Proposer dedicated serve, port 41739 | External PowerShell pins Windows executable and allows 2.0.18/2.0.22; 2.0.24 remains rejected |
| Semantic dedicated serve, port 41740 | Now explicitly requires reviewed versions 2.0.18/2.0.22, model/permission schema, OAuth metadata, effective agent instructions/terminal deny-all rule, location and selected response model |
| Embedded core/AI/util | Existing package/lock dependencies remain 2.0.22; no replacement |

The former semantic `2.*` gate was broader than the proposer gate. Tightening it
means a 2.0.24-only installation cannot perform semantic review with this candidate.
That is a deliberate fail-closed change, not a claim that 2.0.24 is incompatible.
Qualification of 2.0.24 needs a dedicated, credential-isolated fixture and exact
running-server schema, session/model/agent and OAuth-route evidence before updating
either allowlist.

PowerShell 7 availability alone does not prove portability: the external transport
uses a Windows executable and case-insensitive directory comparisons. Its owner-side
Git state cannot be established by bypassing dubious-ownership protection. No external
repo edit or copied provider credential is part of this change. Linux proposer fails
explicitly rather than silently using a Human background server or another agent.

Reference checked: <https://opencode.ai/v2/docs/api/>. Current public documentation
confirms the API family, not compatibility of a particular 2.0.22/2.0.24 installation.

## Validation

Final verification on Windows:

- Typecheck, worktree-only build, `git diff --check`: PASS.
- Final related regression: 10 files, 154 passed, 2 Linux-only skipped.
- Additional offline transport / verification-policy tests: 2 files, 118 passed.
- Final full regression: **101 files passed; 2665 tests passed, 6 skipped, 0 failed**.
  Duration 707.18 seconds. Source was held stable for this full run.
- Final log: `C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/linux-phase1-full-final.log`.
  Related log: `linux-phase1-regression-final.log`; transport/policy log:
  `linux-phase1-transport-policy.log` in the same directory.

An earlier full run during review fixes found the former agent rule check and an
existing test that assumed the checkout directory was named `codex-with-chatgpt`.
Both were corrected, individually rechecked, and included in the final full PASS.
Of the six skips, two are the new Linux case-sensitive filesystem / real descendant
termination fixtures; four belong to pre-existing platform-gated fixtures.

The initial independent review found three blockers: missing POSIX exit waiting before
retry, insufficient effective-agent checks, and Windows live-path-dependent tests.
All three received source/test fixes. The additional taskkill-failure finding now
surfaces an inspection error instead of claiming the whole tree was terminated.
Re-review found that OpenCode appends agent rules after defaults, and that generic
worker-failure handling could retry uncertain tree termination. The final fixes use
last-match deny-all semantics and a durable non-retryable stop with retained repo
reservation. Final independent static review: no remaining blocker; acceptable for
source integration. The independent reviewer did not execute tests or validate Linux.

Commands use installed Node entrypoints, equivalent to the package scripts:

```text
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/copy-runtime.mjs
node node_modules/vitest/vitest.mjs run --maxWorkers=2
```

Dependencies were made available by a worktree-local `node_modules` junction to the
existing installation. pnpm's automatic dependency check refused the external target;
the safety check was not disabled and no install was forced. No dependency change.
An initial 120-second aggregate test command timed out; only completed test results
count as evidence. The full run uses a separate log and sufficient execution time.

No Linux execution PASS: WSL is not installed and Docker is unavailable. Synthetic
Linux policy/process-signal tests on Windows do not establish Linux runtime behavior.
No provider session, live authenticated MCP E2E, Windows-stop test, VM/CT operation,
runtime promotion, service restart or push is part of validation.

## Next phase / Human approval

1. Approve source baseline and deployment plan; keep VM111 preserved, VM117 unknown,
   CT703 reserved, and VM704 as KVM (not the withdrawn LXC design).
2. Obtain owner-side config repo status and approved isolated Linux test access.
3. Port/qualify the existing PowerShell transport, or replace only its nonportable
   portion; qualify exact OpenCode versions without using Human authentication.
4. Connect fixed candidate verification to credential-free VM704, including cgroup
   resource evidence and process cleanup, before opening production dispatch.
5. Port remaining legacy `autonomous-gateway.ts`, `completion-adapter.ts`,
   `read-only-worker.ts`, fixture profile paths, and Windows-only Gateway/Dashboard
   launchers as required by the approved service scope. Preserve recovery behavior.
6. Deploy nonprivileged VM116 services, authenticate through separately approved
   provisioning, and validate CT700/701/702 boundaries. VM116 receives no PVE root,
   Human approval, signature or finalizer authority; VM704 receives no provider OAuth,
   GitHub, PVE, approval or signing credentials.
7. Run Linux E2E, unknown-lock/uncertain-commit and duplicate-dispatch fixtures, then
   Windows-off continuity testing. Only a subsequent Human-approved cutover permits
   retirement of the temporary Windows services. Stage 1 PASS is not Production PASS.

## Rollback

Before adoption, keep using the untouched original worktree/runtime; this branch has
no runtime effect. Preserve or abandon this worktree as a source candidate. After a
future source-only cherry-pick, revert its recorded implementation commit(s) on the
destination branch without reset/force. Deployment rollback is a separate approved
procedure: never roll binaries back while discarding new lock provenance, concurrent
writers or uncertain commit receipts. Retain all evidence until reconciliation.
