import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const config = fileURLToPath(new URL('../scripts/codex-worker-task-config.ps1', import.meta.url));
const scripts = fileURLToPath(new URL('../scripts', import.meta.url));

function check(variation: string, scriptRoot = scripts): boolean {
  const script = `
. '${config.replaceAll("'", "''")}'
$root = 'C:\\work\\codex-with-chatgpt'
$task = [pscustomobject]@{
  Settings = [pscustomobject]@{ Enabled = $true; MultipleInstances = 'IgnoreNew'; RestartCount = 3; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S' }
  Principal = [pscustomobject]@{ UserId = 'workspace'; LogonType = 'Interactive'; RunLevel = 'Highest' }
  Triggers = @([pscustomobject]@{ UserId = 'workspace'; CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' } })
  Actions = @([pscustomobject]@{ Execute = "$env:SystemRoot\\System32\\wscript.exe"; Arguments = '//B //Nologo "C:\\work\\codex-with-chatgpt\\scripts\\launch-codex-interactive-worker.vbs"'; WorkingDirectory = $root })
}
$scriptDir = '${scriptRoot.replaceAll("'", "''")}'
$task.Actions[0].Arguments = '//B //Nologo "' + (Join-Path $scriptDir 'launch-codex-interactive-worker.vbs') + '"'
${variation}
Test-CodexWorkerTaskConfig -Task $task -Root $root -ScriptRoot $scriptDir
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim() === 'True';
}

describe.skipIf(process.platform !== 'win32')('autologon preflight pinned worker task', () => {
  it('accepts the installed windowless WScript/VBS to hidden PowerShell chain', () => {
    expect(check('')).toBe(true);
  });

  it.each([
    "$task.Actions[0].Execute = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'",
    "$task.Actions[0].Arguments = '-NoProfile -NonInteractive -File start-codex-interactive-worker.ps1'",
    "$task.Actions += [pscustomobject]@{ Execute = 'cmd.exe'; Arguments = '/c whoami' }",
    "$task.Actions[0].Arguments += ' arbitrary-command'",
    "$task.Actions[0].WorkingDirectory = 'C:\\work\\other'",
    "$task.Principal.LogonType = 'S4U'",
    "$task.Principal.RunLevel = 'Limited'",
    "$task.Triggers[0].CimClass.CimClassName = 'MSFT_TaskBootTrigger'",
    "$task.Settings.MultipleInstances = 'Parallel'",
    '$task.Settings.RestartCount = 0',
    '$task.Settings.RestartCount = 2',
    "$task.Settings.RestartInterval = 'PT5M'",
    "$task.Settings.ExecutionTimeLimit = 'PT1H'",
  ])('rejects non-pinned task settings: %s', (variation) => {
    expect(check(variation)).toBe(false);
  });

  it('rejects a modified VBS or missing fixed worker entrypoint', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-preflight-'));
    try {
      const vbs = path.join(dir, 'launch-codex-interactive-worker.vbs');
      const entrypoint = path.join(dir, 'start-codex-interactive-worker.ps1');
      fs.copyFileSync(path.join(scripts, 'launch-codex-interactive-worker.vbs'), vbs);
      fs.copyFileSync(path.join(scripts, 'start-codex-interactive-worker.ps1'), entrypoint);
      expect(check('', dir)).toBe(true);
      fs.appendFileSync(vbs, '\nCreateObject("WScript.Shell").Run "cmd.exe"\n');
      expect(check('', dir)).toBe(false);
      fs.copyFileSync(path.join(scripts, 'launch-codex-interactive-worker.vbs'), vbs);
      fs.unlinkSync(entrypoint);
      expect(check('', dir)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
