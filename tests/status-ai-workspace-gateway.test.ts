import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const statusScript = fileURLToPath(new URL('../scripts/status-ai-workspace-gateway.ps1', import.meta.url));

function statusWithCloudflared(present: boolean, commandLine: string | null): string {
  const script = `
function Get-ScheduledTask { $null }
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
  });
});
