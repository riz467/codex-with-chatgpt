# One-shot comparison. Does not invoke or modify the production gateway or orchestration task.
param([switch]$S4UOnly)
$ErrorActionPreference = 'Stop'
$taskName = 'AI-Workspace-Codex-Diagnostic'
$root = 'C:\work\pve-doc'
$logDir = 'C:\work\ai-workspace-logs\codex-s4u-diagnostic'
$worker = Join-Path $PSScriptRoot 'codex-s4u-diagnostic-worker.ps1'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()

if ($identity.Name.Split('\')[-1] -ne 'workspace') { throw 'Run as workspace.' }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "$taskName already exists; do not overwrite it." }
$elevated = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) { throw 'Elevated workspace PowerShell is required to register the S4U task; no diagnostic was started.' }
if ($S4UOnly) {
    if (-not (Test-Path -LiteralPath (Join-Path $logDir 'interactive.json')) -or
        (Test-Path -LiteralPath (Join-Path $logDir 's4u.json'))) {
        throw 'S4UOnly requires existing interactive evidence and no S4U evidence.'
    }
} elseif (Test-Path -LiteralPath $logDir) { throw "$logDir already exists; refusing to repeat or overwrite evidence." }
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw "Missing $worker" }
if (-not (Test-Path -LiteralPath $pwsh -PathType Leaf)) { throw "Missing $pwsh" }

if (-not $S4UOnly) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$registered = $false
try {
    # Same fixed worker and working directory for both runs; each mode is started only once.
    if (-not $S4UOnly) {
        Push-Location $root
        try { & $pwsh -NoProfile -File $worker -Mode interactive }
        finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "Interactive worker failed: $LASTEXITCODE" }
    }
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -File `"$worker`" -Mode s4u" -WorkingDirectory $root
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    $registered = $true
    Start-ScheduledTask -TaskName $taskName
    $summary = Join-Path $logDir 's4u.json'
    $started = $false
    $startupDeadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Seconds 1
        $task = Get-ScheduledTask -TaskName $taskName
        if ($task.State -eq 'Running' -or $task.State -eq 'Queued') { $started = $true }
        if (-not $started -and (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime -gt (Get-Date).AddMinutes(-5)) { $started = $true }
        if (-not $started -and (Get-Date) -gt $startupDeadline) { throw 'S4U task did not start within 30 seconds; no Codex timeout was changed.' }
    } while (-not $started -or $task.State -eq 'Running' -or $task.State -eq 'Queued')
    if (-not (Test-Path -LiteralPath $summary)) { throw "S4U worker did not write evidence; Task Scheduler result: $((Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult)" }
    $a = Get-Content -LiteralPath (Join-Path $logDir 'interactive.json') -Raw | ConvertFrom-Json
    $b = Get-Content -LiteralPath $summary -Raw | ConvertFrom-Json
    $diff = [ordered]@{
        interactive_exit = $a.exit_code; s4u_exit = $b.exit_code
        interactive_runner_pipe_timeout = [bool]((Get-Content (Join-Path $logDir 'interactive.stderr.log') -Raw -ErrorAction SilentlyContinue) -match 'timed out after 15000ms connecting runner pipe-in')
        s4u_runner_pipe_timeout = [bool]((Get-Content (Join-Path $logDir 's4u.stderr.log') -Raw -ErrorAction SilentlyContinue) -match 'timed out after 15000ms connecting runner pipe-in')
        interactive_children = $a.process_tree; s4u_children = $b.process_tree
        environment = [ordered]@{ interactive = $a.environment; s4u = $b.environment }
        pipe_names = [ordered]@{ interactive = $a.pipe_names; s4u = $b.pipe_names }
    }
    $diff | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $logDir 'comparison.json') -Encoding utf8
    Write-Host "Evidence: $logDir"
} finally {
    if ($registered) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
}
