# Autonomy bootstrap execution record — 2026-10-08

This is a development record, not authoritative DONE. No runtime promotion yet.

## Preflight

- Branch `ai-workspace`, initial HEAD `9fea456a102cb3356af24ce9cf84917f66975f12`, clean, ahead 79.
- Only one main-repository worktree. Gateway 48765 and Dashboard 48766 healthy.
- Gateway runs `.tooling/ai-workspace-execution-runtime`; Dashboard/review use root `dist`.
- Existing bounded ledgers have no RUNNING/REVIEW_PENDING tasks or execution/review locks.
- Configuration repository has pre-existing edits in `autonomous-opencode-session.ps1` and
  `bounded-opencode-proposal.ps1`; preserved.

## Recovery guard hardening

- Files: `src/mcp/bounded-task.ts`, `src/mcp/server.ts`, `tests/bounded-task.test.ts`,
  `tests/mcp-integration.test.ts`.
- Commit: the commit containing this section (resolve with `git log -- docs/autonomy-bootstrap-20261008.md`).
- Added repository reservation around MCP recovery; blocks other task starts and nested recovery.
- Exhaustion proof rejects staged/out-of-scope changes and corrupt baseline hashes.
- Recovery validates baseline hashes before restore and rechecks exhaustion proof immediately before restore.
- Checks: typecheck PASS; bounded-task + MCP integration 90 tests PASS; added reservation/failure test PASS.
- Review: developer inspection complete; independent review not yet obtained.
- Runtime: not promoted.
- Remaining: sealed evidence for verification-failure recovery, durable campaign/restart orchestration,
  reviewer reference evidence, real Dashboard A–D execution.

## Sealed reviewer reference evidence

- Previous recovery commit: `e07d905`.
- Files: bounded task/server, new bounded-reference-evidence / bounded-semantic-review /
  bounded-process-lock modules, bridge test injection, associated tests.
- Commit: the commit containing this section.
- Baseline source/tests are sealed into the revision manifest with file path, commit SHA,
  whole-file/content SHA-256 and explicit line ranges. Read scope and byte budgets are controller-owned.
- Evidence insufficiency reacquires a larger sealed excerpt at most twice per revision;
  attempt claims/results survive restart. No evidence failure can authorize a commit.
- Lifecycle gets a cross-process owner lock and can enter at pending review / accepted finalization.
- Checks: typecheck PASS; reference + authenticated review + MCP integration 72 tests PASS;
  bounded-task 29 tests PASS in the preceding combined run.
- Fixed an outdated manual-continue test: authenticated NEEDS_WORK already starts continuation automatically.
- Review: developer inspection; independent review still pending. Runtime not promoted.
- Remaining: durable campaign scheduling/finite handoff, interrupted execution, live A–D scenarios.

## Durable campaigns and recovery/commit completion

- Previous evidence commit: `4bf0cf7`. Commit for this stage: the commit containing this section.
- Files: new `bounded-campaign.ts`, `bounded-workspace-recovery.ts`; task/server/semantic review/
  typed-actions; Dashboard server/collector/app; corresponding regression tests and opt-in live/review scripts.
- Campaigns persist creation/handoff intents, retain the original contract and review feedback,
  use at most 3 tasks × 3 revisions / 45 minutes, and stop on a second identical failure.
- Applied-but-unverified diffs are sealed before verification. Later edits invalidate recovery proof.
  Recovery stores before-bytes and undoes partial restores only where baseline bytes still match.
- Extracted recovery out of server.ts to preserve the 64 KiB bound.
- Fixed two live discoveries: allowed scope does not require changing every file; local commit
  is never authoritative DONE in Dashboard. Exact staged commit recovery requires a prior controller intent.
- Added process-wide lifecycle fencing and durable semantic-result reuse. Unknown execution locks
  are preserved and reported for inspection, not stolen or blindly replayed.
- Checks: typecheck PASS; targeted six-suite rerun 185 PASS; reference/process suites 4 PASS;
  partial restore and subset/staging crash regressions PASS.
- Full regression (ran during development): 2612 PASS / 4 skipped / 3 failures. All three failed
  suites passed the focused rerun. The legacy read-only test was isolated from a differently owned
  live config repository; the Dashboard static test now permits the campaign GET route.
- Live isolated receipts under `.tooling/`: A `autonomy-live-1791424039486`,
  B `autonomy-live-1791424790122`, C `autonomy-live-1791424161100`, D `autonomy-live-1791424441447`.
  All COMMITTED. C injects three wrong goals into real worker prompts (recorded in fault-injection.json),
  keeping actual independent semantic review. D kills PID 15672 at REVIEW_PENDING and continues in PID 2136.
- Initial A exposed the subset commit bug; preserved failed receipt `autonomy-live-1791423827545`.
- Independent code review `.tooling/autonomy-code-review-1791424663852`: NEEDS_WORK.
  Addressed review-result crash recovery; clarified fixture acceptance about adding assertions;
  resolved/reran reported test failures. Re-review pending. Runtime not promoted yet.
