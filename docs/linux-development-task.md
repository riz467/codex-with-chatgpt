# Linux development task seam (offline only)

`src/linux-development/task.ts` is a small composition over `DevelopmentStore`
and the existing development request, candidate, proposal, FAST and advisory
review APIs. It does not change the fixture runner, custody inspection,
Qualification or legacy production seams.

## Production boundary

`runLinuxDevelopmentTask()` always returns `HOST_ADAPTER_CLOSED`, authority
`NONE`, production dispatch `CLOSED`, and provider `NOT_RUN`. Its input is not
inspected. There is no CLI enable flag, environment lookup, credential reader,
network call or implemented authenticated Linux host adapter here.

## Explicit offline host composition

`createOfflineLinuxDevelopmentTask(host, hostExpected, capabilities)` accepts
exact data-only records from a **trusted offline test host**, not task caller
options. The host supplies:

- A genuine ready DevelopmentStore, candidate repository and request input
  handle, plus an independently fixed expected binding.
- Proposer/reviewer callbacks typed as the existing `dispatchProposal` and
  `dispatchAdvisoryReview` adapters, and a synthetic FAST evidence callback.
  The test callbacks are fake; no native session or native E2E claim is made.
- Public, secret-filtered adapter results. The real adapters already discard
  raw errors and check secrets privately; this module cannot discover secrets
  in an arbitrary trusted callback's returned strings. Never inject credentials
  or raw provider responses into this offline seam.

The returned task has parameterless `run()` and `readStatus()` methods. Handles
and callbacks are captured once; extra properties, accessor properties and
forged existing handles are rejected with a fixed sanitized error.

The store must start at `CANDIDATE_READY`. Task acceptance, dispatch reservation
and proposal intent are durable before the proposer call. Valid proposal DATA
is applied only through the existing bounded UTF-8 candidate mutation API.
The task runs no candidate verifier or arbitrary code. Synthetic FAST evidence
is bound to the manifest and exact post-mutation snapshot before use.

The reviewer receives the existing opaque, host-built review context containing
the human goal/acceptance criteria, exact baseline/candidate bytes and FAST
evidence. `REVIEW_PENDING` and review intent precede the call. Findings must bind
to that exact context, and the reviewer session identity must differ from the
proposer identity. Session identity checks here are consistency checks, not
authenticated native provenance or OS isolation.

PASS stops at `PASS_RECORDED` / `ADVISORY_PASS_ONLY`. NEEDS_WORK stops at
`ATTEMPT_REJECTED`. Neither issues authority or enters materialization, execution,
commit, push, production, Qualification or Human gates. Findings/context bytes
remain in the protected existing store; public status exposes only result,
state and evidence hashes, not source, prompt, findings text or raw exceptions.

## Stop and storage behavior

Each callback has a fixed 45-second settlement limit. Timeout or any validation,
transport, mutation or storage uncertainty stops at `UNKNOWN_NO_REPLAY` and
attempts to record `RECONCILE_REQUIRED`. If that write fails, the already durable
intent/reservation is the fence. No callback is killed, automatically retried,
resumed or replayed. Late promise settlement cannot continue this orchestration;
trusted callbacks must not independently mutate storage or execute candidates.

The host retains the store creation receipt/anchor independently. After loss,
`readLinuxDevelopmentTask(root, hostAnchor)` reopens receipts read-only and never
dispatches. Missing terminal evidence and fenced storage report UNKNOWN. A
reopened unsettled store cannot be admitted as a new ready task.

Filesystem checks, per-process handles, deny-tool profiles, fresh sessions and
different directories are **not** a same-UID security sandbox. Protected roots,
continuous exclusive custody, authenticated delegation and restart-safe host
admission remain unimplemented production host responsibilities.

## Focused offline checks

```text
node node_modules/vitest/vitest.mjs run tests/linux-development-task.test.ts tests/linux-development.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

The task tests use synthetic adapters/evidence and never access OAuth, providers,
SSH, live resources or candidate execution.
