import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateFixture } from "../src/linux-development/fixture.js";
import { assertLinuxIdentity, OutcomeUnknown, providerReadiness, readFixedFixture, runFixedFixture } from "../src/linux-development/runner.js";

const parents: string[] = [];
const root = () => { const parent = fs.mkdtempSync(path.join(os.tmpdir(), "linux-dev-test-")); parents.push(parent); return path.join(parent, "attempt"); };
const commit = "8a84d986c5624c1fc0aabb0823d31cb43947070a";
const roles: string[] = [];
const fake = async (role: "proposer" | "reviewer", input: unknown) => {
  roles.push(role); return { ...evaluateFixture(role, input), pid: role === "proposer" ? 101 : 102 };
};
afterEach(() => { for (const parent of parents.splice(0)) fs.rmSync(parent, { recursive: true, force: true }); roles.splice(0); });

describe("Linux fixed fixture development CLI (NOT AI E2E)", () => {
  it("rejects real root, effective root, unknown identity and non-Linux", () => {
    expect(() => assertLinuxIdentity("linux", 1000, 1000)).not.toThrow();
    for (const [platform, uid, euid] of [["linux", 1000, 0], ["linux", 0, 1000], ["linux", undefined, 1000], ["win32", 1000, 1000]] as const) {
      expect(() => assertLinuxIdentity(platform, uid, euid)).toThrow();
    }
  });
  it("persists task, two role identities, verification and result in existing store", async () => {
    const dir = root(); const result = await runFixedFixture(dir, commit, fake);
    expect(result.result).toBe("FIXED_FIXTURE_PASS_NOT_AI_E2E");
    expect(roles).toEqual(["proposer", "reviewer"]);
    expect(readFixedFixture(dir)).toEqual(result);
    expect(result.authority).toBe("NONE"); expect(result.productionDispatch).toBe("CLOSED");
    expect(result.artifacts.find(a => a.id.endsWith("result"))?.value.provider).toBe("NOT_RUN");
  });
  it("does not reenroll existing root or dispatch again", async () => {
    const dir = root(); await runFixedFixture(dir, commit, fake);
    await expect(runFixedFixture(dir, commit, fake)).rejects.toThrow();
    expect(roles).toHaveLength(2);
  });
  it("records UNKNOWN on proposer loss, never runs review and never resumes", async () => {
    const dir = root(); let calls = 0;
    const result = await runFixedFixture(dir, commit, async () => { calls++; throw new OutcomeUnknown(); });
    expect(result.result).toBe("UNKNOWN_NO_REPLAY"); expect(calls).toBe(1);
    expect(readFixedFixture(dir).result).toBe("UNKNOWN_NO_REPLAY");
    await expect(runFixedFixture(dir, commit, fake)).rejects.toThrow(); expect(roles).toHaveLength(0);
  });
  it("records reviewer loss separately from successful fixed apply", async () => {
    const dir = root(); const result = await runFixedFixture(dir, commit, async (role, input) => {
      if (role === "reviewer") throw new OutcomeUnknown(); return fake(role, input);
    });
    expect(result.result).toBe("UNKNOWN_NO_REPLAY");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "candidate.json"), "utf8"))).toEqual({ counter: 1 });
    expect(result.artifacts.some(a => a.id.endsWith("review-intent"))).toBe(true);
  });
  it("rejects untrusted fixture extras and arbitrary operations", () => {
    expect(() => evaluateFixture("proposer", { fixture: "COUNTER_V1", taskId: randomUUID(), before: 0, command: "shell" })).toThrow();
    expect(() => evaluateFixture("proposer", { fixture: "OTHER", taskId: randomUUID(), before: 0 })).toThrow();
  });
  it("checks candidate independently rather than blindly passing", () => {
    expect(evaluateFixture("reviewer", { request: { fixture: "COUNTER_V1", taskId: randomUUID(), before: 0 }, candidate: { counter: 9 } }).review).toBe("NEEDS_WORK");
  });
  it("rejects role/session identity reuse", async () => {
    const dir = root(); const sessionId = randomUUID();
    const result = await runFixedFixture(dir, commit, async (role, input) => ({ ...await fake(role, input), sessionId }));
    expect(result.result).toBe("UNKNOWN_NO_REPLAY");
  });
  it("rejects cross-task receipts", async () => {
    const result = await runFixedFixture(root(), commit, async (role, input) => ({ ...await fake(role, input), taskId: randomUUID() }));
    expect(result.result).toBe("UNKNOWN_NO_REPLAY"); expect(roles).toEqual(["proposer"]);
  });
  it("invalid source SHA creates no state", async () => {
    const dir = root(); await expect(runFixedFixture(dir, "main", fake)).rejects.toThrow(); expect(fs.existsSync(dir)).toBe(false);
  });
  it("tampered journal cannot claim stored success", async () => {
    const dir = root(); await runFixedFixture(dir, commit, fake);
    const journal = "development-v2.journal";
    fs.appendFileSync(path.join(dir, journal), "broken\n");
    expect(() => readFixedFixture(dir)).toThrow();
  });
  it("provider readiness does not inspect or copy credentials", () => {
    expect(providerReadiness()).toMatchObject({ provider: "NOT_RUN", credentialImported: false, authority: "NONE" });
  });
});
