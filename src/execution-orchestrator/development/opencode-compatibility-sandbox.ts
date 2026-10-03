import { z } from "zod";
import { freeze, parseStrict } from "../../task-contract/contract.js";

export const networkObservationSchema = z.object({
  backend: z.literal("NODE_PERMISSION_DENY"),
  nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/).refine(v => Number(v.split(".")[0]) >= 25),
  denied: z.object({ fetch: z.literal("ERR_ACCESS_DENIED"), http: z.literal("ERR_ACCESS_DENIED"),
    https: z.literal("ERR_ACCESS_DENIED"), net: z.literal("ERR_ACCESS_DENIED") }).strict(),
  candidateNetworkAttemptsAllowed: z.literal(0),
}).strict();
export function parseNetworkObservation(input: unknown) { return freeze(parseStrict(networkObservationSchema, input)); }

// This source is host-owned and copied into the sealed capsule. It imports ONLY
// Node builtins, runs BEFORE candidate imports and BEFORE replacing global fetch.
// Version/flag checks reject unsupported runtimes; only actual permission errors
// from all four paths establish capability. DNS/connection/timeout failures do not.
export const NETWORK_PREFLIGHT_SOURCE = String.raw`
export function isNetworkPermissionDenial(error) {
  const seen = new Set(), pending = [error];
  while (pending.length) {
    const e = pending.pop();
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    if (e.code === 'ERR_ACCESS_DENIED' && e.permission === 'Net') return true;
    // Node 26's socket error stores the original permission error in errno;
    // fetch then wraps that socket error in cause. Inspect only object errors.
    pending.push(e.cause, e.errno);
  }
  return false;
}
export async function preflightNetworkIsolation() {
  const unavailable = { status: 'PLATFORM_UNAVAILABLE', observation: null };
  // Never exercise network on an old runtime, in audit mode, or with broad grants.
  if (Number(process.versions.node.split('.')[0]) < 25 ||
      !process.allowedNodeEnvironmentFlags.has('--allow-net') ||
      !process.execArgv.includes('--permission') ||
      process.execArgv.some(a => /^--(?:allow-(?:net|child-process|worker|addons|wasi|ffi|inspector|openssl-store)|permission-audit)(?:=|$)/.test(a)) ||
      process.env.NODE_OPTIONS || !process.permission) return unavailable;
  try {
    if (process.permission.has('net') || process.permission.has('child') ||
        process.permission.has('worker') || process.permission.has('addon')) return unavailable;
  } catch { return unavailable; }
  const http = await import('node:http');
  const https = await import('node:https');
  const net = await import('node:net');
  // Numeric loopback: no DNS, no external endpoint, no credentials. Success,
  // ECONNREFUSED, TLS error, DNS error and timeout ALL fail certification.
  const attempt = start => new Promise(resolve => {
    let resource, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resource?.destroy();
      resolve(isNetworkPermissionDenial(error) ? 'ERR_ACCESS_DENIED' : 'NOT_DENIED');
    };
    const timer = setTimeout(() => finish(null), 1500);
    try { resource = start(finish); } catch (error) { finish(error); }
  });
  const denied = {};
  try {
    await globalThis.fetch('http://127.0.0.1:43219/', { signal: AbortSignal.timeout(1500) });
    denied.fetch = 'NOT_DENIED';
  } catch (error) { denied.fetch = isNetworkPermissionDenial(error) ? 'ERR_ACCESS_DENIED' : 'NOT_DENIED'; }
  denied.http = await attempt(done => {
    const req = http.request('http://127.0.0.1:43219/', () => done(null));
    req.once('error', done); req.end(); return req;
  });
  denied.https = await attempt(done => {
    const req = https.request('https://127.0.0.1:43219/', () => done(null));
    req.once('error', done); req.end(); return req;
  });
  denied.net = await attempt(done => {
    const socket = net.connect({ host: '127.0.0.1', port: 43219 });
    socket.once('error', done); socket.once('connect', () => done(null)); return socket;
  });
  if (Object.values(denied).some(value => value !== 'ERR_ACCESS_DENIED')) return unavailable;
  return { status: 'ENFORCED', observation: { backend: 'NODE_PERMISSION_DENY',
    nodeVersion: process.versions.node, denied, candidateNetworkAttemptsAllowed: 0 } };
}
`;
