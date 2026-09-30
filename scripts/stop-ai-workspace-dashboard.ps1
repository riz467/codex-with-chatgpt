# Stop only the verified dashboard Scheduled Task; never kill an unrelated PID.
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { throw 'Arguments are not accepted.' }
. "$PSScriptRoot\ai-workspace-dashboard-task.ps1"

$task = Get-DashboardTaskVerified

if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $DashboardTask -ErrorAction Stop
}

# Stop-ScheduledTask is asynchronous. Do not return until both the task and
# fixed Dashboard listener have quiesced, otherwise an immediate restart can
# race the previous Node process and fail to bind 127.0.0.1:48766.
for ($i = 0; $i -lt 50; $i++) {
    $current = Get-ScheduledTask -TaskName $DashboardTask -ErrorAction Stop
    $listeners = @(
        try {
            Get-NetTCPConnection `
                -LocalPort $DashboardPort `
                -State Listen `
                -ErrorAction Stop |
                Where-Object { $_.LocalAddress -eq $DashboardHost }
        }
        catch {
            @()
        }
    )

    if ($current.State -ne 'Running' -and $listeners.Count -eq 0) {
        Write-Host 'Dashboard task stopped and listener released. No Gateway, Review Bridge or Worker task was touched.'
        return
    }

    Start-Sleep -Milliseconds 200
}

throw "Dashboard stop was requested, but task/listener quiescence was not confirmed within 10 seconds. No process was forcibly terminated."
