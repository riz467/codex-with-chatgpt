import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/task-contract/contract.js";
import { hashRecord } from "../src/execution-orchestrator/development/contract.js";
import { hashProposal } from "../src/execution-orchestrator/development/proposal.js";
import { DevelopmentStore } from "../src/execution-orchestrator/development/store.js";
import { inspectMutatedCandidate, mutateCandidate, sha256, snapshotTree } from "../src/execution-orchestrator/development/candidate-mutation.js";
import { cleanup, fixture } from "./rc02-development-e0-fixture.js";

afterEach(() => { vi.restoreAllMocks(); cleanup(); });
describe("E0 deterministic mutation and Manifest before FAST", () => {
  it("reserves durably before first write; exact BOM/newlines, snapshots, all-scope manifest and immutable canonical", () => {
    const f = fixture(); f.ready();
    const canonical = snapshotTree(f.canonical, false), write = fs.ftruncateSync;
    let writes = 0;
    vi.spyOn(fs, "ftruncateSync").mockImplementation((fd, len) => {
      const r = f.store.recover();
      expect(r.state.state).toBe("CANDIDATE_MUTATION_IN_PROGRESS");
      expect(r.state.reservations.find(r => r.kind === "CANDIDATE")?.status).toBe("HELD");
      expect(r.receipts.at(-1)?.operation).toBe("RESERVE"); writes++;
      return write(fd, len);
    });
    const handle = mutateCandidate(f.input(), f.binding), data = inspectMutatedCandidate(handle), m = data.binding.manifest!;
    expect(writes).toBe(2);
    expect(fs.readFileSync(path.join(f.candidate.root, "file.txt"))).toEqual(Buffer.from("\uFEFFexact\r\nno-final-newline"));
    expect(m.files.map(r => r.path)).toEqual(f.binding.delegation.scope);
    expect(m.files.map(r => r.operation)).toEqual(["MODIFIED", "UNCHANGED", "CREATED"]);
    expect(m.files[0].before).toEqual({ state: "FILE", sha256: sha256("before\r\n"), byteLength: 8 });
    expect(m.files[0].after).toEqual({ state: "FILE", sha256: sha256("\uFEFFexact\r\nno-final-newline"), byteLength: Buffer.byteLength("\uFEFFexact\r\nno-final-newline") });
    expect(m.files[2].before).toEqual({ state: "MISSING" });
    expect(m.proposalDigest).toBe(JSON.parse(f.proposal()).proposalDigest);
    expect(m.digest).toBe(hashRecord(m));
    const r = f.store.recover();
    expect(r.state.state).toBe("CANDIDATE_MUTATION_CONFIRMED");
    expect(r.receipts.find(x => x.manifestDigest)?.operation).toBe("ADVANCE");
    expect(r.state.binding.fast).toBeUndefined();
    expect(snapshotTree(f.canonical, false)).toEqual(canonical);
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow();
    expect(() => inspectMutatedCandidate({ ...handle })).toThrow("UNRECOGNIZED");
  });
  it("rejects entry state, forged store/candidate, independent binding and tampered proposal without write", () => {
    const f = fixture(), before = snapshotTree(f.candidate.root);
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("ENTRY_STATE"); f.ready();
    expect(() => mutateCandidate({ ...f.input(), store: Object.create(DevelopmentStore.prototype) }, f.binding)).toThrow("UNRECOGNIZED");
    expect(() => mutateCandidate({ ...f.input(), candidate: { ...f.candidate } }, f.binding)).toThrow();
    expect(() => mutateCandidate(f.input(), { ...f.binding, attempt: { ...f.binding.attempt, digest: "b".repeat(64) } })).toThrow();
    const p = JSON.parse(f.proposal()); p.files[0].content = "forged";
    expect(() => mutateCandidate({ ...f.input(), proposal: canonicalJson(p) }, f.binding)).toThrow("binding mismatch");
    expect(snapshotTree(f.candidate.root)).toEqual(before);
  });
  it("rejects out-of-scope and .git data even when proposal digest is recomputed", () => {
    const f = fixture(); f.ready();
    for (const target of ["outside.txt", ".git/config", "../escape", "/absolute", "node_modules/x"]) {
      const p = JSON.parse(f.proposal()); delete p.proposalDigest; p.files[0].path = target;
      expect(() => mutateCandidate({ ...f.input(), proposal: canonicalJson({ ...p, proposalDigest: hashProposal(p) }) }, f.binding)).toThrow();
    }
    expect(f.store.recover().state.reservations.some(r => r.kind === "CANDIDATE")).toBe(false);
  });
  it.each(["hardlink", "junction", "case", "invalid-utf8"])("rejects %s before mutation", kind => {
    const f = fixture(); f.ready();
    const file = path.join(f.candidate.root, "file.txt");
    if (kind === "hardlink") fs.linkSync(file, path.join(f.candidate.root, "alias.txt"));
    if (kind === "junction") fs.symlinkSync(f.canonical, path.join(f.candidate.root, "nested"), "junction");
    if (kind === "case") fs.renameSync(file, path.join(f.candidate.root, "FILE.txt"));
    if (kind === "invalid-utf8") fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow();
    expect(f.store.recover().state.state).toBe("PROPOSAL_FIXED");
  });
  it("reservation failure leaves candidate byte-identical", () => {
    const f = fixture(); f.ready(); const before = snapshotTree(f.candidate.root);
    vi.spyOn(DevelopmentStore.prototype, "transact").mockImplementation(() => { throw new Error("reservation disk failure"); });
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("reservation disk failure");
    expect(snapshotTree(f.candidate.root)).toEqual(before);
  });
  it("partial write is UNKNOWN, keeps reservation, and cannot retry", () => {
    const f = fixture(); f.ready(); const truncate = fs.ftruncateSync;
    vi.spyOn(fs, "ftruncateSync").mockImplementation((fd, len) => { truncate(fd, len); throw new Error("partial mutation"); });
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("CANDIDATE_MUTATION_UNKNOWN");
    expect(f.store.recover().state.state).toBe("CANDIDATE_MUTATION_UNKNOWN");
    expect(f.store.recover().disposition).toBe("RECONCILE_REQUIRED");
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("RECONCILE_REQUIRED");
  });
  it("post-confirmation journal failure fences continued execution", () => {
    const f = fixture(); f.ready(); const transact = DevelopmentStore.prototype.transact;
    vi.spyOn(DevelopmentStore.prototype, "transact").mockImplementation(function (c: any, expected) {
      if (c.to === "CANDIDATE_MUTATION_CONFIRMED") throw new Error("journal failure");
      return transact.call(this, c, expected);
    });
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("RECONCILE_REQUIRED");
    expect(f.store.recover().state.state).toBe("CANDIDATE_MUTATION_IN_PROGRESS");
    expect(f.store.recover().state.binding.manifest).toBeUndefined();
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("RECONCILE_REQUIRED");
  });
  it("held/recovery reservations block entry", () => {
    const f = fixture(); f.ready(); f.send({ operation: "RESERVE", kind: "CANDIDATE" });
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("RECONCILE_REQUIRED");
  });
  it("pre-write open failure is FAILED_WITHOUT_MUTATION and cannot retry", () => {
    const f = fixture(); f.ready(); const before = snapshotTree(f.candidate.root), open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((name, flags, mode) => {
      if (name === path.join(f.candidate.root, "file.txt") && typeof flags === "number" && (flags & fs.constants.O_WRONLY))
        throw new Error("fixture pre-write denial");
      return open(name, flags, mode);
    });
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("FAILED_WITHOUT_MUTATION");
    expect(snapshotTree(f.candidate.root)).toEqual(before);
    expect(f.store.recover().state.state).toBe("FAILED_KNOWN");
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow();
  });
  it.each(["keep.txt", "outside.txt", ".git/config"])("unexpected post-state change to %s closes mutation UNKNOWN", name => {
    const f = fixture(); f.ready(); const truncate = fs.ftruncateSync;
    vi.spyOn(fs, "ftruncateSync").mockImplementation((fd, len) => {
      truncate(fd, len); fs.writeFileSync(path.join(f.candidate.root, name), "injected unexpected write");
    });
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("CANDIDATE_MUTATION_UNKNOWN");
    expect(f.store.recover().state.binding.manifest).toBeUndefined();
  });
  it("canonical drift is reconciliation, not a known failure", () => {
    const f = fixture(); f.ready(); const truncate = fs.ftruncateSync;
    vi.spyOn(fs, "ftruncateSync").mockImplementation((fd, len) => {
      truncate(fd, len); fs.writeFileSync(path.join(f.canonical, "private.txt"), "fixture drift only");
    });
    expect(() => mutateCandidate(f.input(), f.binding)).toThrow("RECONCILE_REQUIRED");
    expect(f.store.recover().state.state).toBe("RECONCILE_REQUIRED");
  });
  it("unchanged replacements remain UNCHANGED; untouched missing scope fails before reservation", () => {
    const f = fixture(["file.txt"]); f.ready();
    const handle = mutateCandidate({ ...f.input(), proposal: f.proposal([{ path: "file.txt", content: "before\r\n" }]) }, f.binding);
    expect(inspectMutatedCandidate(handle).binding.manifest!.files[0].operation).toBe("UNCHANGED");
    const missing = fixture(["absent.txt"]); missing.ready();
    expect(() => mutateCandidate({ ...missing.input(), proposal: missing.proposal([]) }, missing.binding)).toThrow("MANIFEST_MISSING");
    expect(missing.store.recover().state.state).toBe("PROPOSAL_FIXED");
  });
  it("rejects command fields and accessors without invoking them", () => {
    const f = fixture(); f.ready(); const getter = vi.fn();
    expect(() => mutateCandidate({ ...f.input(), command: "shell" } as any, f.binding)).toThrow("INVALID_INPUT_FIELDS");
    const input = Object.defineProperty(f.input(), "proposal", { enumerable: true, get: getter });
    expect(() => mutateCandidate(input, f.binding)).toThrow("INVALID_INPUT_PROPERTY"); expect(getter).not.toHaveBeenCalled();
  });
  it("rejects a genuine candidate issued for a different delegation binding", () => {
    const first = fixture(["file.txt"]), second = fixture(); second.ready();
    expect(first.candidate.head).toBe(second.candidate.head);
    expect(() => mutateCandidate({ ...second.input(), candidate: first.candidate }, second.binding)).toThrow("Candidate attempt binding mismatch");
    expect(second.store.recover().state.state).toBe("PROPOSAL_FIXED");
  });
});
