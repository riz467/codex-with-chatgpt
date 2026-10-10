# Linux independent entry and custody — offline preparation, live auth CLOSED

No new Phase. Reuse the VM116 fixed fixture and existing OpenCode 2.0.22 host adapter.
Qualification LIVE_BLOCKED, Production CLOSED / authority NONE remain unchanged.

## Independent Human development entry

Live read-only VM116 inspection found:

- ai-linux-dev UID994/GID985, no supplementary privilege groups, home0700 owned994/985;
  shell `/usr/sbin/nologin`, no `.ssh` or authorized_keys.
- sshd: publickey yes, password/KBD no, StrictModes yes, no AuthorizedKeysCommand/CA.
  **AllowUsers workspace** from `/etc/ssh/sshd_config.d/90-ai-control.conf` line5 excludes
  ai-linux-dev. Shell and public key alone cannot establish login.
- Documented Win11 endpoint is pve3 VM112 `.143`; VM116 is `.45`. Source address and
  direct network reachability need Human confirmation on Win11, not an HQO SSH test.
- Existing `/usr/local/bin/opencode` resolves to a root-owned ELF binary under
  `/opt/opencode-2.0.22`, package version2.0.22. CLI/service/auth was not started.

No public key has been received from Win11. Therefore **all login changes are held**.
Do not generate the private key on HQO or install an existing shared HumanAdmin key.
Human commands below are instructions for Win11 only, not commands executed by this agent:

```powershell
# On Win11 VM112, under Human control; choose a passphrase when prompted.
$Key = Join-Path $env:USERPROFILE '.ssh\ai-linux-dev-vm116'
ssh-keygen -t ed25519 -a 100 -f $Key -C 'Win11-Human-to-VM116-ai-linux-dev'
ssh-keygen -l -E sha256 -f "$Key.pub"
Get-Content "$Key.pub"  # Send only this public line + its fingerprint.
Test-NetConnection 192.168.0.45 -Port 22
```

Do not overwrite an existing key; choose a new filename if it exists. Send no private
key/passphrase/OAuth data. Keep private key ACL restricted to the Human on Win11.
Win11 remains SSH client/Human terminal: no OpenCode/Orchestration Runtime deployment.

After Human public key + current source IP are received, prepare/approve exact changes:

1. Recheck ai-linux-dev identity/home/no unexpected authorized_keys. Create only its
   `.ssh`0700 / authorized_keys0600 with the supplied fingerprint. Preserve every
   existing key; unexpected contents stop the operation.
2. Change only this new development account shell to `/bin/bash` (no sudo/PVE group).
3. Preserve `workspace` and add only ai-linux-dev to the actual AllowUsers directive,
   optionally binding to the **confirmed** Win11 source IP. This existing sshd file is
   in the 2,228file manifest: explicit approval and before/after SHA are required.
   Do not append another competing AllowUsers and assume the effective policy changed.
4. Syntax/effective peer checks first; sshd reload, if required, is separately scoped.
   No listener restart, existing connection stop, root key edit, network/Tunnel change.
5. Human verifies VM116 host key out-of-band, then fresh direct login from Win11 with
   `IdentitiesOnly=yes` / `StrictHostKeyChecking=yes`, no agent forwarding/proxy/HQO hop.
   Run only hostname, id, pwd, Git HEAD and **status** of existing fixture (not rerun).
   Record source/client identity, UID/EUID994 and existing receipt/journal SHA.

Observed VM116 Ed25519 host fingerprint:
`SHA256:+dSdb2GmhnqyO2vtWFYXDfevcO0vrZMnrRRyDz1UCtw`.
This HQO/QGA observation is not independent out-of-band host authentication.
Until fresh Win11 login succeeds, HQO-independent entry = NOT_ESTABLISHED.
Recovery must use a separately verified independent Human management route, restoring
only the scoped sshd change if necessary, retains new account/state/evidence, and never
removes unrelated keys/services. That independent recovery route remains unverified.

## Linux credential custody preparation

`src/linux-development/custody.ts` adds a **metadata-only diagnostic**, used by the
existing `provider-readiness` CLI. It reads no credential bytes, env/HOME/global auth
database and makes no network calls. Unknown/missing/inaccessible metadata fails closed.
It rejects shared custodian/executor UID, root execution, unsafe private paths,
symlinks/hardlinks, writable ancestors and developer/custodian-owned adapter runtime.

The proposed layout is `/var/lib/ai-linux-provider` private storage and
`/opt/ai-linux-provider/runtime/host-adapter.js` root-controlled runtime, with a distinct
nonprivileged **ai-linux-provider** principal. No such user/files were created live.
`credentials/host-oauth.json` is a prospective host envelope name, NOT a guessed
OpenCode database layout and NOT a file to manually fill with HQO OAuth values.
Metadata collector uses UID994 for the current deployment's untrusted developer.
Generalization to other executor UIDs needs host inventory/policy, not request fields.

Even valid metadata yields `admitted:false`, `provider:NOT_RUN`, `authority:NONE`.
Pure `assessLinuxCustodyMetadata()` takes observations for offline testing only; a
client can forge them. It does not return a credential handle or authorization receipt.
Filesystem races, ACL/capability/ptrace, privileged root reentry, full code ownership and
continuous isolation are not attested by this diagnostic. The existing
`acquireProposalOAuthCredential()` remains an unconditional sanitized refusal.
No enabling flag, environment credential, CLI generic agent or receipt bypass was added.

Minimum future boundary:

- ai-linux-dev remains Human development/edit/storage owner only. Generated/untrusted
  code must never execute as the credential UID. VM117 isolation remains unproved;
  arbitrary candidate execution stays prohibited.
- Dedicated custodian has private0700 root/0600 secret, no credential forwarding to
  developer or reviewer. Same-UID HOME/profile/session splitting is not OS isolation.
- Trusted host adapter is root-provisioned/pinned; credential UID does not load developer-
  writable checkout, project configs/plugins/hooks or user-supplied executables.
  Existing embedded-core no-tools, fixed provider/model/endpoint, no refresh/retry and
  durable dispatch-intent-before-call behavior must be reused, not general `opencode run`.
- Proposer/reviewer retain separate native sessions/processes and public evidence roots;
  secrets/accounts/authorization headers never enter receipts/logs. Current fixture
  session UUIDs are not proof of native OpenCode sessions or a live semantic review.
- The old HQO root SSH→QGA route can read guest files regardless of0700. It remains
  usable/unfenced. Establish independent Human management + real legacy privilege
  admission prevention before storing a new credential that is claimed inaccessible
  to old AI. New UID alone cannot remove that root capability.

Future Linux Human-only `/connect` is a separate approval. V2 ordinarily auto-starts
a shared service and may discover ancestor config/providers; do not launch it casually
to check auth. Verify the pinned host composition/version/profile first, and do not
submit a model prompt during authentication. Current generic provider defaults retry
timeouts, so they do not substitute for the existing no-replay transport.
There is no OAuth operation, CLI startup, provider request or authentication migration
in this change. Actual host custody adapter enrollment/broker admission remains pending
OS enforcement and a separately reviewed exact-SHA authorization.
