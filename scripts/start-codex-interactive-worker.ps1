# Fixed InteractiveToken task entrypoint; no caller-supplied executable or arguments.
$ErrorActionPreference = 'Stop'
$started = [DateTimeOffset]::UtcNow
$exitCode = 1
$nodeStarted = $false
$root = 'C:\work\codex-with-chatgpt'
$node = 'C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node.exe'
try {
    . "$PSScriptRoot\codex-interactive-logon.ps1"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $groups = @($identity.Groups | ForEach-Object { $_.Value })
    $interactive = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-4')
    )
    $session = (Get-Process -Id $PID).SessionId
    if (-not (Test-CodexInteractiveLogon -UserSid $identity.User.Value -UserName $identity.Name -SessionId $session -GroupSids $groups -InteractiveRoleEnabled $interactive)) {
        throw 'Interactive workspace logon required; refusing Codex execution.'
    }
    $env:AI_WORKER_SESSION_ID = "$session"
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath "$root\dist\worker\cli.js" -PathType Leaf)) {
        throw 'Pinned worker entrypoint unavailable'
    }
    $nodeStarted = $true
    & $node "$root\dist\worker\cli.js" worker
    if ($null -ne $LASTEXITCODE) { $exitCode = [int]$LASTEXITCODE }
} catch { $exitCode = 1 }
finally {
    try { . "$PSScriptRoot\codex-worker-exit-evidence.ps1"; Write-CodexWorkerFallbackExit -Started $started -ExitCode $exitCode -NodeStarted $nodeStarted }
    catch { # Telemetry cannot mask the original exit status.
    }
}
exit $exitCode
