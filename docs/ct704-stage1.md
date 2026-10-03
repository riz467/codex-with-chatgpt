# RC-02 Stage 1 — KVM executor proof closure

Stage 1 is closed as a **technical KVM sandbox proof**. It does not authorize,
deploy or start production execution.

Current closure state (2026-10-04):

- Stage 1 technical proof: **PASS**
- final clean-room substrate: **KVM**
- former LXC / CT704 execution route: **RETIRED**
- `productionExecution`: **DISABLED**
- live-runner authority field: **UNRESOLVED_UNTIL_HUMAN_BOUNDARY_REVIEW**
- Review PASS is not Human Approval, a permit, production activation or DONE.

The historical `ct704-*` filenames are retained only for evidence continuity.
They are not evidence that CT704 remains an executable Stage 1 target.

## Why the LXC route was retired

The original Stage 1 experiment used an unprivileged Debian LXC guest with
`nesting=0`. Bubblewrap could not establish the required sandbox boundary
without weakening the container constraints.

The failed LXC result was accepted as a boundary result. The following fallbacks
remain prohibited:

- privileged LXC
- `nesting=1`
- AppArmor/seccomp relaxation
- setuid tricks
- direct-process fallback
- shared/NAS mounts
- importing review, signing, approval or production authority into the executor

Stage 1 therefore moved to KVM rather than weakening the sandbox.

`scripts/ct704-stage1-human.sh` is now a fail-closed retirement sentinel. It
must not be used to reach a guest or hypervisor. Invocation exits non-zero before
performing infrastructure operations. Any future Stage 1 rerun requires a new
bounded, human-reviewed KVM plan; the old LXC procedure must not be revived.

## Runtime used by the proof

The final proof used Debian 13 KVM guests and the official Node **26.10.0**
glibc Linux-x64 archive. The archive SHA-256 used by the proof was:

`ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022`

The guest preparation included `bubblewrap`, Git, CA certificates, `wget`,
`xz-utils`, `libstdc++6`, `libgcc-s1` and `libatomic1`. Node and Git loader /
shared-library closure was materialized into the sealed runtime rather than
binding the host `/lib` or `/usr` trees.

The FAST runtime additionally contained fixed, reviewed local files only:

- `/etc/hosts`
- `/etc/nsswitch.conf` with `hosts: files`
- `/runtime/git-excludes` containing only `/node_modules/`

No `resolv.conf` was added and `--unshare-net` remained in force.

## Stage 1 execution contract

The proof exercised these boundaries:

1. **CAPSULE** — sealed Node runtime and dependency closure
2. **BWRAP** — KVM guest can execute the fixed bubblewrap namespace contract
3. **DL2_C** — malicious sandbox fixture remains contained
4. **D1** — OpenCode compatibility capsule stays proposal-only, with no review
   authority and zero provider calls in the synthetic compatibility probe
5. **E0_FAST** — FAST verification runs inside the sealed KVM sandbox

The live runner reports the exact phase state and fails closed. A failed phase
is `FAIL`; later phases are `SKIP`. There is no security-relaxing retry path.

The D1 compatibility capsule removes review-only imports and branches through a
host-owned AST specialization. Any unexpected review reference or source drift
is `HOST_ADAPTER_HARNESS_DRIFT`, not permission to weaken the capsule.

Native `.node` dependencies are walked deterministically and inspected with
`ldd`. Missing, uninspectable, symlink or other non-regular dependency entries
fail closed.

## Final clean-room proof

A diagnostic KVM guest first established that the substrate could satisfy the
sandbox contract. The final evidence was then reproduced in a fresh guest,
not a clone of the diagnostic VM.

Final clean-room guest:

- VMID: **112**
- node: **pve5**
- hostname: `rc02-cleanroom-112`
- Debian genericcloud image
- 2 cores / 2048 MiB
- CPU type `host`
- `local-lvm`
- `vmbr0`, firewall enabled
- DHCP
- `onboot=0`
- protection enabled
- no-authority tag

Final live result:

```json
{"stage":"RC02_STAGE1","results":{"CAPSULE":"PASS","BWRAP":"PASS","DL2_C":"PASS","D1":"PASS","E0_FAST":"PASS"},"productionExecution":"DISABLED","authority":"UNRESOLVED_UNTIL_HUMAN_BOUNDARY_REVIEW"}
```

The separate boundary audit then confirmed the Stage 1 guest identity had no
sudo grant or supplementary groups, no Stage 1 listener, no PVE/Docker/Podman/
Tailscale/approver/review authority paths, no PVE ACL/token relationship, and
no production execution enablement. That audit is evidence about this bounded
proof; it does not create production authority or change the live-runner field.

Proof artifact retained outside the removed test guests:

- artifact: `rc02-stage1-kvm-20261004-001246.tar`
- SHA-256: `63e1c8e308ffad36b50595da5a04f6c98488d02a06f435e6155b448feab20d26`
- clean-room log SHA-256:
  `70b3d0fd58e747ff10b12661d7d0461716c97f621bfa4c7f34cdb79a1c8b87e4`
- boundary-audit SHA-256:
  `afa3bee5d05fe6f83c1dc348c96e6010c9bcfdc6e9a93f5b6cd5639fe89927bf`

## Cleanup

The diagnostic KVM guest, clean-room KVM guest, temporary cloud image,
clean-room temporary directory and former CT704 LXC test environment were
removed after evidence capture.

Stage 1 does not depend on any surviving test guest.

## What Stage 1 does not authorize

Stage 1 establishes only the bounded sandbox proof above. It does **not**
establish or authorize:

- a Production KVM Executor service
- Production Executor activation
- provider/OAuth credential custody
- review, signing or approval authority inside the executor
- commit or push authority
- deployment or runtime reload
- production network access
- Human Approval or Passkey substitution

Production KVM Executor work must use a new contract and a new activation gate.
The retired LXC wrapper is not a migration path to production.

Before Production Executor activation, negative E2E coverage must demonstrate
that unreviewed candidate/test execution cannot successfully read host
credentials or repo-external files, obtain unapproved network access, spawn a
host-side process, mutate canonical/controller/verifier state, or escalate an
MCP/tool surface into generic shell/Python/arbitrary-path execution. Sandbox
completion must leave no host-side change outside the explicitly bounded
evidence path.

## Status semantics

- **Stage 1 PASS**: the recorded KVM technical proof completed all five live
  phases and the separate bounded authority/boundary audit passed.
- **Review PASS**: independent review evidence only; never Human Approval.
- **Human Approval**: separate explicit human action.
- **Permit / production execution**: separate later control-plane state.
- **DONE**: not implied by any Stage 1 result.

`productionExecution=DISABLED` remains the production state at Stage 1 closure.
