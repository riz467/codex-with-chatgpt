$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\ai-workspace-gateway.ps1"
$task = Get-ScheduledTask -TaskName $GatewayTask -ErrorAction Stop
if ($task.State -eq 'Running') { Write-Host 'Gateway task is already running.'; return }
Start-ScheduledTask -TaskName $GatewayTask
Write-Host 'Gateway task start requested; run status-ai-workspace-gateway.ps1 to verify both routes.'
