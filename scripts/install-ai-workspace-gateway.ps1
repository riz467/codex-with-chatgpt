# Run elevated, from the workspace account. Does not stop existing foreground processes.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\ai-workspace-gateway.ps1"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Elevated Administrator PowerShell is required to register an AtStartup task.'
}
if ($identity.Name.Split('\')[-1] -ne $GatewayAccount) {
    throw "Run elevated as $GatewayAccount so the existing user profile and auth store are retained."
}
if (Get-ScheduledTask -TaskName $GatewayTask -ErrorAction SilentlyContinue) {
    throw "Task $GatewayTask already exists; inspect it before changing registration."
}
foreach ($file in @($GatewayNode, $GatewayTunnel, $GatewayConfig, "$GatewayRoot\dist\cli\index.js")) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing: $file" }
}
$action = New-ScheduledTaskAction -Execute $GatewayNode -Argument '"C:\work\codex-with-chatgpt\scripts\run-ai-workspace-gateway.mjs"' -WorkingDirectory $GatewayRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $GatewayTask -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings | Out-Null
Write-Host "Registered $GatewayTask (AtStartup, $($identity.Name), S4U). No processes were stopped or started."
