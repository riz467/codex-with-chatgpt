# Fixed, read-only OS observation for the Dashboard. No input arguments or process/task mutations.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($args.Count) { throw 'Arguments are not accepted.' }
. "$PSScriptRoot\ai-workspace-gateway.ps1"
. "$PSScriptRoot\ai-workspace-dashboard-task.ps1"
. "$PSScriptRoot\codex-worker-task-config.ps1"
. "$PSScriptRoot\workspace-interactive-session.ps1"
$expectedSid = 'S-1-5-21-1389881484-3427664689-3699660927-1000'
function Item($status, $summary, $processId = $null, $session = $null, $observed = $null) {
    return @{ status = $status; summary = $summary; pid = $processId; session_id = $session; observed_at = $observed }
}
function OwnerSid($process) {
    try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop; if ($owner.ReturnValue -eq 0) { return $owner.Sid } } catch {}
    return $null
}
function Observe-Tunnel {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop)
    $candidate = @($all | Where-Object { $_.ExecutablePath -ieq $GatewayTunnel })
    $matched = @($candidate | Where-Object { $_.CommandLine -and $_.CommandLine -like "*--config*$GatewayConfig*tunnel run ai-workspace-mcp*" })
    if ($matched.Count -eq 1) { return Item 'verified' '固定トンネルのプロセスを確認' ([int]$matched[0].ProcessId) }
    # Match the existing gateway status model when CIM redacts both path and command line.
    $unreadable = @($all | Where-Object { -not $_.ExecutablePath -and -not $_.CommandLine })
    if ($all.Count -eq 1 -and (($candidate.Count -eq 1 -and -not $candidate[0].CommandLine) -or $unreadable.Count -eq 1)) {
        return Item 'degraded' 'プロセスを確認、実行ファイルと起動設定は未確認' ([int]$all[0].ProcessId)
    }
    if ($all.Count -eq 0) { return Item 'unavailable' 'プロセスが見つかりません' }
    return Item 'unknown' '固定トンネルの同一性を確認できません'
}
function Observe-Worker($beatInput = $null, $now = [DateTimeOffset]::UtcNow) {
    $unknown = Item 'unknown' 'プロセス・タスク・対話セッションの照合が未完了'
    $sessionUnknown = Item 'unknown' '対話セッションを確認できません'
    try {
        $account = "$env:COMPUTERNAME\workspace"
        if (([Security.Principal.NTAccount]::new($account)).Translate([Security.Principal.SecurityIdentifier]).Value -cne $expectedSid) { return @{ worker = $unknown; session = $sessionUnknown } }
        $sessions = @(Get-WorkspaceInteractiveSessions | Where-Object { $_.User -ieq $account -and $_.SessionId -gt 0 -and $_.State -in @('Active','Disconnected') })
        $task = Get-ScheduledTask -TaskName 'AI-Workspace-Codex-InteractiveWorker' -ErrorAction Stop
        if (-not (Test-CodexWorkerTaskConfig -Task $task -Root $GatewayRoot -ScriptRoot $PSScriptRoot) -or $task.State -ne 'Running') { return @{ worker = $unknown; session = $sessionUnknown } }
        if ($null -eq $beatInput) {
            $beatFile = 'C:\work\ai-workspace-logs\codex-worker\heartbeat.json'
            if (-not (Test-DashboardFixedFile $beatFile) -or (Get-Item -LiteralPath $beatFile).Length -gt 16384) { return @{ worker = $unknown; session = $sessionUnknown } }
            $beat = Get-Content -LiteralPath $beatFile -Raw | ConvertFrom-Json -ErrorAction Stop
        } else { $beat = $beatInput }
        if ($beat.pid -isnot [int] -and $beat.pid -isnot [long]) { return @{ worker = $unknown; session = $sessionUnknown } }
        if ($beat.pid -le 0 -or $beat.session_id -le 0 -or $beat.session_id -isnot [int] -and $beat.session_id -isnot [long]) { return @{ worker = $unknown; session = $sessionUnknown } }
        $time = [DateTimeOffset]::Parse([string]$beat.observed_utc)
        $age = ($now - $time).TotalSeconds
        if ($age -lt 0 -or $age -ge 10) { return @{ worker = $unknown; session = $sessionUnknown } }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$beat.pid)" -ErrorAction Stop
        $session = @($sessions | Where-Object SessionId -EQ $beat.session_id)
        if (-not $process -or $process.ProcessId -ne $beat.pid -or $session.Count -ne 1 -or $process.SessionId -ne $beat.session_id -or
            $process.Name -ne 'node.exe' -or $process.ExecutablePath -ine $GatewayNode -or
            $process.CommandLine -notmatch ('^\s*"?' + [regex]::Escape($GatewayNode) + '"?\s+"?' + [regex]::Escape("$GatewayRoot\dist\worker\cli.js") + '"?\s+worker\s*$') -or
            (OwnerSid $process) -cne $expectedSid) { return @{ worker = $unknown; session = $sessionUnknown } }
        return @{ worker = (Item 'ready' 'タスク・プロセス・対話セッションを確認' ([int]$beat.pid) ([int]$beat.session_id) $time.UtcDateTime.ToString('o'));
            session = (Item 'verified' 'ワーカーと一致する対話セッションを確認' $null ([int]$beat.session_id) $time.UtcDateTime.ToString('o')) }
    } catch { return @{ worker = $unknown; session = $sessionUnknown } }
}
function Observe-Dashboard {
    try {
        $task = Get-ScheduledTask -TaskName $DashboardTask -ErrorAction Stop
        if (-not (Test-DashboardTaskConfig $task) -or $task.State -ne 'Running') { return Item 'unknown' 'Dashboardタスクの設定を確認できません' }
        $listeners = @(Get-NetTCPConnection -LocalPort $DashboardPort -State Listen -ErrorAction Stop | Where-Object LocalAddress -EQ $DashboardHost)
        if ($listeners.Count -ne 1) { return Item 'unknown' '固定listenerを確認できません' }
        $pidValue = [int]$listeners[0].OwningProcess
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction Stop
        if (-not $process -or $process.ProcessId -ne $pidValue -or $process.ExecutablePath -ine $DashboardNode -or
            $process.CommandLine -notmatch ('^\s*"?' + [regex]::Escape($DashboardNode) + '"?\s+"?' + [regex]::Escape($DashboardLauncher) + '"?\s*$') -or
            (OwnerSid $process) -cne $expectedSid) { return Item 'unknown' 'Dashboardプロセスを確認できません' }
        # Never request /api/status here: the collector calls this script while serving it.
        return Item 'verified' '固定タスク・プロセス・listenerを確認' $pidValue
    } catch { return Item 'unknown' 'Dashboardの同一性を確認できません' }
}
if ($MyInvocation.InvocationName -ne '.') {
    $tunnel = try { Observe-Tunnel } catch { Item 'unknown' 'トンネルの観測に失敗' }
    $worker = Observe-Worker
    $dashboard = Observe-Dashboard
    @{ tunnel = $tunnel; codex_worker = $worker.worker; interactive_session = $worker.session; dashboard = $dashboard } | ConvertTo-Json -Compress -Depth 4
}
