import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { sandboxNamespaceArguments, sandboxWorkerEnvironment } from "../src/execution-orchestrator/development/sandbox.js";
import { fastEnvironment, fastSandboxPlan } from "../src/execution-orchestrator/development/fast-sandbox.js";

const fixedFastFiles = {
  "etc/hosts": "127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n",
  "etc/nsswitch.conf": "hosts: files\n",
  "runtime/git-excludes": "/node_modules/\n",
};

// Execute the real builder against a virtual Linux filesystem and trusted ldd fixture.
// No platform-specific native binary, root privileges or provisioning is needed.
function runtimeFixture(options: { output?: string; lddError?: boolean; entry?: "symlink" | "special" | "directory"; uid?: number } = {}) {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../scripts/ct704-stage1-runtime.mjs"), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replaceAll("import.meta.dirname", JSON.stringify("/reviewed/scripts"));
  const entries = new Map<string, { kind: string; mode: number; content?: string }>();
  const copies: string[][] = [];
  const inspections: string[] = [];
  const logs: string[] = [];
  const stats = (file: string) => {
    const value = entries.get(file);
    if (!value) throw new Error(`Missing fixture entry: ${file}`);
    return { mode: value.mode, isDirectory: () => value.kind === "directory", isFile: () => value.kind === "file" };
  };
  const mkdir = (dir: string, recursive = false) => {
    if (entries.has(dir)) {
      if (!recursive) throw new Error("EXISTING_CAPSULE");
      return;
    }
    if (recursive && path.posix.dirname(dir) !== dir) mkdir(path.posix.dirname(dir), true);
    entries.set(dir, { kind: "directory", mode: 0o700 });
  };
  const mockFs = {
    mkdirSync: (dir: string, opts?: { recursive?: boolean }) => mkdir(dir, opts?.recursive),
    copyFileSync: (from: string, to: string) => {
      copies.push([from, to]);
      entries.set(to, { kind: "file", mode: from.endsWith("/node") || from.endsWith("/git") ? 0o700 : 0o600 });
    },
    writeFileSync: (file: string, content: string) => entries.set(file, { kind: "file", mode: 0o600, content }),
    cpSync: (from: string, to: string, opts: { recursive: boolean; dereference: boolean; filter: (source: string) => boolean }) => {
      expect(from).toBe("/reviewed/node_modules");
      expect(opts).toMatchObject({ recursive: true, dereference: false });
      expect(opts.filter).toBeTypeOf("function");
      mkdir(to, true);
      // Deliberately insert reverse lexical order, including a nested hidden dependency.
      entries.set(`${to}/z.node`, { kind: "file", mode: 0o600 });
      mkdir(`${to}/.pnpm/package`, true);
      entries.set(`${to}/.pnpm/package/a.node`, { kind: options.entry ?? "file", mode: 0o600 });
      entries.set(`${to}/index.js`, { kind: "file", mode: 0o600 });
    },
    readdirSync: (dir: string) => [...entries.keys()]
      .filter(file => file !== dir && path.posix.dirname(file) === dir)
      .map(file => ({ name: path.posix.basename(file), ...stats(file) })),
    lstatSync: stats, statSync: stats,
    chmodSync: (file: string, mode: number) => { entries.get(file)!.mode = mode; },
  };
  const run = () => runInNewContext(source, {
    fs: mockFs, path: path.posix,
    process: { platform: "linux", getuid: () => options.uid ?? 0, execPath: "/trusted/bin/node" },
    console: { log: (text: string) => logs.push(text) },
    execFileSync: (exe: string, args: string[], opts: object) => {
      expect(exe).toBe("/usr/bin/ldd");
      expect(opts).toEqual({ encoding: "utf8", env: { LANG: "C" } });
      expect(args).toHaveLength(1);
      inspections.push(args[0]);
      if (args[0].endsWith(".node")) {
        if (options.lddError) throw new Error("LDD_INSPECTION_FAILED");
        if (options.output !== undefined) return options.output;
        return "linux-vdso.so.1 (0x0001)\n librt.so.1 => /lib/x86_64-linux-gnu/librt.so.1 (0x0002)\n /lib64/ld-linux-x86-64.so.2 (0x0003)\n";
      }
      return "libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0002)\n /lib64/ld-linux-x86-64.so.2 (0x0003)\n";
    },
  });
  return { run, entries, copies, inspections, logs, source };
}

it("Stage 1 materializes exact sealed FAST-only local name-service and Git exclude files without host configuration", () => {
  const fixture = runtimeFixture();
  fixture.run();
  for (const [name, content] of Object.entries(fixedFastFiles)) {
    expect(fixture.entries.get(`/opt/rc02-fast-runtime/${name}`)).toEqual({ kind: "file", mode: 0o644, content });
    expect(fixture.entries.has(`/opt/rc02-sandbox-runtime/${name}`)).toBe(false);
  }
  expect(fixture.entries.get("/opt/rc02-fast-runtime/etc")).toEqual({ kind: "directory", mode: 0o755 });
  expect(fixture.copies.some(([from]) => from.startsWith("/etc/"))).toBe(false);
  expect([...fixture.entries.keys()].some(name => name.endsWith("resolv.conf"))).toBe(false);
  expect(fixture.source).not.toMatch(/resolv\.conf|\bmount\b|--(?:ro-)?bind/);
});

it("FAST inspection requires exact reviewed regular files and rejects additional etc configuration", () => {
  const fixture = runtimeFixture();
  fixture.run();
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../src/execution-orchestrator/development/fast-sandbox.ts"), "utf8");
  // Exercise the actual inspector with virtual Linux custody/snapshot imports.
  const inspect = source.slice(source.indexOf("export function inspectFastRuntime()"), source.indexOf("\ntype SandboxResult"))
    .replace("export function", "function").replace("n: string", "n").replaceAll(".sha256!", ".sha256");
  const runtime = "/opt/rc02-fast-runtime";
  const readDirectory = (dir: string) => [...fixture.entries.keys()]
    .filter(file => file !== dir && path.posix.dirname(file) === dir).map(file => path.posix.basename(file));
  const run = () => runInNewContext(`${inspect}\ninspectFastRuntime();`, {
    runtime, backend: "/usr/bin/bwrap", path: path.posix, Buffer,
    process: { platform: "linux", getuid: () => 1000, geteuid: () => 1000 },
    trusted: () => {}, freeze: (value: unknown) => value, sha256: () => "fixture-digest", canonicalJson: JSON.stringify,
    snapshotTree: () => Object.fromEntries([...fixture.entries].filter(([name]) => name.startsWith(runtime + "/"))
      .map(([name, entry]) => [name.slice(runtime.length + 1), { kind: entry.kind === "file" ? "FILE" : "DIRECTORY", sha256: "fixture-digest", byteLength: 0 }])),
    fs: {
      readFileSync: (file: string) => file === "/proc/self/mountinfo" ? "1 0 0:1 / / rw - ext4 /dev/root rw\n" : fixture.entries.get(file)?.content,
      readdirSync: readDirectory,
      lstatSync: (file: string) => ({ isDirectory: () => fixture.entries.get(file)?.kind === "directory" }),
    },
  });
  expect(run).not.toThrow();
  for (const name of Object.keys(fixedFastFiles)) {
    const file = `${runtime}/${name}`, saved = fixture.entries.get(file)!;
    fixture.entries.delete(file);
    expect(run).toThrow("FAST_RUNTIME_FILE_ABSENT");
    fixture.entries.set(file, { ...saved, kind: "directory" });
    expect(run).toThrow("FAST_RUNTIME_FILE_ABSENT");
    fixture.entries.set(file, { ...saved, content: saved.content + "extra\n" });
    expect(run).toThrow("FAST_RUNTIME_FIXED_CONTENT");
    fixture.entries.set(file, saved);
  }
  fixture.entries.set(`${runtime}/etc/resolv.conf`, { kind: "file", mode: 0o644, content: "nameserver 8.8.8.8\n" });
  expect(run).toThrow("FAST_NONMINIMAL_RUNTIME");
});

it("FAST retains exact isolation and read-only overlays with only the fixed Git environment addition", () => {
  const gitConfig = [
    ["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["credential.helper", ""],
    ["protocol.allow", "never"], ["core.attributesFile", "/dev/null"], ["core.excludesFile", "/runtime/git-excludes"],
  ];
  expect(fastEnvironment.GIT_CONFIG_COUNT).toBe(String(gitConfig.length));
  const env: Record<string, string> = { PATH: "/usr/bin", LANG: "C", LC_ALL: "C", TMPDIR: "/tmp",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0",
    GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_COUNT: "6" };
  gitConfig.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  expect(fastEnvironment).toEqual(env);
  expect(Object.isFrozen(fastEnvironment)).toBe(true);
  const runtime = "/opt/rc02-fast-runtime";
  const candidate = path.resolve("prepared-candidate");
  expect(fastSandboxPlan(candidate).args).toEqual([
    "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
    "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--ro-bind", runtime, "/", "--ro-bind", candidate, "/candidate",
    "--ro-bind", `${runtime}/runtime/scripts/verify-ai-workspace.mjs`, "/candidate/scripts/verify-ai-workspace.mjs",
    "--ro-bind", `${runtime}/runtime/scripts/verification-policy.mjs`, "/candidate/scripts/verification-policy.mjs",
    "--ro-bind", `${runtime}/runtime/node_modules`, "/candidate/node_modules",
    "--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev", "--remount-ro", "/dev",
    "--tmpfs", "/tmp", "--tmpfs", "/scratch", "--chdir", "/candidate",
    ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
    "--", "/usr/bin/node", "/candidate/scripts/verify-ai-workspace.mjs", "FAST",
  ]);
});

it("the fixed Git exclude removes only root dependency noise while tracked and other changes remain observable", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ct704-git-exclude-test-"));
  const candidate = path.join(base, "candidate"), excludes = path.join(base, "git-excludes");
  const globalConfig = path.join(base, "empty-git-config");
  const fixture = runtimeFixture();
  fixture.run();
  try {
    fs.mkdirSync(candidate);
    fs.writeFileSync(globalConfig, "");
    fs.writeFileSync(excludes, fixture.entries.get("/opt/rc02-fast-runtime/runtime/git-excludes")!.content!);
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-c", `core.excludesFile=${excludes}`, ...args], {
        cwd: candidate, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_COUNT: "0" },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim().split(/\r?\n/).filter(Boolean);
    };
    git("init", "--quiet");
    for (const name of ["node_modules/tracked.js", "node_modules/untracked.js", "scripts/new.js", "tests/new.ts", "src/new.ts", "nested/node_modules/new.js"]) {
      const file = path.join(candidate, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "fixture\n");
    }
    git("add", "-f", "node_modules/tracked.js");
    fs.writeFileSync(path.join(candidate, "node_modules/tracked.js"), "changed\n");
    expect(git("ls-files", "--others", "--exclude-standard")).toEqual(["nested/node_modules/new.js", "scripts/new.js", "src/new.ts", "tests/new.ts"]);
    expect(git("diff", "--name-only")).toEqual(["node_modules/tracked.js"]);
    expect(fs.existsSync(path.join(candidate, ".gitignore"))).toBe(false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

it("Stage 1 walks copied native addons deterministically and materializes their closure alongside Node and Git", () => {
  const fixture = runtimeFixture();
  fixture.run();
  expect(fixture.inspections).toEqual([
    "/trusted/bin/node", "/trusted/bin/node", "/usr/bin/git",
    "/opt/rc02-fast-runtime/runtime/node_modules/.pnpm/package/a.node",
    "/opt/rc02-fast-runtime/runtime/node_modules/z.node",
  ]);
  for (const image of ["/opt/rc02-sandbox-runtime", "/opt/rc02-fast-runtime"]) {
    expect(fixture.copies).toContainEqual(["/trusted/bin/node", `${image}/usr/bin/node`]);
    expect(fixture.copies).toContainEqual(["/lib/x86_64-linux-gnu/libc.so.6", `${image}/lib/x86_64-linux-gnu/libc.so.6`]);
    expect(fixture.copies).toContainEqual(["/lib64/ld-linux-x86-64.so.2", `${image}/lib64/ld-linux-x86-64.so.2`]);
  }
  expect(fixture.copies).toContainEqual(["/usr/bin/git", "/opt/rc02-fast-runtime/usr/bin/git"]);
  expect(fixture.copies.filter(([from]) => from.endsWith("/librt.so.1"))).toEqual([
    ["/lib/x86_64-linux-gnu/librt.so.1", "/opt/rc02-fast-runtime/lib/x86_64-linux-gnu/librt.so.1"],
    ["/lib/x86_64-linux-gnu/librt.so.1", "/opt/rc02-fast-runtime/lib/x86_64-linux-gnu/librt.so.1"],
  ]);
  for (const [file, entry] of fixture.entries) {
    if (file.startsWith("/opt/rc02-")) expect(entry.mode).toBe(entry.kind === "directory" || file.endsWith("/node") || file.endsWith("/git") ? 0o755 : 0o644);
  }
  expect(fixture.logs).toEqual(["RUNTIME_PREPARED=PASS; EXECUTION_PROOF_PENDING"]);
  expect(fixture.run).toThrow("EXISTING_CAPSULE");
  const unprivileged = runtimeFixture({ uid: 1000 });
  expect(unprivileged.run).toThrow("ROOT_PROVISIONING_ONLY");
  expect(unprivileged.entries.size).toBe(0);
  expect(fixture.source).not.toMatch(/\bmount\b|--(?:ro-)?bind|librt\.so\.1/);
});

it.each([
  { options: { output: "librt.so.1 => not found\n /lib64/ld-linux-x86-64.so.2 (0x0003)" }, error: "RUNTIME_LIBRARY_MISSING" },
  { options: { output: "" }, error: "RUNTIME_LIBRARY_UNINSPECTABLE" },
  { options: { output: "not a dynamic executable" }, error: "RUNTIME_LIBRARY_UNINSPECTABLE" },
  { options: { lddError: true }, error: "LDD_INSPECTION_FAILED" },
])("Stage 1 fails closed for uninspectable addon closure: $error", ({ options, error }) => {
  const fixture = runtimeFixture(options);
  expect(fixture.run).toThrow(error);
  expect(fixture.logs).toEqual([]);
  expect(fixture.inspections.at(-1)).toBe("/opt/rc02-fast-runtime/runtime/node_modules/.pnpm/package/a.node");
});

it.each(["symlink", "special", "directory"] as const)("Stage 1 rejects %s addon entries without inspecting or following them", entry => {
  const fixture = runtimeFixture({ entry });
  expect(fixture.run).toThrow("NON_REGULAR_CAPSULE_ENTRY");
  expect(fixture.inspections).toEqual(["/trusted/bin/node", "/trusted/bin/node", "/usr/bin/git"]);
  expect(fixture.logs).toEqual([]);
});

it("Stage 1 rejects a source dependency-tree symlink before copying or materializing its target", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ct704-runtime-link-test-"));
  const root = path.join(base, "reviewed");
  const image = path.join(base, "image");
  const target = path.join(base, "external-package");
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../scripts/ct704-stage1-runtime.mjs"), "utf8");
  // Execute the builder's actual copy statement and source filter with real filesystem semantics.
  const copy = source.slice(source.indexOf("    fs.cpSync("), source.indexOf("    nativeAddons(image,"));
  try {
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "addon.node"), "fixture native addon");
    const link = path.join(root, "node_modules", "linked-package");
    // Windows directory junctions require no symlink privilege and are lstat-visible links.
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => runInNewContext(copy, { fs, path, root, image })).toThrow("NON_REGULAR_CAPSULE_ENTRY");
    const copiedLink = path.join(image, "runtime/node_modules/linked-package");
    expect(fs.existsSync(copiedLink)).toBe(false);
    expect(fs.readFileSync(path.join(target, "addon.node"), "utf8")).toBe("fixture native addon");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

it("Stage 1 requires exactly LANG, PATH and sandbox-controlled PWD in the effective environment", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const source = fs.readFileSync(path.join(root, "src/execution-orchestrator/development/sandbox.ts"), "utf8");
  // Execute the actual fixture's environment assertions, not a duplicate contract or a live OS probe.
  const checks = source.match(/^assert\(.*'environment(?: values)?'\);$/gm);
  expect(checks).toHaveLength(2);
  const verify = (env: Record<string, string>) => runInNewContext(
    `function assert(v, label) { if (!v) throw new Error(label); }\n${checks!.join("\n")}`, { process: { env } });
  const effective = { ...sandboxWorkerEnvironment, PWD: "/candidate" };
  expect(() => verify(effective)).not.toThrow();
  expect(() => verify({ ...sandboxWorkerEnvironment })).toThrow("environment");
  for (const PWD of ["/", "/host", "", "/candidate/elsewhere"])
    expect(() => verify({ ...effective, PWD })).toThrow("environment values");
  for (const key of ["HOME", "NODE_OPTIONS", "OPENAI_API_KEY", "ARBITRARY_EXTRA"])
    expect(() => verify({ ...effective, [key]: "injected" })).toThrow("environment");
  for (const key of ["LANG", "PATH"])
    expect(() => verify({ ...effective, [key]: "injected" })).toThrow("environment values");
  expect(sandboxWorkerEnvironment).toEqual({ PATH: "/usr/bin", LANG: "C" });
  expect(Object.isFrozen(sandboxWorkerEnvironment)).toBe(true);
});

it("Stage 1 preserves the exact sandbox security argv and explicit worker environment", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const source = fs.readFileSync(path.join(root, "src/execution-orchestrator/development/sandbox.ts"), "utf8");
  const construction = source.slice(source.indexOf("  const args ="), source.indexOf("  const result ="));
  const args = runInNewContext(`${construction}\nargs`, {
    sandboxNamespaceArguments, sandboxWorkerEnvironment, runtime: "/opt/rc02-sandbox-runtime",
    request: { candidate: { root: "/prepared-candidate" } }, fixture: "fixed-fixture",
    identity: { canonicalRoot: "/canonical" }, hostHome: () => "/host-home", process: { pid: 123 }, namespaces: {},
  });
  expect(args).toEqual([
    "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
    "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--ro-bind", "/opt/rc02-sandbox-runtime", "/", "--bind", "/prepared-candidate", "/candidate",
    "--proc", "/proc", "--dev", "/dev", "--chdir", "/candidate",
    "--setenv", "PATH", "/usr/bin", "--setenv", "LANG", "C",
    "--", "/usr/bin/node", "--no-addons", "--no-warnings", "-e", "fixed-fixture",
    JSON.stringify({ canonical: "/canonical", home: "/host-home", hostPid: 123, namespaces: {} }),
  ]);
});

it("Stage 1 package contains fixture closure, no credentials or authority services, and does not overwrite", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ct704-pack-test-"));
  const output = path.join(base, "package");
  const root = path.resolve(import.meta.dirname, "..");
  try {
    const pack = () => spawnSync(process.execPath, ["scripts/pack-ct704-stage1.mjs", output], { cwd: root, encoding: "utf8" });
    expect(pack().status).toBe(0);
    const inventory: string[] = JSON.parse(fs.readFileSync(path.join(output, "stage1-files.json"), "utf8"));
    expect(inventory).toContain("src/execution-orchestrator/development/sandbox.ts");
    expect(inventory).toContain("tests/rc02-development-e0-fixture.ts");
    expect(inventory).toContain("src/execution-orchestrator/development/opencode-core-adapter.ts");
    expect(inventory.some(n => /(?:human-approver|review-service|signer|auth\.json|\.git\/|\.ai\/|node_modules\/)/.test(n))).toBe(false);
    for (const name of inventory) expect(fs.readFileSync(path.join(output, name), "utf8")).not.toContain("\r\n");
    const manifest = fs.readFileSync(path.join(output, "package.json"), "utf8");
    expect(pack().status).not.toBe(0);
    expect(fs.readFileSync(path.join(output, "package.json"), "utf8")).toBe(manifest);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

it("retired Stage 1 LXC human wrapper is an inert fail-closed sentinel", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const wrapper = fs.readFileSync(path.join(root, "scripts/ct704-stage1-human.sh"), "utf8");
  expect(wrapper).toBe([
    "#!/bin/bash",
    "set -euo pipefail",
    "printf '%s\\n' 'RC02_STAGE1_LXC_WRAPPER_RETIRED=STOP; KVM_PROOF_COMPLETE; PRODUCTION_DISABLED' >&2",
    "exit 64",
    "",
  ].join("\n"));
  expect(wrapper).not.toMatch(/\b(?:pct|qm|ssh|scp|curl|wget|apt(?:-get)?|systemctl)\b/);
  const docs = fs.readFileSync(path.join(root, "docs/ct704-stage1.md"), "utf8");
  expect(docs).toContain("former LXC / CT704 execution route: **RETIRED**");
  expect(docs).not.toContain("pct exec 704");
  expect(docs).toContain("`productionExecution`: **DISABLED**");
  expect(docs).toContain("**UNRESOLVED_UNTIL_HUMAN_BOUNDARY_REVIEW**");
});

it("Stage 1 fails closed unless the detected substrate is KVM, without an LXC fallback", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const guest = fs.readFileSync(path.join(root, "scripts/ct704-stage1-guest.sh"), "utf8");
  expect(guest).toContain("set -euo pipefail");
  expect(guest).toContain('trap \'echo "RC02_STAGE1=FAIL; STOP; NO_SECURITY_FALLBACK" >&2\' ERR');
  expect(guest).toMatch(/^test "\$\(systemd-detect-virt\)" = kvm$/m);
  expect(guest.match(/systemd-detect-virt/g)).toHaveLength(1);
  expect(guest).not.toMatch(/\blxc\b/i);
  expect(guest.indexOf('test "$(systemd-detect-virt)" = kvm')).toBeLessThan(guest.indexOf("apt-get update"));
});

it("Stage 1 minimally provisions libatomic1 and preserves administrative PATH", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const guest = fs.readFileSync(path.join(root, "scripts/ct704-stage1-guest.sh"), "utf8");
  expect(guest).toMatch(/^apt-get install -y --no-install-recommends .*\blibatomic1$/m);
  expect(guest).toMatch(/^dpkg-query -W .*\blibatomic1$/m);
  expect(guest).toContain("node_dir=/opt/node-v26.10.0-linux-x64");
  expect(guest).toContain('export PATH="$node_dir/bin:/usr/sbin:/usr/bin:/sbin:/bin"');
});

it.each([
  { failure: "CAPSULE", expected: ["FAIL", "SKIP", "SKIP", "SKIP", "SKIP"], calls: 0 },
  { failure: "BWRAP", expected: ["PASS", "FAIL", "SKIP", "SKIP", "SKIP"], calls: 1 },
  { failure: "DL2_C", expected: ["PASS", "PASS", "FAIL", "SKIP", "SKIP"], calls: 2 },
  { failure: "D1", expected: ["PASS", "PASS", "PASS", "FAIL", "SKIP"], calls: 3 },
  { failure: "D1_CERTIFICATE", expected: ["PASS", "PASS", "PASS", "FAIL", "SKIP"], calls: 4 },
  { failure: "E0_FAST", expected: ["PASS", "PASS", "PASS", "PASS", "FAIL"], calls: 5 },
  { failure: "NONE", expected: ["PASS", "PASS", "PASS", "PASS", "PASS"], calls: 5 },
])("Stage 1 classifies $failure failure at its actual phase boundary", async ({ failure, expected, calls }) => {
  const root = path.resolve(import.meta.dirname, "..");
  // Execute the actual runner with mocked imports/platform: no Linux probe or live fixture runs here.
  const source = fs.readFileSync(path.join(root, "scripts/ct704-stage1-live.mjs"), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replaceAll("import.meta.dirname", JSON.stringify(path.join(root, "scripts")))
    .replaceAll("import.meta.url", JSON.stringify("file:///ct704-stage1-live.mjs"));
  const launches: { exe: string; args: string[] }[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const writes: string[] = [];
  const mockProcess = {
    platform: "linux", getuid: () => 1000, versions: { node: "26.10.0" },
    execPath: "/opt/node-v26.10.0-linux-x64/bin/node", env: {}, exitCode: 0,
    stderr: { write: (text: string) => errors.push(text) },
  };
  await runInNewContext(`(async () => {\n${source}\n})()`, {
    fs: { writeFileSync: (file: string) => writes.push(file) }, path, process: mockProcess,
    console: { log: (text: string) => output.push(text), error: (text: string) => errors.push(text) },
    tsImport: async () => ({
      sandboxCapability: () => ({ available: failure !== "CAPSULE" }),
      sandboxNamespaceArguments: ["--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled"],
    }),
    spawnSync: (exe: string, args: string[]) => {
      launches.push({ exe, args });
      const phase = exe === "/usr/bin/bwrap" ? "BWRAP"
        : args[0] === "scripts/verify-opencode-compatibility.mjs" ? "D1_CERTIFICATE"
        : args[2] === "tests/rc02-development-sandbox.test.ts" ? "DL2_C"
        : args[2] === "tests/rc02-development-opencode-compatibility-sandbox.test.ts" ? "D1"
        : args[2] === "tests/rc02-development-fast-sandbox.test.ts" ? "E0_FAST" : "UNKNOWN";
      expect(phase).not.toBe("UNKNOWN");
      if (["DL2_C", "D1", "E0_FAST"].includes(phase)) {
        const selected = {
          DL2_C: ["tests/rc02-development-sandbox.test.ts", "LIVE Linux:"],
          D1: ["tests/rc02-development-opencode-compatibility-sandbox.test.ts", "fetch/http/https/net are permission-denied"],
          E0_FAST: ["tests/rc02-development-fast-sandbox.test.ts", "Linux live malicious-test fixture"],
        }[phase as "DL2_C" | "D1" | "E0_FAST"];
        expect(args).toEqual([
          path.join(root, "node_modules/vitest/vitest.mjs"), "run", selected[0], "-t", selected[1],
          "--maxWorkers=1", "--reporter=json", "--configLoader=runner",
        ]);
      }
      if (phase === failure) return { status: 1, stderr: "fixture launch denied", stdout: "" };
      if (phase === "BWRAP") return { status: 0, stderr: "", stdout: "v26.10.0\n" };
      const stdout = phase === "D1_CERTIFICATE"
        ? { certificate: { result: "COMPATIBLE", capabilities: { providerCalls: 0 } }, liveProbe: "COMPLETED" }
        : { success: true, testResults: [{ assertionResults: [{ status: "passed", fullName: args[4] }] }] };
      return { status: 0, stderr: "", stdout: JSON.stringify(stdout) };
    },
  });
  expect(launches).toHaveLength(calls);
  expect(mockProcess.exitCode).toBe(failure === "NONE" ? 0 : 1);
  expect(writes).toEqual(expected[3] === "PASS" ? ["/var/lib/rc02-stage1/d1-report.json"] : []);
  expect(output).toHaveLength(1);
  const report = JSON.parse(output[0]);
  expect(report).toEqual({
    stage: "RC02_STAGE1",
    results: Object.fromEntries(["CAPSULE", "BWRAP", "DL2_C", "D1", "E0_FAST"].map((key, i) => [key, expected[i]])),
    productionExecution: "DISABLED", authority: "UNRESOLVED_UNTIL_HUMAN_BOUNDARY_REVIEW",
  });
  if (calls > 0) {
    expect(launches[0].exe).toBe("/usr/bin/bwrap");
    expect(launches[0].args).toEqual(expect.arrayContaining([
      "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled", "--cap-drop", "ALL",
      "--clearenv", "--die-with-parent", "--new-session",
    ]));
    if (failure !== "NONE") expect(errors).toContain("fixture launch denied");
  }
});
