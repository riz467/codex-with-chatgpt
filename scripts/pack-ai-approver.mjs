import fs from "node:fs";
import path from "node:path";

const root = path.join("dist", "ai-approver-package");
const marker = path.join(root, ".generated-by-pack-ai-approver");
if (fs.existsSync(root)) {
  if (!fs.existsSync(marker)) throw new Error("Refusing to replace an unrecognized package directory");
  // Replace only our own generated artifact; never ship stale local node_modules or files.
  fs.rmSync(root, { recursive: true });
}
fs.mkdirSync(path.join(root, "runtime", "approver-service", "public"), { recursive: true });
fs.mkdirSync(path.join(root, "runtime", "human-approval"), { recursive: true });
for (const name of ["server", "storage", "cli"]) fs.copyFileSync(`dist/approver-service/${name}.js`, path.join(root, "runtime", "approver-service", `${name}.js`));
fs.copyFileSync("dist/human-approval/contract.js", path.join(root, "runtime", "human-approval", "contract.js"));
fs.cpSync("src/approver-service/public", path.join(root, "runtime", "approver-service", "public"), { recursive: true });
for (const name of ["package.json", "package-lock.json"])
  fs.copyFileSync(path.join("deploy", "ai-approver", name), path.join(root, name));
// Windows working trees may be CRLF; CT /bin/sh and systemd need LF artifacts.
for (const name of ["ai-approver.service", "install.sh"])
  fs.writeFileSync(path.join(root, name), fs.readFileSync(path.join("deploy", "ai-approver", name), "utf8").replace(/\r\n/g, "\n"));
fs.writeFileSync(marker, "generated artifact; safe to replace\n");
console.log(root);
