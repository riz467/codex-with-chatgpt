# HQO independence — one Linux native preparation / approval boundary

## Outcome: IMPLEMENTATION_PARTIAL / LINUX_ARTIFACT_INCOMPLETE

Not `LINUX_NATIVE_OFFLINE_READY`; not merely waiting for Human approval.
Baseline branch `development/hqo-independence-task-seam-20261011`, prior HEAD
`69f48dc5a51f5cb61f0148e68e299b08146a2b50`. This change is isolated source/offline work.
Production CLOSED / authority NONE / Qualification LIVE_BLOCKED remain unchanged.
Bridge auth attribution remains UNKNOWN; neither normal rotation nor a new approved
baseline is asserted. No further Bridge history inspection occurred.

## Implemented (offline tested, not Linux-live certified)

- Fixed COUNTER_JSON_V1 root-authorized CLI, complete pinned runtime inventory and
  real/effective nonroot custodian checks; no caller model/task/path/enable flag.
- Existing DevelopmentStore durable exclusive claim/intents before role/HTTP dispatch;
  separate processes/native sessions, fixed gpt-5.5, deny-all tools, one bounded turn;
  proposer cgroup/child settlement before reviewer, no fallback/retry after UNKNOWN.
- Supported pinned OpenCode2.0.22 `Integration.connection.active` and `Credential.get`
  credential read, fixed private native SQLite Global paths, genuine in-process opaque
  handle/capability. No manually guessed auth JSON/SQL, autoOAuth, refresh, env key,
  discovery or serialization of credential handles. No credentials were acquired live.
- Fixed DATA transport integrated into pinned embedded adapter. This is not a fixture
  response: production callback calls native core; mock callback tests remain offline.
  Review is advisory fixed DATA review, not code verification or Qualification.
- Resource readbacks MemoryHigh512MiB/MemoryMax640MiB/swap0/CPU100%; whole-delegation
  child exit/close/empty checks. Limits and capacity are unmeasured native design values.
- Separate sanitized public handoff/observer for existing UID994 SSH terminal.
  Terminal UNKNOWN/result/settlement invalidates worker admission on every recheck.
- Linux-only capsule recipe, frozen offline public dependency closure, pinned Node/
  OpenCode/pnpm, no lifecycle/pnpmfile hooks, source archive and original regular-file/
  lock-byte checks plus relocated archive verification. Full post-build tree invariance
  is not proved by those original-byte checks.

## Still missing implementation/artifacts, NOT approval-only blockers

1. Real Linux capsule build and independently reviewed source/compiled/dependency/
   native-module manifest. Windows build is not the Linux runtime. Actual complete
   runtime/capsule/authorization/source-compiled correspondence SHAs are **UNAVAILABLE**.
2. Complete ELF dynamic-library/interpreter/native-addon dependency closure and
   target-ABI acceptance implementation/evidence, including runtime admission gate;
   that gate is not implemented. Structural ELF checks are insufficient.
   Strict deployment requires symlink-free, singly linked root runtime; packaging must
   prove hoisted runtime meets this condition, not silently relax custody.
3. Root launcher provisioning implementation and exact reviewed systemd unit/hook
   bytes for bounded delegation, role groups/common-ancestor migration, fixed env and
   controller controls. Policy is documented but no deploy-ready root installer/unit
   exists and target systemd support has not been verified.
4. Fixed supported Human credential enrollment entry and enrollment/admission receipt.
   Reading a supported existing active credential is implemented; selecting/creating/
   authenticating one is not. A guessed `host-oauth.json` is not a native store source.
5. No authenticated/semantic Linux turn, real peak RSS/PSI/settlement or SSH public
   observer run. These are later live validation, not a reason to label mocks native.

No Linux build environment is available on HQO (no WSL distribution / discovered
Docker executable). No VM116/VM117 fallback build or host installation was attempted.
Public Node/pnpm archives were fetched only for byte pins; neither was executed.

## Proposed new Linux objects — NOT approved/provisioned

Before each actual EXEC, independently confirm host/VM identity and UID/GID/path
collision; UID993/GID984 were only previously observed free, never reserved.

| Object | Proposed owner/mode | Scope |
|---|---|---|
| `ai-linux-provider` | UID993, primary GID984, results-only group985 | No developer/custodian SSH credential identity sharing |
| `/opt/ai-linux-provider/runtime` | root:root, dirs0755 / files0644 / pinned binaries0755, no links/ACL write | New immutable Linux-only capsule; no existing fixture replacement |
| runtime `native-manifest.json`, `native-authorization.json` | root:root0644, finite strict schema | Exact approved runtime manifest SHA + one fixed task UUID; not ambient enablement |
| `/var/lib/ai-linux-provider` and home/config/cache/data/state/private receipt store |993:984 dirs0700 / files0600 | Private native SQLite + existing DevelopmentStore journal |
| `/var/lib/ai-linux-results` |root:root0755 | Root-protected parent, no developer writes |
| `/var/lib/ai-linux-results/receipt-001` |993:9840700, files0600 | Exclusive private claim/anchor/terminal evidence |
| `/var/lib/ai-linux-results/public-receipt-001` |993:98502750, sanitized handoff0640 | UID994 read-only status/receipt, no private-store access |
| `/sys/fs/cgroup/ai-linux-provider.service` + control/proposer/reviewer | separately reviewed bounded root delegation | Serial parent budget includes supervisor; no root-control chown shortcut |
| new root-owned systemd launcher/unit/hook | exact bytes/SHA still unavailable | No restart/auto-replay; no edits to existing Gateway/Dashboard/Bridge/Tunnel |

New source entry files are `native-admission`, `native-cli`, `native-credential`,
`native-fixed-data`, `native-host-transport`, `native-launcher`, `native-observer`,
`native-receipt`, `native-worker` under `src/linux-development/`; only the existing
development embedded adapter gains the guarded host path. Existing fixture files,
closed general OAuth acquisition, Qualification external-fencing EXEC refusal and
Production paths are not enabled or replaced.

## Minimum staged next approvals (do not reuse old approvals)

**A. First finish offline prerequisites.** Provide permitted credential-free Linux
build environment/public cache; implement missing enrollment entry, ABI verification
and exact root launcher setup; independently review capsule/unit hashes. No credential
or provider approval is needed to complete these offline artifacts.

**B. Independent Human recovery and residual custody decision.** Prove Human privileged
console/management recovery without HQO before provisioning. Shared old HQO
root→pve5→QGA/other-node transit remains unresolved;0700/nonroot/root-owned files do
not isolate secrets from that root path. Explicit risk acceptance is not technical
isolation, does not admit a provider turn and cannot adopt Bridge auth baseline.

**C. Narrow new-area provisioning approval.** After A/B, approve exact source/runtime/
unit/manifest SHAs, one task UUID, UID/GID/path collision-rechecked creation, private
native DB boundary, public observer and cgroup setup only. VM116 stays2vCPU/2GiB.
No existing protected service/config/auth modifications, old claim release, credential
copy, VM117 arbitrary execution or VM resource/reservation/placement change.
If the protection policy cannot separate these new writes from UNKNOWN Bridge state,
stop that live write; do not exclude auth hashes or bypass the existing gate.

**D. Separate Human enrollment/provider approval.** Human authenticates via the reviewed
fixed supported Linux entry, no HQO OAuth/key transfer. Then authorize exactly one
public DATA/no-tools proposer and separate reviewer, real RSS/PSI/settlement measurement
and public observer reread from Win11. Credential secrecy/native-process admission
must be established, not inferred from Human risk acceptance or metadata tests.

## Stop/recovery

Implemented runtime, auth, active credential, cgroup, source/custody/resource and
public-result-path guards fail closed before dispatch. The missing ABI admission gate
is a source blocker: root must not issue task authorization until it is implemented
and independently verified; metadata/hashes are not an ABI admission substitute.
Nonzero/signal/
timeout/leftover PID or ambiguous provider/result ⇒ durable UNKNOWN, no retry/replay,
no reviewer before settled proposer. Preserve private claim/journal/evidence; do not
delete/release them to retry. Already-sent requests cannot be undone. No automatic kill,
restart or existing-service repair; independent Human handles settlement/recovery under
new approval. Preserve existing fixture-001 and existing services unchanged.

If640MiB is insufficient, stop and request Codex assessment using measured RSS/PSI,
pve-doc and current pve5 host budget; never change guest resources automatically.
Two native workers are not permitted concurrently. Prior512MiB/high,640MiB/max and
256–512MiB planning RSS are not measured capacity; user remains approval authority.

## HQO-stop remainder by category

- **Offline implementation:** A plus native Linux artifact review (currently incomplete).
- **Actual machine changes:** B/C; independently recoverable custodian/runtime/delegation/
  separate safe result publication, without changing protected Bridge/fixture services.
- **Human authentication:** D supported Linux enrollment and separately scoped provider
  authorization, no HQO credentials copied.
- **Operational checks:** real one-at-a-time turns/settlement/memory; Win11 public status
  reread; separately approved isolation/verifier for arbitrary candidate code; only then
  Human-confirmed HQO-stop and recovery window. Current development/build/push still
  depends on HQO; HQO-stop test remains BLOCKED / NOT_RUN.
