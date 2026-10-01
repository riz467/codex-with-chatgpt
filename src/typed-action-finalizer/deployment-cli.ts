import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Deployment, deploymentPaths, unitName, validateListeners, validateMetadata, verifyHealth } from "./deployment.js";

const account = "ct701-finalizer";
const actions = ["initialize", "bootstrap-key", "bootstrap-token", "install-human-key", "initialize-ledger", "ledger-worker", "install", "dry-run", "verify", "rollback", "startup-check"];
export function parseDeploymentAction(args: string[]) {
  if (args.length !== 1 || !actions.includes(args[0])) throw new Error("Expected one fixed deployment action");
  return args[0];
}
function command(program: string, args: string[]) {
  return execFileSync(program, args, { encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" }, timeout: 30_000 }).trim();
}
function identity() {
  const fields = command("/usr/bin/getent", ["passwd", account]).split(":");
  const uid = Number(fields[2]), gid = Number(fields[3]);
  if (fields[0] !== account || !Number.isInteger(uid) || uid <= 0 || uid >= 1000 || !Number.isInteger(gid) || gid <= 0
    || fields[5] !== "/nonexistent" || fields[6] !== "/usr/sbin/nologin"
    || command("/usr/bin/id", ["-Gn", account]) !== account) throw new Error("Unsafe system account");
  return { uid, gid };
}
function stopped() {
  const status = command("/usr/bin/systemctl", ["show", unitName, "--property=ActiveState", "--value"]);
  if (!["inactive", "failed"].includes(status)
    || command("/usr/bin/systemctl", ["show", unitName, "--property=MainPID", "--value"]) !== "0") throw new Error("Service must already be stopped by approved operator");
}
function approvedPackage(deployment: Deployment) {
  const file = "/var/cache/ct701-typed-action-finalizer/approved-package.sha256";
  for (const parent of ["/var", "/var/cache", "/var/cache/ct701-typed-action-finalizer", deploymentPaths.source]) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("Unsafe staging ancestry");
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe approval pin");
  validateMetadata(stat, 0, 0, 0o644);
  const expected = readFileSync(file, "utf8").trim(), id = deployment.package().id;
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== id) throw new Error("Approved package hash mismatch");
  return id;
}
export async function main(args = process.argv.slice(2)) {
  const action = parseDeploymentAction(args);
  if (process.platform !== "linux" || !process.getuid) throw new Error("Linux required");
  if (!["startup-check", "ledger-worker"].includes(action) && process.getuid() !== 0) throw new Error("Root required");
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error("Node environment overrides forbidden");
  if (action === "dry-run") {
    console.log(approvedPackage(new Deployment({ uid: 0, gid: 0 })));
    return;
  }
  process.umask(0o077);
  const lock = "/run/ct701-typed-action-finalizer-deployment.lock";
  if (action === "initialize") {
    // This action alone provisions the fixed dedicated account. It never starts a service.
    stopped();
    const fd = openSync(lock, "wx", 0o600);
    try {
      const passwd = readFileSync("/etc/passwd", "utf8");
      if (!passwd.split("\n").some(line => line.startsWith(`${account}:`))) command("/usr/sbin/useradd", ["--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", account]);
      new Deployment(identity()).initialize();
    } finally { closeSync(fd); unlinkSync(lock); }
    return;
  }
  const ids = identity(), deployment = new Deployment(ids);
  if (action === "ledger-worker") {
    if (process.getuid() !== ids.uid) throw new Error("Service identity required");
    deployment.initializeLedger(); return;
  }
  if (action === "startup-check") {
    if (process.getuid() !== ids.uid) throw new Error("Service identity required");
    deployment.verifyOffline(); return;
  }
  if (action === "verify") {
    deployment.verifyOffline();
    command("/usr/bin/systemctl", ["is-enabled", "--quiet", unitName]);
    command("/usr/bin/systemctl", ["is-active", "--quiet", unitName]);
    if (command("/usr/bin/systemctl", ["show", unitName, "--property=DropInPaths", "--value"]) !== ""
      || command("/usr/bin/systemctl", ["show", unitName, "--property=NeedDaemonReload", "--value"]) !== "no"
      || command("/usr/bin/systemctl", ["show", unitName, "--property=FragmentPath", "--value"]) !== deploymentPaths.unit) throw new Error("Unexpected loaded unit");
    const pid = command("/usr/bin/systemctl", ["show", unitName, "--property=MainPID", "--value"]);
    validateListeners(command("/usr/bin/ss", ["-H", "-lntup"]), pid);
    await verifyHealth();
    // Correlate the running process with the selected release, not merely an old healthy process.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    if (JSON.stringify(cmdline) !== JSON.stringify(["/usr/bin/node", "--jitless", `${deploymentPaths.home}/current/runtime/typed-action-finalizer/cli.js`, `${deploymentPaths.home}/current/config.json`])) throw new Error("Unexpected service command");
    const { realpathSync } = await import("node:fs");
    if (realpathSync(`/proc/${pid}/cwd`) !== realpathSync(`${deploymentPaths.home}/current`)) throw new Error("Running release mismatch");
    console.log("CT701 verification PASS"); return;
  }
  stopped();
  // Exclusive fixed lock; stale lock after a crash requires operator investigation.
  const fd = openSync(lock, "wx", 0o600);
  try {
    switch (action) {
      case "bootstrap-key": console.log(`Ed25519 SPKI SHA256 ${deployment.bootstrapKey()}`); break;
      case "bootstrap-token": deployment.bootstrapToken(); break;
      case "install-human-key": console.log(`CT700 SPKI SHA256 ${deployment.installHumanKey()}`); break;
      case "initialize-ledger":
        // SQLite and WAL must be created by the service identity, never root.
        approvedPackage(deployment);
        execFileSync("/usr/bin/node", ["--jitless", `${deploymentPaths.source}/runtime/typed-action-finalizer/deployment-cli.js`, "ledger-worker"], {
          uid: ids.uid, gid: ids.gid, timeout: 30_000,
          env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" }, stdio: "pipe",
        }); break;
      case "install": approvedPackage(deployment); console.log(deployment.install()); break;
      case "rollback": deployment.rollback(); break;
    }
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("CT701 deployment rejected; inspect fixed prerequisites (no secrets logged)"); process.exitCode = 1; });
}
