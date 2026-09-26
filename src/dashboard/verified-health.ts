import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeBridge } from "../bridge/runtime.js";
import { SERVICE_NAME } from "../version.js";

export type HealthItem = { status: "verified" | "healthy" | "ready" | "degraded" | "unavailable" | "unknown"; summary: string; pid: number | null; session_id: number | null; observed_at: string | null };
export type OsHealth = Record<"tunnel" | "codex_worker" | "interactive_session" | "dashboard", HealthItem>;
const unknown = (summary = "確認できません"): HealthItem => ({ status: "unknown", summary, pid: null, session_id: null, observed_at: null });
const keys = ["tunnel", "codex_worker", "interactive_session", "dashboard"] as const;
const states = new Set(["verified", "healthy", "ready", "degraded", "unavailable", "unknown"]);
const fallback = (): OsHealth => ({ tunnel: unknown(), codex_worker: unknown(), interactive_session: unknown(), dashboard: unknown() });

// The PowerShell process has no caller-supplied arguments or paths. Only allowlisted projected fields leave this module.
export function normalizeOsHealth(raw: unknown): OsHealth {
  const result = fallback();
  if (!raw || typeof raw !== "object") return result;
  for (const key of keys) {
    const item = (raw as Record<string, unknown>)[key];
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.status !== "string" || !states.has(record.status)) continue;
    result[key] = {
      status: record.status as HealthItem["status"],
      summary: typeof record.summary === "string" && /^[^\x00-\x1f\x7f]{1,100}$/.test(record.summary) ? record.summary : "確認できません",
      pid: Number.isSafeInteger(record.pid) && (record.pid as number) > 0 ? record.pid as number : null,
      session_id: Number.isSafeInteger(record.session_id) && (record.session_id as number) > 0 ? record.session_id as number : null,
      observed_at: typeof record.observed_at === "string" && !Number.isNaN(Date.parse(record.observed_at)) ? record.observed_at : null
    };
  }
  return result;
}
const script = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../scripts/observe-ai-workspace-health.ps1");
let cached: Promise<OsHealth> | null = null;
let until = 0;
export function observeOsHealth(): Promise<OsHealth> {
  if (process.platform !== "win32") return Promise.resolve(fallback());
  if (cached && Date.now() < until) return cached;
  until = Infinity; // share an in-flight probe, even when it takes longer than the snapshot interval
  cached = new Promise<OsHealth>(resolve => {
    execFile("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", script],
      { windowsHide: true, timeout: 5000, maxBuffer: 8192 }, (error, stdout) => {
        if (error) { resolve(fallback()); return; }
        try { resolve(normalizeOsHealth(JSON.parse(stdout))); } catch { resolve(fallback()); }
      });
  }).then(result => { until = Date.now() + 2000; return result; });
  return cached;
}
export async function bridgeHealth(port: 48765 | 54108, probe = probeBridge): Promise<HealthItem> {
  const payload = await probe(port, 1000);
  return payload?.service === SERVICE_NAME && payload.status === "ok" ? { status: "healthy", summary: "固定localhostのサービスを確認", pid: null, session_id: null, observed_at: null } : unknown("ヘルス応答またはサービスの同一性を確認できません");
}
export async function verifiedHealth(osProbe = observeOsHealth, probe = probeBridge) {
  const [execution_bridge, review_bridge, os] = await Promise.all([bridgeHealth(48765, probe), bridgeHealth(54108, probe), osProbe().catch(fallback)]);
  const safe = normalizeOsHealth(os);
  const age = safe.codex_worker.observed_at ? (Date.now() - Date.parse(safe.codex_worker.observed_at)) / 1000 : Infinity;
  if (safe.codex_worker.status === "ready" && !(age >= 0 && age < 10)) {
    safe.codex_worker = unknown("ハートビートが失効しました");
    safe.interactive_session = unknown("ワーカーとの整合を確認できません");
  }
  return { execution_bridge, review_bridge, ...safe };
}
