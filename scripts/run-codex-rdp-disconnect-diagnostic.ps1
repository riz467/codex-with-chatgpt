# Fixed one-shot diagnostic only. No caller-provided repo, task ID, command or prompt.
param([switch] $Start, [switch] $Status, [switch] $Review)
$ErrorActionPreference = 'Stop'
if (@($Start, $Status, $Review).Where({ $_ }).Count -gt 1) { throw 'Choose -Start, -Status or -Review.' }
$node = 'C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node.exe'
$cli = 'C:\work\codex-with-chatgpt\dist\worker\cli.js'
$logDir = 'C:\work\ai-workspace-logs\codex-rdp-disconnect-diagnostic'

if ($Start) {
    . "$PSScriptRoot\codex-interactive-logon.ps1"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $session = (Get-Process -Id $PID).SessionId
    $groups = @($identity.Groups | ForEach-Object { $_.Value })
    $interactive = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.SecurityIdentifier]::new('S-1-5-4'))
    if (-not (Test-CodexInteractiveLogon -UserSid $identity.User.Value -UserName $identity.Name -SessionId $session -GroupSids $groups -InteractiveRoleEnabled $interactive)) {
        throw 'Start only from the workspace interactive session.'
    }
    $beat = Get-Content -LiteralPath 'C:\work\ai-workspace-logs\codex-worker\heartbeat.json' -Raw | ConvertFrom-Json
    if ($beat.session_id -ne $session) { throw 'Worker belongs to a different interactive session.' }
}

if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Build the worker before running the diagnostic.' }
$mode = if ($Start) { 'rdp-start' } elseif ($Review) { 'rdp-review' } else { 'rdp-status' }
$raw = & $node $cli $mode
if ($LASTEXITCODE -ne 0) { throw "Fixed RDP diagnostic $mode failed; do not retry a reserved request." }
$raw | ConvertFrom-Json -Depth 12 | ConvertTo-Json -Depth 12
if ($Start) {
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path -LiteralPath (Join-Path $logDir 'codex-started.json'))) {
        if ((Get-Date) -ge $deadline) { throw "Codex did not start in 30 seconds. Inspect $logDir; do not start again." }
        Start-Sleep -Seconds 1
    }
    Write-Host "Codex started. Close the RDP window without logging off NOW; reconnect after 10-12 minutes. Run this script with -Status. Evidence: $logDir"
}
