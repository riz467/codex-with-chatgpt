import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { canonicalJson } from "../src/task-contract/contract.js";
import { hashRecord, type DevelopmentBinding } from "../src/execution-orchestrator/development/contract.js";
import { prepareCandidateRepository } from "../src/execution-orchestrator/development/candidate-repo.js";
import { DevelopmentStore } from "../src/execution-orchestrator/development/store.js";
import { hashProposal, PROPOSAL_DOMAIN } from "../src/execution-orchestrator/development/proposal.js";

export const roots: string[] = [];
export function cleanup() { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); }
const h = "a".repeat(64);
const seal = <T extends { digest: string }>(x: T): T => ({ ...x, digest: hashRecord(x) });
export function fixture(scope = ["file.txt", "keep.txt", "nested/new.txt"], extraFiles: Record<string, string> = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rc02-e0-"))); roots.push(root);
  const canonical = path.join(root, "canonical"), parent = path.join(root, "candidates"), storeRoot = path.join(root, "store");
  fs.mkdirSync(path.join(canonical, ".git", "objects"), { recursive: true });
  fs.mkdirSync(parent); fs.mkdirSync(storeRoot);
  const object = (type: string, bytes: Buffer) => {
    const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
    const hash = createHash("sha1").update(raw).digest("hex");
    fs.mkdirSync(path.join(canonical, ".git", "objects", hash.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(canonical, ".git", "objects", hash.slice(0, 2), hash.slice(2)), deflateSync(raw));
    return hash;
  };
  const files: Record<string, string> = { "file.txt": "before\r\n", "keep.txt": "keep\n",
    "scripts/verify-ai-workspace.mjs": "throw new Error('candidate verifier must never run');\n",
    "scripts/verification-policy.mjs": "throw new Error('candidate policy must never run');\n", ...extraFiles };
  const tree = (prefix: string): string => {
    const children = [...new Set(Object.keys(files).filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length).split("/")[0]))].sort();
    return object("tree", Buffer.concat(children.map(name => {
      const full = prefix + name, directory = !(full in files);
      const hash = directory ? tree(full + "/") : object("blob", Buffer.from(files[full]));
      return Buffer.concat([Buffer.from(`${directory ? "40000" : "100644"} ${name}\0`), Buffer.from(hash, "hex")]);
    })));
  };
  const head = object("commit", Buffer.from(`tree ${tree("")}\nauthor Fixture <test@invalid> 1 +0000\ncommitter Fixture <test@invalid> 1 +0000\n\nfixture\n`));
  fs.writeFileSync(path.join(canonical, ".git", "HEAD"), head + "\n");
  fs.writeFileSync(path.join(canonical, "private.txt"), "canonical private bytes");
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION" as const, id: "dev2-delegation-e0", policyId: "dev2-policy-e0",
    policyDigest: h, repositoryId: "dev2-repository-e0", baselineHead: head, scope, maxAttempts: 1, digest: h });
  const request = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST" as const, id: "dev2-request-e0", delegationDigest: delegation.digest,
    goalDigest: h, acceptanceCriteriaDigest: h, digest: h });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT" as const, id: "dev2-attempt-e0", requestDigest: request.digest,
    sequence: 1, predecessor: null, candidateId: "dev2-candidate-e0", candidateGeneration: 1, sessionId: "dev2-session-e0",
    executionId: "dev2-execution-e0", inputSnapshotDigest: h, manifestId: "dev2-manifest-e0", fastId: "dev2-fast-e0",
    advisoryReviewId: "dev2-review-e0", materializationId: "dev2-materialization-e0", reviewReceiptId: "dev2-receipt-e0", digest: h });
  const binding: DevelopmentBinding = { delegation, request, attempt };
  const candidate = prepareCandidateRepository({ binding, candidateRoot: path.join(parent, "one") },
    { expectedBinding: binding, canonicalRoot: canonical, candidateParent: parent });
  const { store } = DevelopmentStore.create(storeRoot, { operation: "CREATE", transactionId: "dev2-store-tx-create", expectedVersion: 0, binding }, binding);
  const send = (fields: Record<string, unknown>) => {
    const r = store.recover();
    return store.transact({ transactionId: `dev2-store-tx-fixture-${r.state.version + 1}`, expectedVersion: r.state.version, binding, ...fields }, binding);
  };
  const advance = (to: string) => send({ operation: "ADVANCE", to, candidateOutcome: "NOT_STARTED", canonicalOutcome: "NOT_STARTED" });
  const ready = () => {
    advance("ATTEMPT_FIXED"); advance("CANDIDATE_PREPARING"); advance("CANDIDATE_READY");
    send({ operation: "RESERVE", kind: "DISPATCH" }); advance("WORKER_DISPATCH_IN_PROGRESS"); advance("PROPOSAL_FIXED");
    store.completeRelease("DISPATCH");
  };
  const proposal = (rows = [{ path: "file.txt", content: "\uFEFFexact\r\nno-final-newline" }, { path: "nested/new.txt", content: "created\n" }]) => {
    const body = { domain: PROPOSAL_DOMAIN, attemptDigest: attempt.digest, candidateId: attempt.candidateId,
      sessionId: attempt.sessionId, executionId: attempt.executionId, scope, files: rows.map(r => ({ ...r, operation: "REPLACE_UTF8" })) };
    return canonicalJson({ ...body, proposalDigest: hashProposal(body) });
  };
  const input = () => ({ store, binding, candidate, proposal: proposal() });
  return { root, canonical, binding, candidate, store, ready, send, advance, proposal, input };
}

export function passSummary() {
  return { requested_profile: "FAST", effective_profile: "FAST", escalation_required: false, escalation_reasons: [],
    changed_paths: ["file.txt"], declared_paths: null, observed_git_paths: ["file.txt"], out_of_scope_paths: [],
    related_tests: [], mandatory_tests: [], direct_tests: [], commands: [], result: "PASS", pass: true,
    related_sources: ["file.txt"], docs_only: false };
}
