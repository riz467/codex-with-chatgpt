import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeBridge } from "../src/bridge/runtime.js";
import { bridgeHealth, normalizeOsHealth, verifiedHealth } from "../src/dashboard/verified-health.js";
import { Collector } from "../src/dashboard/collector.js";

const script = fileURLToPath(new URL("../scripts/observe-ai-workspace-health.ps1", import.meta.url));
const shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
function ps(code: string) {
  return JSON.parse(execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", `. '${script}'; ${code}`],
    { encoding: "utf8", timeout: 12000, windowsHide: true })) as Record<string, any>;
}
const live = { status: "ready", summary: "確認済み", pid: 42, session_id: 1, observed_at: new Date().toISOString() };
describe("verified dashboard health", () => {
  it("requires fixed bridge service identity and ok status", async () => {
    expect((await bridgeHealth(48765, async () => ({ service: "c2c-bridge", status: "ok", version: "v", workspaceId: "w" }))).status).toBe("healthy");
    expect((await bridgeHealth(54108, async () => ({ service: "foreign", status: "ok", version: "v", workspaceId: "w" }))).status).toBe("unknown");
    expect((await bridgeHealth(48765, async () => ({ service: "c2c-bridge", status: "failed", version: "v", workspaceId: "w" }))).status).toBe("unknown");
    expect((await bridgeHealth(48765, async () => null)).status).toBe("unknown");
  });
  it("rejects malformed, wrong HTTP status and timeout in the shared bridge probe", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => new Response("not json", { status: 200 }));
      expect(await probeBridge(48765, 50)).toBeNull();
      globalThis.fetch = vi.fn(async () => new Response('{"service":"c2c-bridge","status":"ok"}', { status: 201 }));
      expect(await probeBridge(48765, 50)).toBeNull();
      globalThis.fetch = vi.fn((_url, opts) => new Promise((_resolve, reject) => (opts?.signal as AbortSignal).addEventListener("abort", () => reject(new Error("timeout"))))) as typeof fetch;
      expect(await probeBridge(48765, 20)).toBeNull();
    } finally { globalThis.fetch = original; }
  });
  it("projects only safe fields; rejects stale heartbeat and missing evidence", async () => {
    const input = { tunnel: { status: "verified", summary: "safe", pid: 12, command: "secret", sid: "secret" }, codex_worker: live,
      interactive_session: { status: "verified", summary: "ok", session_id: 1 }, dashboard: { status: "unexpected", summary: "bad" } };
    const normalized = normalizeOsHealth(input);
    expect(JSON.stringify(normalized)).not.toContain("secret");
    expect(normalized.dashboard.status).toBe("unknown");
    const probe = async () => ({ service: "c2c-bridge", status: "ok", version: "v", workspaceId: "w" });
    const ready = await verifiedHealth(async () => normalized, probe);
    expect(ready.codex_worker.status).toBe("ready");
    const stale = await verifiedHealth(async () => normalizeOsHealth({ ...input, codex_worker: { ...live, observed_at: "2020-01-01T00:00:00Z" } }), probe);
    expect(stale.codex_worker.status).toBe("unknown");
    expect(stale.interactive_session.status).toBe("unknown");
  });
  it("adds verified_health to the existing status shape without exposing secrets", async () => {
    const collector = new Collector({ "pve-doc": "C:/missing", "ai-orchestration-config": "C:/missing" }, "C:/missing", "C:/missing", async () => normalizeOsHealth({ codex_worker: live }));
    const health = await collector.health();
    expect(health.verified_health.codex_worker.status).toBe("ready");
    expect(health.codex_worker).toBe("ready");
    expect(health.last_known_pid).toBeNull();
    expect(JSON.stringify(health)).not.toMatch(/secret|CommandLine|UserSid/);
  });
});

describe.skipIf(process.platform !== "win32")("fixed PowerShell OS verifier", () => {
  const prelude = `function Get-CimInstance { param($Class,$Filter) $script:processes }
    function Get-ScheduledTask { [pscustomobject]@{ State = $script:taskState } }
    function Test-CodexWorkerTaskConfig { $script:taskOK }
    function Get-WorkspaceInteractiveSessions { $script:sessions }
    function OwnerSid { param($process) $script:ownerSid }
    $script:taskState = 'Running'; $script:taskOK = $true;
    $script:ownerSid = 'S-1-5-21-1389881484-3427664689-3699660927-1000';
    $script:sessions = @([pscustomobject]@{ User = "$env:COMPUTERNAME\\workspace"; SessionId = 1; State = 'Disconnected' });
    $node = 'C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node.exe';
    $script:processes = @([pscustomobject]@{ ProcessId=42; Name='node.exe'; SessionId=1; ExecutablePath=$node; CommandLine=('"'+$node+'" "C:\\work\\codex-with-chatgpt\\dist\\worker\\cli.js" worker') });
    $beat = [pscustomobject]@{ pid=42; session_id=1; observed_utc=[DateTimeOffset]::UtcNow.ToString('o') };`;
  const worker = (alter = "") => ps(`${prelude} ${alter}; $result=Observe-Worker $beat; $result | ConvertTo-Json -Compress -Depth 4`);
  it("accepts matching PID, user SID and disconnected interactive session", () => {
    const result = worker();
    expect(result.worker.status).toBe("ready"); expect(result.session.status).toBe("verified");
  });
  it.each([
    ["stale heartbeat", "$beat.observed_utc=[DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o')"],
    ["PID mismatch", "$script:processes[0].ProcessId=43"],
    ["process missing", "$script:processes=@()"],
    ["session zero", "$beat.session_id=0"],
    ["session mismatch", "$script:processes[0].SessionId=2"],
    ["wrong user", "$script:sessions[0].User='OTHER\\workspace'"],
    ["wrong SID", "$script:ownerSid='S-1-5-18'"],
    ["non-interactive session", "$script:sessions[0].State='Other'"],
    ["S4U task", "$script:taskOK=$false"],
    ["wrong executable", "$script:processes[0].ExecutablePath='C:\\other\\node.exe'"]
  ])("fails closed for %s", (_name, change) => { expect(worker(change).worker.status).toBe("unknown"); });
  it("distinguishes expected tunnel, inaccessible command line, wrong executable and absent process", () => {
    const base = `function Get-CimInstance { $script:processes }
      $script:processes=@([pscustomobject]@{ ProcessId=55; ExecutablePath='C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'; CommandLine='cloudflared --config C:\\Users\\workspace\\.cloudflared\\config.yml tunnel run ai-workspace-mcp' });`;
    const tunnel = (change = "") => ps(`${base} ${change}; Observe-Tunnel | ConvertTo-Json -Compress`);
    expect(tunnel().status).toBe("verified");
    expect(tunnel("$script:processes[0].CommandLine=$null").status).toBe("degraded");
    expect(tunnel("$script:processes[0].ExecutablePath='C:\\other\\cloudflared.exe'").status).toBe("unknown");
    expect(tunnel("$script:processes=@()").status).toBe("unavailable");
  });
});
