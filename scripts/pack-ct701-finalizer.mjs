import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Fixed inputs/output. No arbitrary entry point, destination or command selectors.
if (process.argv.length !== 2) throw new Error("No pack arguments accepted");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".tooling/ct701-finalizer-package");
if (fs.existsSync(output)) throw new Error("Package output already exists; retain/review or explicitly remove before rebuilding");
fs.mkdirSync(output, { recursive: true });
const hash = data => createHash("sha256").update(data).digest("hex");
const seen = new Set();
function local(relative) {
  if (seen.has(relative)) return;
  if (!/^[a-zA-Z0-9_./-]+\.js$/.test(relative) || relative.startsWith("../")) throw new Error("Unsafe runtime import");
  seen.add(relative);
  const text = fs.readFileSync(path.join(root, "dist", relative), "utf8");
  const dest = path.join(output, "runtime", relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text.replace(/^\/\/# sourceMappingURL=.*$/gm, ""));
  for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) local(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
    else if (!specifier.startsWith("node:") && !["express", "zod"].includes(specifier)) throw new Error(`Unexpected runtime dependency ${specifier}`);
  }
}
local("typed-action-finalizer/cli.js");
local("typed-action-finalizer/deployment-cli.js");
// Preserve each package's dependency resolution with nested copies; no pnpm links,
// dev dependencies, registry access, lifecycle scripts or native addons at install.
function dependency(name, requireFrom, destination, ancestry = new Set()) {
  const req = createRequire(requireFrom);
  let directory = req.resolve.paths(name).map(base => path.join(base, name))
    .find(candidate => fs.existsSync(path.join(candidate, "package.json")));
  if (!directory || JSON.parse(fs.readFileSync(path.join(directory, "package.json"))).name !== name) throw new Error(`Cannot resolve ${name}`);
  directory = fs.realpathSync(directory);
  if (ancestry.has(directory)) throw new Error("Dependency cycle requires explicit packaging review");
  const next = new Set(ancestry).add(directory);
  fs.cpSync(directory, destination, { recursive: true, filter: source => !path.relative(directory, source).split(path.sep).includes("node_modules") });
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json")));
  for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) dependency(dep, path.join(directory, "package.json"), path.join(destination, "node_modules", dep), next);
}
for (const dep of ["express", "zod"]) dependency(dep, path.join(root, "package.json"), path.join(output, "node_modules", dep));
for (const name of fs.readdirSync(path.join(root, "deploy/ct701-typed-action-finalizer"))) {
  fs.copyFileSync(path.join(root, "deploy/ct701-typed-action-finalizer", name), path.join(output, name));
}
fs.writeFileSync(path.join(output, "package.json"), '{"private":true,"type":"module"}\n');
fs.copyFileSync(path.join(root, "pnpm-lock.yaml"), path.join(output, "pnpm-lock.yaml"));
fs.copyFileSync(path.join(root, "docs/ct701-finalizer-deployment.md"), path.join(output, "README.md"));
const files = {};
function walk(dir, prefix = "") {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name), rel = prefix + name, stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Package must contain regular files only");
    fs.chmodSync(file, stat.isDirectory() ? 0o755 : 0o644);
    if (stat.isDirectory()) walk(file, rel + "/"); else files[rel] = hash(fs.readFileSync(file));
  }
}
walk(output);
const manifest = JSON.stringify({ format: 1, node: process.version, files }, null, 2) + "\n";
fs.writeFileSync(path.join(output, "manifest.json"), manifest);
console.log(`Package: .tooling/ct701-finalizer-package\nApproved manifest SHA256: ${hash(manifest)}\nNode runtime: ${process.version}`);
