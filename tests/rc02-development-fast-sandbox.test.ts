import fs from "node:fs";
import path from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fastEnvironment, fastSandboxPlan, inspectFastRuntime, runFastSandbox } from "../src/execution-orchestrator/development/fast-sandbox.js";
import * as mutation from "../src/execution-orchestrator/development/candidate-mutation.js";
import { cleanup, fixture, passSummary } from "./rc02-development-e0-fixture.js";
import { fixCandidateFast } from "../src/execution-orchestrator/development/candidate-fast.js";
import { DevelopmentStore } from "../src/execution-orchestrator/development/store.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>() }));

// Filesystem/child-process adapter fixture only: no Linux process is launched.
function linuxRuntimeFixture(onFast?: () => void, failure?: "timeout" | "fail" | "full") {
  const nativeProcess = process;
  vi.stubGlobal("process", new Proxy(nativeProcess, { get(target, key) {
    if (key === "platform") return "linux";
    if (key === "getuid" || key === "geteuid") return () => 1000;
    return Reflect.get(target, key);
  } }));
  const entries = ["", "candidate", "proc", "dev", "tmp", "scratch", "usr", "usr/bin", "runtime", "runtime/scripts", "runtime/node_modules",
    "usr/bin/node", "usr/bin/git", "runtime/scripts/verify-ai-workspace.mjs", "runtime/scripts/verification-policy.mjs"];
  const isFile = (name: string) => /(?:node|git|\.mjs)$/.test(name);
  const tree = Object.fromEntries(entries.map(name => [name, { kind: isFile(name) ? "FILE" : "DIRECTORY", identity: "fixture",
    ...(isFile(name) ? { sha256: "a".repeat(64), byteLength: 1 } : {}) }])) as mutation.TreeSnapshot;
  const snapshot = mutation.snapshotTree;
  vi.spyOn(mutation, "snapshotTree").mockImplementation((root, candidate) => root === "/opt/rc02-fast-runtime" ? tree : snapshot(root, candidate));
  const trusted = (name: unknown) => typeof name === "string" && /^(?:\/$|\/opt(?:\/|$)|\/usr(?:\/|$))/.test(name.replaceAll("\\", "/"));
  const stat = fs.lstatSync, realpath = fs.realpathSync.native, list = fs.readdirSync;
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((name: any, ...args: any[]) => name === "/proc/self/mountinfo"
    ? "1 0 8:1 / / rw - ext4 /dev/root rw\n" : (read as any)(name, ...args)) as any);
  vi.spyOn(fs, "lstatSync").mockImplementation(((name: any, ...args: any[]) => trusted(name)
    ? { uid: 0, mode: 0o755, nlink: 1, isSymbolicLink: () => false, isFile: () => isFile(String(name)) || String(name).endsWith("bwrap"),
      isDirectory: () => !isFile(String(name)) && !String(name).endsWith("bwrap") }
    : (stat as any)(name, ...args)) as any);
  vi.spyOn(fs.realpathSync, "native").mockImplementation(((name: any, ...args: any[]) => trusted(name) ? name : (realpath as any)(name, ...args)) as any);
  vi.spyOn(fs, "readdirSync").mockImplementation(((name: any, ...args: any[]) => {
    if (!trusted(name)) return (list as any)(name, ...args);
    const n = String(name).replaceAll("\\", "/");
    if (n === "/opt/rc02-fast-runtime") return ["usr", "runtime", "candidate", "proc", "dev", "tmp", "scratch"];
    if (n.endsWith("/usr/bin")) return ["node", "git"];
    return [];
  }) as any);
  const spawn = childProcess.spawnSync;
  return vi.spyOn(childProcess, "spawnSync").mockImplementation(((exe: any, args: any, options: any) => {
    if (exe !== "/usr/bin/bwrap") return (spawn as any)(exe, args, options);
    expect(options.shell).toBe(false); expect(options.env).toEqual({ LANG: "C" });
    if (args.at(-1) === "--version") return { status: 0, signal: null, stdout: Buffer.from("v22.1.0\n"), stderr: Buffer.alloc(0) };
    onFast?.();
    if (failure === "timeout") return { status: null, signal: "SIGKILL", error: new Error("ETIMEDOUT"), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const summary = failure === "full" ? { ...passSummary(), effective_profile: "FULL_REQUIRED", escalation_required: true } : passSummary();
    return { status: failure ? 1 : 0, signal: null, stdout: Buffer.from(JSON.stringify(summary) + "\n"), stderr: Buffer.alloc(0) };
  }) as any);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanup(); });
describe("E0 FAST OS boundary (static/fixture, not live certification)", () => {
  it.skipIf(process.platform !== "linux" || !fs.existsSync("/opt/rc02-fast-runtime"))("Linux live malicious-test fixture (out-of-band capsule required)", () => {
    inspectFastRuntime();
    const extra = Object.fromEntries(["verify-ai-workspace.mjs", "verification-policy.mjs"].map(name =>
      [`scripts/${name}`, fs.readFileSync(`/opt/rc02-fast-runtime/runtime/scripts/${name}`, "utf8")]));
    const f = fixture(["tests/isolation.test.ts"], extra); f.ready();
    const source = `import { test, expect } from 'vitest';
import fs from 'node:fs'; import net from 'node:net'; import os from 'node:os';
test('OS FAST boundary', async () => {
 const denied = fn => { let error; try { fn(); } catch (e) { error = e; } expect(error).toBeTruthy(); };
 denied(() => fs.writeFileSync('/candidate/file.txt', 'escape'));
 denied(() => fs.writeFileSync('/candidate/.git/HEAD', 'escape'));
 denied(() => fs.writeFileSync('/candidate/node_modules/.forbidden', 'escape'));
 denied(() => fs.readFileSync(${JSON.stringify(path.join(f.canonical, "private.txt"))}));
 denied(() => fs.readdirSync('/home')); denied(() => fs.readdirSync('/root'));
 expect(process.env.HOME).toBeUndefined(); expect(process.env.USERPROFILE).toBeUndefined();
 expect(fs.readFileSync('/candidate/file.txt','utf8')).toBe('before\\r\\n');
 fs.writeFileSync('/tmp/allowed','ok'); fs.writeFileSync('/scratch/allowed','ok');
 expect(fs.readFileSync('/proc/self/status','utf8')).toMatch(/^NoNewPrivs:\\s+1$/m);
 expect(fs.readFileSync('/proc/self/status','utf8')).toMatch(/^CapEff:\\s+0+$/m);
 expect(Object.keys(os.networkInterfaces()).every(n => n === 'lo')).toBe(true);
 await new Promise((resolve,reject) => { const s=net.connect({host:'1.1.1.1',port:53});
  s.on('connect',()=>{s.destroy();reject(new Error('network escaped'));}); s.on('error',()=>resolve());
  s.setTimeout(1500,()=>{s.destroy();reject(new Error('network inconclusive'));}); });
});`;
    const handle = mutation.mutateCandidate({ ...f.input(), proposal: f.proposal([{ path: "tests/isolation.test.ts", content: source }]) }, f.binding);
    expect(fixCandidateFast(handle, mutation.inspectMutatedCandidate(handle).binding).result).toBe("PASS");
  }, 620_000);
  it("has read-only root, candidate, verifier overlays and dependency tree, fixed argv and no shell", () => {
    const plan = fastSandboxPlan(path.resolve("candidate"));
    expect(plan.executable).toBe("/usr/bin/bwrap");
    expect(plan.args.slice(-4)).toEqual(["--", "/usr/bin/node", "/candidate/scripts/verify-ai-workspace.mjs", "FAST"]);
    for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
      "--disable-userns", "--assert-userns-disabled", "--new-session", "--clearenv"]) expect(plan.args).toContain(flag);
    expect(plan.args).toContain("--cap-drop"); expect(plan.args).toContain("ALL");
    expect(plan.args).not.toContain("--bind"); expect(plan.args).not.toContain("pnpm"); expect(plan.args).not.toContain("sh");
    const binds = plan.args.flatMap((v, i) => v === "--ro-bind" ? [[plan.args[i + 1], plan.args[i + 2]]] : []);
    expect(binds).toContainEqual(["/opt/rc02-fast-runtime/runtime/scripts/verify-ai-workspace.mjs", "/candidate/scripts/verify-ai-workspace.mjs"]);
    expect(binds).toContainEqual(["/opt/rc02-fast-runtime/runtime/scripts/verification-policy.mjs", "/candidate/scripts/verification-policy.mjs"]);
    expect(binds).toContainEqual(["/opt/rc02-fast-runtime/runtime/node_modules", "/candidate/node_modules"]);
    expect(plan.args.flatMap((v, i) => v === "--tmpfs" ? [plan.args[i + 1]] : [])).toEqual(["/tmp", "/scratch"]);
    expect(plan.timeout).toBe(600_000); expect(plan.maxBuffer).toBe(1024 * 1024);
  });
  it("has no credentials, HOME, agent, provider, registry or inherited environment", () => {
    for (const name of ["HOME", "USERPROFILE", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "GITHUB_TOKEN", "NODE_OPTIONS", "NPM_TOKEN"])
      expect(fastEnvironment).not.toHaveProperty(name);
    expect(fastEnvironment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(fastEnvironment.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(fastEnvironment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(fastEnvironment.GIT_ALLOW_PROTOCOL).toBe("");
    expect(fastEnvironment.PATH).toBe("/usr/bin");
  });
  it("rejects forged mutation handles before reservation or launch", () => {
    expect(() => runFastSandbox({ kind: "MANIFEST_COMMITTED_EVIDENCE_ONLY" }, {})).toThrow("UNRECOGNIZED");
  });
  it.skipIf(process.platform === "linux")("Windows never executes a candidate FAST process", () => {
    const f = fixture(); f.ready(); const handle = mutation.mutateCandidate(f.input(), f.binding);
    const spawn = vi.spyOn(childProcess, "spawnSync");
    expect(() => inspectFastRuntime()).toThrow("UNSUPPORTED_PLATFORM");
    const result = runFastSandbox(handle, mutation.inspectMutatedCandidate(handle).binding);
    expect(result).toEqual({ outcome: "FAILED_KNOWN", reason: "UNSUPPORTED_PLATFORM" });
    expect(spawn.mock.calls.filter(([exe]) => exe === "/usr/bin/bwrap" || exe === process.execPath)).toHaveLength(0);
    expect(f.store.recover().state.state).toBe("FAST_IN_PROGRESS");
    expect(() => runFastSandbox(handle, mutation.inspectMutatedCandidate(handle).binding)).toThrow();
  });
  it("drift after Manifest fails closed as UNKNOWN, never known test failure", () => {
    const f = fixture(); f.ready(); const handle = mutation.mutateCandidate(f.input(), f.binding);
    fs.writeFileSync(path.join(f.candidate.root, "keep.txt"), "unexpected drift");
    const result = runFastSandbox(handle, mutation.inspectMutatedCandidate(handle).binding);
    expect(result.outcome).toBe("UNKNOWN");
  });
  it("fixture execution reserves first, binds capsule identity, and never executes candidate verifier", () => {
    const f = fixture(); f.ready(); const handle = mutation.mutateCandidate(f.input(), f.binding), b = mutation.inspectMutatedCandidate(handle).binding;
    const spawn = linuxRuntimeFixture(() => {
      const r = f.store.recover();
      expect(r.state.state).toBe("FAST_IN_PROGRESS");
      expect(r.state.reservations.find(x => x.kind === "FAST")?.status).toBe("HELD");
      expect(r.state.binding.manifest).toBeDefined();
    });
    const result = runFastSandbox(handle, b);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "PASS" });
    if (result.outcome === "PASS") {
      expect(result.evidence.runtimeCapsuleDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.evidence.nodeVersion).toBe("v22.1.0");
      expect(result.evidence.gitExecutableDigest).toBe("a".repeat(64));
    }
    expect(spawn.mock.calls.filter(([exe]) => exe === "/usr/bin/bwrap")).toHaveLength(2);
    expect(() => runFastSandbox(handle, b)).toThrow();
  });
  it.each(["timeout", "fail", "full"] as const)("fixture %s has no PASS or automatic retry", failure => {
    const f = fixture(); f.ready(); const handle = mutation.mutateCandidate(f.input(), f.binding), b = mutation.inspectMutatedCandidate(handle).binding;
    const spawn = linuxRuntimeFixture(undefined, failure);
    expect(runFastSandbox(handle, b).outcome).toBe(failure === "timeout" ? "UNKNOWN" : "FAILED_KNOWN");
    expect(() => runFastSandbox(handle, b)).toThrow();
    expect(spawn.mock.calls.filter(([exe]) => exe === "/usr/bin/bwrap")).toHaveLength(2);
  });
  it("fixture post-execution drift overrides a passing verifier summary", () => {
    const f = fixture(); f.ready(); const handle = mutation.mutateCandidate(f.input(), f.binding);
    linuxRuntimeFixture(() => fs.writeFileSync(path.join(f.candidate.root, "file.txt"), "host fixture drift"));
    expect(runFastSandbox(handle, mutation.inspectMutatedCandidate(handle).binding).outcome).toBe("UNKNOWN");
  });
  it.each(["owner", "writable", "hardlink", "symlink"])("rejects %s runtime capsule relationship", kind => {
    linuxRuntimeFixture(); const stat = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((name: any, ...args: any[]) => {
      const s = (stat as any)(name, ...args);
      if (String(name).replaceAll("\\", "/").endsWith("usr/bin/node")) return { ...s,
        ...(kind === "owner" ? { uid: 1000 } : kind === "writable" ? { mode: 0o777 } :
          kind === "hardlink" ? { nlink: 2 } : { isSymbolicLink: () => true }) };
      return s;
    }) as any);
    expect(() => inspectFastRuntime()).toThrow("FAST_UNTRUSTED_RUNTIME");
  });
  it("failed FAST reservation launches no process", () => {
    const f = fixture(); f.ready(); const handle = mutation.mutateCandidate(f.input(), f.binding), b = mutation.inspectMutatedCandidate(handle).binding;
    const spawn = linuxRuntimeFixture();
    vi.spyOn(DevelopmentStore.prototype, "transact").mockImplementation(() => { throw new Error("reserve failed"); });
    expect(() => runFastSandbox(handle, b)).toThrow("reserve failed");
    expect(spawn.mock.calls.filter(([exe]) => exe === "/usr/bin/bwrap")).toHaveLength(0);
    expect(() => runFastSandbox(handle, b)).toThrow("FAST_REPLAY");
  });
  it("rejects mounted external capsule aliases", () => {
    linuxRuntimeFixture(); const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((name: any, ...args: any[]) => name === "/proc/self/mountinfo"
      ? "1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 /external /opt/rc02-fast-runtime/runtime rw - ext4 /dev/root rw\n"
      : (read as any)(name, ...args)) as any);
    expect(() => inspectFastRuntime()).toThrow("FAST_RUNTIME_MOUNT_ALIAS");
  });
});
