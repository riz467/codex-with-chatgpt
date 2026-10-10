# Fixed Linux native launcher (offline implementation, not live qualification)

## Integration contract (credential/transport agent)

The fixed root manifest **must** inventory `dist/linux-development/native-host-transport.js`. That module exports:

```ts
dispatchFixedNativeRole(input: Readonly<NativeWorkerInput>): Promise<NativeTransportResult>
```

Types and strict runtime schemas are in `src/linux-development/native-worker.ts`. Input contains only version 1, task `COUNTER_JSON_V1`, root-authorized UUID taskId, proposer/reviewer role, `{counter:0}`, and either null or `{counter:1}` candidate and prior proposer session ID. Output contains only version 1, role, genuine `ses_...` session ID, proposer `{counter:1}`/null review or reviewer null proposal/`PASS|NEEDS_WORK`. Do not return findings text, prompts, errors, credentials or serialized opaque handles. The integrated host module acquires genuine in-process credential/capability handles in the claimed worker and uses `runNativeFixedDataTurn()` over the pinned embedded one-turn core. It does not serialize/create fake proposal or ReviewContext handles and does not manufacture FAST evidence. Existing general development host seams remain separate. Missing module/export or blocked transport stays UNKNOWN and prevents reviewer dispatch. Worker rechecks the complete authorization/manifest after joining its cgroup and before importing this fixed host module.

**Credential capability guard:** call `assertAuthenticatedNativeWorkerTurn(role)` from `native-receipt.ts` before issuing/consuming a host turn capability. Admission alone is not a provider dispatch permit. The guard requires the actual process in its fixed role cgroup and its exclusive worker claim tied to its PID/root-authorized task. Worker creates that claim only after independently reopening the DevelopmentStore anchor and verifying the exact durable role intent and absence of terminal/settled evidence. A direct worker invocation or second worker cannot bypass/reuse intent.

## Fixed roots and admission

- Runtime: `/opt/ai-linux-provider/runtime` (every directory/file root-owned, non-symlink, no group/other write; all regular files singly linked).
- Private state: `/var/lib/ai-linux-provider` (UID 993); preprovision proposer/reviewer directories mode 0700.
- Receipts: `/var/lib/ai-linux-results/receipt-001` (UID 993; root-owned immutable ancestors).
- Delegation: `/sys/fs/cgroup/ai-linux-provider.service` (root-slice systemd service).
- Real/effective UID must both be **993**. No environment/caller authorization, credential flags, alternate paths, sudo or `systemd-run`.

Root provisions `native-authorization.json` with exact fields:

```json
{"version":1,"task":"COUNTER_JSON_V1","taskId":"ROOT-PROVISIONED-UUID","custodianUid":993,"sourceCommit":"40-lowercase-hex","manifestSha256":"64-lowercase-hex","dispatch":"ONE_FIXED_ATTEMPT","receiptId":"receipt-001"}
```

Root provisions `native-manifest.json` as `{"version":1,"files":{"relative/path":"sha256",...}}`. SHA256 is of exact manifest bytes. Inventory must match **every** runtime file except these two metadata files, including complete dependency closure, `bin/node`, worker and host transport module. No symlinks or omitted files; limits: 20,000 files, 128 MiB/file, 1 GiB total. Packaging must dereference dependencies into a root-controlled runtime (ordinary pnpm symlink layouts are intentionally rejected). This authorization inventory is distinct from a capsule build manifest: capsule rows/symlinks/ABI diagnostics are not automatically a dispatch authorization.

Custodian CLI: pinned Node runs pinned `dist/linux-development/native-cli.js` with exactly one of `run`, `status`, `readreceipt`; this private path requires UID993. Existing developer SSH UID994 instead runs `dist/linux-development/native-observer.js status` or `readreceipt`, reading only `/var/lib/ai-linux-results/public-receipt-001/handoff.json`. Root preprovisions public directory993:985 mode02750; sanitized handoff is993:9850640, single-link, exclusive/fsynced. Custodian needs group985 solely for this separate public publication, never credential access sharing. Observer does not open credential HOME, private claims/store, authenticate, repair or launch. Missing/unpublished handoff is unavailable, not success/in-progress proof. These paths require separate approved Linux provisioning; no SSH change or custodian SSH identity is implied. Credential enrollment remains a separate later human action.

## Root/systemd cgroup provisioning (not performed by the CLI)

Root/systemd must provide a real cgroup-v2 domain delegation at the fixed path, with root-owned immutable parent controls and these exact readbacks:

| systemd policy | cgroup file | value |
|---|---|---|
| MemoryHigh=512MiB | memory.high | 536870912 |
| MemoryMax=640MiB | memory.max | 671088640 |
| MemorySwapMax=0 | memory.swap.max | 0 |
| CPUQuota=100%, CPUQuotaPeriodSec=100ms | cpu.max | 100000 100000 |

The parent directory is root-owned, not writable by UID 993; fixed `control`, `proposer`, `reviewer` subgroups are precreated. Role directories are UID 993 with no group/other write. Root must delegate role controller/procs writes and common-ancestor `cgroup.procs` migration permission to UID 993; **do not delegate parent resource-control writes**. Supervisor starts already inside `control`, as its only PID. Parent direct procs and both role groups must be empty. No role subgroup creation or privilege escalation is attempted. Parent cap includes the supervisor and all groups; each role additionally gets the same limits read back before launch. cgroup namespace must expose the exact absolute paths (otherwise fail closed). This is a trusted fixed-worker resource boundary, not a sandbox for arbitrary hostile code.

Root/systemd service policy must include `Slice=-.slice`, `User=993`, `Group=984`, `SupplementaryGroups=985`, `Delegate=cpu memory pids`, `DelegateSubgroup=control` (supported systemd required), `MemoryHigh=512MiB`, `MemoryMax=640MiB`, `MemorySwapMax=0`, `CPUQuota=100%`, and `CPUQuotaPeriodSec=100ms`. Its fixed `ExecStart` is pinned `bin/node --disable-proto=throw .../dist/linux-development/native-cli.js run`; remove NODE_OPTIONS/NODE_PATH/credential/provider environment before startup. A separately approved **root provisioning** step must create role groups, keep parent directory/resource controls root-owned and delegate only subgroup controls/migration as above (systemd's default broad chown delegation is not sufficient). The CLI neither installs a unit nor invokes systemd or that provisioning step. Service restart cannot replay because claim.json is exclusive. No deploy-ready unit is claimed without this root provisioning implementation and actual systemd-version verification.

Worker writes its own PID into its fixed role subgroup before loading host/provider code. Before launch and after child close, the launcher inspects the **whole delegation**, so movement to control/other role or descendants cannot be mistaken for settlement. Success requires close observed, exit 0, no signal/spawn error/output overflow, role `populated 0`, empty `cgroup.procs`, no descendant groups, and whole delegation containing only the supervisor PID. Unknown is conservatively immediate if a descendant has not yet exited at close; no grace-period retry, kill, `cgroup.kill`, or relaunch. A 45-second timeout retains the process fence and consumes/discards late streams. Public result never depends on exit alone.

## Durable ordering and public boundary

Exclusive `claim.json` is fsynced, then its directory fsynced, **before** store creation/launch/provider. Existing claim prevents another run regardless of root authorization UUID. Existing DevelopmentStore records each role intent before launch and settlement before moving to reviewer. Store anchor and terminal `handoff.json` are exclusive, fsynced files. Capability issuance and the final HTTP admission recheck reopen the journal and reject terminal UNKNOWN/result, role settlement, wrong/missing intent and handoff; delayed workers cannot re-admit after those records. A request already in flight cannot be retroactively undone, so uncertainty remains UNKNOWN/no-replay. No caller can supply a journal/launcher to the production CLI. Public handoff/status is schema-filtered IDs, hashes, session IDs, result and bounded evidence references, not private artifacts, raw errors, prompts or tokens.

`NATIVE_FIXED_DATA_ADVISORY_PASS_ONLY` requires both serial settled roles with different sessions. It is not Qualification/Human/production approval, not candidate-code execution, and not FAST OS proof. The offline injectable API can only return `OFFLINE_CONTRACT_PASS_NOT_NATIVE`; injected settlement strings are explicitly relabeled `OFFLINE_OBSERVATION_ONLY`.

## Unverified/missing deployment prerequisites

No live systemd/cgroup/ACL/capability/ptrace/namespace or OAuth/provider exercise was performed by this worker. The host transport seam is integrated, but root provisioning/launcher setup implementation, supported Human enrollment entry, Linux capsule/dependency and ABI verification, actual observer LinuxSSH access and independent Linux settlement observations remain incomplete. Root must exclude hostile same-UID processes and writable ACL/capability/mount aliases; mode-bit checks alone do not prove those. These requirements cannot be enabled by runtime environment flags or offline fixtures. Until they exist the native CLI is fail-closed, not completed native E2E. See `linux-native-offline-approval.md` for one consolidated next-approval boundary.
