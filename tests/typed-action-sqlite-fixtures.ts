import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixture, now } from "./typed-action-fixtures.js";
import { consumptionNamespaces } from "../src/typed-action-finalizer/contract.js";
import { TypedActionFinalizerStore } from "../src/typed-action-finalizer/storage.js";
import { createTypedActionPermitSigningKernel } from "../src/typed-action-finalizer/signer.js";

export async function sqliteFixture() {
  const crypto = fixture();
  const base = path.join(await realpath(tmpdir()), "opencode"); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "ct701-sqlite-"));
  const file = path.join(directory, "ledger.sqlite");
  const handles: DatabaseSync[] = [];
  let clock = now;
  function connect() {
    const db = new DatabaseSync(file); handles.push(db);
    const store = new TypedActionFinalizerStore({ database: db, trustedFinalizerKeys: crypto.finalizerKeys, now: () => clock });
    const kernel = createTypedActionPermitSigningKernel({ store, privateKey: crypto.finalizer.privateKey,
      finalizerKeyId: "ct701-test", trustedHumanKeys: crypto.humanKeys, now: () => clock });
    return { db, store, kernel };
  }
  const first = connect();
  const identity = { permitJti: crypto.input.issuance.jti, attemptHash: crypto.input.boundAttempt.attemptHash };
  const keys = [
    { namespace: consumptionNamespaces.humanApproval, value: crypto.approval.payload.jti },
    { namespace: consumptionNamespaces.executionPermit, value: crypto.input.issuance.jti },
    { namespace: consumptionNamespaces.attempt, value: crypto.input.boundAttempt.attemptHash },
  ];
  return { ...crypto, ...first, file, identity, keys, connect, setClock: (value: number) => { clock = value; },
    count: (table: "finalized_permits" | "consumed_execution_identities" | "finalizer_audit") =>
      (first.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    async cleanup() {
      for (const db of handles) { try { db.close(); } catch { /* Some tests intentionally close/reopen. */ } }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
export type SqliteFixture = Awaited<ReturnType<typeof sqliteFixture>>;
