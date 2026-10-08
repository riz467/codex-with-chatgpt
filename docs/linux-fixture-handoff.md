# Offline Linux fixture source handoff

## Status and scope

The ZIP is **SOURCE_READY**, not **OFFLINE_READY**. Dependency closure is
**BLOCKED / NOT_INCLUDED_NOT_VERIFIED**. No Linux dependency cache, Node or
PowerShell distribution is provided by this tool. A source archive passing
validation does not establish Linux test PASS or provider qualification.

Python **3.12+** and Git are required to build; Python 3.12+ alone verifies and
extracts. The tool reads only Git blobs at an explicit full commit SHA, never
worktree files or `node_modules` (including the Windows junction). It includes
allowlisted source extensions under `src/`, `tests/`, `scripts/`, the package and
pnpm lock/workspace files, TypeScript/Vitest configuration, LICENSE, README and
four essential Linux documents. Dotfiles, HOME, secrets, runtime, ledger,
sessions, build outputs, `.tooling` and other paths are excluded or rejected.
`.npmrc` is deliberately omitted: its local store path is not dependency closure.
Tracked links in the selected source set fail the build. Common private-key and
token patterns fail the build; this is not a comprehensive secret detector.
Review the exact manifest inventory and source content before handoff.

## Build only after the final implementation commit

In PowerShell, in the source repository:

```powershell
$commit = git rev-parse HEAD
python -B tests/linux-fixture-bundle-test.py
python -B scripts/linux-fixture-bundle.py build --commit $commit --output C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/phase16-handoff
```

The final commit must contain this tool, its test and this document. No commit,
checkout, remote push or transfer is performed. The output name contains the
full commit: `linux-fixture-source-<commit>.zip`, with adjacent `.sha256` and
`.manifest.json`. ZIP entries have fixed timestamps and recorded regular-file
modes. The manifest lists every source file's SHA-256, byte length and mode, plus
direct dependency declarations and the pinned package-manager version. The
hashed `pnpm-lock.yaml` supplies resolved transitive dependencies and integrity
metadata; `package.json` alone is insufficient (some declarations use `latest`).
Existing ZIP outputs are refused.

## Independent validation and extraction on Linux

Obtain the small verifier script, approved full commit and ZIP SHA-256 through
the trusted handoff record. Do not run a script first extracted from an
unvalidated archive. The verifier needs neither Git nor the original repository.
An archive's self-declared commit/manifest is not authentication; the independently
trusted ZIP digest binds the approved artifact. Do not trust a replaced adjacent
checksum file as an independent trust anchor.

Use a private directory owned by the non-root fixture user, with no concurrent
writers; the extraction directory must not already exist. Example (replace the
three uppercase placeholders):

```sh
python3 -B /trusted/linux-fixture-bundle.py verify \
  --archive /handoff/linux-fixture-source-COMMIT.zip --commit COMMIT --sha256 SHA256
python3 -B /trusted/linux-fixture-bundle.py extract \
  --archive /handoff/linux-fixture-source-COMMIT.zip --commit COMMIT --sha256 SHA256 \
  --destination /fixture/source
```

Validation happens before writing: archive digest, commit, complete manifest
membership, each file hash/size/mode, path allowlist, missing/extra entries,
duplicate/case-colliding names, traversal, absolute/backslash paths, links,
special files and unsafe modes. Archive expansion is bounded to 128 MiB/10,000
entries. Extraction writes individual regular files, never `extractall`, rejects
existing destinations and symlink/junction ancestors, and preserves executable
bits. Run only in the private directory: it is not a defense against another
process with the same user's write access racing the extraction.

## Missing dependency artifacts: offline readiness gate

Before calling this OFFLINE_READY, separately provide and record hashes,
versions, Linux architecture/libc and provenance for:

- Node **24.16.0** (Windows baseline; Linux build not yet acquired), pnpm **11.24.0**, Git, Python 3.12+ and PowerShell **7.5+**
  (7.6.6 recommended). The runner uses `/usr/bin:/bin`; its children need Node,
  Git and `/usr/bin/pwsh` available there. PowerShell `-DateKind String` is required.
- A complete pnpm store for this exact lockfile, including development and Linux
  optional/native packages (not Windows `node_modules` or its junction). Resolve
  the target architecture/libc variants of esbuild, Rollup and any other locked
  native dependencies. No store completeness has been established here.
- Any native build inputs required by the lockfile and its `pnpm-workspace.yaml`
  build policy. Do not weaken that policy to make installation succeed.

In the egress-blocked disposable Linux fixture, with an empty dedicated HOME,
install from the independently supplied store:

```sh
cd /fixture/source
pnpm install --offline --frozen-lockfile --store-dir /fixture/pnpm-store
node scripts/verify-linux-portability-fixture.mjs
```

Do not use Corepack/network bootstrap in the offline run; the pinned pnpm must
already be available. A missing package or platform artifact is **BLOCKED**, not
a reason to fetch dependencies or relax the lockfile. Store acquisition and Linux
provisioning are separate work; this source handoff performs neither.

The fixed suite imports TypeScript sources through Vitest; no `dist` build is
required to run it. To additionally check release packaging in this disposable
directory, use `node node_modules/typescript/bin/tsc -p tsconfig.json` followed by
`node scripts/copy-runtime.mjs`. Never copy that build to a production directory.

Required inherited setup is only the toolchain and private writable fixture
directory. The runner supplies PATH, LANG, fresh HOME/XDG/C2C state, CI and
isolated Git config. Provider keys, OPENAI_BASE_URL, OPENCODE_* overrides,
SSH_AUTH_SOCK, proxy/auth/token settings and operational state paths must not be
supplied; they are not forwarded by the runner's environment allowlist. No
operational OpenCode configuration/plugins may exist in fixture ancestors.

## Fixed-13 qualification and pass criteria

Use the existing runner exactly, without caller-selected test paths. It selects:
`linux-portability`, `linux-process-lifecycle`, `owned-process`,
`bounded-process-lock`, `bounded-worker-termination`, `proposer-powershell`,
`bounded-task`, `bounded-campaign`, `bounded-reference-evidence`,
`semantic-session-transport`, `review-workspace-info`, `mcp-integration`, `opencode-binary`
(all `tests/<name>.test.ts`).

| Contract | Expected evidence |
|---|---|
| Linux identity/path | Case-distinct directories stay distinct; alias and invalid boundaries reject |
| PowerShell transport/binary | Real PS functions enforce SHA/version/auth/agent/tools=0 with fake API; Human exe changes are irrelevant |
| Process lifecycle | Real child/grandchild group exits, including leader-first exit; peer survives; timeout uncertainty stops retry |
| Locks/recovery | Foreign/legacy locks preserved, finite retry, no duplicate dispatch, sealed recovery |
| Review/commit | Independent review binding, incomplete commit reconciliation and retained evidence |
| Runner receipt | Exactly 13 suite files, consistent totals, every assertion passed; provider NOT_RUN |

Run as non-root on disposable Linux with egress blocked, no operational mounts,
credentials or provider environment, and a reaping init. The runner creates its
own empty HOME/XDG/state and scrubbed child environment. A PASS requires exit 0,
all 13 unique files present, every assertion passed, totals consistent and no
skip/pending/timeout. Preserve the printed evidence directory's `receipt.json`,
`vitest.json`, stdout and stderr together with commit, source manifest, trusted
ZIP digest and dependency/environment inventory. Windows test results, source
verification and successful dependency installation are not Linux fixed-13 PASS.

`provider_qualification: NOT_RUN` and `production_dispatch: DISABLED` remain
separate from offline fixture success. No OpenCode/provider qualification,
runtime/service modification, VM modification or production deployment is part
of this handoff.
