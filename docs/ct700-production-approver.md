# CT700 production-oriented Typed Action Approver — IR-02 and IR-05 Stage 2B-2 offline core

Offline implementation, not a live deployment or Passkey cutover. Production composition is `production-cli.js` → `createProductionApprover`. Its peer verifier is **deny-all**, with no config/environment/plugin override. Historical `cli.js`, `createApproverService` default profile, `approver:pack` and `deploy/ai-approver` retain compatibility only; they are not production CT700 entrypoints. The new package excludes the historical CLI and browser script. Shared server/storage code includes compatibility modules, but production route registration and store gates disable that protocol. The IR-05 Stage 2B-1 local-principal/gateway core and Stage 2B-2 inbound mTLS core described below are offline only; neither changes the CLI's deny-all verifier.

## Surface matrix

| Surface | Human `127.0.0.1:48768` | Peer `127.0.0.1:48769` |
| --- | --- | --- |
| `GET /health` | yes | absent |
| `GET /approve-typed-action/:id`, `/app.js` | yes | absent |
| `GET /api/typed-action-approval-requests/:id` | persisted trusted display only | absent |
| `POST /api/webauthn/typed-action/{options,verify}` | exact RP/Origin/Host + UV | absent |
| `GET /enroll/:token`, `POST /enrollment/{options,verify}` | one-use local invitation only | absent |
| `POST /api/typed-action-presentations` | absent | host-verified exact record only |
| `GET /api/typed-action-{status,evidence}/:id` | absent | host-authorized exact UUID only |
| legacy DONE submit/sign/evidence, generic admin/signer/window/key/credential mutation | absent | absent |

Human and Peer are separate apps and route tables, not a shared ingress middleware toggle. Production CLI fixes their loopback addresses and ports. Future Tailnet HTTPS 443 maps only to Human; future CT701 mTLS 7443 maps only to Peer. Browser Origin/Host are never peer credentials. Loopback alone does not authenticate a local principal.

## IR-05 Stage 2B-1 offline local-principal and gateway core

The three surfaces are Human on loopback `127.0.0.1:48768`; Peer on loopback `127.0.0.1:48769`, requiring a process-local credential on exactly its presentation POST and status/evidence GET APIs; and a separately returned offline Gateway app. The Gateway app forwards only those POST presentations and GET status/evidence requests to `127.0.0.1:48769`. It is not a generic proxy, and no gateway listener is active.

Each composition generates an unpredictable 32-byte credential. Peer performs route-specific local-principal checks before invoking `TrustedTypedActionPresentationVerifier` or the store. Gateway forwarding isolates caller-supplied headers from its injected credential; callers cannot supply Peer authority through forwarded headers. Request handling bounds JSON and timeouts and fails closed with generic responses. The credential authenticates neither a CT701 remote transport identity nor a human approval: the verifier remains independently authoritative, and the production CLI still uses its deny-all verifier.

## IR-05 Stage 2B-2 offline inbound TLS1.3/mTLS core

The inbound predicate checks the client's raw X509 DER certificate for validity dates, clientAuth EKU, a sole URI SAN carrying the required role, and the host-pinned SHA-256 digest of its SPKI. Strict host TLS options require explicit server cert, key and CA and enforce TLS1.3 only, `requestCert` and `rejectUnauthorized`. Composition returns an unbound HTTPS server; before the restricted Gateway handles a request, it checks both `socket.authorized` and the client certificate. Returning a server does not start a listener.

Trust is layered: CA-verified mTLS client → host-pinned SPKI and role → narrow Gateway → local-principal credential → `TrustedTypedActionPresentationVerifier` and store → Human Passkey. Client role, token and HTTP headers do not authorize approval; the verifier and human ceremony retain their separate authority.

An in-memory signed software Ed25519 certificate fixture uses ephemeral loopback port 0 to exercise a real positive TLS1.3 handshake and fail-closed missing-cert, TLS1.2, wrong-SPKI, wrong-role, duplicate-SAN, wrong-EKU, invalid-date and untrusted-CA cases. The earlier inert public DER test is not chain evidence; the actual test handshake supplies chain evidence for the software fixture. TypeScript and fixed regressions PASS.

This remains offline code, not production ingress. Production CLI still exposes only loopback Human `:48768` and Peer `:48769`, with a deny-all verifier: no `:7443` listener, issued production certificates or keys, Tailscale/firewall/Serve/network changes, external E2E, push or authoritative DONE.

## Trusted presentation contract and lifecycle

`TrustedTypedActionPresentationVerifier` is a narrow synchronous host dependency: `verifyRegistration(candidate)` returns an independently authenticated/verified record, or null; `authorizeLookup` authorizes a bounded operation and request UUID. HTTP has no authority by itself. Tests inject a host-owned pinned fixture, not caller PASS/current. The offline inbound mTLS core does not implement IR-04/05's authenticated publication and serialized currentness protocol in production composition; that protocol cannot be a JSON switch or module loader.

The strict immutable presentation contains a UUID, source identity, full canonical approval request, independently verified context, and domain-separated SHA-256. Context binds all action/target/request/attempt/sequence/review/policy/generation/window fields; it requires PASS and request/review/policy current. Request includes approvalRequestId, issue/expiry and JTI. All binding fields must match exactly; submitted bytes must equal the verifier's attested record. Unknown fields, arbitrary display text/HTML, source strings outside the bounded identity grammar and bad hashes are rejected.

`trusted_presentations` is a separate SQLite table with full canonical body, indexed unique presentation ID/hash, request foreign key and state. Registration and request creation share `BEGIN IMMEDIATE`. Exact CURRENT duplicate is idempotent; conflicting replacement is forbidden. States are CURRENT → STALE or SUPERSEDED. Terminal records cannot reactivate or be deleted. Host-only `invalidatePresentation(requestId, expectedHash, terminalState, now)` performs hash-CAS invalidation; there is no `setCurrent(true)` or window HTTP API. Restart retains records and invalidations.

Window authority comes exclusively from that persisted exact record, including request/attempt and maintenanceWindowId binding. Window start/expiry must encompass the approval validity and current clock. Options check the displayed presentation hash and currentness; store ceremony issuance rechecks after the asynchronous WebAuthn option generator. Verify consumes a one-use ceremony, verifies RP/Origin/UV/public key, rechecks window/currentness after WebAuthn, and rechecks again **inside the counter-CAS/signing transaction**. Immutability prevents changing the record between display and signing. Counter and authentication revision CAS, expiry, replay prevention, shared-credential races and multiple credentials remain supported.

The browser reads the persisted presentation request/context and renders all action, target, request, attempt, review PASS/hash, policy, generation, window and expiry fields with `textContent`. Fixed action enum labels convey meaning. The displayed hash is sent to options/verify. Signed evidence uses the existing Typed Action contract/verifier and is retrieved only through the peer app.

This is local currentness, not proof of remote freshness. IR-04 must serialize CT701 activation/revocation with the host-owned CT700 store; partition/barrier/fence behavior remains a dependency. A cached remote PASS must not enable the production verifier. Default CLI therefore remains fail-closed even though isolated host-injected fixtures can approve.

## Store and host composition

Production schema revision 7001. Existing DBs are checked before any DDL or journal-mode change: exact sqlite_master definitions (tables/indexes/triggers), user_version, WAL, quick_check, foreign keys. Unknown, historical, empty existing, partial or modified schema fails closed. No production migration/repair. New stores initialize locally; interrupted initialization leaves a DB that fails the next startup. Historical migration remains explicitly separate.

Immutable presentation/request/credential identity/evidence and append-only audit/JTI triggers are part of the verified schema. Approval state, counter/revision and credential disable are monotonic. Currentness invalidation and signing serialize on SQLite's write lock. Filesystem/root compromise and whole-store rollback require IR-08 independent anchors; schema checks do not claim protection from those authorities.

Production CLI accepts only `serve`, checks unprivileged Linux, fixed RP/paths/ports, root-owned non-writable config, private state directory, regular owner-only single-link key/DB files, Ed25519, and production DB schema. No keygen/export/enrollment-opening command is packaged. Bootstrap key provisioning/store initialization/local enrollment invitation still require separately authorized host tooling; no production enrollment was performed. Human is the custodian, with main/spare authenticators separately stored (HD-13).

## Packaging and verification

`pnpm ct700:pack` builds `.tooling/ct700-approver-package`. Output is never silently overwritten. AST traversal follows complete local runtime import/export closure from the production CLI and rejects computed/unknown dependencies. Runtime dependencies are copied from the resolved lock-backed installation, recursively, without pnpm symlinks or dev-only dependency traversal. No registry access or lifecycle execution. Source maps are excluded; project TypeScript sources, private keys, DBs, credentials, invitation tokens and `.git` are not packaged.

Package includes production runtime + required Typed Action/MCP enum/legacy contract modules, static production UI, runtime dependencies, unit/config **templates**, lockfile, provenance, README and standalone integrity verifier. Sorted file inventory and manifest raw SHA-256 bind every file. Provenance records source hashes, base commit, tracked diff digest, dependency versions/package hashes, lock digest and build platform. Exact Node version **and executable digest** are pinned: build/verify with the actual intended target Node binary for a deployable release. The Windows offline artifact is not a Linux deployment certification. No bundled Node executable or installer; no install-time download, lifecycle script, keygen, enroll, service start/enable or Tailscale mutation.

`node ct700-package-integrity.mjs <package> <independently-approved-manifest-sha256>` verifies exact inventory, file types, hashes and runtime. An approved digest must come from outside the artifact; a self-computed digest is only a build consistency check. Missing, extra, modified or linked files fail. Retain the reviewed manifest hash separately.

`pnpm ct700:verify-package` copies the package outside checkout, runs a fresh child process with only local package imports, ephemeral SQLite/Ed25519 and software WebAuthn fixture, loopback-only HTTP, Human health, peer deny-all, trusted registration/display, actual signature verification, restart and tamper/missing-file negative checks. The fixture guards socket connections to loopback and rejects DNS/UDP/fetch before package import (Node 24 has no network permission flag); this is test instrumentation, not an OS sandbox. Fixture keys/DB are outside the artifact and removed afterwards. This validates software behavior, not real browser enrollment, Linux/systemd/DAC, live transport or external ACLs. Fixed TypeScript/CT700 regressions pass for the offline core; this documentation change makes no code or test edits and has no production side effects.

## Remaining campaign dependencies

- IR-04: CT701 coordinator, authenticated publication/invalidation, currentness barriers/fencing and partition/restart protocol.
- IR-05: beyond the offline Stage 2B-1 and 2B-2 cores, production service wiring for authenticated mTLS gateway ingress on `:7443`, issued production identity material, Tailscale/physical ingress policies and external negative E2E tests remain dependencies.
- Other campaign steps: approved Linux runtime/release, key helpers and domain identity, local enrollment administration, independent anchors, real Human enrollment/UV and full isolated campaign acceptance. None is implied by IR-02 fixture PASS.
