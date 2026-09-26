# Signed Human Approval v1: contract and trust boundary

**Status:** contract and AI-Workspace verifier only. Neither this verifier nor the existing WebAuthn PoC issues signed approvals or connects to autonomous Complete / DONE. Do not enable the legacy fixture-only Dashboard approval path in production. This document is not a claim that the current Windows principal is a human-only boundary.

## Request and evidence

The external Approver accepts a request for one independently checked, current PASS Review. Request schema (`src/human-approval/contract.ts`, strict; unknown fields rejected):

```json
{
  "schema_version": 1,
  "type": "AI_WORKSPACE_DONE_APPROVAL_REQUEST",
  "request_id": "req-1234567890abcdef1234567890abcdef",
  "task_id": "rpc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "run_id": "auto-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "authoritative_review_id": "review-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "review_evidence_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "bundle_manifest_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "canonical_goal_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "issued_at": "2026-09-26T11:59:00.000Z",
  "expires_at": "2026-09-26T12:04:00.000Z",
  "nonce": "<32 cryptographically random bytes in canonical unpadded base64url>"
}
```

`request_id` is a unique request correlation ID; `nonce` is the unique v1 **jti** used for single-use consumption. Both must be generated independently with cryptographic randomness by the requester/isolated issuer as appropriate, not inferred from a task ID. A production Approver must independently validate the request's provenance and currentness, display the actual task/review/goal binding to the human, verify WebAuthn UV for its own RP, recheck currentness, and sign *only* the accepted exact request. Merely receiving an AI-generated request must not trigger signing. A 32-byte nonce plus a 5-minute maximum validity window is required. Goal digest is SHA-256 of the canonical goal's UTF-8 bytes; review evidence digest is SHA-256 of the authoritative Review result's raw bytes; manifest digest is the verified bundle manifest SHA-256. Raw paths/commands and `done_approved` are not contract fields.

Evidence envelope (`SignedApproval`, all fields mandatory, strict):

```json
{
  "schema_version": 1,
  "type": "AI_WORKSPACE_DONE_APPROVAL",
  "payload": { "<exact Approval Request object above>": "including its schema_version and type" },
  "approver_key_id": "approver-2026-01",
  "signature_algorithm": "Ed25519",
  "signature": "<64-byte Ed25519 signature in canonical unpadded base64url>"
}
```

The signature is over the UTF-8 bytes of `AI_WORKSPACE_DONE_APPROVAL_V1\n` followed by `JSON.stringify` of a newly constructed object with keys **exactly in this order**: `schema_version`, `type`, `payload`, `approver_key_id`, `signature_algorithm`. The `payload` keys are **exactly in this order**: `schema_version`, `type`, `request_id`, `task_id`, `run_id`, `authoritative_review_id`, `review_evidence_hash`, `bundle_manifest_sha256`, `canonical_goal_sha256`, `issued_at`, `expires_at`, `nonce`. Use `approvalSigningBytes()` after strict schema parsing to implement the issuer on a separate host. Never sign unparsed input JSON or the `signature` field. Identifiers and hashes are ASCII; timestamps use canonical UTC ISO milliseconds. Signature/key ID/algorithm substitutions, extra fields, or version changes are invalid.

## AI-Workspace verifier and future consumer

`verifySignedApproval(input, trustedContext, trustedKeys, now)` has no I/O or mutable state. It fails closed unless strict schema, pinned Ed25519 public key ID and signature, canonical encoding, time bounds (issued no more than 30 seconds into the future; expires after now and issued, within five minutes), and *every* binding match. Task/run suffixes must agree. `trustedContext` is a snapshot **independently established** by a future adapter from the sealed Review pointer, authoritative result raw-byte hash, verified bundle manifest, canonical goal hash, run state and PASS status. It must **not** be taken from the request or evidence. `current_review_id` / `current_review_evidence_hash` must match the authoritative Review; `review_is_current` and `bundle_integrity_valid` must be true. The verifier neither reads the Review nor approves or completes tasks; a caller supplying false trusted context breaks the contract.

On VALID, a separate gate must atomically check-and-reserve the `nonce` (jti) in an AI-inaccessible transactional store, recheck the independent current Review immediately before consumption, then perform the existing Complete preflight and recheck immediately before Complete. A failed/stale/replayed/ambiguous reservation must fail closed; define crash recovery semantics before production (no consumed jti may permit a second Complete). The test-only bounded in-memory gate demonstrates the contract, **not** a production implementation. No public key, trust map or external evidence is currently wired into `completeCurrentAutonomous`. Existing legacy `done_approved: true` with a local fixture record is separate and must be replaced/disabled before enabling production Signed Approval. These JSON values alone can never satisfy this new verifier: `{ "done_approved": true }`, `{ "task_id": "...", "review_result": "PASS" }`.

## Threat model

The adversary includes OpenCode, Codex, ChatGPT/MCP execution, and AI processes under the AI-Workspace Windows principal. They may propose approval requests, make arbitrary HTTP calls, or construct/alter approval JSON. They cannot forge a valid Ed25519 signature under a **separately protected** private signing key, even with a valid WebAuthn assertion. WebAuthn proves UV to the Approver service; the Approver's signature attests its decision on the exact binding to AI-Workspace. AI-Workspace stores only allowlisted public keys/key IDs. Pinning/key rotation and revocation need independently controlled configuration and revalidation; never trust a public key supplied in the envelope or keep a signing private key or WebAuthn private key in this repository/runtime.

**Unresolved today:** AI-Workspace and the PoC share a Windows principal, which can modify service code, its credential store, and any same-principal evidence. Therefore even cross-device UV does not establish the desired production boundary. PVE host root, cluster administrators, and a compromised Approver CT root are out of scope. The intended separation is **AI-Workspace compromised ≠ Human Approver CT compromised**. A stolen human passkey, malicious enrolled credential, UI deception, and a compromised human browser require separate operational controls; signature verification alone does not solve them.

## Next deployment design (not implemented)

Use Debian 13 in an **unprivileged LXC** (or separate VM/host), 1 vCPU, 256–512 MiB RAM, 2–4 GiB disk. Install only the Human Approver service under a dedicated unprivileged principal. Store WebAuthn credential public keys/counters, challenge state, approval audit, signing private key, and consumed jti inside the isolated domain with restrictive ACLs and backups. Prefer TPM/HSM-backed non-exportable signing keys if available. No AI-Workspace bind mount, shared writable filesystem, AI-Workspace SSH private key, or AI-Workspace sudo/root access. AI-Workspace must have no direct read/write/mount/admin path to the Approver store. Rotate key IDs by an independent administrator; pin only public keys on the verifier side. Issuer logic must include enrollment/recovery authorization and exact request/currentness checks before signing.

Human browser → tailnet-only Tailscale Serve HTTPS → isolated Approver. AI-Workspace → separately authenticated, tightly scoped Approver API if required; do not let the API perform UV or approve by POST alone. **No Funnel.** Use a stable name such as `https://ai-approver.<tailnet>.ts.net` as origin and RP ID; changing the RP from `localhost` or the current Windows tailnet hostname requires new WebAuthn enrollment. Configure tailnet ACLs, TLS and allowlisted clients. No CT, production key, production enrollment, Scheduled Task, Gateway/Dashboard restart, DONE transition, or Complete integration is performed in this phase.
