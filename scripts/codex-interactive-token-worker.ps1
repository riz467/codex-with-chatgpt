# Runs exclusively inside the temporary InteractiveToken scheduled task.
$ErrorActionPreference = 'Stop'
$logDir = 'C:\work\ai-workspace-logs\codex-interactive-token-diagnostic'
$result = Join-Path $logDir 'task-context.json'
if (Test-Path -LiteralPath $result) { throw 'Task already ran; refusing repeat.' }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$groups = @(& whoami.exe /groups /fo csv | ForEach-Object { "$_" })
$principal = (Get-ScheduledTask -TaskName 'AI-Workspace-Codex-InteractiveToken-Diagnostic' -ErrorAction Stop).Principal
$context = [ordered]@{
    observed_utc = (Get-Date).ToUniversalTime().ToString('o')
    identity = $identity.Name
    sid = $identity.User.Value
    session_id = (Get-Process -Id $PID).SessionId
    logon_type_inferred = if ($groups -match ',"S-1-5-3",') { 'Batch' } elseif ($groups -match ',"S-1-5-4",') { 'Interactive' } else { 'Unknown' }
    task_principal = [ordered]@{ UserId = $principal.UserId; LogonType = "$($principal.LogonType)"; RunLevel = "$($principal.RunLevel)" }
    current_directory = (Get-Location).Path
}
$context | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $result -Encoding utf8 -NoNewline
if ($identity.Name.Split('\')[-1] -ne 'workspace' -or $identity.User.Value -notmatch '-1000$' -or
    $context.session_id -eq 0 -or $context.logon_type_inferred -ne 'Interactive' -or
    $context.task_principal.LogonType -ne 'Interactive' -or $context.current_directory -ne 'C:\work\pve-doc') {
    throw 'Unexpected task identity/session/principal/directory: Codex was not started.'
}
& (Join-Path $PSScriptRoot 'codex-s4u-diagnostic-worker.ps1') -Mode interactive -LogDir $logDir
