import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashRecord } from "../src/execution-orchestrator/development/contract.js";
import { prepareCandidateRepository } from "../src/execution-orchestrator/development/candidate-repo.js";
import { runSandboxFixture, sandboxCapability, SandboxUnavailable, sandboxWorkerEnvironment,
  sandboxNamespaceArguments } from "../src/execution-orchestrator/development/sandbox.js";

const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function liveCandidate() {
  const base = mkdtempSync(join(realpathSync.native(tmpdir()), "rc02-live-sandbox-")); temporary.push(base);
  const canonical = join(base, "canonical"), parent = join(base, "candidates");
  mkdirSync(join(canonical, ".git", "objects"), { recursive: true }); mkdirSync(parent);
  const object = (type: string, body: Buffer) => {
    const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const hash = createHash("sha1").update(raw).digest("hex"), dir = join(canonical, ".git", "objects", hash.slice(0, 2));
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, hash.slice(2)), deflateSync(raw)); return hash;
  };
  const blob = object("blob", Buffer.from("baseline\n"));
  const tree = object("tree", Buffer.concat([Buffer.from("100644 file.txt\0"), Buffer.from(blob, "hex")]));
  const head = object("commit", Buffer.from(`tree ${tree}\nauthor Test <test@invalid> 1 +0000\ncommitter Test <test@invalid> 1 +0000\n\nfixture\n`));
  writeFileSync(join(canonical, ".git", "HEAD"), head + "\n"); writeFileSync(join(canonical, "file.txt"), "canonical\n");
  const digest = "a".repeat(64), seal = <T extends { digest: string }>(value: T) => ({ ...value, digest: hashRecord(value) });
  const delegation = seal({ domain: "RC02_DEVELOPMENT_V2_DELEGATION", id: "dev2-delegation-live", policyId: "dev2-policy-live",
    policyDigest: digest, repositoryId: "dev2-repository-live", baselineHead: head, scope: ["file.txt"], maxAttempts: 1, digest });
  const request = seal({ domain: "RC02_DEVELOPMENT_V2_REQUEST", id: "dev2-request-live", delegationDigest: delegation.digest,
    goalDigest: digest, acceptanceCriteriaDigest: digest, digest });
  const attempt = seal({ domain: "RC02_DEVELOPMENT_V2_ATTEMPT", id: "dev2-attempt-live", requestDigest: request.digest,
    sequence: 1, predecessor: null, candidateId: "dev2-candidate-live", candidateGeneration: 1,
    sessionId: "dev2-session-live", executionId: "dev2-execution-live", inputSnapshotDigest: digest,
    manifestId: "dev2-manifest-live", fastId: "dev2-fast-live", advisoryReviewId: "dev2-review-live",
    materializationId: "dev2-materialization-live", reviewReceiptId: "dev2-receipt-live", digest });
  const binding = { delegation, request, attempt };
  return { canonical, candidate: prepareCandidateRepository({ binding, candidateRoot: join(parent, "one") },
    { expectedBinding: binding, canonicalRoot: canonical, candidateParent: parent }) };
}

describe("RC02 OS-enforced fixture-only execution boundary", () => {
  it("requires explicit userns for disable-userns in the immutable namespace argv policy", () => {
    // Construction regression only; this does not claim Linux OS enforcement was exercised.
    expect(sandboxNamespaceArguments).toEqual([
      "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
    ]);
    expect(Object.isFrozen(sandboxNamespaceArguments)).toBe(true);
  });

  it.each(["executable", "command", "argv", "shell", "cwd", "environment", "env", "network", "networkMode", "mount",
    "mounts", "writablePath", "sandboxProfile", "receipt"])("rejects caller-controlled %s before execution", key => {
    expect(() => runSandboxFixture({ candidate: {}, profile: "ISOLATION_FIXTURE", [key]: "injected" })).toThrow(/Unrecognized key/);
  });

  it.each(["FAST", "SHELL", "NETWORK_ENABLED", "PROPOSAL_TRANSPORT", "bash", "cmd.exe"])("has no %s profile", profile => {
    expect(() => runSandboxFixture({ candidate: {}, profile })).toThrow(/Invalid literal/);
  });

  it("constructs an immutable credential-free allowlist independently of hostile host environment", () => {
    for (const key of ["OPENAI_API_KEY", "OPENAI_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "GIT_ASKPASS",
      "HOME", "USERPROFILE", "AWS_SECRET_ACCESS_KEY", "HTTPS_PROXY", "NODE_OPTIONS", "CONTROLLER_SECRET", "PATH"])
      vi.stubEnv(key, "DO_NOT_CROSS_BOUNDARY");
    expect(sandboxWorkerEnvironment).toEqual({ PATH: "/usr/bin", LANG: "C" });
    expect(Object.isFrozen(sandboxWorkerEnvironment)).toBe(true);
  });

  it("reports capability honestly and fails closed when the real platform/backend is unavailable", () => {
    const capability = sandboxCapability();
    if (process.platform !== "linux") expect(capability).toEqual({ available: false, code: "UNSUPPORTED_PLATFORM" });
    if (!capability.available) {
      expect(() => runSandboxFixture({ candidate: {}, profile: "ISOLATION_FIXTURE" })).toThrow(SandboxUnavailable);
      expect(() => runSandboxFixture({ candidate: {}, profile: "ISOLATION_FIXTURE" })).toThrow(capability.code);
    } else expect(capability.code).toBe("LIVE_PROBE_REQUIRED");
  });

  it("never accepts a serialized candidate or recovered RESERVE receipt as execution authority", () => {
    expect(() => runSandboxFixture({ kind: "RESERVE", receipt: {}, profile: "ISOLATION_FIXTURE" })).toThrow();
    expect(() => runSandboxFixture({ candidate: { kind: "RESERVE", root: "/" }, profile: "ISOLATION_FIXTURE" })).toThrow();
  });

  // This is deliberately SKIPPED on Windows or absent runtime; it must never be counted as OS proof.
  // On a provisioned, unprivileged Linux host the actual bwrap process and actual kernel mechanisms
  // must pass ALL embedded checks. No mock, fake executable, or test-only backend is accepted.
  it.skipIf(!sandboxCapability().available)("LIVE Linux: candidate write; denied host FS/HOME/process access and network; no credentials", () => {
    const f = liveCandidate();
    vi.stubEnv("OPENAI_OAUTH_TOKEN", "DO_NOT_CROSS_BOUNDARY"); vi.stubEnv("SSH_AUTH_SOCK", "/host/agent");
    vi.stubEnv("NODE_OPTIONS", "--require=/host/evil.cjs");
    const result = runSandboxFixture({ candidate: f.candidate, profile: "ISOLATION_FIXTURE" });
    expect(result.osEnforcementLiveTest).toBe("PASS");
    expect(readFileSync(join(f.candidate.root, ".rc02-isolation-fixture"), "utf8")).toBe("isolated\n");
    expect(readFileSync(join(f.canonical, "file.txt"), "utf8")).toBe("canonical\n");
    // A repeated fixture cannot turn an existing marker into a false success.
    expect(() => runSandboxFixture({ candidate: f.candidate, profile: "ISOLATION_FIXTURE" })).toThrow(SandboxUnavailable);
  }, 30_000);
});
