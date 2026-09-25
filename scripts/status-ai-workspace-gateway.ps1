. "$PSScriptRoot\ai-workspace-gateway.ps1"
if (-not (Get-Command Get-WorkspaceInteractiveSessions -CommandType Function -ErrorAction SilentlyContinue)) { . "$PSScriptRoot\workspace-interactive-session.ps1" }
$task = Get-ScheduledTask -TaskName $GatewayTask -ErrorAction SilentlyContinue
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $GatewayTask
    Write-Host "Task $GatewayTask : $($task.State), user=$($task.Principal.UserId), logon=$($task.Principal.LogonType), lastResult=$($info.LastTaskResult)"
} else { Write-Host "Task $GatewayTask : NOT REGISTERED" }
$processes = @(Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -eq $GatewayNode -and $_.CommandLine -like '*\dist\cli\index.js serve --workspace *') -or
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -eq $GatewayNode -and $_.CommandLine -like '*run-ai-workspace-gateway.mjs*')
})
$tunnelCim = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue)
$cloudflared = @(Get-Process -Name cloudflared -ErrorAction SilentlyContinue)
$tunnelProcesses = @(
    foreach ($process in $cloudflared) {
        $cim = $tunnelCim | Where-Object ProcessId -EQ $process.Id | Select-Object -First 1
        $path = if ($cim -and $cim.ExecutablePath) { $cim.ExecutablePath } else { try { $process.Path } catch { $null } }
        if ($path -and $path -ne $GatewayTunnel) { continue }
        $commandLine = if ($cim) { $cim.CommandLine } else { $null }
        [pscustomobject]@{
            ProcessId = $process.Id
            Name = 'cloudflared.exe'
            CommandLine = if ($commandLine) { $commandLine } else { 'unavailable' }
            CommandLineAvailable = [bool]$commandLine
            TunnelCommandMatches = [bool]($commandLine -like '*tunnel run ai-workspace-mcp*')
        }
    }
)
@($processes) + @($tunnelProcesses) | Select-Object ProcessId,Name,CommandLine | Format-Table -Wrap
foreach ($port in @(48765,54108)) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    Write-Host "127.0.0.1:$port listener PID: $(if ($listener) { ($listener.OwningProcess -join ',') } else { 'NONE' })"
}
foreach ($base in @('http://127.0.0.1:48765','http://127.0.0.1:54108','https://ai-workspace-mcp.m1n4m0.me','https://ai-orchestration-review.m1n4m0.me')) {
    Write-Host "$base health=$(Get-GatewayResponse "$base/health") unauthenticated-mcp=$(Get-GatewayResponse "$base/mcp")"
}
foreach ($service in @(@('Gateway',48765),@('Review Bridge',54108))) {
    $name, $port = $service
    $listener = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    $running = @($processes | Where-Object { $listener.OwningProcess -contains $_.ProcessId }).Count -gt 0
    Write-Host "$name (S4U host): listenerPID=$(if ($listener) {$listener.OwningProcess -join ','} else {'NONE'}), processVerified=$(if ($running) {'True'} else {'unavailable'}), localHealth=$(Get-GatewayResponse "http://127.0.0.1:$port/health")"
}
$matchedTunnel = @($tunnelProcesses | Where-Object TunnelCommandMatches)
$unavailableTunnel = @($tunnelProcesses | Where-Object { -not $_.CommandLineAvailable })
$tunnelStatus = if ($matchedTunnel.Count) {
    "present (PID: $($matchedTunnel.ProcessId -join ','))"
} elseif ($unavailableTunnel.Count) {
    "present (PID: $($unavailableTunnel.ProcessId -join ','), commandline unavailable)"
} elseif ($cloudflared.Count) {
    'unknown (cloudflared running, expected tunnel command not verified)'
} else {
    'absent'
}
Write-Host "Tunnel process: $tunnelStatus; logs: $GatewayLogDir"
$workerName = 'AI-Workspace-Codex-InteractiveWorker'
$workerTask = Get-ScheduledTask -TaskName $workerName -ErrorAction SilentlyContinue
$workerDir = 'C:\work\ai-workspace-logs\codex-worker'
$heartbeat = Join-Path $workerDir 'heartbeat.json'
$workerInfo = if ($workerTask) { Get-ScheduledTaskInfo -TaskName $workerName } else { $null }
$beat = if (Test-Path -LiteralPath $heartbeat) { try { Get-Content -LiteralPath $heartbeat -Raw | ConvertFrom-Json } catch { $null } } else { $null }
$workerProcess = if ($beat -and "$($beat.pid)" -match '^[1-9][0-9]*$') { Get-Process -Id ([int]$beat.pid) -ErrorAction SilentlyContinue } else { $null }
$sessions = try { @(Get-WorkspaceInteractiveSessions) } catch { Write-Warning "Cannot enumerate interactive sessions: $_"; @() }
$workspaceAccount = "$env:COMPUTERNAME\workspace"
$workspaceSessions = @($sessions | Where-Object { $_.User -ieq $workspaceAccount -and $_.SessionId -gt 0 -and $_.State -in @('Active', 'Disconnected') })
$age = if ($beat) { try { ([DateTime]::UtcNow - ([DateTime]$beat.observed_utc).ToUniversalTime()).TotalSeconds } catch { [double]::PositiveInfinity } } else { [double]::PositiveInfinity }
$workerCim = if ($workerProcess) { Get-CimInstance Win32_Process -Filter "ProcessId=$($beat.pid)" -ErrorAction SilentlyContinue } else { $null }
$sessionMatch = [bool]($beat -and $workerProcess -and $beat.session_id -gt 0 -and @($workspaceSessions | Where-Object SessionId -EQ $beat.session_id | Where-Object { $workerProcess.SessionId -eq $_.SessionId }).Count -gt 0)
$workerBinary = $workerCim -and $workerCim.ExecutablePath -eq $GatewayNode -and $workerCim.CommandLine -like '*\dist\worker\cli.js worker*'
$live = [bool]($workerProcess -and $workerBinary -and $sessionMatch -and $age -ge 0 -and $age -lt 10)
$launcher = "$PSScriptRoot\launch-codex-interactive-worker.vbs"
$taskConfigured = [bool]($workerTask -and $workerTask.Settings.Enabled -and $workerTask.Principal.LogonType -eq 'Interactive' -and
    $workerTask.Principal.RunLevel -eq 'Highest' -and $workerTask.Principal.UserId -in @('workspace', $workspaceAccount) -and
    @($workerTask.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.UserId -in @('workspace', $workspaceAccount) }).Count -gt 0 -and
    @($workerTask.Actions).Count -eq 1 -and
    @($workerTask.Actions | Where-Object { $_.Execute -eq "$env:SystemRoot\System32\wscript.exe" -and $_.Arguments -eq "//B //Nologo `"$launcher`"" -and $_.WorkingDirectory -eq $GatewayRoot }).Count -eq 1)
$ready = $live -and $taskConfigured
$queueDepth = if (Test-Path -LiteralPath (Join-Path $workerDir 'requests')) {
    @((Get-ChildItem -LiteralPath (Join-Path $workerDir 'requests') -Filter '*.json' -File) | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $workerDir "results\$($_.Name)"))
    }).Count
} else { 0 }
$latest = if (Test-Path -LiteralPath (Join-Path $workerDir 'results')) { Get-ChildItem -LiteralPath (Join-Path $workerDir 'results') -Filter '*.json' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 } else { $null }
$lastResult = if ($latest) { try { Get-Content -LiteralPath $latest.FullName -Raw | ConvertFrom-Json } catch { $null } } else { $null }
Write-Host "Interactive worker: task=$(if ($workerTask) {$workerTask.State} else {'NOT REGISTERED'}), logon=$(if ($workerTask) {$workerTask.Principal.LogonType} else {'N/A'}), logonState=$(if ($live) {'interactive session alive (RDP connection not inferred)'} else {'not confirmed'}), taskResult=$(if ($workerInfo) {$workerInfo.LastTaskResult} else {'N/A'}), PID=$(if ($live) {$beat.pid} else {'NONE'}), SessionId=$(if ($live) {$beat.session_id} else {'NONE'}), queueDepth=$queueDepth"
Write-Host "Interactive worker last result: $(if ($lastResult) {"task=$($lastResult.task_id), exit=$($lastResult.exit_code), session=$($lastResult.session_id), completed=$($lastResult.completed_utc)"} else {'NONE'})"
Write-Host "Workspace interactive session exists: $($workspaceSessions.Count -gt 0); sessions: $(if ($workspaceSessions.Count) { ($workspaceSessions | ForEach-Object { "SessionId=$($_.SessionId) state=$($_.State)" }) -join '; ' } else { 'NONE' })"
Write-Host "Codex worker heartbeat: $(if ($beat) { "PID=$($beat.pid) SessionId=$($beat.session_id) observed=$($beat.observed_utc) ageSeconds=$([math]::Round($age, 1))" } else { 'NONE' }); processVerified=$([bool]$workerBinary); taskConfigured=$taskConfigured"
Write-Host "Worker ready for Codex execution: $([bool]$ready) (requires matching interactive session, worker process, fresh heartbeat and pinned task)"
