# RC-02 Development Loop V2 — E1/F implementation

## Boundaries

- E1 review policy: OpenAI `gpt-5.5`, through the pinned D1 embedded OpenCode/OAuth composition. Dedicated fresh native session; zero model-visible tools/MCP/external plugins/project or global instructions. No proposal session reuse or automatic retry.
- Production OAuth acquisition remains closed. Fake-provider tests exercise the actual embedded transport; they are not live-provider certification.
- F materializer: deterministic host code, **no AI model**. Its only executable entrypoint accepts a genuine temporary canonical fixture handle. The factory creates new temporary storage; it cannot enroll an existing repository path. No MCP canonical mutation endpoint exists.
- Store receipts, advisory PASS, materialization identity, REVIEW receipt and human checkpoint are local lifecycle/evidence records, never authority, approval or commit permits.
- Candidate/canonical/store directories and ancestors require exclusive trusted-host custody. Path/snapshot checks are not an OS locking mechanism against privileged concurrent hostile writers.

## E1

`runAdvisoryReview(mutation, humanInputHandle)` requires `FAST_EVIDENCE_FIXED` from the genuine store. The host persists the digest-bound original human input and rereads it. Manifest/FAST records and FAST artifact bytes come from the store, with candidate snapshot binding. Baseline bytes come from a fixed read-only blob primitive at the delegation baseline; candidate bytes must match the E0 Manifest.

The bounded UTF-8 context explicitly separates host instruction, human request, baseline, candidate, Manifest and FAST evidence. Project text, including AGENTS/README/comments/config/tests, is untrusted data. Context identity is SHA-256 of the canonical envelope excluding its self-referential `reviewIdentity` digest field. The exact envelope is durably stored.

`REVIEW_PENDING` is committed before dispatch. The dispatcher independently checks durable admission, context artifact, binding and currentness before credentials, native admission, final network submission and result acceptance. A lost process has no review-resume path.

Strict canonical findings allow only PASS/NEEDS_WORK and bounded strings. Findings artifact precedes the review-record artifact; only `COMMIT_REVIEW` introduces the verdict. NEEDS_WORK permanently rejects that attempt. PASS is explicitly advanced to local materialization eligibility.

## F

`materializeCanonicalFixture(fixture, mutation)` requires a genuine candidate identity, eligible store, committed PASS and durable findings/context/review artifacts. Canonical HEAD must match delegation baseline. Index must exactly match the host-prepared baseline index (conservative; semantically equivalent but differently encoded indexes fail closed). Exact scoped working-tree bytes must match Manifest before-state.

All targets are validated before the durable canonical reservation and one-time consumption. Both transactions precede any canonical write. Only MODIFIED/CREATED rows are written, using confirmed candidate bytes, descriptor identity checks and file flushes. UNCHANGED rows are untouched. Postchecks compare candidate/Manifest/canonical scope and the full observed tree for unexpected changes, including Git metadata and existing user work. No checkout/reset/apply/commit/push occurs.

After consumption, any write/flush/currentness/postcheck failure requires reconciliation. There is no rollback, rearm or retry. Store duplicate consumption queries can return the original **storage receipt only**; the materializer rejects replay by lifecycle state before writing.

`verifyMaterializedReview(proof)` durably reserves REVIEW_VERIFY and checks exact materialized content against the reviewed candidate. The strict verification artifact precedes a sealed REVIEW receipt. The store checks artifact existence/hash/chain before REVIEW_VERIFIED. `reachHumanCommitCheckpoint(proof)` rechecks currentness before the fixture-only human checkpoint.

On POSIX, materialization flushes new directory entries. On Windows, the fixture proof establishes acknowledged file flushes plus exact rereads, not durable directory-entry publication. Real canonical activation requires platform-specific crash/directory durability certification.

## Security findings and repairs

1. Store could accept review records without durable findings bytes: added findings hash, exact binding, canonical schema and result checks at artifact and commit boundaries.
2. Store could promote REVIEW receipt without durable strict verification evidence: added required reservation, artifact hash/binding and complete evidence-chain checks.
3. Independent review found direct exported review dispatch could bypass durable admission: added dispatcher-owned admission/currentness checks at all dispatch boundaries, with direct-call/stale-context regression coverage.

All three changes strengthen local validation without changing authority ownership, credential custody or approval semantics.

Independent read-only security review and repair re-review: **PASS**, with no remaining actionable findings under the documented exclusive host-custody assumptions. Review was performed in a separate agent session; fake-provider execution tests are reported separately from that source review.

## Remaining activation gates / human checkpoints

- DL2-C Linux bwrap live certification.
- D.1 supported/patched Node live certification.
- E0 Linux live FAST sandbox: `PLATFORM_UNAVAILABLE` on this Windows development host.
- OS cgroup resource limits: `NOT_ESTABLISHED`.
- Trusted production OAuth custody and live provider certification.
- CT704 deployment and production platform/durability certification.
- Real canonical materialization activation, with independently established host custody/currentness policy.
- Human release review; any real commit, push, deploy or runtime reload requires a separate human checkpoint.

These gates prevent production activation, not development implementation completion.
