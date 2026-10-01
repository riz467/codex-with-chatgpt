# CT702 Independent Review Authority — IR-03

Offline implementation. No deployment, generated production identity, provider credential,
external model transfer, Passkey operation, or live unit activation is part of this change.

## Authority and protected composition

`review-service/production-cli.js` is the fixed Linux entry point. It reads an existing
Ed25519 key and opens an already provisioned, exact-schema database. It never creates
or exports keys. The listener is `127.0.0.1:7020`; both production peer authorization
and provider access are deny-all. The JSON configuration cannot install an adapter,
module, executable, endpoint, policy, or authentication dependency. Runtime code,
configuration and package approval must be host-owned and inaccessible to the execution agent.

The host uses the unchanged typed-review contract, signer and verifier. The signing
kernel's `independentlyVerifyReview()` callback rereads frozen bytes and the committed
result under the synchronous local mutation fence. Its internal `reviewIsCurrent`
means only that this result is the local snapshot being signed. It is never an API
field and is **not production currentness**. Signed FAIL and NEEDS_WORK remain valid
historical evidence; unchanged Finalizer verification requires PASS.

The accepted source binding is a candidate claim, not proof of CT701 intent. The host
checks exact request/attempt domain hashes and raw source identities; IR-04 must compare that signed
binding with CT701's independently trusted production request and attempt. Windows
CURRENT_REVIEW files and historical worker outputs have no special authority here.

## Frozen material protocol

Submit a strict object `{binding, files:[{path,base64}]}`. `binding` is exactly the
existing review-input schema. Two files are required:

* `request.json`: canonical JSON of the existing strict typed-action request schema.
* `attempt.json`: canonical JSON of the existing strict typed-action attempt schema.

These full typed-action documents bind the frozen candidate; other files contain
candidate execution evidence. `evidence.txt` must be nonempty to pass the bounded
structural sufficiency gate. This release deliberately includes only a deterministic
offline fixture adapter, not a production semantic model. Installing a substantive
production reviewer requires a separate reviewed host composition/profile change.

The host recomputes the existing domain-separated request/attempt hashes using
`parseActionRequest`, `hashActionRequest`, and `bindActionAttempt`, comparing all eight
review binding fields with frozen identity and local review identity. Policy IDs in
candidate requests remain untrusted claims for CT701 to match with trusted policy.
Separately, the content store hashes **raw bytes** and sorts paths
to build canonical `{version:1,files:[{path,sha256,bytes}]}`. The manifest digest is raw
SHA-256 of this UTF-8 JSON; root identity is SHA-256 of
`CT702_FROZEN_MATERIAL_V1\n` followed by the manifest. Limits are 64 files, 1 MiB total
decoded bytes, 200 ASCII characters per portable path, and 1,500,000 HTTP body bytes.
Paths cannot be absolute, drive/UNC paths, dot segments, reserved DOS names, streams,
or trailing dots. Case-folded duplicates fail. Input contains bytes, not filesystem
references: links, reparse declarations, URLs and file types are unknown fields.

The content-addressed store lives **inside the dedicated SQLite database**: immutable
BLOB rows keyed by raw digest and manifest rows keyed by root. Exclusive write
transactions atomically accept exact bytes, manifest and review identity; existing
objects are reread and compared on duplicate insertion. No partial filesystem CAS
objects or caller-controlled filesystem traversal exist. Every review lookup and
startup rechecks material digests, lengths, manifest and root. A conflicting review
replacement fails; exact duplicate submissions retain the original signature/JTI.

## SQLite chronology and reconciliation

Schema version `7022` uses STRICT tables, WAL, FULL synchronous durability, foreign
keys, trusted_schema=OFF and zero lock retry timeout. Startup compares the exact SQL
schema with an in-memory reference, checks integrity/foreign keys, and checks every
frozen material. Missing/old/unknown databases fail. Serving does not initialize,
migrate, repair or retry uncertain writes. Previous IR-03 schema `7021` is rejected
without migration; this correction requires a newly provisioned offline database.
Offline provisioning can explicitly call
`new ReviewStore(fixedDatabasePath,{initialize:true})` using the reviewed package;
initialization requires an exclusive new file and is never exposed over HTTP.

Append-only `events.seq` is the global local sequence. Every table forbids UPDATE and
DELETE through triggers. Review IDs, attempt IDs, action/attempt sequence pairs,
result evidence identities, publication/invalidation operation IDs and signature JTIs
are unique. Startup also rehashes durable
reports and verifies stored historical signatures at their issuance time; serving
expired history does not extend its lifetime. Transition triggers enforce:

```
REVIEW_PENDING -> MATERIAL_FIXED -> REVIEW_RUNNING -> RESULT_DURABLE
  -> SIGNED_PENDING_PUBLICATION -> PUBLICATION_ACKNOWLEDGED
  -> INVALIDATION_PENDING -> INVALIDATED  (exact CT701 admission acknowledgement)
  or SUPERSESSION_PENDING -> SUPERSEDED   (exact CT701 admission acknowledgement)
```

Acceptance commits the first two events with the material. Review-running is committed
before the bounded call. Full report (including provider profile, material identity,
and material-fixed/review-running sequences committed by its signed report hash), integrity report
and independently verified snapshot commit before signing. Signature storage and the
pending-publication event commit together. A later attempt appends SUPERSESSION_PENDING
for an acknowledged predecessor, binding its previous global sequence and the exact
replacement review ID. It does not locally revoke that predecessor. A never-acknowledged
predecessor can be terminally superseded locally: acceptance and publication acknowledgement
both acquire BEGIN IMMEDIATE, and publication requires the exact previous sequence/state.
Thus publication wins first (requiring pending supersession) or local supersession wins
first (making publication acknowledgement stale). Lock contention fails closed without
automatic retry. Typed-action retries must name an existing local
predecessor with exact action/request/attempt identity and the same target/kind. A
superseded or supersession-pending predecessor cannot acquire a later sibling branch.
Explicit invalidation of an acknowledged review appends INVALIDATION_PENDING; only
never-acknowledged reviews may be locally INVALIDATED. Pending obligations are immutable:
replacement acceptance/publication and later descendants never erase them. Each review's
bounded status includes `pendingInvalidation: {kind,sequence,intentHash,replacementReviewId}`
or null. The intent hash is SHA-256 of the exact canonical pending event detail; the
sequence is that event's global sequence, not the predecessor's earlier publication sequence.
IR-04 must track these obligations and build its own readiness/currentness barrier.
INVALIDATED and SUPERSEDED are terminal; acknowledgement never reactivates them.
History and signed evidence remain retrievable after invalidation or expiration.
Retrieval is historical; consumers must apply freshness and CT701 currentness separately.

An acknowledgement is an authenticated future coordinator's historical publication
receipt, not a CT702 assertion of production activation. Acknowledgement/invalidation
require an exact local sequence and operation UUID. The separate
`acknowledgeInvalidation` capability is reserved for a future authenticated CT701 peer.
It binds review ID, pending global sequence, intent hash, exact replacement review ID
(null for explicit invalidation), and a fresh acknowledgement UUID. Only this receipt
converts a pending intent to its matching terminal state. SQL transition guards also
require the receipt to match the pending event sequence and full intent detail.
Production peer composition still denies every capability; no caller header establishes
CT701 identity. Pending revocation never means production revocation. Exact duplicates reconcile
idempotently. An uncertain COMMIT poisons that store instance: every access fails
`RECONCILE_REQUIRED`, including signed-envelope retrieval. No in-process automatic
retry occurs. Reopen and validate the database, then reconcile the **exact original**
request/operation. A committed result can be signed without repeating review; a
committed signature is returned unchanged. REVIEW_RUNNING after a crash is never
automatically rerun: explicitly invalidate it and submit a newer attempt. Root-owned
operators must reconcile unavailable/torn databases; no automatic repair exists.

## Provider and egress

Pure `structuralVerdict` and `requireSemanticProfile` are reused from the existing
review code without importing Windows profile registries or worker state. The
host builds the provider packet only from reread frozen bytes and a fixed prompt.
The fixture profile binds provider `offline-fixture`, model `deterministic-v1`, the
prompt SHA-256, endpoint `none:offline`, one call, timeout (1–5000 ms), and response
size (32–4096 bytes). The strict response is `{result,reason}`. Unknown identities,
endpoints, fields and malformed output fail closed. Timeout/failure produces
NEEDS_WORK; it never falls back to PASS. A timed-out adapter holds its single
concurrency slot until it actually settles, preventing abandoned-call accumulation.

Production installs no adapter: no credentials, DNS resolution, HTTP model client,
caller URL fetch or transfer exists. `provider.ts` exports fixture composition only
for offline verification; production JSON cannot enable it. Trusted adapter code
itself is a host dependency, not a JavaScript sandbox. Abort deadlines bound the
awaited response; a future real adapter must enforce transport cancellation and
streaming response limits before installation. Physical egress isolation is IR-05.

## API

Only POST with `application/json` is accepted:

| Endpoint | Input |
|---|---|
| `/v1/reviews/submit` | strict binding and byte files |
| `/v1/reviews/status` | `{reviewId}` |
| `/v1/reviews/evidence` | `{reviewId}`; historical envelope with local status |
| `/v1/reviews/acknowledge` | `{reviewId,expectedSequence,acknowledgementId}` |
| `/v1/reviews/invalidate` | same sequence/operation fields |
| `/v1/reviews/acknowledge-invalidation` | `{reviewId,expectedSequence,intentHash,replacementReviewId,acknowledgementId}` |

Later-attempt submission initiates supersession. No currentness boolean, generic
signer, shell, admin, SQL, filesystem or provider selector is exported over HTTP.
Host composition authenticates peers and assigns explicit capabilities; default is
403 for every request. Host/Origin/headers/IP never establish authority. The server
limits bodies, concurrent requests, connections, headers and request time. Lookup
responses contain at most one review's bounded eight-state history.

## Linux deployment templates (not activated in IR-03)

* Root-owned non-writable package at `/opt/ct702-review`; root-owned config at
  `/etc/ct702-review/config.json`. Root-owned, non-writable ancestor directories.
* Dedicated account `ct702-review`; root-reviewed config fixes its numeric UID.
  CLI verifies real/effective UID and the account entry in `/etc/passwd`.
* Private account-owned state at `/var/lib/ct702-review` (0700); database, WAL/SHM
  and existing `signing.key` private (0600), regular, single-link files. No symlinks.
  Config is root-owned and not group/other writable. CLI sets/verifies umask 0077.
* Provision an empty exact-schema DB offline with the reviewed store initializer;
  do not use automatic creation as a response to missing or corrupt production state.
* Supply the separately approved Node executable as `/opt/ct702-review/node`.
  The manifest pins its exact version and SHA-256. This Windows-built verification
  artifact is not an approved Linux executable: rebuild/verify with the intended
  Linux Node runtime and approve the resulting manifest before deployment.
* The provided systemd file is a template only. It fixes the executable and working
  directory, clears NODE_OPTIONS/NODE_PATH, removes capabilities, restricts writes
  to state and disables restart. No unit was installed, enabled or started.

## Package and offline verification

```
pnpm ct702:test
pnpm typecheck
pnpm test
pnpm ct702:pack
pnpm ct702:verify-package .tooling/ct702-review-package <approved-manifest-sha256>
pnpm ct702:clean-room .tooling/ct702-review-package <approved-manifest-sha256>
```

The packer refuses to replace an existing output directory. It recursively walks
literal runtime imports, allows only the audited `zod` external dependency and
rejects any unexpected transitive dependency. The production runtime closure,
dependency runtime files, config/unit templates, verifier, deployment guide and
lockfile are inventoried. TS source/declarations, maps, Git/env files, DB/WAL/SHM,
PEM/keys and production identities are excluded. No private-key generation or
fixture key is shipped. The verifier checks an **externally approved** manifest
digest, exact file inventory, required closure files and the Node executable hash.
It is an integrity verifier, not a substitute for independent package approval.

Provenance contains baseline commit, tracked-diff hash, individual source hashes
(including new/untracked source), package manager/lock hash, dependency name/version/
package.json hashes, build platform and architecture. The manifest hashes provenance
and every payload file. Changes after packaging require a new approved artifact.

The clean room copies only package, disposable fixture and pinned Node into a fresh
directory, clears environment, uses Node filesystem permissions restricted to that
directory, disables child/worker capabilities by default, and blocks network APIs
before runtime import. It generates only an in-memory ephemeral **fixture** Ed25519
key, then exercises freeze/sign/verify/restart/publication acknowledgement, durable
pending invalidation, exact CT701 invalidation acknowledgement, idempotency and
missing/tampered payload/manifest rejection. No package manager or external network
is used in the clean room. This is offline evidence, not IR-05 physical isolation.

## Explicit remaining boundaries

* **IR-04:** CT701 trusted production request registry, remote currentness barrier,
  durable activation/revocation linearization and Bridge handoff fence.
* **IR-05:** authenticated mTLS/Tailscale ingress, reviewed peer identity binding
  and physical network/egress isolation. Loopback alone is not authentication.
* **IR-07:** production one-shot key generation/pinning helper. This host only reads
  an existing reviewed key; no production identity has been generated.

No completion claim is made for these boundaries or for a real model adapter.
