# Install an opt-in transport branch in the external engine AFTER the RDP test.
# Does not set AI_CODEX_WORKER_ENABLED or start/stop any production task.
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$engine = 'C:\Users\workspace\.config\opencode\scripts\orchestrate-v03.ps1'
$source = [IO.File]::ReadAllText($engine)
$anchor = '    Save-Json "$prefix.argv.json" $arguments'
if ($source.Contains('AI_CODEX_WORKER_ENABLED')) { throw 'Engine hook already present; refusing repeat.' }
if ($source.Split(@($anchor), [StringSplitOptions]::None).Count -ne 2) { throw 'Unexpected engine version; inspect before installing.' }
$branch = @'

    if ($env:AI_CODEX_WORKER_ENABLED -ceq '1') {
        # Engine still owns the prompt, attempt, ledger, audit, approval and proposal parsing.
        # The adapter accepts only the fixed repo/task/attempt, never a command string.
        $workerResult = & 'C:\work\codex-with-chatgpt\scripts\invoke-codex-interactive.ps1' -Repo $Repo -TaskId $TaskId -Attempt $Attempt
        if (!$workerResult) { throw 'Interactive Codex worker returned no result' }
        Write-Atomic "$prefix.stdout.txt" $workerResult.stdout
        Write-Atomic "$prefix.stderr.txt" $workerResult.stderr
        Write-Atomic "$prefix.exit.txt" "$($workerResult.exit_code)`n"
        return [pscustomobject]@{ exit = $workerResult.exit_code; output = $workerResult.stdout; error = $workerResult.stderr }
    }
'@
if (-not $Apply) { Write-Host 'Preview only. After the RDP test passes, run with -Apply to add the opt-in engine branch. Production remains on direct Codex until AI_CODEX_WORKER_ENABLED=1 is deliberately set on the Gateway task.'; return }
$backup = "$engine.pre-interactive-worker-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
[IO.File]::Copy($engine, $backup, $false)
[IO.File]::WriteAllText($engine, $source.Replace($anchor, $anchor + $branch), [Text.UTF8Encoding]::new($false))
Write-Host "Hook installed; backup: $backup. No production switch performed."
