# Run elevated as workspace. Registration only; does not start or alter other tasks.
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { throw 'Arguments are not accepted.' }
. "$PSScriptRoot\ai-workspace-dashboard-task.ps1"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated PowerShell is required.' }
if ($identity.Name -ine $DashboardAccount) { throw "Run elevated as $DashboardAccount; no other user may register this task." }
$existing = Get-ScheduledTask -TaskName $DashboardTask -ErrorAction SilentlyContinue
if ($existing) {
    if (-not (Test-DashboardTaskConfig $existing)) { throw "Existing $DashboardTask has a different configuration; refusing to replace it." }
    Write-Host "$DashboardTask is already registered with the expected configuration; unchanged."
    return
}
foreach ($file in @($DashboardNode, $DashboardLauncher, $DashboardServer, "$DashboardRoot\dist\dashboard\public\index.html")) {
    if (-not (Test-DashboardFixedFile $file)) { throw "Missing or reparse-point runtime component: $file" }
}
$action = New-ScheduledTaskAction -Execute $DashboardNode -Argument $DashboardActionArguments -WorkingDirectory $DashboardRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $DashboardAccount -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$candidate = New-ScheduledTask -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings
if (-not (Test-DashboardTaskConfig $candidate)) { throw 'Generated task configuration failed preflight; nothing registered.' }
Register-ScheduledTask -TaskName $DashboardTask -InputObject $candidate -ErrorAction Stop | Out-Null
if (-not (Test-DashboardTaskConfig (Get-ScheduledTask -TaskName $DashboardTask -ErrorAction Stop))) {
    throw 'Registered dashboard task did not pass post-registration verification; do not start it.'
}
Write-Host "Registered $DashboardTask (AtStartup, S4U, loopback only). It was not started."
