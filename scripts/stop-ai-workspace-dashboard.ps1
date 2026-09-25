# Stop only the verified dashboard Scheduled Task; never kill an unrelated PID.
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { throw 'Arguments are not accepted.' }
. "$PSScriptRoot\ai-workspace-dashboard-task.ps1"
$task = Get-DashboardTaskVerified
if ($task.State -ne 'Running') { Write-Host 'Dashboard task is not running; unchanged.'; return }
Stop-ScheduledTask -TaskName $DashboardTask -ErrorAction Stop
Write-Host 'Dashboard task stop requested. No Gateway, Review Bridge or Worker task was touched.'
