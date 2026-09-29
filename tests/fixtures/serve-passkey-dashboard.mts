// Explicit, test-only loopback service. Does not start Dashboard production or Approver CT.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createHumanApprover } from "../../src/human-approver/server.js";
import { PasskeyFixture } from "../../src/dashboard/passkey-fixture.js";
import { BoundedTasks } from "../../src/mcp/bounded-task.js";

const id = process.env.BOUNDED_TASK_ID;
if (!id || !/^bounded-[a-f0-9]{32}$/.test(id)) throw new Error("ACCEPTED_TASK_ID_REQUIRED");
const repo = "C:\\work\\bounded-review-live-fixture";
const tasks = new BoundedTasks({ "autonomous-fixture": repo });
tasks.acceptedSnapshot(id); // fail closed before making any browser page
const credentialPath = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "ai-workspace-human-approver-poc", "credential.json");
if (!fs.existsSync(credentialPath)) throw new Error("EXISTING_PASSKEY_REGISTRATION_NOT_FOUND");
const credential = JSON.parse(fs.readFileSync(credentialPath, "utf8")) as Record<string, unknown>;
if (credential.rpID !== "localhost" || typeof credential.id !== "string" || !credential.id ||
    typeof credential.publicKey !== "string" || !credential.publicKey ||
    !Number.isSafeInteger(credential.counter) || (credential.counter as number) < 0)
  throw new Error("VALID_LOCALHOST_PASSKEY_REGISTRATION_REQUIRED");
const root = path.join(os.tmpdir(), "opencode", `passkey-dashboard-${randomUUID()}`);
const fixture = new PasskeyFixture(root, Date.now, () => tasks.acceptedSnapshot(id));
// Only public credential material is copied. Counter updates must remain in the fixture,
// never in the existing Approver credential store.
const fixtureCredential = path.join(root, "credential.json");
fs.writeFileSync(fixtureCredential, JSON.stringify({ rpID: credential.rpID, id: credential.id,
  publicKey: credential.publicKey, counter: credential.counter,
  ...(Array.isArray(credential.transports) && credential.transports.every(x => typeof x === "string")
    ? { transports: credential.transports } : {}) }), { flag: "wx", mode: 0o600 });
const app = createHumanApprover({ mode: "localhost", storePath: fixtureCredential, fixture });
const server = app.listen(48767, "127.0.0.1", () => {
  // Never log the credential, authentication challenge or approval token.
  console.log(JSON.stringify({ url: "http://localhost:48767/passkey-fixture", fixture_root: root,
    request_id: fixture.status().request.request_id, state: fixture.status().state }));
});
server.on("error", error => { console.error((error as NodeJS.ErrnoException).code ?? "LISTEN_FAILED"); process.exitCode = 1; });
