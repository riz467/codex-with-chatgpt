import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDashboard } from '../src/dashboard/server.js';
import { Collector } from '../src/dashboard/collector.js';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const common = fileURLToPath(new URL('../scripts/ai-workspace-dashboard-task.ps1', import.meta.url));
const launcher = fileURLToPath(new URL('../scripts/run-ai-workspace-dashboard.mjs', import.meta.url));
const ps = (code: string) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 });
const dot = `. '${common.replaceAll("'", "''")}'`;

function config(variation = '') {
  const result = ps(`${dot}

$a=New-ScheduledTaskAction -Execute $DashboardNode -Argument $DashboardActionArguments -WorkingDirectory $DashboardRoot
$t=New-ScheduledTaskTrigger -AtStartup
$p=New-ScheduledTaskPrincipal -UserId $DashboardAccount -LogonType S4U -RunLevel Highest
$s=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task=New-ScheduledTask -Action $a -Trigger $t -Principal $p -Settings $s
${variation}
Test-DashboardTaskConfig $task`);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim() === 'True';
}
function issues(variation: string) {
  const result = ps(`${dot}
$a=New-ScheduledTaskAction -Execute $DashboardNode -Argument $DashboardActionArguments -WorkingDirectory $DashboardRoot
$t=New-ScheduledTaskTrigger -AtStartup
$p=New-ScheduledTaskPrincipal -UserId $DashboardAccount -LogonType S4U -RunLevel Highest
$s=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task=New-ScheduledTask -Action $a -Trigger $t -Principal $p -Settings $s
${variation}
@(Get-DashboardTaskConfigIssues $task) -join ','`);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe.skipIf(process.platform !== 'win32')('dashboard Scheduled Task preflight (no registration)', () => {
  it('accepts only the pinned AtStartup S4U Highest configuration', () => expect(config()).toBe(true));
  it.each([
    "$task.Principal.UserId = 'workspace'",
    '$task.Principal.UserId = $DashboardAccount',
    '$task.Principal.UserId = ([Security.Principal.NTAccount]::new($DashboardAccount)).Translate([Security.Principal.SecurityIdentifier]).Value',
  ])('accepts same workspace SID regardless of account representation: %s', variation => expect(config(variation)).toBe(true));
  it('accepts HighestAvailable XML representation and equivalent ISO durations', () => {
    expect(config("$task.Principal = [pscustomobject]@{ UserId=$DashboardAccount; LogonType='S4U'; RunLevel='HighestAvailable' }; $task.Settings.ExecutionTimeLimit = 'PT00H00M00S'; $task.Settings.RestartInterval = 'PT60S'")).toBe(true);
  });
  it.each([
    ["$task.Principal.UserId = 'S-1-5-18'", 'Principal.UserId'],
    ["$task.Principal.UserId = 'OTHER\\workspace'", 'Principal.UserId'],
    ["$task.Principal.LogonType = 'Password'", 'Principal.LogonType'],
    ["$task = [pscustomobject]@{ TaskName='AI-Workspace-Dashboard'; Actions=$task.Actions; Triggers=$task.Triggers; Settings=$task.Settings; Principal=[pscustomobject]@{ UserId=$DashboardAccount; LogonType='InteractiveToken'; RunLevel='Highest' } }", 'Principal.LogonType'],
    ["$task.Settings.RestartInterval = 'PT5M'", 'Settings.RestartInterval'],
    ["$task.Settings.ExecutionTimeLimit = 'PT1H'", 'Settings.ExecutionTimeLimit'],
    ["$task.Settings.RestartCount = 4", 'Settings.RestartCount'],
    ["$task.Actions += New-ScheduledTaskAction -Execute 'cmd.exe'", 'Actions.Count'],
    ["$task.Actions[0].Execute = 'cmd.exe'", 'Actions.Execute'],
    ["$task.Actions[0].Arguments = 'other-script.js'", 'Actions.Arguments'],
  ])('fails closed with a safe reason for %s', (variation, reason) => {
    expect(issues(variation)).toContain(reason);
    expect(config(variation)).toBe(false);
  });
  it.each([
    '$task.Actions[0].Execute = "C:\\Windows\\System32\\cmd.exe"',
    '$task.Actions[0].Arguments += " --port 80"',
    '$task.Actions[0].WorkingDirectory = "C:\\work\\other"',
    '$task.Actions += New-ScheduledTaskAction -Execute "cmd.exe"',
    '$task.Triggers = @(New-ScheduledTaskTrigger -AtLogOn)',
    '$task.Principal.LogonType = "Interactive"',
    '$task.Principal.RunLevel = "Limited"',
    '$task.Principal.UserId = "OTHER\\workspace"',
    '$task.Settings.Hidden = $false',
    '$task.Settings.MultipleInstances = "Parallel"',
    '$task.Settings.RestartCount = 2',
    '$task.Settings.RestartInterval = "PT5M"',
    '$task.Settings.ExecutionTimeLimit = "PT1H"',
    '$task.Settings.DisallowStartIfOnBatteries = $true',
    '$task.Settings.StopIfGoingOnBatteries = $true',
    '$task.Settings.RunOnlyIfNetworkAvailable = $true',
    '$task.Settings.Enabled = $false',
  ])('rejects malformed configuration: %s', variation => expect(config(variation)).toBe(false));
  it('rejects launcher arguments before any import or bind', () => {
    const result = spawnSync(process.execPath, [launcher, '--host', '0.0.0.0'], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('rejected');
  });
  it('pins launcher paths and bind without exposing caller arguments or shell commands', () => {
    const source = fs.readFileSync(launcher, 'utf8');
    expect(source).toContain("const root = 'C:\\\\work\\\\codex-with-chatgpt'");
    expect(source).toContain("createDashboard().listen(48766, '127.0.0.1')");
    expect(source).toContain('process.argv.length !== 2');
    expect(source).not.toMatch(/spawn\(|exec\(|eval\(/);
    for (const name of ['install', 'start', 'stop', 'status']) {
      expect(fs.readFileSync(`${scripts}/${name}-ai-workspace-dashboard.ps1`, 'utf8')).toContain('if ($args.Count -ne 0)');
    }
    expect(fs.readFileSync(`${scripts}/stop-ai-workspace-dashboard.ps1`, 'utf8')).not.toMatch(/Stop-Process|AI-Workspace-Gateway|AI-Workspace-Codex-InteractiveWorker/);
  });
  it('parses task, process, port, health and API without printing response bodies', () => {
    const statusScript = fileURLToPath(new URL('../scripts/status-ai-workspace-dashboard.ps1', import.meta.url));
    const run = (pid: number, command: string) => ps(`
function Get-ScheduledTask { $task = New-ScheduledTask -Action (New-ScheduledTaskAction -Execute 'C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node.exe' -Argument '"C:\\work\\codex-with-chatgpt\\scripts\\run-ai-workspace-dashboard.mjs"' -WorkingDirectory 'C:\\work\\codex-with-chatgpt') -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal (New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\\workspace" -LogonType S4U -RunLevel Highest) -Settings (New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries); [pscustomobject]@{ TaskName='AI-Workspace-Dashboard'; State='Running'; Actions=$task.Actions; Triggers=$task.Triggers; Principal=$task.Principal; Settings=$task.Settings } }
function Get-ScheduledTaskInfo { [pscustomobject]@{ LastTaskResult=0 } }
function Get-CimInstance { [pscustomobject]@{ ProcessId=${pid}; ExecutablePath='C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node.exe'; CommandLine='${command}' } }
function Get-NetTCPConnection { [pscustomobject]@{ LocalAddress='127.0.0.1'; OwningProcess=42 } }
function Invoke-WebRequest { param($Uri) [pscustomobject]@{ StatusCode=200; Content='{"ok":true,"service":"ai-workspace-dashboard"}' } }
& '${statusScript.replaceAll("'", "''")}'`);
    const valid = run(42, '"C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node.exe" "C:\\work\\codex-with-chatgpt\\scripts\\run-ai-workspace-dashboard.mjs"');
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout).toContain('Registered: YES');
    expect(valid.stdout).toContain('Config valid: YES');
    expect(valid.stdout).toContain('Mismatch reasons: none');
    expect(valid.stdout).toMatch(/LastTaskResult=(?:unknown|\d+)/);
    expect(valid.stdout).toContain('fixedAction=True');
    expect(valid.stdout).toContain('Process PID: 42');
    expect(valid.stdout).toContain('/api/status : HTTP 200');
    expect(valid.stdout).toContain('Dashboard readiness: True');
    expect(valid.stdout).not.toContain('"service"');
    const malicious = run(42, 'node.exe "C:\\work\\codex-with-chatgpt\\scripts\\run-ai-workspace-dashboard.mjs" --port 80');
    expect(malicious.status, malicious.stderr).toBe(0);
    expect(malicious.stdout).toContain('Dashboard readiness: False');
  });
  it('reports a mismatch reason without hiding task state, listener and health', () => {
    const statusScript = fileURLToPath(new URL('../scripts/status-ai-workspace-dashboard.ps1', import.meta.url));
    const result = ps(`
function Get-ScheduledTask { $task = New-ScheduledTask -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '"C:\\work\\codex-with-chatgpt\\scripts\\run-ai-workspace-dashboard.mjs"' -WorkingDirectory 'C:\\work\\codex-with-chatgpt') -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal (New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\\workspace" -LogonType S4U -RunLevel Highest) -Settings (New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries); [pscustomobject]@{ TaskName='AI-Workspace-Dashboard'; State='Ready'; Actions=$task.Actions; Triggers=$task.Triggers; Principal=$task.Principal; Settings=$task.Settings } }
function Get-ScheduledTaskInfo { [pscustomobject]@{ LastTaskResult=17 } }
function Get-CimInstance { $null }
function Get-NetTCPConnection { $null }
function Invoke-WebRequest { throw 'unavailable' }
& '${statusScript.replaceAll("'", "''")}'`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Registered: YES');
    expect(result.stdout).toContain('Config valid: NO; fixedAction=False');
    expect(result.stdout).toContain('Mismatch reasons: Actions.Execute');
    expect(result.stdout).toMatch(/Ready; LastTaskResult=(?:unknown|\d+)/);
    expect(result.stdout).toContain('listener PID: NONE');
    expect(result.stdout).toContain('/health : HTTP unavailable');
  });
});

describe('dashboard health', () => {
  it('returns only fixed service identity on GET, refusing mutation', async () => {
    const server = createServer(createDashboard(new Collector()));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
      const base = `http://127.0.0.1:${address.port}`;
      expect(await (await fetch(base + '/health')).json()).toEqual({ ok: true, service: 'ai-workspace-dashboard' });
      expect((await fetch(base + '/health', { method: 'POST' })).status).toBe(405);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
