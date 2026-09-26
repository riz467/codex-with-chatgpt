import fs from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { ApproverStore } from "./storage.js";
import { approverConfigSchema, createApproverService } from "./server.js";

const configFile = "/etc/ai-approver/config.json";
function main() {
  if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Run as the unprivileged ai-approver system user on Linux");
  const config = approverConfigSchema.parse(JSON.parse(fs.readFileSync(configFile, "utf8")) as unknown);
  const command = process.argv.slice(2);
  if (command.length !== 1 || !["init", "serve", "enroll-open", "public-key"].includes(command[0])) throw new Error("Expected one of: init, serve, enroll-open, public-key");
  process.umask(0o077);
  if (command[0] === "init") {
    // The private key is generated *only inside the CT*, never at build/package time.
    const { privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(config.signing_key_path, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    new ApproverStore(config.db_path).close();
    console.log("Initialized local signing key and SQLite store. Export the public key with: public-key");
    return;
  }
  const info = fs.lstatSync(config.signing_key_path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("Unsafe signing key ownership or permissions");
  const key = createPrivateKey(fs.readFileSync(config.signing_key_path));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");
  if (command[0] === "public-key") {
    console.log(JSON.stringify({ key_id: config.key_id, public_key_pem: createPublicKey(key).export({ type: "spki", format: "pem" }) }));
    return;
  }
  const store = new ApproverStore(config.db_path);
  if (command[0] === "enroll-open") {
    // Admin-only local CLI invocation: never exposed via HTTP. Avoid logging this token elsewhere.
    console.log(`Enrollment invitation (5 minutes, single-use): ${config.origin}/enroll/${store.openEnrollment(Date.now())}`);
    store.close(); return;
  }
  createApproverService(config, store, key).listen(config.port, "127.0.0.1", () => console.log(`ai-approver listening on 127.0.0.1:${config.port}`));
}
main();
