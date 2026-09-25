# A one-shot temporary task only. Never starts or modifies the production task or Gateway.
param([switch]$S4UOnly, [switch]$InteractiveOnly)
$ErrorActionPreference = 'Stop'
if ($S4UOnly -and $InteractiveOnly) { throw 'Choose one mode.' }
$taskName = 'AI-Workspace-Codex-Profile-Diagnostic'
$root = 'C:\work\pve-doc'
$logDir = 'C:\work\ai-workspace-logs\codex-s4u-profile-diagnostic'
$observer = Join-Path $PSScriptRoot 'codex-s4u-profile-observe.ps1'
$worker = Join-Path $PSScriptRoot 'codex-s4u-diagnostic-worker.ps1'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.Name.Split('\')[-1] -ne 'workspace' -or $identity.User.Value -notmatch '-1000$') { throw 'Run as workspace (SID ending -1000).' }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "$taskName already exists; refusing to overwrite it." }
if (-not $InteractiveOnly -and -not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Elevated workspace PowerShell required for the temporary S4U task.'
}
foreach ($path in @($root, $observer, $worker, $pwsh)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing: $path" } }
$interactive = Join-Path $logDir 'interactive.profile.json'
$s4u = Join-Path $logDir 's4u.profile.json'
if (-not $S4UOnly) {
    if (Test-Path -LiteralPath $interactive) { throw 'Interactive evidence already exists.' }
    Push-Location $root
    try { & $pwsh -NoProfile -File $observer -Mode interactive; if ($LASTEXITCODE -ne 0) { throw "Observer failed: $LASTEXITCODE" } }
    finally { Pop-Location }
}
if ($InteractiveOnly) { return }
if (-not (Test-Path -LiteralPath $interactive) -or (Test-Path -LiteralPath $s4u) -or (Test-Path -LiteralPath (Join-Path $logDir 's4u.json'))) {
    throw 'Requires interactive evidence and no prior S4U evidence.'
}
$registered = $false
try {
    # Observe before Codex in the SAME task. Failure in observation prevents Codex launch.
    $command = "& '$observer' -Mode s4u; if (`$LASTEXITCODE -ne 0) { exit 1 }; & '$worker' -Mode s4u -LogDir '$logDir'"
    # PowerShell script errors are terminating inside this wrapper.
    $command = "`$ErrorActionPreference='Stop'; $command"
    $bytes = [Text.Encoding]::Unicode.GetBytes($command)
    $encoded = [Convert]::ToBase64String($bytes)
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -EncodedCommand $encoded" -WorkingDirectory $root
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    $registered = $true
    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds(30)
    $started = $false
    do {
        Start-Sleep -Seconds 1
        $task = Get-ScheduledTask -TaskName $taskName
        if ($task.State -in @('Running', 'Queued') -or (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime -gt (Get-Date).AddMinutes(-5)) { $started = $true }
        if (-not $started -and (Get-Date) -gt $deadline) { throw 'Temporary S4U task did not start.' }
    } while (-not $started -or $task.State -in @('Running', 'Queued'))
    if (-not (Test-Path -LiteralPath $s4u) -or -not (Test-Path -LiteralPath (Join-Path $logDir 's4u.json'))) {
        throw "Incomplete S4U evidence; task result: $((Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult)"
    }
    $a = Get-Content -LiteralPath $interactive -Raw | ConvertFrom-Json
    $b = Get-Content -LiteralPath $s4u -Raw | ConvertFrom-Json
    $run = Get-Content -LiteralPath (Join-Path $logDir 's4u.json') -Raw | ConvertFrom-Json
    $stderr = Get-Content -LiteralPath (Join-Path $logDir 's4u.stderr.log') -Raw -ErrorAction SilentlyContinue
    $match = [regex]::Match($stderr, 'timed out after 15000ms connecting runner pipe-in')
    function Same-Hive($x, $y) {
        if ($x.exit_code -ne 0 -or $y.exit_code -ne 0) { return $false }
        $one = (@($x.output) -join "`n") -replace 'HKEY_CURRENT_USER', 'HIVE'
        $two = (@($y.output) -join "`n") -replace ('HKEY_USERS\\' + [regex]::Escape($a.identity_sid)), 'HIVE'
        return $one -eq $two
    }
    $comparison = [ordered]@{
        interactive = [ordered]@{ sid = $a.identity_sid; hkcu_exit = $a.hkcu.exit_code; hku_exit = $a.hku_workspace.exit_code; hkcu_matches_hku_root = (Same-Hive $a.hkcu $a.hku_workspace); profile = $a.win32_userprofile; session_id = $a.session_id; logon_type = $a.logon_type_inferred }
        s4u = [ordered]@{ sid = $b.identity_sid; hkcu_exit = $b.hkcu.exit_code; hku_exit = $b.hku_workspace.exit_code; hkcu_matches_hku_root = (Same-Hive $b.hkcu $b.hku_workspace); profile = $b.win32_userprofile; session_id = $b.session_id; logon_type = $b.logon_type_inferred }
        differences = [ordered]@{
            same_sid = ($a.identity_sid -eq $b.identity_sid)
            s4u_hku_workspace_present = ($b.hku_workspace.exit_code -eq 0)
            same_profile_loaded = ($null -ne $a.win32_userprofile -and $null -ne $b.win32_userprofile -and $a.win32_userprofile.Loaded -eq $b.win32_userprofile.Loaded)
            same_userprofile_path = ($a.userprofile -eq $b.userprofile)
            same_temp = ($a.temp -eq $b.temp)
            same_tmp = ($a.tmp -eq $b.tmp)
        }
        runner = [ordered]@{ start_utc = $run.start; end_utc = $run.end; observation_utc = $b.observed_utc; elapsed_seconds = ([datetime]$run.end - [datetime]$run.start).TotalSeconds; timeout_15000ms = $match.Success; exit_code = $run.exit_code; error = $run.error }
        note = 'HKCU/HKU root listing equality is corroboration, not proof of identical backing hive. stderr has no timestamp per timeout line.'
    }
    $comparison | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $logDir 'comparison.json') -Encoding utf8
    Write-Host "Evidence: $logDir"
} finally {
    if ($registered) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
}
