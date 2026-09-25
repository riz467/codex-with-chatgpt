# Starts only the pinned dashboard task. Manual foreground launch is documented separately.
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { throw 'Arguments are not accepted.' }
. "$PSScriptRoot\ai-workspace-dashboard-task.ps1"
foreach ($file in @($DashboardNode, $DashboardLauncher, $DashboardServer, "$DashboardRoot\dist\dashboard\public\index.html")) {
    if (-not (Test-DashboardFixedFile $file)) { throw "Missing or reparse-point runtime component: $file" }
}
$task = Get-DashboardTaskVerified
if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $DashboardTask -ErrorAction Stop }
for ($i = 0; $i -lt 15; $i++) {
    $status = Get-DashboardObservation
    if ($status.Ready) { Write-Host "Dashboard ready at http://${DashboardHost}:${DashboardPort}/ (PID $($status.ProcessPID))."; return }
    Start-Sleep -Seconds 1
}
throw "Dashboard is not ready. Run status-ai-workspace-dashboard.ps1; no other task was touched."
