# Register or explicitly update only the pinned interactive worker task; never touch S4U tasks.
param([switch]$Update)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\ai-workspace-gateway.ps1"
$name = 'AI-Workspace-Codex-InteractiveWorker'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -cne 'S-1-5-21-1389881484-3427664689-3699660927-1000' -or $identity.Name.Split('\')[-1] -cne 'workspace' -or -not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or (Get-Process -Id $PID).SessionId -le 0) { throw 'Run elevated in the workspace interactive logon.' }
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing -and -not $Update) { throw 'Worker task already registered; use -Update after reviewing its action.' }
if (-not $existing -and $Update) { throw 'Worker task not registered; omit -Update to install.' }
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
$wscript = "$env:SystemRoot\System32\wscript.exe"
$launcher = "$PSScriptRoot\launch-codex-interactive-worker.vbs"
$arguments = "//B //Nologo `"$launcher`""
foreach ($file in @($pwsh, $wscript, $GatewayNode, "$GatewayRoot\dist\worker\cli.js", "$PSScriptRoot\start-codex-interactive-worker.ps1", $launcher)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing: $file" }
}
$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $GatewayRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($existing) {
    $oldAction = @($existing.Actions)
    $oldTrigger = @($existing.Triggers)
    $expectedOld = "-NoProfile -NonInteractive -File `"$PSScriptRoot\start-codex-interactive-worker.ps1`""
    if ($oldAction.Count -ne 1 -or $oldAction[0].Execute -ne $pwsh -or $oldAction[0].Arguments -ne $expectedOld -or $oldAction[0].WorkingDirectory -ne $GatewayRoot -or
        $oldTrigger.Count -ne 1 -or $oldTrigger[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or $oldTrigger[0].UserId -ne $identity.Name -or
        $existing.Principal.UserId -notin @($identity.Name, 'workspace') -or $existing.Principal.LogonType -ne 'Interactive' -or $existing.Principal.RunLevel -ne 'Highest' -or
        $existing.Settings.MultipleInstances -ne 'IgnoreNew' -or $existing.Settings.RestartCount -ne 3 -or $existing.Settings.ExecutionTimeLimit -ne 'PT0S') {
        throw 'Existing task differs from the pinned interactive worker configuration; refusing update.'
    }
    if ($existing.State -eq 'Running') { throw 'Stop the old worker task before updating it.' }
    Set-ScheduledTask -TaskName $name -Action $action | Out-Null
    Write-Host "Updated $name to windowless launcher. Start manually for the first test."
    return
}
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host "Registered $name (AtLogOn, InteractiveToken, Highest, windowless). Start manually for the first test."
