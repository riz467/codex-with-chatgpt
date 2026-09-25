# Read-only to source. Fixed worker-only fallback when the Node process cannot record its own exit.
function Write-CodexWorkerFallbackExit {
    param([DateTimeOffset]$Started, [int]$ExitCode, [bool]$NodeStarted, [string]$EvidenceDir = 'C:\work\ai-workspace-logs\codex-worker')
    try {
        $current = Join-Path $EvidenceDir 'current-exit.json'
        $log = Join-Path $EvidenceDir 'lifecycle.jsonl'
        $old = Join-Path $EvidenceDir 'lifecycle.1.jsonl'
        foreach ($file in @($current, $log, $old)) {
            $part = [IO.Path]::GetPathRoot($file)
            foreach ($name in $file.Substring($part.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
                $part = Join-Path $part $name
                if (Test-Path -LiteralPath $part) {
                    if (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return }
                }
            }
        }
        if (Test-Path -LiteralPath $current -PathType Leaf) {
            try {
                $previous = Get-Content -LiteralPath $current -Raw | ConvertFrom-Json -DateKind String -ErrorAction Stop
                $when = [DateTimeOffset]::Parse([string]$previous.timestamp)
                if ($previous.event -eq 'worker_exit' -and $previous.phase -ne 'wrapper' -and $when -ge $Started -and $when -le [DateTimeOffset]::UtcNow.AddSeconds(5)) { return }
            } catch { # Malformed previous evidence must not prevent recording a new exit.
            }
        }
        $now = [DateTimeOffset]::UtcNow
        $session = (Get-Process -Id $PID -ErrorAction Stop).SessionId
        $entry = [ordered]@{
            timestamp = $now.ToString('o'); pid = $PID; session_id = if ($session -gt 0) { $session } else { $null }
            event = 'worker_exit'; exit_code = $ExitCode
            reason_category = if ($NodeStarted) { 'PROCESS_EXIT' } else { 'WORKER_INIT_ERROR' }
            short_summary = if ($NodeStarted) { 'Node child exit observed by wrapper; reason unknown' } else { 'PowerShell wrapper failed before Node launch' }
            error_name = $null; task_id = $null; phase = 'wrapper'
            uptime_seconds = [math]::Max(0, [int]($now - $Started).TotalSeconds); graceful = $false
        }
        $json = ConvertTo-Json -InputObject $entry -Compress
        if (Test-Path -LiteralPath $log -PathType Leaf) {
            $size = (Get-Item -LiteralPath $log).Length
            if ($size -gt 131072 -or $size + [Text.Encoding]::UTF8.GetByteCount($json) + 1 -gt 131072) {
                [IO.File]::Move($log, $old, $true)
                if ((Get-Item -LiteralPath $old).Length -gt 131072) { $stream = [IO.File]::OpenWrite($old); try { $stream.SetLength(131072) } finally { $stream.Dispose() } }
            }
        }
        [IO.File]::AppendAllText($log, "$json`n", [Text.UTF8Encoding]::new($false))
        $temp = Join-Path $EvidenceDir ("current-exit.$([guid]::NewGuid().ToString('N')).tmp")
        try {
            [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
            [IO.File]::Move($temp, $current, $true)
        } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
    } catch { # Observability never changes the wrapper's exit code.
    }
}
