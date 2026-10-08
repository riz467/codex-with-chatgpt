# Autonomy bootstrap execution record — 2026-10-08

This is a development record, not authoritative DONE. Local runtime promotion is complete;
see the final section for receipts, rollback and remaining Human-inspection boundaries.

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

## Deadline and production entry-point corrections

- Durable campaign/recovery stage commit: `eeaba18`.
- Second independent review: `.tooling/autonomy-code-review-1791425059706/result.json`,
  NEEDS_WORK: active lifecycle deadline bypass, direct MCP start bypass, final full regression missing.
- Corrected task execution, proposal application, verification, review acceptance and local commit
  to enforce the persisted campaign deadline. Production MCP starts now create campaigns;
  Gateway startup reconciles them after successfully binding its listener.
- Files: `src/bridge/server.ts`, `src/mcp/{bounded-campaign,bounded-task,server,typed-actions}.ts`,
  campaign/MCP tests, live fixture/browser helper, independent review probe, this record.
- Active-worker deadline regression PASS: expired proposal is not applied, reviewed or committed.
  Campaign suite 7 PASS. Typecheck and isolated candidate build PASS; final full regression
  97 suites PASS, 2619 tests PASS / 4 skipped (861.97 seconds). Log:
  `C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/autonomy-final-full-tests.log`.
- Actual browser scenario A PASS: `.tooling/autonomy-live-1791425605760/result.json`.
  Edge submitted the Dashboard form; real worker, verification and independent review produced
  a local commit; `dashboard-rendered.txt` and `dashboard.png` show COMMITTED and non-authoritative DONE.
- Browser startup now bounded-retries locked/incomplete DevToolsActivePort reads and cleans up
  startup failures. The prior failed fixture's Edge tree was identified by its unique profile and stopped.
- Clarified-contract scenario C PASS: `.tooling/autonomy-live-1791424897209/result.json`.
- Candidate: `.tooling/autonomy-runtime-candidate-20261008/dist`, 286 hashed files in `manifest.json`.
  Current production runtime remains unmodified pending full regression and independent re-review.

### Prepared local promotion and rollback

- One-shot local procedure: `.tooling/promote-autonomy-runtime.ps1`, gated on clean expected HEAD,
  independent PASS, completed passing full regression, idle task/campaign ledgers, no task locks,
  verified Scheduled Task identities, and candidate file hashes.
- It stages both copies before stopping services, checks idle state again after quiescence,
  saves bounded state (excluding authentication), and retains both previous runtime directories.
  Failed promotion restores the previous runtime directories and restarts the local tasks.
- Later rollback requires a fresh idle/identity check: stop the verified Dashboard and Gateway,
  retain the current `dist` and execution-runtime `dist`, restore `root-dist` and `execution-dist`
  from the recorded promotion backup, restart both tasks, and revalidate all three health endpoints.
  State backups are inspection evidence; do not overwrite later task ledgers with old backups.
- Human action remains necessary for stopped campaigns with unknown locks/unprovable workspace
  changes and for authoritative approval/finalization outside this local development scope.

## Review-response failure and additional recovery corrections

- Two post-regression reviewer responses failed strict schema validation; no PASS was inferred.
  The second response is retained in `.tooling/autonomy-code-review-1791426297687/raw-review.json`.
  Its actual verdict was NEEDS_WORK; an overlong issue string invalidated the envelope.
- Concrete findings addressed: a persisted committed receipt is now projected before the deadline
  check after restart; an interrupted unowned lock gate now stops for inspection after 30 seconds
  rather than silently retrying. The gate is preserved because its owner cannot be proved dead.
- Added behavioral regressions for both cases. This intentionally does not promise automatic
  recovery of unknown/partial locks. Post-deadline new work remains forbidden.
- Additional files: `src/mcp/bounded-process-lock.ts`, campaign implementation/tests and review
  probe diagnostics (capture only final text/identity/usage, excluding reasoning payloads).
- Candidate rebuilt; post-correction typecheck PASS and four affected suites 103 tests PASS
  (111.50 seconds); fresh-gate contention assertion also passed separately. Log:
  `C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/autonomy-review-fixes-tests.log`.
  Fresh independent review pending.

## Missing-receipt reconciliation and whole-process restart

- Independent review `.tooling/autonomy-code-review-1791426578250/result.json`: NEEDS_WORK.
  Findings: post-commit/pre-receipt crashes after the deadline were still blocked; original D
  killed the executor child rather than the whole Dashboard/controller process.
- Added `reconcileBoundedCommit`: under the lifecycle lock, reconstruct only a missing receipt
  for the exact clean reviewed single-child commit. `allowNewCommit=false` prevents staging or
  creating commits. Existing sealed receipts remain historical evidence after later repo work.
- Regressions cover missing/existing receipts past deadline, refusing new commits/staging for
  expired accepted tasks, and preserving historical receipts after subsequent repository work.
- Latest real D PASS: `.tooling/autonomy-live-1791426829539/result.json`.
  Killed whole fixture Dashboard/scheduler/lifecycle PID 7036 at REVIEW_PENDING, restarted PID 6880.
  Exactly one real worker invocation, independent PASS, one local commit
  `d3b0b1022514b7782b0fe60aeb18ce47287d5b12`; no parent-process execution/review fallback.
- New helper: `tests/fixtures/autonomy-dashboard-process.mts`; old executor-only D evidence remains
  retained but is superseded for whole-process restart claims.
- Checks: typecheck PASS; campaign/MCP 72 PASS; typed-actions 168 PASS after updating its explicit
  export allowlist; expired-no-new-commit regression PASS. Final receipt/campaign rerun:
  180 tests PASS (67.96 seconds), typecheck PASS; isolated candidate rebuilt. Log:
  `C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/autonomy-receipt-final-tests.log`.
- Runtime hardening and unit-regression commit: `760439d`.
- Review `.tooling/autonomy-code-review-1791427110689` had an invalid envelope with NEEDS_WORK
  text. Two claimed root mismatches conflict with `server.ts` lines 37–51: Dashboard and
  control-plane profiles share the exact same physical root, accepted by the finalizer.
  Added these previously omitted baseline lines to the next independent evidence bundle,
  plus clarification of optional supplemental reference omissions versus required evidence.
  No valid PASS inferred; re-review pending.

## Unknown-owner lock termination

- Independent review `.tooling/autonomy-code-review-1791427221879/result.json`: NEEDS_WORK.
  An ownerless lifecycle lock could bypass the deadline in accepted-task reconciliation.
- Unknown/malformed owner records now raise `PROCESS_LOCK_OWNER_REQUIRES_INSPECTION`, preserving
  the lock. Live lifecycle/controller contention checks the deadline before returning.
- Added a four-case regression matrix: unknown/live owners for lifecycle/controller locks,
  asserting STOP, preserved lock, and no extra proposal/review/finalization.
- Validation: typecheck and rebuilt candidate PASS; four-case lock matrix PASS; final complete
  campaign/process-lock suites 16 PASS (68.56 seconds). An initial test-only fixture path mistake
  was corrected before the final passing run. Log: `autonomy-owner-lock-final-tests.log` in the
  approved OpenCode temporary directory. Independent re-review pending; runtime unpromoted.

## Bounded reviewer exceptions and visible evidence failures

- Unknown-owner lock correction committed as `a2ba988`.
- Independent review `.tooling/autonomy-code-review-1791427497055/result.json`: NEEDS_WORK.
  Findings: reviewer exceptions skipped the remaining claim; oversized diffs returned without
  diagnostics; invalid campaign ledgers disappeared from the campaign listing.
- Reviewer exceptions now persist failed-attempt evidence and consume the remaining claim,
  with a deadline check before each attempt. Both failed claims remain exhausted across restart.
- Invalid/oversized review artifacts and other pending-review errors persist diagnostic reasons.
- Invalid campaign ledgers remain byte-for-byte intact and project STOPPED with an explicit
  inspection reason/action in the existing Dashboard campaign list; no execution is resumed.
- Added regressions for timeout→PASS, repeated timeouts/no third call, oversized artifacts and
  corrupt-ledger visibility/preservation. Typecheck and candidate build PASS; four affected suites
  115 tests PASS (124.90 seconds). Commit: `e264129`. Independent re-review pending.

## Required-reference gate and deadline/commit projection race

- Independent review `.tooling/autonomy-code-review-1791427857664/result.json`: NEEDS_WORK.
  Required edit-path references needed deterministic enforcement, and deadline STOP could hide
  a commit finishing under another live process's lifecycle lock.
- Missing/truncated required edit-path references now prevent accepting any reviewer PASS;
  the two sealed acquisition claims are consumed before evidence-exhausted STOP. Optional
  supplemental reference omissions remain for the independent reviewer to assess.
- Deadline-stopped campaigns may reconcile only already-existing commits/receipts when a live
  owner releases its lock. No new worker/review/recovery/commit runs; other inspection STOPs remain stopped.
- Added missing/truncated-reference rejection and live-owner release projection regressions.
  Typecheck/build PASS; three affected suites 86 tests PASS (90.91 seconds).
  Commit: `c64166a`. Independent review pending; runtime unpromoted.

## Malformed review-page diagnostics

- Independent review `.tooling/autonomy-code-review-1791428133580/result.json`: NEEDS_WORK.
  One page offset/hash/base64 validation branch still returned silently.
- Every malformed page branch now persists `SEMANTIC_REVIEW_INVALID`; artifact sizes require
  safe integers. Missing pending-review revision/worker/verification evidence stops explicitly.
- Four malformed-page negative cases and missing-revision STOP regression added.
  Typecheck/build PASS; campaign/MCP suites 84 tests PASS (84.84 seconds).
  Commit: `7d07f86`. Independent re-review pending; runtime unpromoted.

## Campaign-controller write fencing

- Independent review `.tooling/autonomy-code-review-1791428359282/result.json`: NEEDS_WORK.
  A contending scheduler could save a stale deadline STOP without owning the controller lock.
- Campaign creation now holds its controller lock before publishing intent. Contending ticks
  never write the campaign ledger. Expired budgets are read-only status projections; inspection
  failures without ownership use a separate sidecar, subordinate to an existing COMMITTED ledger.
- Added a race regression injecting another owner's COMMITTED write between status read and
  failed lock acquisition; the newer committed ledger must remain intact.
- Typecheck/build PASS; campaign/process-lock suites 19 tests PASS (75.65 seconds).
  Commit: `aa2a06f`. Independent re-review pending; runtime unpromoted.

## True reference reacquisition and partial-initialization boundary

- Reviewer `.tooling/autonomy-code-review-1791428688667` returned an invalid envelope containing
  NEEDS_WORK about partial task initialization and expanding rather than reacquiring references.
- Claim 2 now genuinely rereads controller-scoped Git blobs at the original baseline SHA.
  Its snapshot is sealed to task/contract/revision/manifest and content hashes, reused after
  restart, and checked against tampering. A recovered reference does not consume an edit revision.
- Partial initialization can retain a repository reservation without provable process ownership.
  It deliberately stops with `TASK_INITIALIZATION_REQUIRES_INSPECTION`, preserving both directory
  and reservation. This is an explicit Human-inspection boundary, not automatic replay or a
  claim of universal crash recovery. Scenario D proves the durable REVIEW_PENDING boundary.
- Added fresh-baseline reacquisition/reuse/tamper and partial-initialization preservation tests.
  Typecheck/build PASS; four affected suites 125 tests PASS (139.91 seconds).
  Commit: `39a65ba`. Independent re-review pending; runtime unpromoted.

## Campaign API projection and truthful start-tool contract

- Independent review `.tooling/autonomy-code-review-1791429106772/result.json`: NEEDS_WORK.
  Campaign API exposed raw contract goals/criteria; MCP start description incorrectly denied commits.
- Campaign API now explicitly selects IDs/status/paths/times/fixed inspection instructions and
  `authoritative_done: false`, excluding contract contents/digests and failure records. It checks
  the fixed local Host/socket and runs after no-store/security-header middleware.
- MCP tool description now states that independent-review-approved local commits can occur
  automatically, without push/deploy/approval/authoritative DONE authority.
- Added HTTP projection/privacy and tool-description checks. Typecheck/build PASS;
  seven Dashboard/MCP suites 190 tests PASS (88.04 seconds). Commit: `72c0ce8`.
- Current-source browser A PASS: `.tooling/autonomy-live-1791429297178/result.json`, independent
  PASS and local commit `ce30268580148fd38a0646dd36df42773b847887`. Actual form submission,
  rendered completion and screenshot retained. Current-source whole-process D rerun pending.
- D attempt `.tooling/autonomy-live-1791429427842` stopped for inspection after the kill landed
  during controller gate creation: one worker, zero commits, unowned gate preserved. Recorded
  in `failure.json`; this is not a passing restart proof.
- The D probe now stops its fixture scheduler immediately before signaling the durable
  REVIEW_PENDING crash point, then kills the entire Dashboard process. This isolates the declared
  checkpoint from the separately documented unknown-gate inspection boundary. `restart-boundary.json`
  records this fault-injection condition; failure results are written before proof assertions.
- Latest current-source D PASS: `.tooling/autonomy-live-1791429613700/result.json`, whole Dashboard
  PID 12536 → 3028, one worker call and one commit `8abb8aaea598da1b900399994848225119572849`,
  independent PASS with reacquired baseline references. Independent implementation re-review pending.

## Independent implementation review accepted

- `.tooling/autonomy-code-review-1791429681517/result.json`: **PASS / GOAL_SATISFIED**,
  no unresolved issues. Independent session/model/profile and hashed input/source evidence retained.
- Reviewed executable source HEAD: `72c0ce8` (preceding hardening commits listed above).
  Candidate rebuilt from these sources; all 286 runtime files are hashed in its manifest.
- Verification: complete regression 2619 PASS / 4 skipped, followed by affected-suite reruns
  after review-driven corrections (latest Dashboard/MCP 190 PASS, recovery/reference/task 125 PASS).
  Latest real browser A and whole-process D receipts are recorded above; B and C remain verified
  by their preserved real-worker/independent-review fixture receipts.
- Runtime promotion is the next gated local step. This PASS certifies the reviewed local
  development behavior, not external deployment, Human approval, or authoritative DONE.

## Local runtime promotion completed — 2026-10-08 12:24 JST

- Evidence/probe/documentation commit: `5f54d68e478d299e13385ff4dd38911b5e9c2938`.
  Executable source is the independently reviewed `72c0ce8` tree; subsequent commit changes
  only fixtures, the review probe and documentation. No source changes followed the PASS.
- Fresh preflight confirmed a clean main worktree, expected Scheduled Task identities,
  no RUNNING/REVIEW_PENDING tasks, no task/repository locks and no autonomous activity.
- Promoted the 286-file hash-verified candidate into root `dist` and
  `.tooling/ai-workspace-execution-runtime/dist` after stopping only the verified local tasks.
  Previous runtimes and bounded-state snapshots were preserved; authentication storage was excluded.
- Promotion/rollback backup: `.tooling/autonomy-promotion-20261008-122345/`.
  `result.json` binds the promoted commit and independent PASS receipt; `post-validation.json`
  records health/identity/authentication/task-state observations. Previous runtime directories:
  `root-dist/` and `execution-dist/`. The prepared procedure is `.tooling/promote-autonomy-runtime.ps1`.
- Health PASS: Gateway 48765 (workspace `f2f8a725a712`), Dashboard 48766,
  Review Bridge 54108 (workspace `3ca00af72a83`). New PIDs: supervisor 10792,
  execution 3728, review 5508, Dashboard 9648; exact executable/command lines checked.
- Campaign API responds with an empty list; current task null, autonomous runs zero.
  Unauthenticated Gateway MCP remains **401**. Historical bounded states unchanged:
  216 ESCALATE / 88 REVIEW_ACCEPTED, with no active tasks. Main repository still has one worktree.
- Existing config-repository changes remain only the two pre-existing PowerShell scripts.
  No push or external infrastructure deployment was performed.

### Final verified scope and remaining boundaries

- A: actual browser form → real worker → checks → independent PASS → local commit/rendered result.
- B: real NEEDS_WORK → automatic next revision → PASS → local commit.
- C: three rejected real worker revisions → evidence-bound restore → successor → reviewed local commit.
- D: recorded quiescent REVIEW_PENDING checkpoint → whole Dashboard/controller process kill/restart
  → one worker invocation / one commit, with fresh sealed reference acquisition.
- Independent implementation review **PASS**; full regression 2619 PASS / 4 skipped and all
  subsequent affected-suite reruns PASS. Final source browser A and whole-process D PASS.
- Runtime rollback: fresh idle/identity check, stop verified Dashboard/Gateway tasks, preserve
  current runtime directories, restore the backup's `root-dist` and `execution-dist` to their
  recorded destinations, restart both tasks, then verify all health endpoints and MCP 401.
  Do not restore old task-state backups over later work.
- Human inspection is still required for unknown/partial locks, partial task initialization,
  corrupt ledgers, unprovable workspace changes or exhausted budgets. These are explicit safe stops.
- Local COMMITTED is **not authoritative DONE**. External independent authority, signed Human
  approval and Finalizer/DONE integration remain outside this authorized local scope.
