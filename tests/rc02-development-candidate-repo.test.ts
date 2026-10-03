import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashRecord } from "../src/execution-orchestrator/development/contract.js";
import { inspectCandidateRepository, prepareCandidateRepository } from "../src/execution-orchestrator/development/candidate-repo.js";

const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function binding(head: string) {
  const digest = "a".repeat(64);
  const seal = <T extends { digest: string }>(record: T) => ({ ...record, digest: hashRecord(record) });
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION", id: "dev2-delegation-test", policyId: "dev2-policy-test",
    policyDigest: digest, repositoryId: "dev2-repository-test", baselineHead: head, scope: ["file.txt"], maxAttempts: 1, digest });
  const request = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST", id: "dev2-request-test", delegationDigest: delegation.digest,
    goalDigest: digest, acceptanceCriteriaDigest: digest, digest });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT", id: "dev2-attempt-test", requestDigest: request.digest,
    sequence: 1, predecessor: null, candidateId: "dev2-candidate-test", candidateGeneration: 1,
    sessionId: "dev2-session-test", executionId: "dev2-execution-test", inputSnapshotDigest: digest,
    manifestId: "dev2-manifest-test", fastId: "dev2-fast-test", advisoryReviewId: "dev2-review-test",
    materializationId: "dev2-materialization-test", reviewReceiptId: "dev2-receipt-test", digest });
  return { delegation, request, attempt };
}

// Build disposable Git objects directly: no git commit, checkout, source checkout, or canonical mutation.
function fixture(symlink = false) {
  const base = mkdtempSync(join(realpathSync.native(tmpdir()), "rc02-candidate-")); temporary.push(base);
  const canonical = join(base, "canonical"), parent = join(base, "candidates"), candidate = join(parent, "one");
  mkdirSync(join(canonical, ".git", "objects"), { recursive: true }); mkdirSync(parent);
  mkdirSync(join(canonical, ".git", "refs", "heads"), { recursive: true });
  const object = (type: string, body: Buffer | string) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
    const hash = createHash("sha1").update(raw).digest("hex"), dir = join(canonical, ".git", "objects", hash.slice(0, 2));
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, hash.slice(2)), deflateSync(raw)); return hash;
  };
  const entries = [
    ["100644", ".gitattributes", object("blob", "*.txt filter=poison\n")],
    ["100644", ".gitmodules", object("blob", '[submodule "sub"]\npath = sub\nurl = https://invalid.example/sub\n')],
    ["100644", "file.txt", object("blob", "committed\n")],
    ...(symlink ? [["120000", "link", object("blob", canonical)]] : []),
    ["160000", "sub", "b".repeat(40)],
  ];
  const tree = object("tree", Buffer.concat(entries.map(([mode, name, hash]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(hash, "hex")]))));
  const head = object("commit", `tree ${tree}\nauthor Fixture <fixture@invalid> 1 +0000\ncommitter Fixture <fixture@invalid> 1 +0000\n\nfixture\n`);
  writeFileSync(join(canonical, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(canonical, ".git", "refs", "heads", "main"), `${head}\n`);
  writeFileSync(join(canonical, "file.txt"), "DIRTY working tree\n");
  writeFileSync(join(canonical, "untracked-secret.txt"), "not committed");
  writeFileSync(join(canonical, ".git", "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
  const b = binding(head);
  const request = { binding: b, candidateRoot: candidate };
  const host = { expectedBinding: b, canonicalRoot: canonical, candidateParent: parent };
  return { base, canonical, parent, candidate, head, tree, request, host, make: () => prepareCandidateRepository(request, host) };
}

describe("RC02 independent committed candidate preparation", () => {
  it("has independent Git directories, exact HEAD/tree, no links/remotes/worktree, and ignores dirty files", () => {
    const f = fixture(), c = f.make(), info = inspectCandidateRepository(c);
    expect(c.head).toBe(f.head); expect(c.tree).toBe(f.tree);
    expect(lstatSync(join(c.root, ".git")).isDirectory()).toBe(true);
    expect(info.gitDir).toBe(join(c.root, ".git")); expect(info.commonDir).toBe(info.gitDir);
    expect(info.objectDir).toBe(join(c.root, ".git", "objects"));
    expect(info.gitDir).not.toBe(join(f.canonical, ".git"));
    expect(info.alternates).toBe(false); expect(info.remotes).toBe(0); expect(info.sharedStorage).toBe(false);
    expect(existsSync(join(c.root, ".git", "objects", "info", "alternates"))).toBe(false);
    expect(existsSync(join(c.root, ".git", "worktrees"))).toBe(false);
    expect(readFileSync(join(c.root, "file.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(join(c.root, "untracked-secret.txt"))).toBe(false);
    expect(lstatSync(join(c.root, "file.txt")).nlink).toBe(1);
    expect(lstatSync(join(c.root, "file.txt")).ino).not.toBe(lstatSync(join(f.canonical, "file.txt")).ino);
    writeFileSync(join(c.root, "file.txt"), "candidate mutation");
    writeFileSync(join(c.root, ".git", "HEAD"), "candidate refs mutation");
    expect(readFileSync(join(f.canonical, "file.txt"), "utf8")).toBe("DIRTY working tree\n");
    expect(readFileSync(join(f.canonical, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(existsSync(join(c.root, "sub"))).toBe(false);
  });

  it("isolates hostile system/global/local config, hooks, filters, diff, merge, helpers and Git environment", () => {
    const f = fixture(), marker = join(f.base, "executed"), script = join(f.base, "poison.cjs"), config = join(f.base, "hostile.config");
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'); process.exit(99);`);
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const malicious = `[core]\nhooksPath = ${f.base.replaceAll("\\", "/")}\nfsmonitor = "${command}"\n[filter "poison"]\nsmudge = "${command}"\nclean = "${command}"\nrequired = true\n[diff]\nexternal = "${command}"\n[merge "poison"]\ndriver = "${command}"\n[credential]\nhelper = "${command}"\n[remote "origin"]\nurl = https://invalid.example/repo\n`;
    writeFileSync(config, malicious); writeFileSync(join(f.canonical, ".git", "config"), malicious);
    for (const name of ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"]) vi.stubEnv(name, config);
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor"); vi.stubEnv("GIT_CONFIG_VALUE_0", command);
    vi.stubEnv("GIT_DIR", join(f.base, "invalid")); vi.stubEnv("GIT_WORK_TREE", f.canonical);
    vi.stubEnv("GIT_EXTERNAL_DIFF", command); vi.stubEnv("GIT_TEMPLATE_DIR", f.base);
    const c = f.make();
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(c.root, "file.txt"), "utf8")).toBe("committed\n");
    expect(readFileSync(join(c.root, ".git", "config"), "utf8")).toContain("hooksPath = ");
    expect(existsSync(join(c.root, ".git", "hooks"))).toBe(false);
    expect(inspectCandidateRepository(c).remotes).toBe(0);
  });

  it.each(["executable", "command", "argv", "cwd", "environment", "baselineHead"])("rejects caller option %s", key => {
    const f = fixture(); expect(() => prepareCandidateRepository({ ...f.request, [key]: "injected" }, f.host)).toThrow();
    expect(existsSync(f.candidate)).toBe(false);
  });

  it("binds exact source HEAD to independently supplied Phase A identity", () => {
    const f = fixture();
    expect(() => prepareCandidateRepository({ ...f.request, binding: binding("c".repeat(40)) }, f.host)).toThrow("Host binding mismatch");
    writeFileSync(join(f.canonical, ".git", "refs", "heads", "main"), "c".repeat(40));
    expect(f.make).toThrow("baseline mismatch");
    expect(existsSync(f.candidate)).toBe(false);
  });

  it("rejects source worktree .git indirection and alternates", () => {
    const f = fixture(); mkdirSync(join(f.canonical, ".git", "objects", "info"));
    writeFileSync(join(f.canonical, ".git", "objects", "info", "alternates"), "/external");
    expect(f.make).toThrow("storage rejected");
    rmSync(join(f.canonical, ".git"), { recursive: true }); writeFileSync(join(f.canonical, ".git"), "gitdir: elsewhere");
    expect(f.make).toThrow("worktree");
  });

  it("rejects symlink tree entries without following a canonical back-reference", () => {
    const f = fixture(true); expect(f.make).toThrow("symlink");
    expect(existsSync(join(f.candidate, "link"))).toBe(false);
    expect(readFileSync(join(f.canonical, "file.txt"), "utf8")).toContain("DIRTY");
  });

  it("rejects candidate parent symlinks/junctions, including existing root aliases", () => {
    const f = fixture(), alias = join(f.base, "alias");
    symlinkSync(f.canonical, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => prepareCandidateRepository({ ...f.request, candidateRoot: join(alias, "new") },
      { ...f.host, candidateParent: alias })).toThrow("Symlink/junction");
    symlinkSync(f.canonical, f.candidate, process.platform === "win32" ? "junction" : "dir");
    expect(f.make).toThrow("Unsafe candidate root");
  });

  it("rejects canonical roots, ancestors, existing directories and out-of-parent paths", () => {
    const f = fixture();
    for (const root of [f.canonical, f.base, f.parent, join(f.canonical, "child"), join(f.parent, "..", "escape")])
      expect(() => prepareCandidateRepository({ ...f.request, candidateRoot: root }, f.host)).toThrow();
  });

  it("rejects forged/recovered receipt handles and post-preparation links/config mutation", () => {
    const f = fixture(), c = f.make();
    expect(() => inspectCandidateRepository({ ...c })).toThrow("Unrecognized");
    const tracked = join(c.root, "file.txt"); rmSync(tracked); linkSync(join(f.canonical, "file.txt"), tracked);
    expect(() => inspectCandidateRepository(c)).toThrow("Hardlinked");
    rmSync(tracked); writeFileSync(tracked, "new");
    writeFileSync(join(c.root, ".git", "config"), "[include]\npath = /host/config\n");
    expect(() => inspectCandidateRepository(c)).toThrow("config changed");
  });

  it("copies reachable object bytes into new storage rather than linking source objects", () => {
    const f = fixture(), c = f.make();
    for (const file of readdirSync(join(c.root, ".git", "objects", "pack")))
      expect(lstatSync(join(c.root, ".git", "objects", "pack", file)).nlink).toBe(1);
    rmSync(join(f.canonical, ".git", "objects"), { recursive: true });
    expect(inspectCandidateRepository(c).head).toBe(f.head);
  });
});
