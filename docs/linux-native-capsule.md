# Linux x64 native capsule — strict builder, artifact not yet produced

`scripts/linux-native-capsule.mjs` is a Linux-only build-host recipe. Its Windows policy
tests are not a capsule, Linux execution proof or deployment authorization.
No VM116/117 build, provider call, credential enrollment, service modification or
Bridge baseline adoption belongs to this builder.

## Fixed inputs

- Reviewed exact clean Git commit supplied explicitly; working HEAD must match it.
- Linux x64 Nodev24.16.0 SHA256
  `b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd`.
- Linux x64 OpenCode2.0.22 ELF SHA256
  `32cf5aa0a69a650e36277e3315d189835ddc79fb9aa1d0aef5025be5af5ad122`.
  This is the previous public binary pin, not a new binary download or version claim.
- pnpm11.24.0 JavaScript package payload digest
  `f082bce3f6dd1c09a74883c7b598a59e437747b2180bab605487351c45597549`.
  All455 publisher files, sorted relative path + NUL + size + NUL + bytes, including
  nested dependencies. Public registry archive SHA256
  `d1eab2433172661cc36a18ec85fce93f771db1962717329cc01ec9c2824ca24f`;
  registry SHA512 integrity checked before pin collection; no downloaded code executed.
  Builder executes its bin/pnpm.cjs explicitly with the pinned Node; no arbitrary shim.
- Prepopulated public pnpm cache for the exact frozen lockfile. No ambient npmrc,
  tokens/proxy environment, lifecycle script, online dependency fallback or local
  workstation node_modules copy. Platform packages come from a fresh Linux install.

## Linux builder command (not run on HQO or a guest)

```sh
node scripts/linux-native-capsule.mjs APPROVED_FULL_COMMIT \
  /public-inputs/node /public-inputs/opencode \
  /public-inputs/pnpm/bin/pnpm.cjs /public-inputs/pnpm-store
```

Use a nonroot Linux x64 build host with permitted unprivileged user/network/PID
namespaces, GNU tar, Git, exact public binaries/cache and target-compatible system ABI.
Executable package/compile/copy/D0/CLI version stages run under unshare network and PID
namespaces. Namespace creation failure stops; no fallback to host network or sudo.
`--map-root-user` is root only inside the newly created user namespace, not host-root
or permission to modify PVE/guest/service state. This is network/process containment,
not proof that the entire build host filesystem is a credential-free OS sandbox.
The fixed clean source/toolchain must be reviewed; use a credential-free build identity.

Output is exclusive `.tooling/linux-native-capsule`; an existing output is never
reused/deleted. Failed partial output is preserved, no automatic resume/retry.
Heavy compile/install is on the separate build host, never the2GiB Control Plane.

## Verification performed if a real Linux build succeeds

1. Git archive and original source inventory; remove only generated dist in the new
   isolated source tree before compiling. Original checkout is never overwritten.
2. Frozen/offline/no-lifecycle installs with copy imports; compile from extracted LF
   source. Independently install production dependencies into the new runtime tree.
3. Verify original regular source-file bytes outside generated dist and both lockfile
   hashes stayed unchanged. This is not a complete invariance proof of added files,
   symlink/type/mode changes or every later compile input. Package source/compiled/
   binary/dependency/native-addon hashes, relative links and finite byte/file bounds.
   Production install requests hoisted layout to avoid pnpm linking incompatible with
   strict immutable runtime custody; a final zero-link/count/byte gate rejects any
   residual links or runtime exceeding the launcher limits. The real Linux artifact
   must still prove success; hoisted installation alone is not success.
4. Check structural ELF64/x64 headers/segments for pinned binaries and native addons;
   reject PE, absolute/escaping links, hardlinks, special files and detected DB/private
   paths. These are bounded structural checks, not universal secret absence or ABI proof.
5. Deny-tools D0 core profile under OS network denial: compatible result, expected deny
   evidence, no network/process/forbidden-read observations. This is no-provider dry
   inspection, not proposer/reviewer semantic execution. Pinned CLI `--version` runs
   only with clean private HOME and namespace containment, no authentication.
6. Inventory AFTER certification, deterministic tar, relocate/extract into a different
   new directory and verify all links/hashes again. No deployment action.

The manifest labels system glibc/libraries/tools **not bundled**. ELF/addon interpreter,
shared-library/ABI loading and target compatibility still require isolated Linux
validation before deployable readiness; structure checks alone are insufficient.
The current implementation does not emit a complete ELF dynamic-library dependency
closure or authenticated target-ABI certificate. Do not remove this remaining blocker
because the binary's SHA matches.

## Current status

HQO has no WSL Linux distribution and no discovered Docker executable. No Linux
package install/compile/D0/binary/addon run, manifest or runtime.tar was produced.
Source/helper tests and Windows build logs are separate evidence only. An actual
capsule SHA cannot be supplied now and must not be fabricated from Windows outputs.
Thus capsule state is **BUILD_RECIPE_IMPLEMENTED / LINUX_ARTIFACT_INCOMPLETE**, not
LINUX_NATIVE_OFFLINE_READY. Next build needs a separately available permitted Linux
build host/cache and completion of ABI/artifact verification, not OAuth credentials.
