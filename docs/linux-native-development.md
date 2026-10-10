# Linux development CLI — fixed fixture, not AI autonomous E2E

Production Dispatch CLOSED / authority NONE. Qualification LIVE_BLOCKED and its
unconditional external-fencing refusal are unchanged. No new design Phase.

## Implemented

`src/linux-development/cli.ts` accepts one fixed COUNTER_V1 task, starts separate
trusted proposer/reviewer Node processes with different receipt session IDs and
stripped environments, applies counter 0→1 as **data only**, custody-reads the saved
candidate, checks it, and persists intents/evidence/results with the existing
`DevelopmentStore`. This is neither native OpenCode sessions nor AI semantic review.
No generated script, shell, git hooks, VM117, QGA or provider is called by this CLI.

Linux fixture CLI rejects real/effective root. State directory must be new, absolute,
private and under trusted ancestors. Existing directories cannot be reenrolled.
`status` never dispatches; interrupted/missing results are UNKNOWN_NO_REPLAY.
UNKNOWN persistence failure throws and leaves the previous durable intent.
The local anchor is not rollback-resistant, and same-UID processes are not a sandbox.
Do not expose this entry to untrusted generated code or treat its receipts as permits.

Build from the separately pinned source commit with Node >=20 and lockfile-managed
dependencies; no HQO directories, PowerShell or Scheduled Tasks are required:

```sh
pnpm install --frozen-lockfile
pnpm build
# Under a separately provisioned nonprivileged development user; root is rejected.
node dist/linux-development/cli.js fixture "$HOME/state/fixture-001" "$SOURCE_COMMIT"
node dist/linux-development/cli.js status "$HOME/state/fixture-001"
node dist/linux-development/cli.js provider-readiness
```

`SOURCE_COMMIT` is a 40-hex provenance label supplied by the operator, **not** an
exact-SHA approval verifier. Freeze/check the deployed checkout independently.
The parent `$HOME/state` must already exist and be private. Do not repeat a lost task
under another directory; a fresh root is explicit new enrollment, not global exclusion.
Windows has only an explicit `--offline-windows-test` escape for this harmless fixture.

## Dependencies and reuse

| Component | Existing implementation / minimum Linux requirement |
| --- | --- |
| Gateway/Dashboard | Existing `run-linux-{gateway,dashboard}.mjs` health-only services remain untouched. CLI is a separate entry, no new port/UI |
| Controller | Existing Qualification controller is not activated. CLI receives fixed task and uses durable store without broker/executor privileges |
| OpenCode proposer/reviewer | Existing `execution-orchestrator/development/opencode-{core-adapter,transport}.ts` and `advisory-review.ts`, pinned @opencode 2.0.22; tested embedded core/fake-provider path. New CLI does not claim these run live |
| Provider authentication | `opencode-oauth.ts` host-custody source remains unprovisioned/closed; do not bypass it with env credentials or copy HQO OAuth |
| State/results | Existing DevelopmentStore append-only journal + public role receipts, intents and candidate; no Windows queues |
| Source | GitHub riz467/codex-with-chatgpt, dedicated branch; frozen lockfile and compiler |
| External configuration | riz467/ai-orchestration-config; fresh exact-commit checkout after selecting current remote version. Fixture needs no external config. pve-doc is operations documentation with unrelated local changes |
| Windows legacy | `worker/codex-interactive.ts` C:\\ paths, queues, profile schema and scripts installing Scheduled Tasks are bypassed, not ported wholesale. Existing Windows runtime preserved |

Only zod, Node builtins and the existing task-contract/development-store dependency
closure are used by the new fixture. OpenCode/Effect dependencies belong to the
existing provider adapter, not to the fixed worker. Full project build still uses the
existing package/lockfile, without dependency roll or new package installation on VM116.

## VM116 gate — administrator approval required, not executed

Read-only capability check found Node/Git/OpenCode/pnpm and healthy staging services.
Known users `ai-control-staging` UID995 and `ai-control` UID999 are existing protected
service identities; neither was reused for development. Checked `ai-linux-dev` and
`ai-dev-runner` were absent. This does not assert all possible accounts are absent.
No authenticated nonprivileged dedicated development entry was established.

Proposed minimal approval scope:

1. Human provisions **ai-linux-dev**, separate UID/group, private home
   `/var/lib/ai-linux-dev` and private state subdirectory. No sudo, PVE groups,
   authorized root key, credentials from HQO or privileged sockets. Do not alter the
   existing ai-control users, services or `/srv/ai-orchestration/codex-with-chatgpt`.
2. A new checkout `/srv/ai-linux-development/codex-with-chatgpt` is built from the
   pushed exact commit. Verify the source archive SHA/public build manifest, lockfile,
   installed versions and nonroot UID/EUID. Package/install/write/launch operations
   are outside the read-only capability query and need explicit approval.
3. Run the fixed CLI once under the new identity with private home/state. Reopen
   `status` in a second process, compare journal/evidence SHA, check no replay and
   protected services unchanged. No persistent service is needed for this initial test.
4. Rollback: stop only an identified **new** development process if separately
   authorized, leave state/evidence and source for inspection, disable only the newly
   approved entry. Do not delete old runtime/accounts/credentials or restore files broadly.

Only after this fixture test: Human independently authenticates OpenCode **on Linux**
using its local `/connect` UI (V2 provider docs), under the dedicated identity. Do not
send credential/access/OAuth URL bodies into this harness or export Windows stores.
Native Linux OpenCode availability alone does not provision the existing host adapter.
Wire Linux-owned credential custody to that adapter only in a separately reviewed
minimal change; use no-tools bounded provider request, separate proposer/reviewer
processes/sessions and durable intent before each call. Until then readiness stays NOT_RUN.
Do not start a generic `opencode run` agent to evade the closed adapter or VM117 isolation.

## HQO inventory / stop-test prerequisites

A — Reproduce from GitHub: source, scripts, tests, package/lockfile, committed public
configuration. Main was 186 commits behind the known Qualification branch at start;
use the new dedicated branch rather than deploying main accidentally. External config
remote was 20 commits ahead of the clean HQO checkout after refresh; no merge was made.

B — Preserve selected non-secret local reports, sanitized receipts, fixture journal,
release source/build manifest and public artifact archives. The separate migration
manifest SHA-pins an explicit allowlist; nothing has been copied to Linux yet. Old
campaign private keys/claims are NOT migration inputs and remain in existing custody.
Mixed/uncommitted pve-doc changes require individual review, not whole-repo copying.

C — Keep HQO business data, HumanAdmin private keys, SSH agents, OAuth stores, Windows
profile/settings and existing runtime. Transient compiler/test files may be considered
for deletion only after successful migration and Human approval; nothing is deleted here.
Windows 11 HumanAdmin VM must not host OpenCode/Orchestration Runtime.

Minimum before HQO-off test: dedicated Linux entry and persistent source/state,
independent provider authentication + adapter wiring, actual bounded provider round
and independent review, selected public evidence preservation, then a Human-controlled
HQO stop/restart window. SSH→pve5→QGA from HQO is an investigation/deployment management
dependency today, not proof that Linux development already survives HQO shutdown.
Legacy root-authority cutover remains a separate privileged Qualification gate;
this fixture does not settle old processes or weaken that gate.
