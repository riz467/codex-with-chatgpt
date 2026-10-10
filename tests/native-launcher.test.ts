import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DevelopmentStore } from "../src/execution-orchestrator/development/store.js";
import { canonicalJson } from "../src/task-contract/contract.js";
import { admitFixedNative, assertNativeFileMetadata, assertNativeIdentity, authorizationSchema,
  nativeHash, type NativeAuthorization } from "../src/linux-development/native-admission.js";
import { parseNativeCli } from "../src/linux-development/native-cli.js";
import { assertEmptyCgroupObservation, assertNativeSettlement, type NativeRoleLauncher } from "../src/linux-development/native-launcher.js";
import { coordinateOfflineFixedNative, nativeIntentBinding, nativePublicReceiptSchema, assertUnresolvedNativeIntent, type NativeIntentJournal } from "../src/linux-development/native-receipt.js";
import { evaluateNativeWorkerData, nativeWorkerInputSchema, type NativeWorkerInput, type NativeTransportResult } from "../src/linux-development/native-worker.js";

const taskId = "a182d41b-2220-43cb-bbcc-3a22b8798981";
const auth: NativeAuthorization = { version: 1, task: "COUNTER_JSON_V1", taskId, custodianUid: 993,
  sourceCommit: "a".repeat(40), manifestSha256: "b".repeat(64), dispatch: "ONE_FIXED_ATTEMPT", receiptId: "receipt-001" };
describe("late worker journal fence conditions, not OS dispatch proof", () => {
  function observation(names: string[], role = "proposer", digest = "d".repeat(64)) {
    const blobs: Record<string,string> = {}, artifacts = names.map(name => {
      const sha256 = nativeHash(name), content = { version: 1, role, taskId, inputDigest: digest, settlement: "UNKNOWN_UNTIL_RECEIPT", replay: false };
      blobs[sha256] = Buffer.from(canonicalJson(content)).toString("base64");
      return { id: `dev2-artifact-native-${name}`, sha256 };
    });
    return { writerFenced: false, disposition: "RECOVERED", state: { artifacts, blobs } } as unknown as ReturnType<DevelopmentStore["recover"]>;
  }
  it("allows only the still unresolved exact intent", () => {
    expect(() => assertUnresolvedNativeIntent(observation(["proposer-intent"]), "proposer", taskId, "d".repeat(64))).not.toThrow();
  });
  it.each(["unknown", "result", "proposer-settled"])("denies a delayed worker after durable %s", name => {
    expect(() => assertUnresolvedNativeIntent(observation(["proposer-intent", name]), "proposer", taskId, "d".repeat(64))).toThrow();
  });
  it("denies missing or wrong bound intent and writer fencing", () => {
    const r = observation(["proposer-intent"]);
    expect(() => assertUnresolvedNativeIntent(observation([]), "proposer", taskId, "d".repeat(64))).toThrow();
    expect(() => assertUnresolvedNativeIntent(r, "proposer", taskId, "e".repeat(64))).toThrow();
    expect(() => assertUnresolvedNativeIntent({ ...r, writerFenced: true }, "proposer", taskId, "d".repeat(64))).toThrow();
  });
  it("reviewer requires proposer settlement and no terminal publication", () => {
    expect(() => assertUnresolvedNativeIntent(observation(["reviewer-intent"], "reviewer"), "reviewer", taskId, "d".repeat(64))).toThrow();
    expect(() => assertUnresolvedNativeIntent(observation(["reviewer-intent", "proposer-settled"], "reviewer"), "reviewer", taskId, "d".repeat(64))).not.toThrow();
    expect(() => assertUnresolvedNativeIntent(observation(["reviewer-intent", "proposer-settled", "unknown"], "reviewer"), "reviewer", taskId, "d".repeat(64))).toThrow();
  });
});
function input(role: "proposer" | "reviewer" = "proposer"): NativeWorkerInput {
  return { version: 1, task: "COUNTER_JSON_V1", taskId, role, request: { counter: 0 },
    candidate: role === "reviewer" ? { counter: 1 } : null, proposalSessionId: role === "reviewer" ? "ses_proposer" : null };
}
function transportResult(role: "proposer" | "reviewer", review: "PASS" | "NEEDS_WORK" = "PASS"): NativeTransportResult {
  return { version: 1, role, sessionId: `ses_${role}`, proposal: role === "proposer" ? { counter: 1 } : null,
    review: role === "reviewer" ? review : null };
}
function fixture(failRecord?: string) {
  const events: string[] = [], records = new Map<string, unknown>();
  const journal: NativeIntentJournal = {
    record(name, data) {
      events.push(name);
      if (name === failRecord || records.has(name)) throw new Error("PRIVATE_TOKEN_RAW_ERROR");
      records.set(name, JSON.parse(canonicalJson(data)));
    },
    evidence() { return [...records].map(([id, data]) => ({ id: `dev2-artifact-native-${id}`, sha256: nativeHash(canonicalJson(data)) })); },
  };
  const launcher = vi.fn<NativeRoleLauncher>(async i => {
    events.push(`launch-${i.role}`);
    const output = await evaluateNativeWorkerData(i, { dispatchFixedNativeRole: async () => transportResult(i.role) }, i.role === "proposer" ? 71 : 72);
    return { output, settlement: "EXIT_0_AND_CGROUP_EMPTY", pid: output.pid };
  });
  return { events, records, journal, launcher };
}

describe("fixed native admission: pure metadata observations, not actual Linux OS proof", () => {
  it.each([["win32", 993, 993], ["linux", 0, 993], ["linux", 993, 0], ["linux", 994, 993], ["linux", 993, 994],
    ["linux", undefined, 993]] as const)("rejects identity %s %s %s", (platform, uid, euid) => {
    expect(() => assertNativeIdentity(platform, uid, euid)).toThrow("NATIVE_BLOCKED");
  });
  it("accepts only exact real/effective custodian UID", () => expect(() => assertNativeIdentity("linux", 993, 993)).not.toThrow());
  const metadata = { uid: 0, mode: 0o644, nlink: 1, size: 50, file: true, symlink: false };
  it.each([{ uid: 993 }, { mode: 0o664 }, { mode: 0o666 }, { mode: 0o4644 }, { mode: 0o2644 }, { nlink: 2 },
    { size: 65537 }, { file: false }, { symlink: true }])("rejects root authorization metadata %j", change => {
    expect(() => assertNativeFileMetadata({ ...metadata, ...change }, 0)).toThrow();
  });
  it("allows root-owned readable authorization but requires private receipt permissions", () => {
    expect(() => assertNativeFileMetadata(metadata, 0)).not.toThrow();
    expect(() => assertNativeFileMetadata({ ...metadata, uid: 993 }, 993)).toThrow();
    expect(() => assertNativeFileMetadata({ ...metadata, uid: 993, mode: 0o600 }, 993)).not.toThrow();
  });
  it.each([{ ...auth, enabled: true }, { ...auth, custodianUid: 994 }, { ...auth, task: "ARBITRARY" },
    { ...auth, dispatch: "RETRY" }, { ...auth, manifestSha256: "z".repeat(64) }])("rejects caller extensions %j", a => {
    expect(() => authorizationSchema.parse(a)).toThrow();
  });
  it("actual production admission is closed on Windows regardless of caller input", () => {
    if (process.platform === "win32") expect(() => admitFixedNative()).toThrow("NATIVE_BLOCKED");
  });
  it.each([[], ["run", "--enabled"], ["run", "/tmp/state"], ["status", "--credential"], ["arbitrary"], ["provider-readiness"]])("rejects CLI %j", args => {
    expect(() => parseNativeCli(args)).toThrow();
  });
  it.each(["run", "status", "readreceipt"])("accepts fixed CLI %s", command => expect(parseNativeCli([command])).toBe(command));
});

describe("strict process/cgroup observation contracts (injected, not real OS)", () => {
  const group = { events: "populated 0\nfrozen 0", pids: "", descendantGroups: 0 };
  const settled = { exitCode: 0, signal: null, closeObserved: true, outputBounded: true, spawnError: false, group };
  it("requires exit+close and recursive populated0/pids empty", () => expect(() => assertNativeSettlement(settled)).not.toThrow());
  it.each([{ events: "populated 1" }, { events: "populated 0\npopulated 0" }, { events: "frozen 0" },
    { pids: "99" }, { descendantGroups: 1 }])("rejects unsettled group %j", change => {
    expect(() => assertEmptyCgroupObservation({ ...group, ...change })).toThrow();
  });
  it.each([{ exitCode: 2 }, { exitCode: null }, { signal: "SIGTERM" }, { closeObserved: false }, { outputBounded: false },
    { spawnError: true }, { group: { ...group, pids: "99" } }])("rejects incomplete child %j", change => {
    expect(() => assertNativeSettlement({ ...settled, ...change })).toThrow();
  });
});

describe("fixed DATA-only worker seam", () => {
  it.each([{ ...input(), command: "echo secret" }, { ...input(), request: { counter: 0, prompt: "secret" } },
    { ...input(), candidate: { counter: 1 } }, { ...input("reviewer"), candidate: null },
    { ...input("reviewer"), proposalSessionId: null }, { ...input(), task: "COUNTER_V2" }])("rejects nonfixed data %j", i => {
    expect(() => nativeWorkerInputSchema.parse(i)).toThrow();
  });
  it("freezes nested request DATA and binds digest before dispatch", async () => {
    const i = input();
    const r = await evaluateNativeWorkerData(i, { dispatchFixedNativeRole: async value => {
      expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.request)).toBe(true);
      return transportResult("proposer");
    } }, 71);
    expect(r.inputDigest).toBe(nativeHash(canonicalJson(i))); expect(r.pid).toBe(71);
  });
  it.each([{ ...transportResult("proposer"), tokens: "secret" }, { ...transportResult("proposer"), proposal: { counter: 2 } },
    transportResult("reviewer"), { ...transportResult("proposer"), sessionId: "fake" }])("rejects malformed proposal result %j", result => {
    return expect(evaluateNativeWorkerData(input(), { dispatchFixedNativeRole: async () => result as NativeTransportResult }, 71)).rejects.toThrow();
  });
  it("rejects reviewer session reuse", async () => {
    await expect(evaluateNativeWorkerData(input("reviewer"), { dispatchFixedNativeRole: async () => ({
      ...transportResult("reviewer"), sessionId: "ses_proposer" }) }, 72)).rejects.toThrow();
  });
});

describe("durable-intent serial coordination: injected contracts only", () => {
  it("real DevelopmentStore reopen retains role intents/results, without native OS labels", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-intent-store-"));
    try {
      const binding = nativeIntentBinding(auth);
      const created = DevelopmentStore.create(root, { operation: "CREATE", transactionId: "dev2-store-tx-native-create",
        expectedVersion: 0, binding }, binding);
      const anchor = created.store.anchorOf(created.receipt);
      const journal: NativeIntentJournal = {
        record(name, data) {
          const recovered = created.store.recover();
          created.store.transact({ operation: "ARTIFACT", transactionId: `dev2-store-tx-native-${name}`,
            expectedVersion: recovered.state.version, binding, artifactId: `dev2-artifact-native-${name}`,
            contentBase64: Buffer.from(canonicalJson(data)).toString("base64") }, binding);
        },
        evidence() { return created.store.recover().state.artifacts.map(a => ({ id: a.id, sha256: a.sha256 })); },
      };
      const f = fixture(); const r = await coordinateOfflineFixedNative(auth, journal, f.launcher);
      expect(r.result).toBe("OFFLINE_CONTRACT_PASS_NOT_NATIVE");
      const reopened = DevelopmentStore.open(root, anchor).recover();
      expect(reopened.writerFenced).toBe(false);
      expect(reopened.state.artifacts.map(a => a.id)).toEqual(["proposer-intent", "proposer-settled", "fixed-data-verification",
        "reviewer-intent", "reviewer-settled", "result"].map(id => `dev2-artifact-native-${id}`));
      const last = reopened.state.artifacts.at(-1)!;
      expect(JSON.parse(Buffer.from(reopened.state.blobs[last.sha256], "base64").toString("utf8")).result).toBe("OFFLINE_CONTRACT_PASS_NOT_NATIVE");
      await expect(coordinateOfflineFixedNative(auth, journal, f.launcher)).rejects.toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("records each intent before launch, settlement before reviewer, and never claims native pass", async () => {
    const f = fixture(); const r = await coordinateOfflineFixedNative(auth, f.journal, f.launcher);
    expect(f.events).toEqual(["proposer-intent", "launch-proposer", "proposer-settled", "fixed-data-verification",
      "reviewer-intent", "launch-reviewer", "reviewer-settled", "result"]);
    expect(r.result).toBe("OFFLINE_CONTRACT_PASS_NOT_NATIVE"); expect(r.fastOsProof).toBe("NOT_CLAIMED");
    expect(r.settlements.map(s => s.proof)).toEqual(["OFFLINE_OBSERVATION_ONLY", "OFFLINE_OBSERVATION_ONLY"]);
    expect(r.authority).toBe("NONE"); expect(r.productionDispatch).toBe("CLOSED");
  });
  it.each(["proposer-intent", "proposer-settled", "fixed-data-verification", "reviewer-intent"])("holds fence on journal failure at %s", async name => {
    const f = fixture(name); const r = await coordinateOfflineFixedNative(auth, f.journal, f.launcher);
    expect(r.result).toBe("UNKNOWN_NO_REPLAY"); expect(f.events).not.toContain("launch-reviewer");
    if (name === "proposer-intent") expect(f.launcher).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain("PRIVATE_TOKEN");
  });
  it("unknown child never opens reviewer or retries", async () => {
    const f = fixture(); f.launcher.mockRejectedValue(new Error("PRIVATE_PROVIDER_ERROR_TOKEN"));
    const r = await coordinateOfflineFixedNative(auth, f.journal, f.launcher);
    expect(r.result).toBe("UNKNOWN_NO_REPLAY"); expect(f.launcher).toHaveBeenCalledTimes(1);
    await expect(coordinateOfflineFixedNative(auth, f.journal, f.launcher)).rejects.toThrow("NATIVE_BLOCKED");
    expect(f.launcher).toHaveBeenCalledTimes(1); expect(JSON.stringify(r)).not.toContain("TOKEN");
  });
  it.each(["inputDigest", "taskId", "pid", "role", "sessionId", "unknownField"])("fails closed on invalid proposal %s", async field => {
    const f = fixture(); f.launcher.mockImplementation(async i => {
      const output = await evaluateNativeWorkerData(i, { dispatchFixedNativeRole: async () => transportResult(i.role) }, 71);
      const bad = { ...output, [field]: field === "pid" ? 99 : "bad" };
      return { output: bad, settlement: "EXIT_0_AND_CGROUP_EMPTY", pid: 71 };
    });
    const r = await coordinateOfflineFixedNative(auth, f.journal, f.launcher);
    expect(r.result).toBe("UNKNOWN_NO_REPLAY"); expect(f.launcher).toHaveBeenCalledTimes(1);
  });
  it("does not label pass from an unrecognized settlement", async () => {
    const f = fixture(); f.launcher.mockResolvedValue({ output: {}, settlement: "EXIT_ONLY" as never, pid: 71 });
    const r = await coordinateOfflineFixedNative(auth, f.journal, f.launcher);
    expect(r.result).toBe("UNKNOWN_NO_REPLAY"); expect(f.launcher).toHaveBeenCalledTimes(1);
  });
  it("rejects reviewer replay even with settled injected process", async () => {
    const f = fixture(); f.launcher.mockImplementation(async i => {
      const output = { ...transportResult(i.role), sessionId: "ses_proposer", taskId, inputDigest: nativeHash(canonicalJson(i)), pid: 71 };
      return { output, settlement: "EXIT_0_AND_CGROUP_EMPTY", pid: 71 };
    });
    const r = await coordinateOfflineFixedNative(auth, f.journal, f.launcher);
    expect(r.result).toBe("UNKNOWN_NO_REPLAY"); expect(r.reviewerSessionId).toBeNull();
  });
  it("allows independent settled NEEDS_WORK without any authority", async () => {
    const f = fixture(); f.launcher.mockImplementation(async i => {
      const output = await evaluateNativeWorkerData(i, { dispatchFixedNativeRole: async () => transportResult(i.role, "NEEDS_WORK") }, 71);
      return { output, settlement: "EXIT_0_AND_CGROUP_EMPTY", pid: 71 };
    });
    const r = await coordinateOfflineFixedNative(auth, f.journal, f.launcher);
    expect(r.result).toBe("NEEDS_WORK"); expect(r.authority).toBe("NONE");
  });
  it("unknown after result persistence failure, despite both child observations", async () => {
    const f = fixture("result"); const r = await coordinateOfflineFixedNative(auth, f.journal, f.launcher);
    expect(r.result).toBe("UNKNOWN_NO_REPLAY"); expect(r.settlements).toHaveLength(2);
  });
  it("rejects public secret extension, unsupported native labels, and incomplete settlement", async () => {
    const f = fixture(); const r = await coordinateOfflineFixedNative(auth, f.journal, f.launcher);
    expect(() => nativePublicReceiptSchema.parse({ ...r, token: "secret" })).toThrow();
    expect(() => nativePublicReceiptSchema.parse({ ...r, result: "NATIVE_FIXED_DATA_ADVISORY_PASS_ONLY" })).toThrow();
    expect(() => nativePublicReceiptSchema.parse({ ...r, settlements: [] })).toThrow();
    expect(() => nativePublicReceiptSchema.parse({ ...r, reviewerSessionId: r.proposerSessionId })).toThrow();
    expect(() => nativePublicReceiptSchema.parse({ ...r, mode: "NATIVE_LINUX_HOST", result: "NEEDS_WORK" })).toThrow();
  });
});
