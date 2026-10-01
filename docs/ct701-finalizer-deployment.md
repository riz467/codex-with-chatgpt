# CT701 deployment package / offline validation

This phase builds and tests a package only. No CT701 deployment, production keys,
service restart, CT700 modification, SSH, PVE or Tailscale operation is performed.
The following host procedure is for the **next phase, after human approval**.

## Service boundary

The strict production template preserves the existing four absolute paths and
binds **127.0.0.1:7010 only**. It selects `deny-all`: health works, but standalone
issuance/consumption cannot acquire a trusted provider or execution bridge.
Enabling a real provider requires a separately reviewed implementation/package;
editing config to `host-injected` is rejected by this deployment contract.

## Reproducible package

Use the checked-in pnpm lockfile, the pinned package manager, and Node **v24.16.0**
(the tested runtime). On an offline build host with its dependency store already
populated, `pnpm install --offline --frozen-lockfile`, then:

```text
pnpm typecheck
pnpm test
pnpm finalizer:pack
pnpm finalizer:verify-package
```

`finalizer:pack` has fixed inputs and output, and refuses to overwrite an existing
`.tooling/ct701-finalizer-package`. Preserve the previous artifact before explicitly
removing that generated directory to rebuild. No production secrets are inputs.
The manifest records the exact Node version and SHA256 of every file, with sorted
names and no timestamps. Equal source/dependency bytes yield the same manifest
SHA256. The build copies the service's local import closure and express/zod's
resolved dependency trees, with regular files instead of pnpm symlinks. Dependency
versions come from the installed frozen lockfile; deployment never fetches from a
registry or runs dependency lifecycle scripts. License files remain included.
The lockfile is included for provenance; the hashes pin the actual artifact.

```text
.tooling/ct701-finalizer-package/
  manifest.json                  # package ID = SHA256 of these exact bytes
  package.json                   # private ESM runtime
  pnpm-lock.yaml
  README.md                      # this deployment procedure
  config.json
  ct701-typed-action-finalizer.service
  install.sh / verify.sh / rollback.sh
  runtime/typed-action-finalizer/{cli,server,deployment,deployment-cli,...}.js
  runtime/typed-action-approval/{contract,verifier}.js
  runtime/mcp/typed-actions.js    # contracts only, no Git adapter or MCP server
  node_modules/{express,zod}/... # includes nested runtime dependencies
```

The manifest is integrity metadata, not a signature. Record its hash in the
human-approved release record through a trusted channel. A hash supplied only
alongside an untrusted artifact is not approval. The OS-provided `/usr/bin/node`
must match the recorded version, be root-owned and not group/other writable;
record its OS package provenance/binary hash in the next-phase host record.

## Fixed layout and permissions

| Path | Owner/group | Mode |
| --- | --- | --- |
| `/opt/ct701-typed-action-finalizer`, `releases`, each release directory | root:root | 0755 |
| release files, including config and unit | root:root | 0644 |
| `/etc/systemd/system/ct701-typed-action-finalizer.service` | root:root | 0644 |
| `/etc/ct701-typed-action-finalizer` | root:ct701-finalizer | 0750 |
| `signing-key.pem`, `bridge-token` | ct701-finalizer:ct701-finalizer | 0600 |
| `ct700-public.pem`, `ct700-public.pending.pem`, `ct700-public.sha256` | root:root | 0644 |
| `/var/lib/ct701-typed-action-finalizer` | ct701-finalizer:ct701-finalizer | 0700 |
| `ledger.sqlite`, SQLite `-wal` / `-shm` files | ct701-finalizer:ct701-finalizer | 0600 |
| `/var/cache/ct701-typed-action-finalizer`, package directories | root:root | 0755 |
| staged files, `approved-package.sha256` | root:root | 0644 |

The dedicated system account is `ct701-finalizer`, with a same-name primary group,
no supplementary groups, `/nonexistent` home and `/usr/sbin/nologin` shell.
The Debian-style system UID range is 1–999. Existing unsafe accounts or permissions
are rejected, not silently repaired. All ancestry must be canonical and protected.
Secret/public/config/ledger paths and package entries reject symlinks; hard-linked
regular files are rejected. The only deliberate symlinks are root-controlled
`current` and `previous`, restricted to `releases/<64 lowercase hex SHA256>`.
All releases are checked against their content-addressed directory names.

## Next-phase fixed host procedure

An approved operator stages the reviewed regular-file package at exactly
`/var/cache/ct701-typed-action-finalizer/package`, with the permissions above.
Put the independently approved manifest hash (64 lowercase hex characters and
newline) in `/var/cache/ct701-typed-action-finalizer/approved-package.sha256`.
Verify the staged tool itself against the approved artifact before running it.
No script accepts a source, destination, shell command, plugin, URL or root prefix.
The root-prefix constructor is a trusted in-process fixture seam only.

The CLI is always invoked through this fixed command, followed by **one** action:

```text
/usr/bin/node --jitless /var/cache/ct701-typed-action-finalizer/package/runtime/typed-action-finalizer/deployment-cli.js ACTION
```

Use a clean Node environment (no `NODE_OPTIONS`/`NODE_PATH`). Actions in order:

1. `dry-run`: verify inventory, all hashes, strict config, exact runtime and approval
   pin. It does not provision an account, directory, lock, key, DB, pointer or unit.
2. `initialize`: create/validate the dedicated account and protected directories.
3. `bootstrap-key`: exclusively create the Ed25519 PKCS8 signing key in its fixed
   host path. Validate type/owner/mode. Output only the public SPKI DER SHA256
   fingerprint. An existing file, including a symlink, always rejects overwrite.
   Never run this action in a repository or copy the private key into one.
4. `bootstrap-token`: exclusively create a base64url token from **32 CSPRNG bytes**
   (`crypto.randomBytes`). No token value is printed. Existing token rejects.
5. Obtain CT700's **public** Ed25519 SPKI PEM through the existing human-approved
   export channel, without changing CT700. Stage it as `ct700-public.pending.pem`.
   Independently confirm SHA256 of the SPKI **DER** encoding and put that fingerprint
   in `ct700-public.sha256`. `install-human-key` checks this pin, PEM type, ownership
   and modes, and exclusively installs `ct700-public.pem`. Startup and verification
   recheck the root-owned pin, detecting replacement by a different Ed25519 key.
6. `initialize-ledger`: run a fixed child as the service uid/gid with umask 0077.
   Create an absent ledger using the service-owned v1 schema. An existing ledger
   must pass exact schema/trigger/integrity checks; never repair or reset it.
7. `install`: check approval hash, runtime, keys, token, ledger and config; stage the
   content-addressed release; verify the staged copy; install the identical fixed
   unit; update `previous`, then atomically rename `current.next` to `current`.
   Reinstalling the same hash is a no-op. Changed unit bytes require a separately
   reviewed migration, so rollback cannot silently use the wrong sandbox.

Every mutating deployment action requires the service already inactive/failed.
The scripts never stop, enable, start, reload or restart a production service.
An exclusive `/run/ct701-typed-action-finalizer-deployment.lock` serializes writes.
Failed operations leave unreferenced state for investigation; no catch handler
deletes authority data. Stale locks or `.next` pointers require operator inspection.
An interrupted copy cannot pass inventory verification and cannot become current.
This is atomic pointer publication on POSIX, not a cross-file power-loss transaction;
after host/storage failure inspect pointers and ledger before any activation.

The wrapper scripts are regular files; invoke with `/bin/sh`:

```text
/bin/sh /var/cache/ct701-typed-action-finalizer/package/install.sh --dry-run
/bin/sh /var/cache/ct701-typed-action-finalizer/package/install.sh
/bin/sh /opt/ct701-typed-action-finalizer/current/verify.sh
/bin/sh /var/cache/ct701-typed-action-finalizer/package/rollback.sh
```

## systemd validation and future activation

The unit enables NoNewPrivileges, PrivateTmp/PrivateDevices, ProtectSystem=strict,
ProtectHome, ProtectKernelTunables/Modules/Logs, ProtectControlGroups,
RestrictNamespaces, RestrictSUIDSGID, LockPersonality, MemoryDenyWriteExecute,
empty CapabilityBoundingSet/AmbientCapabilities, and umask 0077.
Node runs with `--jitless` to avoid JIT executable-memory conflicts. SQLite only
needs ledger directory writes (including WAL/SHM). PrivateTmp is private scratch
space; no other persistent application path is writable. AF_UNIX/AF_INET are
allowed; IPAddressDeny=any plus IPAddressAllow=127.0.0.1/32 provides defense in depth.
The application/config independently prohibit wildcard or external binding.

Before activation in a disposable Linux/systemd fixture matching CT701, run:

```text
/usr/bin/systemd-analyze verify /etc/systemd/system/ct701-typed-action-finalizer.service
/usr/bin/systemd-analyze security ct701-typed-action-finalizer.service
```

Confirm the host supports the sandbox directives and cgroup/BPF IP filtering,
and run the unit plus verify procedure in that disposable fixture. This Windows
work session cannot establish systemd/kernel compatibility. The next phase's
approved operator separately performs daemon reload / enable / activation and
records those results. None of those actions are implemented in install/rollback.

## Fixed verification

`verify.sh` checks the current release inventory/hash/config, root-owned unit bytes,
exact secret/public owner/mode, Ed25519 type, CT700 pin, token shape, protected DB
directory, SQLite v1 application ID/version and exact schema including all permanent
consumption triggers, plus `quick_check`, WAL, FULL synchronous and foreign keys.
The verifier opens the ledger read-only; SQLite coordination files are handled as
the service identity. It does not initialize or repair an existing DB.

It then requires systemd enabled/active, no drop-ins, no pending daemon reload and
the expected unit fragment. `ss -H -lntup` must show exactly one listener belonging
to MainPID: TCP 127.0.0.1:7010; public/wildcard/IPv6/extra TCP or UDP listeners from
that process, or a competing listener on 7010, fail. Unrelated host services are
not treated as this service's listeners. Fixed loopback `/health` must return the
exact healthy isolated status within five seconds without redirects. `/proc`
command line and cwd must identify the selected release, preventing an old healthy
process from satisfying verification of a newly selected release.

ExecStartPre runs the same offline filesystem/config/key/schema checks as the
service user before any listener is created.

## Rollback semantics

After the approved operator has stopped the service, `rollback.sh` selects the
validated `previous` release, verifies runtime/config/unit compatibility and the
**current** ledger, and atomically changes only `current`. Repeating rollback is
idempotent; it never toggles forward. Initial install has no previous release and
rollback rejects. Keys/token/config pins remain stable across v1 releases.

**Never delete, truncate, replace, migrate down or restore the authority ledger
from backup as part of rollback.** Do not resurrect consumed Human jti, permit jti
or attempt hashes. DB version other than v1, damaged schema or unresolved outcomes
require investigation/reconciliation; an old package is not retry authorization.
Reactivation/restart is a separate approved operator action followed by verification.

## Offline test coverage and limits

`tests/typed-action-finalizer-deployment.test.ts` covers fixed layout, loopback and
hardening directives, POSIX metadata policy, public pin tamper detection, symlink
secrets/ancestry, overwrite rejection, invalid keys/config, malformed DB, package
integrity/idempotency, fixed CLI arguments, byte-preserving rollback with permanent
consumed identities, health, listener rejection, dry-run immutability and jitless
Ed25519/SQLite. Existing service tests also cover malformed startup and replay
rejection across real service restarts.

Windows fixtures use temporary Linux-like directory trees and directory junctions;
POSIX uid/mode checks are tested as a pure policy. Windows junction publication
does not claim POSIX atomic rename semantics. Linux fixture execution requires a
disposable root container for real ownership checks, never a production host.
`finalizer:verify-package` copies the built artifact outside the checkout, loads its
bundled dependencies, and tests real jitless health/start/stop/restart and malformed
DB rejection using only temporary keys/ledger and ephemeral loopback ports.
It never invokes the production CLI or systemctl. Actual systemd activation,
Linux DAC enforcement and kernel sandbox behavior remain next-phase validations.
