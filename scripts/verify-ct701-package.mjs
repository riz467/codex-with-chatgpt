import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

if (process.argv.length !== 2 || !process.execArgv.includes("--jitless")) throw new Error("Run node --jitless scripts/verify-ct701-package.mjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(tmpdir(), "opencode"); fs.mkdirSync(base, { recursive: true });
const fixture = fs.mkdtempSync(path.join(base, "ct701-package-"));
try {
  const stage = path.join(fixture, "var/cache/ct701-typed-action-finalizer/package");
  fs.cpSync(path.join(root, ".tooling/ct701-finalizer-package"), stage, { recursive: true });
  // Imports resolve entirely outside the checkout: missing bundled dependencies fail.
  const { Deployment, verifyHealth } = await import(pathToFileURL(path.join(stage, "runtime/typed-action-finalizer/deployment.js")).href);
  const d = new Deployment({ root: fixture, fixture: true, uid: process.getuid?.() ?? 100, gid: process.getgid?.() ?? 100 });
  const pkg = d.package();
  for (const name of Object.keys(pkg.manifest.files)) {
    assert(!/signing-key\.pem|bridge-token$|ledger\.sqlite|typed-action-git|mcp\/server/.test(name));
  }
  const { createFinalizerService } = await import(pathToFileURL(path.join(stage, "runtime/typed-action-finalizer/server.js")).href);
  const config = JSON.parse(fs.readFileSync(path.join(stage, "config.json"), "utf8"));
  const dependencies = {
    privateKey: generateKeyPairSync("ed25519").privateKey,
    humanPublicKey: generateKeyPairSync("ed25519").publicKey,
    bridgeToken: randomBytes(32).toString("base64url"), databasePath: path.join(fixture, "ledger.sqlite"),
  };
  for (let launch = 0; launch < 2; launch++) {
    const service = createFinalizerService({ ...config, port: 0 }, dependencies);
    try {
      const port = await service.listen();
      await verifyHealth(port);
    } finally { await service.close(); }
  }
  fs.writeFileSync(dependencies.databasePath, "malformed database");
  assert.throws(() => createFinalizerService({ ...config, port: 0 }, dependencies));
  console.log(`Offline package PASS: ${pkg.id}; ${Object.keys(pkg.manifest.files).length} files; jitless health/restart/SQLite verified`);
} finally { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
