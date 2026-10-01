import { afterEach, describe, expect, it } from "vitest";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Deployment, deploymentPaths as P, digest, fingerprint, unitName, validateDeploymentConfig, validateListeners, validateMetadata, verifyHealth } from "../src/typed-action-finalizer/deployment.js";
import { parseDeploymentAction } from "../src/typed-action-finalizer/deployment-cli.js";
import { createFinalizerService } from "../src/typed-action-finalizer/server.js";

const template = path.resolve("deploy/ct701-typed-action-finalizer");
const config = JSON.parse(fs.readFileSync(path.join(template, "config.json"), "utf8"));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
function setup() {
  const base = path.join(tmpdir(), "opencode"); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "ct701-deploy-")); roots.push(root);
  const d = new Deployment({ root, fixture: true, uid: process.getuid?.() ?? 100, gid: process.getgid?.() ?? 100 });
  for (const parent of ["/etc/systemd/system", "/var/lib", "/var/cache/ct701-typed-action-finalizer", "/opt"])
    fs.mkdirSync(d.location(parent), { recursive: true });
  // Linux integration runs as root in a disposable container; Windows uses a
  // Linux-like path tree with separately tested POSIX metadata policy.
  d.initialize();
  const file = (p: string) => d.location(p);
  const write = (p: string, value: string | Buffer) => fs.writeFileSync(file(p), value, { mode: 0o644 });
  d.bootstrapKey(); d.bootstrapToken();
  const human = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  write(`${P.etc}/ct700-public.pending.pem`, human);
  write(`${P.etc}/ct700-public.sha256`, fingerprint(human) + "\n");
  d.installHumanKey(); d.initializeLedger();
  function pkg(label = "first") {
    fs.rmSync(file(P.source), { recursive: true, force: true });
    fs.mkdirSync(file(`${P.source}/runtime/typed-action-finalizer`), { recursive: true });
    for (const name of ["config.json", unitName, "install.sh", "verify.sh", "rollback.sh"])
      fs.copyFileSync(path.join(template, name), file(`${P.source}/${name}`));
    write(`${P.source}/package.json`, '{"type":"module"}');
    write(`${P.source}/runtime/typed-action-finalizer/cli.js`, `// fixture ${label}\n`);
    write(`${P.source}/runtime/typed-action-finalizer/deployment-cli.js`, "// fixture\n");
    return seal();
  }
  function seal() {
    const files: Record<string, string> = {};
    const walk = (directory: string, prefix = "") => {
      for (const name of fs.readdirSync(directory).sort()) {
        const p = path.join(directory, name), rel = prefix + name;
        if (fs.statSync(p).isDirectory()) walk(p, rel + "/");
        else if (rel !== "manifest.json") files[rel] = digest(fs.readFileSync(p));
      }
    };
    walk(file(P.source));
    write(`${P.source}/manifest.json`, JSON.stringify({ format: 1, node: process.version, files }));
    return d.package().id;
  }
  pkg(); return { d, file, write, pkg, seal };
}

describe("CT701 offline deployment", () => {
  it("packages fixed layout and strict production contract", () => {
    const { d } = setup(); const pkg = d.package();
    expect(Object.keys(pkg.manifest.files)).toEqual(expect.arrayContaining(["config.json", unitName, "install.sh", "verify.sh", "rollback.sh"]));
    expect(validateDeploymentConfig(config).host).toBe("127.0.0.1");
    expect(config.databasePath).toBe(`${P.ledger}/ledger.sqlite`);
  });
  it("unit constrains network, writes, account and hardening; scripts never start/restart", () => {
    const unit = fs.readFileSync(path.join(template, unitName), "utf8");
    for (const name of ["NoNewPrivileges", "PrivateTmp", "PrivateDevices", "ProtectHome", "ProtectKernelTunables", "ProtectKernelModules", "ProtectKernelLogs", "ProtectControlGroups", "RestrictNamespaces", "RestrictSUIDSGID", "LockPersonality", "MemoryDenyWriteExecute"])
      expect(unit).toContain(`${name}=yes`);
    for (const directive of ["ProtectSystem=strict", "CapabilityBoundingSet=\n", "AmbientCapabilities=\n", "User=ct701-finalizer", "Group=ct701-finalizer", "UMask=0077", "IPAddressDeny=any", "IPAddressAllow=127.0.0.1/32", "RestrictAddressFamilies=AF_UNIX AF_INET", `ReadWritePaths=${P.ledger}`, "ExecStart=/usr/bin/node --jitless"])
      expect(unit).toContain(directive);
    expect(unit.match(/^ReadWritePaths=/gm)).toHaveLength(1);
    expect(unit).not.toMatch(/0\.0\.0\.0|IPAddressAllow=::|Restart=always/);
    const cli = fs.readFileSync("src/typed-action-finalizer/deployment-cli.ts", "utf8");
    expect(cli).not.toMatch(/\["(?:restart|start|enable|daemon-reload)"/);
  });
  it("enforces exact POSIX secret ownership, no group/other access and single links", () => {
    expect(() => validateMetadata({ uid: 100, gid: 100, mode: 0o100600, nlink: 1 }, 100, 100, 0o600)).not.toThrow();
    for (const stat of [{ uid: 0, gid: 100, mode: 0o600, nlink: 1 }, { uid: 100, gid: 100, mode: 0o640, nlink: 1 }, { uid: 100, gid: 100, mode: 0o606, nlink: 1 }, { uid: 100, gid: 100, mode: 0o600, nlink: 2 }])
      expect(() => validateMetadata(stat, 100, 100, 0o600)).toThrow();
  });
  it("pins CT700 SPKI and detects public key substitution", () => {
    const { d, write } = setup(); d.install(); d.verifyOffline();
    write(`${P.etc}/ct700-public.pem`, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
    expect(() => d.verifyOffline()).toThrow(/fingerprint/);
  });
  it("rejects symlink secrets and symlink ancestry", () => {
    const { d, file } = setup();
    const key = file(`${P.etc}/signing-key.pem`), saved = file(`${P.etc}/saved.pem`);
    fs.renameSync(key, saved);
    if (process.platform === "win32") fs.symlinkSync(file(P.ledger), key, "junction");
    else fs.symlinkSync(saved, key);
    expect(() => d.install()).toThrow(/Symlink/);
    expect(() => d.bootstrapKey()).toThrow(/Symlink/);
    if (process.platform === "win32") fs.rmdirSync(key); else fs.unlinkSync(key);
    fs.renameSync(saved, key);
    const etc = file(P.etc), relocated = etc + "-relocated";
    fs.renameSync(etc, relocated); fs.symlinkSync(relocated, etc, "junction");
    expect(() => d.install()).toThrow(/Symlink/);
  });
  it("never overwrites existing key or token and returns only a public fingerprint", () => {
    const { d, file } = setup();
    const key = fs.readFileSync(file(`${P.etc}/signing-key.pem`)), token = fs.readFileSync(file(`${P.etc}/bridge-token`));
    expect(Buffer.from(token.toString().trim(), "base64url")).toHaveLength(32);
    expect(() => d.bootstrapKey()).toThrow(); expect(() => d.bootstrapToken()).toThrow();
    expect(fs.readFileSync(file(`${P.etc}/signing-key.pem`))).toEqual(key);
    expect(fs.readFileSync(file(`${P.etc}/bridge-token`))).toEqual(token);
    expect(fingerprint(createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "pem" }))).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects invalid signing and human key types", () => {
    const { d, write } = setup();
    write(`${P.etc}/signing-key.pem`, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(() => d.install()).toThrow(/Ed25519/);
    expect(() => fingerprint("invalid pem")).toThrow();
    expect(() => fingerprint(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }))).toThrow();
  });
  it.each([{ host: "0.0.0.0" }, { port: 0 }, { databasePath: "/tmp/ledger" }, { trustedContextProvider: { kind: "host-injected" } }, { command: "anything" }])("rejects invalid config %j", change => {
    expect(() => validateDeploymentConfig({ ...config, ...change })).toThrow();
  });
  it("rejects malformed and modified DB without repair", () => {
    const { d, file, write } = setup();
    const db = new DatabaseSync(file(`${P.ledger}/ledger.sqlite`)); db.exec("DROP TRIGGER identities_no_delete"); db.close();
    expect(() => d.install()).toThrow(/schema/);
    write(`${P.ledger}/ledger.sqlite`, "not sqlite");
    expect(() => d.initializeLedger()).toThrow();
    expect(fs.readFileSync(file(`${P.ledger}/ledger.sqlite`), "utf8")).toBe("not sqlite");
  });
  it("is idempotent; rejects changed/missing/extra package files and runtime mismatch", () => {
    const { d, write, file } = setup(); const id = d.install();
    expect(d.install()).toBe(id); expect(fs.existsSync(file(`${P.home}/previous`))).toBe(false);
    d.initialize(); d.initializeLedger(); d.verifyOffline();
    write(`${P.source}/extra`, "unexpected"); expect(() => d.install()).toThrow(/inventory/);
    fs.unlinkSync(file(`${P.source}/extra`));
    write(`${P.source}/config.json`, "{}"); expect(() => d.install()).toThrow(/hash/);
  });
  it("rejects arbitrary source/destination/commands at CLI boundary", () => {
    for (const args of [["install", "/tmp/elsewhere"], ["install", "--root=/"], ["--source=/tmp"], ["sh"], ["verify", "command"]]) expect(() => parseDeploymentAction(args)).toThrow();
    expect(() => new Deployment({ root: "/tmp", uid: 0, gid: 0 })).toThrow();
    expect(parseDeploymentAction(["dry-run"])).toBe("dry-run");
  });
  it("rejects wrong runtime, resealed invalid config and release identity replacement", () => {
    const { d, file, write, pkg, seal } = setup();
    const manifest = JSON.parse(fs.readFileSync(file(`${P.source}/manifest.json`), "utf8"));
    write(`${P.source}/manifest.json`, JSON.stringify({ ...manifest, node: "v0.0.0" }));
    expect(() => d.install()).toThrow(/runtime/);
    pkg(); write(`${P.source}/config.json`, JSON.stringify({ ...config, host: "0.0.0.0" }));
    expect(() => seal()).toThrow();
    pkg(); const id = d.install();
    const releasedManifest = file(`${P.home}/releases/${id}/manifest.json`);
    fs.appendFileSync(releasedManifest, "\n");
    expect(() => d.verifyOffline()).toThrow(/identity/);
  });
  it("rollback preserves ledger bytes, all consumed identities and terminal triggers", () => {
    const { d, file, pkg } = setup(); const first = d.install();
    const ledger = file(`${P.ledger}/ledger.sqlite`);
    const db = new DatabaseSync(ledger);
    const namespaces = ["typed-action-human-approval", "typed-action-execution-permit", "typed-action-attempt"];
    // Use exact contract namespaces rather than inventing authority identities.
    const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='consumed_execution_identities'").get()!.sql);
    const allowed = [...sql.matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(allowed).toHaveLength(namespaces.length);
    for (const ns of allowed) db.prepare("INSERT INTO consumed_execution_identities VALUES (?,?,?)").run(ns, randomBytes(32).toString("hex"), new Date().toISOString());
    db.close();
    const before = fs.readFileSync(ledger);
    pkg("second"); expect(d.install()).not.toBe(first); d.rollback(); d.rollback();
    expect(fs.realpathSync(file(`${P.home}/current`))).toBe(fs.realpathSync(file(`${P.home}/releases/${first}`)));
    expect(fs.readFileSync(ledger)).toEqual(before);
    const after = new DatabaseSync(ledger);
    expect(after.prepare("SELECT count(*) AS n FROM consumed_execution_identities").get()!.n).toBe(3);
    expect(() => after.exec("DELETE FROM consumed_execution_identities")).toThrow(/permanent/);
    after.close(); d.verifyOffline();
  });
  it("checks health against a real isolated loopback service and rejects external listeners", async () => {
    const { d, file } = setup();
    const service = createFinalizerService({ ...config, port: 0 }, {
      databasePath: file(`${P.ledger}/ledger.sqlite`), privateKey: createPrivateKey(fs.readFileSync(file(`${P.etc}/signing-key.pem`))),
      humanPublicKey: createPublicKey(fs.readFileSync(file(`${P.etc}/ct700-public.pem`))), bridgeToken: fs.readFileSync(file(`${P.etc}/bridge-token`), "utf8").trim(),
    });
    try {
      const port = await service.listen(); const response = await fetch(`http://127.0.0.1:${port}/health`);
      await verifyHealth(port);
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "ok", boundary: "isolated-loopback" });
    } finally { await service.close(); }
    d.verifyLedger();
    const line = 'tcp LISTEN 0 511 127.0.0.1:7010 0.0.0.0:* users:(("node",pid=123,fd=20))';
    expect(() => validateListeners(line, "123")).not.toThrow();
    for (const bad of ["", line.replace("127.0.0.1:7010", "0.0.0.0:7010"), line.replace("127.0.0.1:7010", "[::]:7010"), line + "\n" + line.replace(":7010", ":8080")])
      expect(() => validateListeners(bad, "123")).toThrow();
  });
  it("dry-run is read-only even before host provisioning", () => {
    const { d, file } = setup();
    const snapshot = () => {
      const result: Record<string, string> = {};
      function walk(dir: string) { for (const name of fs.readdirSync(dir)) { const p = path.join(dir, name); if (fs.statSync(p).isDirectory()) walk(p); else result[p] = digest(fs.readFileSync(p)); } }
      walk(file("/")); return result;
    };
    fs.rmSync(file(P.etc), { recursive: true }); fs.rmSync(file(P.ledger), { recursive: true });
    const before = snapshot(); expect(d.install(true)).toMatch(/^[a-f0-9]{64}$/); expect(snapshot()).toEqual(before);
    expect(fs.existsSync(file(`${P.home}/current`))).toBe(false);
  });
  it("Node --jitless supports Ed25519 and durable SQLite", () => {
    const { file } = setup();
    const code = `const {DatabaseSync}=require('node:sqlite'); const {generateKeyPairSync,sign,verify}=require('node:crypto'); const k=generateKeyPairSync('ed25519'); if(!verify(null,Buffer.from('fixture'),k.publicKey,sign(null,Buffer.from('fixture'),k.privateKey))) throw Error(); const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(x); INSERT INTO fixture VALUES(1)'); if(db.prepare('SELECT x FROM fixture').get().x!==1) throw Error(); db.close();`;
    expect(() => execFileSync(process.execPath, ["--jitless", "-e", code, file("/jitless.sqlite")], { stdio: "pipe" })).not.toThrow();
  });
});
