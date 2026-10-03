# CT704 RC-02 Stage 1 — bounded human-admin execution

Preparation only. No production service/dispatch, approval, review, signing,
provider credentials, Tailscale or shared mount is installed. No commit/push.
The systemd-257 nesting warning is not a failure; actual sandbox execution is
the deciding evidence. Never enable nesting/keyctl or relax AppArmor/seccomp.

## Runtime decision (observed 2026-10-03)

Node **26.10.0**, official glibc Linux-x64 tarball, root-owned under
`/opt/node-v26.10.0-linux-x64`; use absolute executable/controlled PATH.
Official [index](https://nodejs.org/dist/index.json) lists it as newest 26.x.
[Release](https://nodejs.org/en/blog/release/v26.10.0) is Current, not yet LTS;
[schedule](https://github.com/nodejs/Release/blob/main/schedule.json) puts LTS
at 2026-10-28 and EOL at 2029-04-30. This is the current cumulative patched
release, not a claim that its `security:false` means a security-only release.
Archive SHA-256 from official SHASUMS256.txt:
`ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022`.
TLS + pinned hash verification, not an independent PGP signature verification.
Before delayed execution, recheck release/security notices; do not silently
substitute another version.

Debian packages: `bubblewrap git ca-certificates wget xz-utils libstdc++6
libgcc-s1`, with apt's ordinary dependency closure (libc/loader etc.). Existing
Debian Bash, coreutils, tar, util-linux/runuser, passwd/useradd and Python3 are
used. No curl, compiler toolchain, pnpm, Docker or setuid sandbox is needed.
Debian's [pool](https://deb.debian.org/debian/pool/main/b/bubblewrap/) currently
contains trixie update `0.12.0-1~deb13u1`; use the configured signed trixie apt
sources, not sid or a hand-built binary. Actual apt candidate/flags and kernel
permission remain live checks, not inferred from this pool listing.

Host tooling: `vitest@3.2.7 zod@3.25.76 typescript@5.9.3 tsx@4.23.12`, matching
the repository's resolved versions. Install into a separate npm scratch
manifest, no lifecycle scripts or ambient npm config; retain its actual lock
as `stage1-tooling-lock.json`. No repository policy/manifest is rewritten.
Native platform optionals (esbuild/Rollup) are acquired by npm without install
scripts; failure to load them is a failure, not permission to enable scripts.
Transitive tooling dependencies are resolved at preparation time and recorded,
not yet a pre-certified reproducible graph.

## Files / entrypoints

`scripts/pack-ct704-stage1.mjs` produces `stage1-files.json`, the exact source
inventory: selected existing tests and their static relative import closure,
D.1's host-read adapter sources, manifests/policies and the three guest scripts.
No whole repository clone, `.git`, `.ai`, `dist`, Windows dependencies or
authority services are transferred. Source containing synthetic contract
records is fixture data, not signing/delegation authority.

- DL2-C: `sandbox.ts::runSandboxFixture`, existing test `LIVE Linux:`.
- Capsule: `ct704-stage1-runtime.mjs`, Node+actual `ldd` loader/library closure.
  Root-owned regular files, empty mountpoints; no host `/usr` bind.
- D.1: existing `verify-opencode-compatibility.mjs --acquire --candidate 2.0.22`.
  Certify the current pinned core, not an unrequested upgrade. Its npm scratch
  acquisition uses network; candidate execution denies network through Node
  permissions and uses only synthetic OAuth/provider data, zero provider calls.
  No real enrollment or credentials are used. Official Linux npm layout is now
  supported alongside the existing Windows layout.
  Node26 wraps socket permission errors in `errno` (and fetch in `cause`);
  the existing network-denial recognizer now follows both object wrappers while
  still requiring the original `ERR_ACCESS_DENIED` with `permission: Net`.
- E0: existing `Linux live malicious-test fixture`; sealed FAST runtime includes
  Git+loader/libs, trusted verification scripts and regular-file dependencies.
  Host test calls genuine mutation/store/FAST handles; no production candidate.

## Exact preparation and live plan

On the development PC, from `C:\work\codex-with-chatgpt`, use a NEW directory:

```powershell
node scripts/pack-ct704-stage1.mjs C:\work\tmp\ct704-stage1-reviewed
tar -cf C:\work\tmp\ct704-stage1-reviewed.tar -C C:\work\tmp\ct704-stage1-reviewed .
Get-FileHash C:\work\tmp\ct704-stage1-reviewed.tar -Algorithm SHA256
```

Human reviews the inventory and artifact hash, transfers the tar plus
`scripts/ct704-stage1-human.sh` by the existing human-admin route, without
forwarding keys/agent/credentials into the guest. Before connecting, compare
CT704's current placement in the PVE documentation inventory. On **pve5**:

```bash
sha256sum /path/to/ct704-stage1-reviewed.tar # compare PC hash out of band
bash /path/to/ct704-stage1-human.sh /path/to/ct704-stage1-reviewed.tar
```

The wrapper checks CT704 only, its running state, name, IP, unprivileged/nesting/
keyctl/mount/security boundary. It creates only a fresh guest destination and
executes the guest script via `pct exec 704`; CT config is compared after exit.
It never calls `pct set`, restarts a guest, or mutates any PVE resource.
Guest provisioning creates a dedicated non-login user and two capsules, then
executes `ct704-stage1-live.mjs` in a clean environment as that user. No unit,
listener or autostart is installed. Temporary package/cache side effects are
ordinary guest preparation, not authority or isolation failures.

The live runner requires an actual passed assertion, **not** Vitest exit 0 with
a skipped live test. Sequence: capsule execution → DL2-C → D.1 network-denial
fixture + real synthetic compatibility capsule → E0 malicious FAST fixture.
On failure, stop; retain exact bwrap stderr. Do not retry with broader grants.
`Operation not permitted` establishes failure, but not which host policy denied
it: human may consult existing pve5 kernel/AppArmor logs read-only for the exact
cause. No automatic recovery/constraint weakening. Fresh-only installer does
not overwrite existing identities/capsules; review partial preparation manually.

## Required authority review (separate from sandbox PASS)

After fixtures, human-admin performs bounded, read-only inspection inside CT704:

```bash
pct exec 704 -- id rc02-stage1
pct exec 704 -- find /root /home /var/lib/rc02-stage1 /etc/rc02 /opt/rc02-stage1 -maxdepth 4 -type f \( -name auth.json -o -name '*.env' -o -name 'id_*' -o -name '*token*' -o -name '*signing*' -o -name '*approval*' \) -printf '%p\n'
pct exec 704 -- find /etc/sudoers.d -maxdepth 1 -type f -printf '%f\n'
pct exec 704 -- systemctl list-unit-files --no-pager
pct exec 704 -- ss -lntup
pct exec 704 -- findmnt -rn -o TARGET,FSTYPE
pct exec 704 -- sh -c 'for p in /etc/pve /run/pve /run/docker.sock /run/podman/podman.sock /var/lib/tailscale /etc/rc02-approver /etc/rc02-review; do test ! -e "$p" || printf "REVIEW_UNEXPECTED_PATH:%s\n" "$p"; done'
```

Missing optional directories in `find` are harmless, not failed invariants.
Inspect sudo policy and any findings privately; do not print credential contents.
Confirm the new user has no supplementary admin groups/sudo/capability grants,
outbound PVE credentials, agent socket, provider/OAuth material or approval/
review/signing keys; no authority service is active. System SSH host keys,
public CA stores, source code referring to tokens, and synthetic D.1 credentials
are not authority findings by themselves. Review inherited guest root bootstrap
credentials/configuration privately, including locations not listed above if
the baseline used any. Human must attest no authority was transferred and no
PVE ACL/token grant exists for a CT704 identity. Guest filesystem checks cannot
prove a cluster-side ACL or credential absence exhaustively.

## Status semantics / current local result

- **PASS**: on checksum-verified official Windows Node26.10.0, five focused test
  files: **124 passed / 3 skipped**. Includes actual permission-denied fetch/http/
  https/net attempts against an accepting loopback listener (zero connections).
  Typecheck, Bash/JS syntax, package inventory and diff checks also pass.
  This is not Linux kernel certification. An initial standalone Node26 run
  exposed the errno-wrapper incompatibility (now fixed); npm-dependent mock
  tests were rerun with the complete official distribution, not a bare node.exe.
- **SKIP**: local Linux DL2-C, Linux E0 and opt-in registry D.1 certificate test.
- **FAIL**: any live subprocess/assertion failure; remaining steps not executed.
- **UNRESOLVED**: CT704 kernel namespace/bwrap support, actual Debian loader/native
  tooling execution, D.1/E0 live results and human authority review until run.

`CT704 STAGE1 READY FOR LIVE EXECUTION` means the bounded verification artifacts
are prepared, **not** Stage 1 passed. Only all five live result fields PASS plus
the separate human boundary/authority review establish Stage 1 verification.
Even then this implementation does not authorize or start production execution.
