# One temporary task, one Codex invocation. Reuses the previous S4U run; never retries production.
$ErrorActionPreference = 'Stop'
$taskName = 'AI-Workspace-Codex-InteractiveToken-Diagnostic'
$logDir = 'C:\work\ai-workspace-logs\codex-interactive-token-diagnostic'
$previous = 'C:\work\ai-workspace-logs\codex-s4u-diagnostic'
$root = 'C:\work\pve-doc'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
$worker = Join-Path $PSScriptRoot 'codex-interactive-token-worker.ps1'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.Name.Split('\')[-1] -ne 'workspace' -or $identity.User.Value -notmatch '-1000$') { throw 'Run as workspace.' }
if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated workspace PowerShell is required; nothing was started.' }
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'Run from the logged-on interactive session.' }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Temporary task already exists; refusing overwrite.' }
if (Test-Path -LiteralPath $logDir) { throw "Diagnostic log already exists; refusing repeat: $logDir" }
foreach ($file in @($pwsh, $worker, (Join-Path $PSScriptRoot 'codex-s4u-diagnostic-worker.ps1'), "$previous\s4u.json", "$previous\s4u.stderr.log", "$previous\s4u.stdout.log")) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing prerequisite: $file" }
}
$old = Get-Content -LiteralPath "$previous\s4u.json" -Raw | ConvertFrom-Json
if ($old.mode -ne 's4u') { throw 'Previous evidence is not S4U.' }
$registered = $false
try {
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -File `"$worker`"" -WorkingDirectory $root
    # Interactive means "run only when user is logged on"; no trigger or stored password.
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    $registered = $true
    $actual = (Get-ScheduledTask -TaskName $taskName).Principal
    if ($actual.LogonType -ne 'Interactive' -or $actual.RunLevel -ne 'Highest') { throw 'Unexpected registered principal; task not started.' }
    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds(30)
    $started = $false
    do {
        Start-Sleep -Seconds 1
        $task = Get-ScheduledTask -TaskName $taskName
        if ($task.State -in @('Running', 'Queued') -or (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime -gt (Get-Date).AddMinutes(-5)) { $started = $true }
        if (-not $started -and (Get-Date) -gt $deadline) { throw 'Task did not start within 30 seconds.' }
    } while (-not $started -or $task.State -in @('Running', 'Queued'))
    $contextFile = Join-Path $logDir 'task-context.json'
    $summaryFile = Join-Path $logDir 'interactive.json'
    if (-not (Test-Path -LiteralPath $contextFile) -or -not (Test-Path -LiteralPath $summaryFile)) {
        throw "Incomplete diagnostic evidence; task result: $((Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult)"
    }
    $context = Get-Content -LiteralPath $contextFile -Raw | ConvertFrom-Json
    $new = Get-Content -LiteralPath $summaryFile -Raw | ConvertFrom-Json
    $newErr = Get-Content -LiteralPath (Join-Path $logDir 'interactive.stderr.log') -Raw -ErrorAction SilentlyContinue
    $oldErr = Get-Content -LiteralPath "$previous\s4u.stderr.log" -Raw
    $newOut = Get-Content -LiteralPath (Join-Path $logDir 'interactive.stdout.log') -Raw -ErrorAction SilentlyContinue
    $oldOut = Get-Content -LiteralPath "$previous\s4u.stdout.log" -Raw
    function Read-Outcome($run, $err, $out, $session, $logon) {
        $checks = [ordered]@{}
        foreach ($name in @('pwd', 'git_status_short', 'agents_md', 'ai_workspace_md')) {
            $pattern = switch ($name) {
                'pwd' { "(?s)-Command '[^']*(?:Get-Location|pwd)[^']*'[^`n]*`n\s+succeeded in" }
                'git_status_short' { "(?s)-Command 'git status --short'[^`n]*`n\s+succeeded in" }
                'agents_md' { "(?s)-Command '[^']*Get-Content[^']*AGENTS\.md[^']*'[^`n]*`n\s+succeeded in" }
                'ai_workspace_md' { "(?s)-Command '[^']*Get-Content[^']*03_services/ai-workspace\.md[^']*'[^`n]*`n\s+succeeded in" }
            }
            $checks[$name] = [bool]($err -match $pattern)
        }
        return [ordered]@{
            session_id = $session; logon_type = $logon; codex_exit = $run.exit_code
            runner_pipe_timeout = [bool]($err -match 'timed out after 15000ms connecting runner pipe-in')
            runner_0xc0000142_in_logs = [bool](($err + $out) -match '(?i)0xc0000142')
            reads = $checks
            stdout_reports_all_reads_succeeded = [bool]($out -match '4件とも読み取りコマンドは成功|4項目とも読み取り.*成功') -and -not [bool]($out -match '成功していません')
        }
    }
    $a = Read-Outcome $new $newErr $newOut $context.session_id $context.task_principal.LogonType
    $b = Read-Outcome $old $oldErr $oldOut $null 'S4U (previous task principal; SessionId not recorded)'
    $result = [ordered]@{
        interactive_token = $a
        s4u_previous = $b
        task_context = $context
        codex_start_utc = $new.start
        classification = if ($new.error -or $a.codex_exit -ne 0 -or $a.runner_pipe_timeout -or -not $a.stdout_reports_all_reads_succeeded -or -not ($a.reads.Values -notcontains $false)) { 'InteractiveToken failed or incomplete: investigate Task Scheduler/nonstandard launch.' } elseif ($b.runner_pipe_timeout) { 'InteractiveToken succeeded / S4U failed: S4U/Batch/Session 0 context strongly implicated (not proven individually).' } else { 'Both succeeded: investigate conditions specific to earlier S4U run.' }
        note = '0xc0000142 is only marked observed if present in captured logs; Codex exit 0 does not establish runner success. Prior S4U SessionId was not recorded. No S4U re-execution.'
    }
    $result | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath (Join-Path $logDir 'comparison.json') -Encoding utf8
    Write-Host "Evidence: $logDir"
} finally {
    if ($registered) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
}
