# Read-only status: do not print API bodies, logs, credentials or command lines.
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { throw 'Arguments are not accepted.' }
. "$PSScriptRoot\ai-workspace-dashboard-task.ps1"
$status = Get-DashboardObservation
Write-Host "Registered: $($status.Registered)"
Write-Host "Config valid: $(if ($status.ConfigValid) { 'YES' } else { 'NO' }); fixedAction=$($status.ActionFixed)"
Write-Host "Mismatch reasons: $(if ($status.MismatchReasons.Count) { $status.MismatchReasons -join ', ' } else { 'none' })"
Write-Host "Task $DashboardTask : $($status.TaskState); LastTaskResult=$($status.LastTaskResult)"
Write-Host "Process PID: $(if ($null -ne $status.ProcessPID) { $status.ProcessPID } else { 'unknown' })"
Write-Host "${DashboardHost}:${DashboardPort} listener PID: $(if ($null -ne $status.ListenerPID) { $status.ListenerPID } else { 'NONE' })"
Write-Host "GET http://${DashboardHost}:${DashboardPort}/health : HTTP $($status.HealthHTTP); identity=$($status.HealthIdentity)"
Write-Host "GET http://${DashboardHost}:${DashboardPort}/api/status : HTTP $($status.ApiStatusHTTP)"
Write-Host "Dashboard readiness: $($status.Ready)"
