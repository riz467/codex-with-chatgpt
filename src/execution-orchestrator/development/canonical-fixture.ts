import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { parseStrict } from "../../task-contract/contract.js";
import { inspectCandidateRepository, type CandidateRepository } from "./candidate-repo.js";
import { safeComponents } from "./candidate-mutation.js";

export interface CanonicalFixture { readonly kind: "TEMPORARY_CANONICAL_FIXTURE_ONLY"; readonly root: string; readonly head: string }
type Data = { rootIdentity: string; candidate?: CandidateRepository };
const fixtures = new WeakMap<CanonicalFixture, Data>();
const identity = (root: string) => { const s = fs.lstatSync(root); return `${s.dev}:${s.ino}`; };

/** Creates new isolated storage only. No existing canonical path can be enrolled.
 * Raw Git objects establish a fixture baseline; no commit command, hooks or shell. */
export function createCanonicalFixture(input: unknown): CanonicalFixture {
  const rows = parseStrict(z.array(z.object({ path: z.string().max(256), content: z.string().max(32768) }).strict()).min(1).max(100), input);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dl2-f-canonical-")));
  const aliases = new Set<string>();
  for (const row of rows) {
    if (aliases.has(row.path.toLowerCase())) throw new Error("FIXTURE_CASE_ALIAS");
    aliases.add(row.path.toLowerCase());
    const target = safeComponents(root, row.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, row.content, { flag: "wx", mode: 0o600 });
  }
  fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
  const object = (type: string, body: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const hash = createHash("sha1").update(bytes).digest("hex");
    const dir = path.join(root, ".git", "objects", hash.slice(0, 2)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, hash.slice(2)), deflateSync(bytes)); return hash;
  };
  const tree = (prefix: string): string => {
    const children = [...new Set(rows.filter(r => r.path.startsWith(prefix)).map(r => r.path.slice(prefix.length).split("/")[0]))];
    const entries = children.map(name => ({ name, row: rows.find(r => r.path === prefix + name) }));
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.row ? "" : "/")), Buffer.from(b.name + (b.row ? "" : "/"))));
    return object("tree", Buffer.concat(entries.map(({ name, row }) => Buffer.concat([
      Buffer.from(`${row ? "100644" : "40000"} ${name}\0`),
      Buffer.from(row ? object("blob", Buffer.from(row.content)) : tree(prefix + name + "/"), "hex")]))));
  };
  const head = object("commit", Buffer.from(`tree ${tree("")}\nauthor Fixture <fixture@invalid> 1 +0000\ncommitter Fixture <fixture@invalid> 1 +0000\n\nfixture baseline\n`));
  fs.writeFileSync(path.join(root, ".git", "HEAD"), head + "\n", { flag: "wx" });
  const handle = Object.freeze({ kind: "TEMPORARY_CANONICAL_FIXTURE_ONLY" as const, root, head });
  fixtures.set(handle, { rootIdentity: identity(root) });
  return handle;
}

/** Called once before E0; initializes only the freshly created fixture index. */
export function bindCanonicalFixture(handle: CanonicalFixture, candidate: CandidateRepository): void {
  const data = fixtures.get(handle);
  if (!data || data.candidate || data.rootIdentity !== identity(handle.root)) throw new Error("FIXTURE_IDENTITY");
  const info = inspectCandidateRepository(candidate);
  if (info.canonicalRoot !== handle.root || candidate.head !== handle.head) throw new Error("FIXTURE_CANDIDATE_MISMATCH");
  fs.writeFileSync(path.join(handle.root, ".git", "index"), fs.readFileSync(path.join(info.gitDir, "index")), { flag: "wx" });
  data.candidate = candidate;
}
export function assertCanonicalFixture(handle: CanonicalFixture, candidate: CandidateRepository): void {
  const data = fixtures.get(handle);
  if (!data || data.candidate !== candidate || data.rootIdentity !== identity(handle.root) ||
    inspectCandidateRepository(candidate).canonicalRoot !== handle.root) throw new Error("FIXTURE_IDENTITY");
}
