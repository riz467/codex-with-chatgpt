import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const statusScript = fileURLToPath(new URL('../scripts/status-ai-workspace-gateway.ps1', import.meta.url));

function statusWithCloudflared(present: boolean, commandLine: string | null): string {
  const script = `
function Get-ScheduledTask { $null }
function Get-WorkspaceInteractiveSessions { [pscustomobject]@{ SessionId = 2; User = 'AI-WORKSPACE-W\\workspace'; State = 'Disconnected' } }
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($Filter -and ${present ? '$true' : '$false'}) {
        [pscustomobject]@{
            ProcessId = 13800
            Name = 'cloudflared.exe'
            ExecutablePath = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
            CommandLine = ${commandLine === null ? '$null' : `'${commandLine}'`}
        }
    }
}
function Get-Process {
    if (${present ? '$true' : '$false'}) {
        [pscustomobject]@{ Id = 13800; Path = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe' }
    }
}
function Get-NetTCPConnection { $null }
function Invoke-WebRequest {
    param($Uri)
    [pscustomobject]@{ StatusCode = $(if ($Uri -like '*/mcp') { 401 } else { 200 }) }
}
& '${statusScript.replaceAll("'", "''")}'
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('health=200 unauthenticated-mcp=401');
  return result.stdout;
}

describe.skipIf(process.platform !== 'win32')('gateway status tunnel detection', () => {
  it('reports a matching cloudflared command as present with its PID', () => {
    const output = statusWithCloudflared(true, 'cloudflared.exe --config config.yml tunnel run ai-workspace-mcp');
    expect(output).toContain('Tunnel process: present (PID: 13800);');
  });

  it('reports a running cloudflared with inaccessible command line as present', () => {
    const output = statusWithCloudflared(true, null);
    expect(output).toContain('Tunnel process: present (PID: 13800, commandline unavailable);');
    expect(output).toContain('cloudflared.exe');
  });

  it('reports absent when cloudflared is not running', () => {
    const output = statusWithCloudflared(false, null);
    expect(output).toContain('Tunnel process: absent;');
    expect(output).toContain('Workspace interactive session exists: True; sessions: SessionId=2 state=Disconnected');
    expect(output).toContain('Worker ready for Codex execution: False');
    expect(output).toContain('Gateway (S4U host): listenerPID=NONE, processVerified=unavailable, localHealth=200');
    expect(output).toContain('Review Bridge (S4U host): listenerPID=NONE, processVerified=unavailable, localHealth=200');
  });
});

describe.skipIf(process.platform !== 'win32')('interactive worker readiness', () => {
  function statusWithWorker(alive: boolean): string {
    const script = `
function Get-ScheduledTask {
    param($TaskName)
    if ($TaskName -ne 'AI-Workspace-Codex-InteractiveWorker') { return $null }
    [pscustomobject]@{
        State = 'Ready'; Settings = [pscustomobject]@{ Enabled = $true }
        Principal = [pscustomobject]@{ UserId = 'workspace'; LogonType = 'Interactive'; RunLevel = 'Highest' }
        Triggers = @([pscustomobject]@{ UserId = 'workspace'; CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' } })
        Actions = @([pscustomobject]@{ Execute = "$env:SystemRoot\\System32\\wscript.exe"; Arguments = '//B //Nologo "C:\\work\\codex-with-chatgpt\\scripts\\launch-codex-interactive-worker.vbs"'; WorkingDirectory = 'C:\\work\\codex-with-chatgpt' })
    }
}
function Get-ScheduledTaskInfo { [pscustomobject]@{ LastTaskResult = 3221225786 } }
function Get-WorkspaceInteractiveSessions { [pscustomobject]@{ SessionId = 2; User = "$env:COMPUTERNAME\\workspace"; State = 'Disconnected' } }
function Test-Path { param($LiteralPath) return ($LiteralPath -like '*heartbeat.json') }
function Get-Content { param($LiteralPath) '{"pid":12345,"session_id":2,"observed_utc":"' + [DateTime]::UtcNow.ToString('o') + '"}' }
function Get-Process { param($Id) if (${alive ? '$true' : '$false'} -and $Id -eq 12345) { [pscustomobject]@{ Id = 12345; SessionId = 2 } } }
function Get-CimInstance {
    param($ClassName, $Filter)
    if (${alive ? '$true' : '$false'} -and $Filter -eq 'ProcessId=12345') {
        [pscustomobject]@{ ExecutablePath = 'C:\\Users\\workspace\\AppData\\Local\\Author Software\\nvm\\installs\\v24.16.0\\node.exe'; CommandLine = 'node C:\\work\\codex-with-chatgpt\\dist\\worker\\cli.js worker' }
    }
}
function Get-NetTCPConnection { $null }
function Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }
& '${statusScript.replaceAll("'", "''")}'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  it('uses the live worker instead of a historical task failure', () => {
    const output = statusWithWorker(true);
    expect(output).toContain('taskResult=3221225786, PID=12345, SessionId=2');
    expect(output).toContain('Worker ready for Codex execution: True');
  });

  it('fails closed when the heartbeat PID has no matching process', () => {
    expect(statusWithWorker(false)).toContain('Worker ready for Codex execution: False');
  });
});
