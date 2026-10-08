#requires -Version 7.5
param([Parameter(Mandatory)][string]$NodeExecutable)
$ErrorActionPreference = 'Stop'
if (!$IsLinux) { throw 'LINUX_FIXTURE_REQUIRED' }
$psi = [Diagnostics.ProcessStartInfo]::new($NodeExecutable)
$psi.UseShellExecute = $false
$psi.ArgumentList.Add((Join-Path $PSScriptRoot 'linux-process-tree.mjs'))
$child = [Diagnostics.Process]::Start($psi)
try { $child.WaitForExit(); exit $child.ExitCode }
finally { $child.Dispose() }
