import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { IgnoreRules } from "../workspace/ignore.js";
import { GatewayError, REPOS } from "./local-gateway.js";

export type RepoKey = keyof typeof REPOS;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LINES = 200;
const excluded = ignore().add(["vendor/", "generated/", "__generated__/", ".generated/", ".ai/", "*.min.js", "*.map", "*.lockb"]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function rootFor(repo: string): string {
  if (!Object.hasOwn(REPOS, repo)) throw new GatewayError("INVALID_REPO", "Unknown repository key");
  const root = path.resolve(REPOS[repo as RepoKey]);
  if (!fs.statSync(root).isDirectory() || fs.realpathSync.native(root).toLowerCase() !== root.toLowerCase()) {
    throw new GatewayError("INVALID_REPO", "Allowlisted repo root is not a real directory");
  }
  return root;
}

function validatePath(relative: string): string[] {
  if (typeof relative !== "string" || !relative || relative.length > 500 ||
    /[\x00-\x1f\x7f\\:<>"|?*]/.test(relative) || relative.startsWith("/") || relative.includes("//") ||
    relative.split("/").some((part) => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" "))) {
    throw new GatewayError("INVALID_PATH", "Expected a repo-relative file path without traversal");
  }
  return relative.split("/");
}

function safeFile(root: string, relative: string, rules: IgnoreRules): string {
  const parts = validatePath(relative);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new GatewayError("INVALID_PATH", "Symlinks and reparse points are not readable");
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new GatewayError("INVALID_PATH", "Invalid path component");
    }
  }
  const real = fs.realpathSync.native(current);
  if (!real.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new GatewayError("INVALID_PATH", "Outside repository");
  if (rules.isHidden(relative) || excluded.ignores(relative)) throw new GatewayError("ACCESS_DENIED", "Excluded repository path");
  const scopes: { prefix: string; rule: Ignore }[] = [];
  let prefix = "";
  for (const part of parts.slice(0, -1)) {
    const local = gitIgnore(path.join(root, ...prefix.split("/").filter(Boolean)));
    if (local) scopes.push({ prefix, rule: local });
    prefix += `${part}/`;
    if (ignored(prefix.slice(0, -1), true, rules, scopes)) throw new GatewayError("ACCESS_DENIED", "Excluded repository path");
  }
  const local = gitIgnore(path.join(root, ...parts.slice(0, -1)));
  if (local) scopes.push({ prefix, rule: local });
  if (ignored(relative, false, rules, scopes)) throw new GatewayError("ACCESS_DENIED", "Excluded repository path");
  if (!fs.statSync(current).isFile()) throw new GatewayError("NOT_A_FILE", "Not a regular file");
  return current;
}

function readText(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_FILE_BYTES) throw new GatewayError("FILE_TOO_LARGE", "File exceeds 1 MiB limit");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(fd, bytes, offset, size - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (bytes.subarray(0, offset).includes(0)) throw new GatewayError("BINARY_FILE", "Binary file");
    try { return textDecoder.decode(bytes.subarray(0, offset)); }
    catch { throw new GatewayError("BINARY_FILE", "Non-UTF-8 file"); }
  } finally { fs.closeSync(fd); }
}

function gitIgnore(dir: string): Ignore | null {
  const file = path.join(dir, ".gitignore");
  try {
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 256 * 1024) return null;
    return ignore().add(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

function ignored(relative: string, directory: boolean, rules: IgnoreRules, scopes: { prefix: string; rule: Ignore }[]): boolean {
  const candidate = directory ? `${relative}/` : relative;
  if (rules.isHidden(candidate) || excluded.ignores(candidate)) return true;
  return scopes.some(({ prefix, rule }) => relative.startsWith(prefix) && rule.ignores(candidate.slice(prefix.length)));
}

export function searchRepo(repo: string, query: string, maxResults = 20) {
  const root = rootFor(repo);
  if (typeof query !== "string" || !query.trim() || query.length > 200 || /[\x00-\x1f\x7f]/.test(query)) {
    throw new GatewayError("INVALID_QUERY", "Query must be 1-200 characters without control characters");
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) throw new GatewayError("INVALID_LIMIT", "max_results must be 1-50");
  const rules = new IgnoreRules(root);
  const matches: { path: string; line: number; heading: string | null; snippet: string; score: number }[] = [];
  const needle = query.toLocaleLowerCase();
  const walk = (dir: string, prefix: string, scopes: { prefix: string; rule: Ignore }[]) => {
    const local = gitIgnore(dir);
    const active = local ? [...scopes, { prefix, rule: local }] : scopes;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (ignored(relative, entry.isDirectory(), rules, active) || entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(absolute, `${relative}/`, active); continue; }
      if (!entry.isFile() || fs.statSync(absolute).size > MAX_FILE_BYTES) continue;
      let content: string;
      try { content = readText(safeFile(root, relative, rules)); }
      catch { continue; } // unreadable, binary and raced files are not search results
      const lines = content.split(/\r?\n/);
      let heading: string | null = null;
      let best: (typeof matches)[number] | undefined;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s{0,3}#{1,6}\s+\S/.test(line)) heading = line.trim().slice(0, 160);
        if (!line.toLocaleLowerCase().includes(needle)) continue;
        const score = (relative.toLocaleLowerCase().includes(needle) ? 10 : 0) +
          (line === heading ? 5 : 0) + (i < 30 ? 1 : 0);
        const snippet = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2))
          .map((part) => part.slice(0, 240)).join("\n").slice(0, 600);
        if (!best || score > best.score) best = { path: relative, line: i + 1, heading, snippet, score };
      }
      if (best) matches.push(best);
    }
  };
  walk(root, "", []);
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "en") || a.line - b.line);
  return { repo, query, matches: matches.slice(0, maxResults), totalFiles: matches.length, truncated: matches.length > maxResults };
}

export function readRepoFile(repo: string, relative: string, startLine = 1, endLine?: number) {
  const root = rootFor(repo);
  if (!Number.isInteger(startLine) || startLine < 1 || (endLine !== undefined && (!Number.isInteger(endLine) || endLine < startLine))) {
    throw new GatewayError("INVALID_RANGE", "Invalid line range");
  }
  const content = readText(safeFile(root, relative, new IgnoreRules(root)));
  const lines = content.split(/\r?\n/);
  const last = Math.min(endLine ?? startLine + MAX_LINES - 1, startLine + MAX_LINES - 1, lines.length);
  const selected: string[] = [];
  let bytes = 0;
  for (let i = startLine - 1; i < last; i++) {
    const line = lines[i];
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + cost > MAX_OUTPUT_BYTES) break;
    selected.push(line);
    bytes += cost;
  }
  return { repo, path: relative, startLine, endLine: startLine + selected.length - 1,
    totalLines: lines.length, truncated: startLine + selected.length - 1 < lines.length, content: selected.join("\n") };
}
