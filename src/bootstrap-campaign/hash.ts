import { createHash } from "node:crypto";

/** Inspect descriptors before reading values: input getters must never execute. */
export function assertJson(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 100) throw new Error("JSON depth exceeded");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("Invalid Unicode");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("Safe JSON integer required");
    return;
  }
  if (typeof value !== "object" || seen.has(value)) throw new Error("Non-JSON value");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error("Custom JSON prototype");
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== (value as unknown[]).length + 1) throw new Error("Sparse or decorated array");
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("Symbol key");
    if (array && key === "length") continue;
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("Array property");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Non-data JSON property");
    assertJson(key, seen, depth + 1);
    assertJson(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}

export function canonicalJson(value: unknown): string {
  assertJson(value);
  const encode = (v: any): string => v === null || typeof v !== "object" ? JSON.stringify(v)
    : Array.isArray(v) ? `[${v.map(encode).join(",")}]`
      : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode(v[k])}`).join(",")}}`;
  return encode(value);
}

/** JSON.parse alone loses duplicate keys (including escaped spelling aliases). */
export function parseJson(text: string): unknown {
  if (typeof text !== "string" || text.length > 2_000_000) throw new Error("Invalid JSON input");
  let i = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? "x")) i++; };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw new Error("Unterminated JSON string");
  };
  const read = (depth: number): unknown => {
    if (depth > 100) throw new Error("JSON depth exceeded");
    ws();
    if (text[i] === '"') return string();
    if (text[i] === "{") {
      i++; ws(); const result: Record<string, unknown> = {}; const keys = new Set<string>();
      if (text[i] === "}") { i++; return result; }
      for (;;) {
        ws(); if (text[i] !== '"') throw new Error("Expected JSON key");
        const key = string(); if (keys.has(key)) throw new Error("Duplicate JSON key"); keys.add(key);
        ws(); if (text[i++] !== ":") throw new Error("Expected colon");
        Object.defineProperty(result, key, { value: read(depth + 1), enumerable: true, writable: true, configurable: true });
        ws(); const end = text[i++]; if (end === "}") return result;
        if (end !== ",") throw new Error("Expected comma");
      }
    }
    if (text[i] === "[") {
      i++; ws(); const result: unknown[] = [];
      if (text[i] === "]") { i++; return result; }
      for (;;) {
        result.push(read(depth + 1)); ws(); const end = text[i++];
        if (end === "]") return result;
        if (end !== ",") throw new Error("Expected comma");
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!token) throw new Error("Invalid JSON token");
    i += token[0].length; return JSON.parse(token[0]);
  };
  const result = read(0); ws(); if (i !== text.length) throw new Error("Trailing JSON data");
  assertJson(result); return result;
}

export function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain + "\n" + canonicalJson(value), "utf8").digest("hex");
}
