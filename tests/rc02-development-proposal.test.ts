import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/task-contract/contract.js";
import { hashRecord } from "../src/execution-orchestrator/development/contract.js";
import { hashProposal, MAX_PROPOSAL_BYTES, parseProposal, PROPOSAL_DOMAIN }
  from "../src/execution-orchestrator/development/proposal.js";

const digest = "a".repeat(64);
const seal = <T extends { digest: string }>(record: T) => ({ ...record, digest: hashRecord(record) });
function fixture() {
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION", id: "dev2-delegation-test", policyId: "dev2-policy-test",
    policyDigest: digest, repositoryId: "dev2-repository-test", baselineHead: "b".repeat(40), scope: ["file.txt"], maxAttempts: 1, digest });
  const request = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST", id: "dev2-request-test", delegationDigest: delegation.digest,
    goalDigest: digest, acceptanceCriteriaDigest: digest, digest });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT", id: "dev2-attempt-test", requestDigest: request.digest,
    sequence: 1, predecessor: null, candidateId: "dev2-candidate-test", candidateGeneration: 1,
    sessionId: "dev2-session-test", executionId: "dev2-execution-test", inputSnapshotDigest: digest,
    manifestId: "dev2-manifest-test", fastId: "dev2-fast-test", advisoryReviewId: "dev2-review-test",
    materializationId: "dev2-materialization-test", reviewReceiptId: "dev2-receipt-test", digest });
  const binding = { delegation, request, attempt };
  const body = { domain: PROPOSAL_DOMAIN, attemptDigest: attempt.digest, candidateId: attempt.candidateId,
    sessionId: attempt.sessionId, executionId: attempt.executionId, scope: delegation.scope,
    files: [{ path: "file.txt", operation: "REPLACE_UTF8", content: "new text\r\n" }] };
  const proposal = { ...body, proposalDigest: hashProposal(body) };
  return { binding, body, proposal, text: canonicalJson(proposal) };
}
describe("D1 strict deterministic proposal data", () => {
  it("binds exact identities and returns immutable mutation data without authority", () => {
    const f = fixture(), p = parseProposal(f.text, f.binding, structuredClone(f.binding));
    expect(p).toEqual(f.proposal);
    expect(Object.isFrozen(p.files[0])).toBe(true);
    expect(p.files[0].content).toBe("new text\r\n");
    const empty = { ...f.body, files: [] };
    expect(parseProposal(canonicalJson({ ...empty, proposalDigest: hashProposal(empty) }), f.binding, f.binding).files).toEqual([]);
  });
  it.each(["command", "executable", "argv", "cwd", "shell", "provider", "model", "network", "approval", "authorized",
    "permit", "commit", "push", "deploy", "DoneApproved", "unknown"])("rejects field %s at every object layer", key => {
    const f = fixture();
    expect(() => parseProposal(canonicalJson({ ...f.proposal, [key]: true }), f.binding, f.binding)).toThrow();
    expect(() => parseProposal(canonicalJson({ ...f.proposal, files: [{ ...f.body.files[0], [key]: "anything" }] }), f.binding, f.binding)).toThrow();
  });
  it("rejects prose wrappers, trailing data, duplicate JSON keys and noncanonical wire JSON", () => {
    const f = fixture();
    for (const text of [`Here is the result: ${f.text}`, `\`\`\`json\n${f.text}\n\`\`\``, f.text + "{}",
      f.text.replace('{"attemptDigest":', `{"candidateId":"other","attemptDigest":`), JSON.stringify(f.proposal, null, 2), "null", "[]"])
      expect(() => parseProposal(text, f.binding, f.binding)).toThrow();
  });
  it.each(["attemptDigest", "candidateId", "sessionId", "executionId", "scope", "proposalDigest"])
    ("rejects changed %s even with resealed content", key => {
      const f = fixture(), changed = { ...f.proposal, [key]: key === "scope" ? ["other.txt"] : "c".repeat(64) };
      const { proposalDigest: _, ...body } = changed;
      if (key !== "proposalDigest") changed.proposalDigest = hashProposal(body);
      expect(() => parseProposal(canonicalJson(changed), f.binding, f.binding)).toThrow();
    });
  it.each(["../file.txt", ".git/HEAD", "other.txt", "FILE.txt", "C:/file.txt", "dir\\file.txt"])
    ("rejects escaped/out-of-scope path %s", path => {
      const f = fixture(), body = { ...f.body, files: [{ ...f.body.files[0], path }] };
      expect(() => parseProposal(canonicalJson({ ...body, proposalDigest: hashProposal(body) }), f.binding, f.binding)).toThrow();
    });
  it("rejects duplicate paths and case aliases", () => {
    const f = fixture();
    for (const path of ["file.txt", "FILE.txt"]) {
      const body = { ...f.body, files: [...f.body.files, { ...f.body.files[0], path }] };
      expect(() => parseProposal(canonicalJson({ ...body, proposalDigest: hashProposal(body) }), f.binding, f.binding)).toThrow();
    }
  });
  it("rejects oversized UTF-8 response bytes before parsing and unsupported operations", () => {
    const f = fixture();
    expect(() => parseProposal(" ".repeat(MAX_PROPOSAL_BYTES + 1), f.binding, f.binding)).toThrow("size");
    expect(() => parseProposal("界".repeat(MAX_PROPOSAL_BYTES / 2), f.binding, f.binding)).toThrow("size");
    for (const operation of ["DELETE", "RENAME", "SHELL", "PATCH"])
      expect(() => parseProposal(canonicalJson({ ...f.proposal, files: [{ ...f.body.files[0], operation }] }), f.binding, f.binding)).toThrow();
    const body = { ...f.body, files: [{ ...f.body.files[0], content: "\ud800" }] };
    expect(() => parseProposal(canonicalJson({ ...body, proposalDigest: hashProposal(body) }), f.binding, f.binding)).toThrow("UTF-8");
  });
  it("requires independent exact host binding", () => {
    const f = fixture(), other = structuredClone(f.binding);
    other.attempt = seal({ ...other.attempt, id: "dev2-attempt-other" });
    expect(() => parseProposal(f.text, f.binding, other)).toThrow("Host binding mismatch");
  });
});
