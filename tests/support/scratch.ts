import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = fileURLToPath(new URL("../../.tooling/test-tmp/", import.meta.url));
const issued = new WeakSet<object>();
const fail = (): never => { throw new Error("SCRATCH_CONTAINMENT: refusing filesystem mutation"); };

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Check ancestors as well as the leaf: an in-tree junction must never grant authority.
function noLinks(target: string): void {
  let current = path.parse(target).root;
  for (const part of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail();
      if (path.relative(current, fs.realpathSync.native(current)) !== "") fail();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function ordinaryPath(value: string): void {
  // Also reject Windows path tricks when running the suite on another OS.
  const relative = path.isAbsolute(value) ? value.slice(path.parse(value).root.length) : value;
  if (!value || value.includes("\0") || /[<>:"|?*]/.test(relative) ||
      relative.split(/[\\/]/).some((p) => p === "." || p === ".." || /[. ]$/.test(p) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) ||
      value.startsWith("\\\\") || value.startsWith("//")) fail();
}

export interface Scratch {
  readonly root: string;
  /** Validate without creating anything. Absolute paths must belong to this allocation. */
  resolve(target: string): string;
  read(target: string): Buffer;
  /** Create-only: never follow/overwrite an existing file or hard link. */
  write(target: string, content: string | Buffer): string;
  remove(target: string): void;
  dispose(): void;
}

export function assertScratch(value: Scratch): void {
  if (!issued.has(value)) fail();
}

/** Test-only authority, minted under a fixed repository scratch base. No configurable roots. */
export function createScratch(): Scratch {
  noLinks(path.resolve(base));
  fs.mkdirSync(base, { recursive: true });
  noLinks(path.resolve(base));
  const root = fs.mkdtempSync(path.join(base, "rc01-"));
  const identity = fs.lstatSync(root);
  let disposed = false;

  const resolve = (target: string): string => {
    if (disposed) fail();
    ordinaryPath(target);
    const absolute = path.resolve(root, target);
    if (!inside(root, absolute)) fail();
    noLinks(absolute);
    const now = fs.lstatSync(root);
    if (!now.isDirectory() || now.dev !== identity.dev || now.ino !== identity.ino) fail();
    return absolute;
  };
  const checkTree = (target: string): void => {
    noLinks(target);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isDirectory()) for (const name of fs.readdirSync(target)) checkTree(path.join(target, name));
    else if (!stat.isFile() || stat.nlink !== 1) fail();
  };
  const scratch: Scratch = Object.freeze({
    root,
    resolve,
    read(target: string): Buffer { return fs.readFileSync(resolve(target)); },
    write(target: string, content: string | Buffer): string {
      const file = resolve(target);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      resolve(file);
      fs.writeFileSync(file, content, { flag: "wx" });
      return file;
    },
    remove(target: string): void {
      const file = resolve(target);
      checkTree(file); // Preflight the entire tree before deleting anything.
      fs.rmSync(file, { recursive: true, force: true });
    },
    dispose(): void {
      if (disposed) return;
      resolve("allocation-check");
      checkTree(root);
      fs.rmSync(root, { recursive: true, force: true });
      disposed = true;
    },
  });
  issued.add(scratch);
  return scratch;
}
