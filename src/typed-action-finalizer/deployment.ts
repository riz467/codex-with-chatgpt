import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { get } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { finalizerServiceConfigSchema } from "./server.js";
import { TypedActionFinalizerStore, verifySchema as verifyDeploymentLedger } from "./storage.js";

export const deploymentPaths = Object.freeze({
  source: "/var/cache/ct701-typed-action-finalizer/package",
  home: "/opt/ct701-typed-action-finalizer",
  etc: "/etc/ct701-typed-action-finalizer",
  ledger: "/var/lib/ct701-typed-action-finalizer",
  unit: "/etc/systemd/system/ct701-typed-action-finalizer.service",
});
export const unitName = "ct701-typed-action-finalizer.service";
export const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function fingerprint(pem: string | Buffer): string {
  if (!pem.toString().startsWith("-----BEGIN PUBLIC KEY-----")) throw new Error("Public PEM required");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 required");
  return digest(key.export({ format: "der", type: "spki" }));
}
export function validateDeploymentConfig(raw: unknown) {
  const config = finalizerServiceConfigSchema.parse(raw);
  if (config.port !== 7010 || config.trustedContextProvider.kind !== "deny-all"
    || config.finalizerKeyId !== "ct701-finalizer-v1" || config.trustedHumanKeyId !== "ct700-human-v1") throw new Error("Deployment contract mismatch");
  return config;
}
export function validateMetadata(stat: { uid: number; gid: number; mode: number; nlink: number }, uid: number, gid: number, mode: number) {
  if (stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode || stat.nlink !== 1) throw new Error("Unsafe owner/mode/link count");
}
export function validateListeners(output: string, pid: string) {
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("Missing service PID");
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const owned = lines.filter(line => line.includes(`pid=${pid},`));
  if (owned.length !== 1 || owned[0].trim().split(/\s+/)[0] !== "tcp" || owned[0].trim().split(/\s+/)[4] !== "127.0.0.1:7010"
    || lines.some(line => /:7010\s/.test(line) && !line.includes(`pid=${pid},`))) throw new Error("Unexpected listener");
}
/** node:http works with --jitless; Node fetch's undici parser requires WASM. */
export function verifyHealth(port = 7010): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path: "/health", agent: false }, response => {
      let body = "";
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > 1024) request.destroy(new Error("Oversized health response"));
      });
      response.on("end", () => {
        try {
          if (response.statusCode !== 200 || JSON.stringify(JSON.parse(body)) !== JSON.stringify({ status: "ok", boundary: "isolated-loopback" })) throw new Error("Health verification failed");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error("Health deadline exceeded")), 5000);
    request.once("close", () => clearTimeout(deadline));
    request.on("error", reject);
  });
}

/** Trusted test seam only. The production CLI never accepts root, source, command,
 * uid or permission overrides. Windows fixtures model POSIX metadata separately. */
export class Deployment {
  constructor(private readonly host: { root?: string; uid: number; gid: number; fixture?: boolean }) {
    if (host.root && !host.fixture) throw new Error("Fixture root only");
  }
  location(fixed: string): string { return this.host.root ? path.join(this.host.root, fixed) : fixed; }
  private safe(fixed: string, missing = false) {
    const file = this.location(fixed);
    for (let p = file; ; p = path.dirname(p)) {
      try {
        const stat = fs.lstatSync(p);
        if (stat.isSymbolicLink()) throw new Error("Symlink forbidden");
        if (!this.host.fixture && stat.isDirectory() && ((stat.uid !== 0 && stat.uid !== this.host.uid) || (stat.mode & 0o022))) throw new Error("Unsafe path ancestry");
      }
      catch (error) { if (!missing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (p === path.dirname(p)) break;
    }
    return file;
  }
  private owner(file: string, uid: number, gid: number, mode: number) {
    fs.chmodSync(file, mode);
    if (!(this.host.fixture && process.platform === "win32")) fs.chownSync(file, uid, gid);
  }
  private check(fixed: string, uid: number, gid: number, mode: number, directory = false) {
    const file = this.safe(fixed), stat = fs.lstatSync(file);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("Wrong file type");
    if (!(this.host.fixture && process.platform === "win32")) {
      validateMetadata({ ...stat, nlink: directory ? 1 : stat.nlink }, uid, gid, mode);
    }
    return file;
  }
  private dir(fixed: string, uid: number, gid: number, mode: number) {
    const file = this.safe(fixed, true);
    if (!fs.existsSync(file)) { fs.mkdirSync(file); this.owner(file, uid, gid, mode); }
    this.check(fixed, uid, gid, mode, true);
  }
  private exclusive(fixed: string, data: string | Buffer, uid: number, gid: number, mode: number) {
    const file = this.safe(fixed, true);
    const fd = fs.openSync(file, "wx", mode);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.owner(file, uid, gid, mode);
    this.check(fixed, uid, gid, mode);
  }
  initialize() {
    this.dir(deploymentPaths.etc, 0, this.host.gid, 0o750);
    this.dir(deploymentPaths.ledger, this.host.uid, this.host.gid, 0o700);
    this.dir(deploymentPaths.home, 0, 0, 0o755);
    this.dir(`${deploymentPaths.home}/releases`, 0, 0, 0o755);
  }
  bootstrapKey(): string {
    this.check(deploymentPaths.etc, 0, this.host.gid, 0o750, true);
    const target = `${deploymentPaths.etc}/signing-key.pem`;
    if (fs.existsSync(this.safe(target, true))) throw new Error("Existing key cannot be overwritten");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.exclusive(target, privateKey.export({ format: "pem", type: "pkcs8" }), this.host.uid, this.host.gid, 0o600);
    this.keys(false);
    return fingerprint(publicKey.export({ format: "pem", type: "spki" }));
  }
  bootstrapToken() {
    this.check(deploymentPaths.etc, 0, this.host.gid, 0o750, true);
    this.exclusive(`${deploymentPaths.etc}/bridge-token`, randomBytes(32).toString("base64url") + "\n", this.host.uid, this.host.gid, 0o600);
  }
  installHumanKey() {
    this.check(deploymentPaths.etc, 0, this.host.gid, 0o750, true);
    const pem = fs.readFileSync(this.check(`${deploymentPaths.etc}/ct700-public.pending.pem`, 0, 0, 0o644));
    const expected = fs.readFileSync(this.check(`${deploymentPaths.etc}/ct700-public.sha256`, 0, 0, 0o644), "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(expected) || fingerprint(pem) !== expected) throw new Error("CT700 fingerprint mismatch");
    this.exclusive(`${deploymentPaths.etc}/ct700-public.pem`, pem, 0, 0, 0o644);
    return expected;
  }
  private keys(all = true) {
    this.check(deploymentPaths.etc, 0, this.host.gid, 0o750, true);
    const privateKey = createPrivateKey(fs.readFileSync(this.check(`${deploymentPaths.etc}/signing-key.pem`, this.host.uid, this.host.gid, 0o600)));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 required");
    if (all) {
      const pem = fs.readFileSync(this.check(`${deploymentPaths.etc}/ct700-public.pem`, 0, 0, 0o644));
      const pin = fs.readFileSync(this.check(`${deploymentPaths.etc}/ct700-public.sha256`, 0, 0, 0o644), "utf8").trim();
      if (fingerprint(pem) !== pin) throw new Error("CT700 fingerprint mismatch");
      const token = fs.readFileSync(this.check(`${deploymentPaths.etc}/bridge-token`, this.host.uid, this.host.gid, 0o600), "utf8").trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").length !== 32) throw new Error("Invalid bridge token");
    }
    return privateKey;
  }
  verifyLedger() {
    this.check(deploymentPaths.ledger, this.host.uid, this.host.gid, 0o700, true);
    const file = this.check(`${deploymentPaths.ledger}/ledger.sqlite`, this.host.uid, this.host.gid, 0o600);
    for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(this.safe(`${deploymentPaths.ledger}/ledger.sqlite${suffix}`, true)))
      this.check(`${deploymentPaths.ledger}/ledger.sqlite${suffix}`, this.host.uid, this.host.gid, 0o600);
    // Read-only schema verification: no initialization, migration or ledger repair.
    // SQLite may create WAL coordination files even on a read-only connection.
    // Always do that as the service uid with its restrictive umask.
    const privileged = !this.host.fixture && process.geteuid?.() === 0;
    const oldMask = this.host.fixture ? undefined : process.umask(0o077);
    if (privileged) { process.setegid!(this.host.gid); process.seteuid!(this.host.uid); }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL");
      verifyDeploymentLedger(db);
    } finally {
      db?.close();
      if (privileged) { process.seteuid!(0); process.setegid!(0); }
      if (oldMask !== undefined) process.umask(oldMask);
    }
  }
  initializeLedger() {
    this.check(deploymentPaths.ledger, this.host.uid, this.host.gid, 0o700, true);
    const file = `${deploymentPaths.ledger}/ledger.sqlite`;
    if (fs.existsSync(this.safe(file, true))) { this.verifyLedger(); return; }
    const key = this.keys();
    this.exclusive(file, "", this.host.uid, this.host.gid, 0o600);
    const db = new DatabaseSync(this.location(file));
    try { new TypedActionFinalizerStore({ database: db, trustedFinalizerKeys: new Map([["ct701-finalizer-v1", createPublicKey(key)]]), now: Date.now }); }
    finally { db.close(); }
    this.verifyLedger();
  }
  package(fixed: string = deploymentPaths.source) {
    const directory = this.check(fixed, 0, 0, 0o755, true);
    const manifestFile = this.safe(`${fixed}/manifest.json`);
    const text = fs.readFileSync(manifestFile, "utf8");
    const manifest = JSON.parse(text) as { format: number; node: string; files: Record<string, string> };
    if (manifest.format !== 1 || manifest.node !== process.version || !manifest.files || Array.isArray(manifest.files)) throw new Error("Package/runtime mismatch");
    const actual: string[] = [];
    const walk = (dir: string, prefix = "") => {
      for (const name of fs.readdirSync(dir).sort()) {
        const rel = prefix + name, stat = fs.lstatSync(path.join(dir, name));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw new Error("Unsafe package entry");
        if (!(this.host.fixture && process.platform === "win32") && (stat.uid !== 0 || stat.gid !== 0
          || (stat.mode & 0o7777) !== (stat.isDirectory() ? 0o755 : 0o644))) throw new Error("Unsafe package ownership/mode");
        if (stat.isDirectory()) walk(path.join(dir, name), rel + "/");
        else if (rel !== "manifest.json") actual.push(rel);
      }
    };
    walk(directory);
    if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error("Package inventory mismatch");
    for (const name of actual) if (digest(fs.readFileSync(path.join(directory, name))) !== manifest.files[name]) throw new Error("Package hash mismatch");
    for (const name of ["config.json", unitName, "package.json", "runtime/typed-action-finalizer/cli.js", "runtime/typed-action-finalizer/deployment-cli.js"])
      if (!actual.includes(name)) throw new Error("Incomplete package");
    validateDeploymentConfig(JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")));
    return { id: digest(text), directory, manifest };
  }
  private pointer(name: "current" | "previous"): string | undefined {
    const file = this.location(`${deploymentPaths.home}/${name}`);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!stat.isSymbolicLink()) throw new Error("Release pointer must be a symlink");
    const link = fs.readlinkSync(file);
    const target = (this.host.fixture && process.platform === "win32" ? path.relative(this.location(deploymentPaths.home), link) : link).replaceAll("\\", "/");
    if (!/^releases\/[a-f0-9]{64}$/.test(target)) throw new Error("Unsafe release pointer");
    if (this.package(`${deploymentPaths.home}/${target}`).id !== target.slice("releases/".length)) throw new Error("Release identity mismatch");
    return target;
  }
  private switch(name: "current" | "previous", target: string) {
    const temporary = this.safe(`${deploymentPaths.home}/${name}.next`, true);
    if (this.host.fixture && process.platform === "win32") {
      // Windows junction fixture models pointer selection, not POSIX rename atomicity.
      fs.symlinkSync(this.location(`${deploymentPaths.home}/${target}`), temporary, "junction");
      const old = this.location(`${deploymentPaths.home}/${name}`);
      if (fs.existsSync(old)) { this.pointer(name); fs.rmdirSync(old); }
    } else fs.symlinkSync(target, temporary, "dir");
    fs.renameSync(temporary, this.location(`${deploymentPaths.home}/${name}`));
  }
  install(dryRun = false) {
    const pkg = this.package();
    if (dryRun) return pkg.id; // no mkdir, keys, DB, commands, pointers or systemd writes
    this.check(deploymentPaths.home, 0, 0, 0o755, true);
    this.check(`${deploymentPaths.home}/releases`, 0, 0, 0o755, true);
    this.keys(); this.verifyLedger();
    const current = this.pointer("current");
    const release = `${deploymentPaths.home}/releases/${pkg.id}`;
    if (!fs.existsSync(this.safe(release, true))) {
      // A failed copy remains unreferenced and fails inventory checks on retry.
      fs.cpSync(pkg.directory, this.location(release), { recursive: true, errorOnExist: true, force: false });
    }
    if (this.package(release).id !== pkg.id) throw new Error("Release identity mismatch");
    const unit = fs.readFileSync(path.join(pkg.directory, unitName));
    if (fs.existsSync(this.safe(deploymentPaths.unit, true))) {
      if (!fs.readFileSync(this.check(deploymentPaths.unit, 0, 0, 0o644)).equals(unit)) throw new Error("Unit change requires separate reviewed migration");
    } else this.exclusive(deploymentPaths.unit, unit, 0, 0, 0o644);
    if (current === `releases/${pkg.id}`) return pkg.id;
    if (current) this.switch("previous", current);
    this.switch("current", `releases/${pkg.id}`);
    return pkg.id;
  }
  rollback() {
    this.check(deploymentPaths.home, 0, 0, 0o755, true);
    this.check(`${deploymentPaths.home}/releases`, 0, 0, 0o755, true);
    const previous = this.pointer("previous");
    if (!previous) throw new Error("No previous release");
    this.keys(); this.verifyLedger();
    const unit = fs.readFileSync(this.location(`${deploymentPaths.home}/${previous}/${unitName}`));
    if (!fs.readFileSync(this.check(deploymentPaths.unit, 0, 0, 0o644)).equals(unit)) throw new Error("Unit mismatch");
    if (this.pointer("current") !== previous) this.switch("current", previous);
    // previous remains stable: repeated rollback cannot accidentally roll forward.
  }
  verifyOffline() {
    this.check(deploymentPaths.home, 0, 0, 0o755, true);
    this.check(`${deploymentPaths.home}/releases`, 0, 0, 0o755, true);
    this.check(deploymentPaths.etc, 0, this.host.gid, 0o750, true);
    const current = this.pointer("current");
    if (!current) throw new Error("No current release");
    this.keys(); this.verifyLedger();
    if (!fs.readFileSync(this.check(deploymentPaths.unit, 0, 0, 0o644)).equals(fs.readFileSync(this.location(`${deploymentPaths.home}/${current}/${unitName}`)))) throw new Error("Unit mismatch");
  }
}
