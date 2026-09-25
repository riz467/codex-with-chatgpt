# Read-only, bounded projection. Never prints raw telemetry, task payloads or exception text.
if ($args.Count) { throw 'Arguments are not accepted.' }
$root = 'C:\work\ai-workspace-logs\codex-worker'
$task = Get-ScheduledTask -TaskName 'AI-Workspace-Codex-InteractiveWorker' -ErrorAction SilentlyContinue
Write-Host "Worker task: $(if ($task) { $task.State } else { 'unknown' })"
$beatFile = Join-Path $root 'heartbeat.json'
try {
    $beat = if ((Get-Item -LiteralPath $beatFile -ErrorAction Stop).Length -le 16384) { Get-Content -LiteralPath $beatFile -Raw | ConvertFrom-Json -ErrorAction Stop } else { $null }
    if ($beat.pid -isnot [int] -and $beat.pid -isnot [long] -or $beat.pid -le 0) { throw 'Invalid heartbeat' }
    $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$beat.observed_utc)).TotalSeconds
    Write-Host "Last heartbeat: $(if ($age -ge 0) { "{0:N0}s ago (last known PID $($beat.pid))" -f $age } else { 'unknown' })"
} catch { Write-Host 'Last heartbeat: unknown' }
$file = Join-Path $root 'current-exit.json'
try {
    $item = Get-Item -LiteralPath $file -ErrorAction Stop
    if ($item.Length -gt 4096 -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Invalid evidence file' }
    $exit = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -ErrorAction Stop
    $categories = @('NORMAL_EXIT','UNHANDLED_EXCEPTION','QUEUE_ERROR','HEARTBEAT_ERROR','WORKER_INIT_ERROR','JOB_ERROR','SIGNAL_EXIT','PROCESS_EXIT','UNKNOWN')
    $phases = @('init','heartbeat','idle','queue','job','shutdown','process','wrapper')
    if ($exit.event -ne 'worker_exit' -or $exit.reason_category -notin $categories -or $exit.phase -notin $phases -or
        ($exit.exit_code -isnot [int] -and $exit.exit_code -isnot [long]) -or $exit.exit_code -lt 0 -or $exit.exit_code -gt 255 -or
        $exit.graceful -isnot [bool]) { throw 'Invalid evidence' }
    $timestamp = [DateTimeOffset]::Parse([string]$exit.timestamp).ToUniversalTime().ToString('o')
    Write-Host "Last exit: time=$timestamp code=$($exit.exit_code) category=$($exit.reason_category) phase=$($exit.phase) graceful=$([bool]$exit.graceful)"
    # Use a fixed, category-only summary. Do not print arbitrary JSON strings even if evidence is malformed.
} catch { Write-Host 'Last exit: unknown (missing or invalid evidence)' }
