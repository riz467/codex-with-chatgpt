. "$PSScriptRoot\ai-workspace-gateway.ps1"
$task = Get-ScheduledTask -TaskName $GatewayTask -ErrorAction SilentlyContinue
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $GatewayTask
    Write-Host "Task $GatewayTask : $($task.State), user=$($task.Principal.UserId), logon=$($task.Principal.LogonType), lastResult=$($info.LastTaskResult)"
} else { Write-Host "Task $GatewayTask : NOT REGISTERED" }
$processes = @(Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -eq $GatewayNode -and $_.CommandLine -like '*\dist\cli\index.js serve --workspace *') -or
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -eq $GatewayNode -and $_.CommandLine -like '*run-ai-workspace-gateway.mjs*')
})
$tunnelCim = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue)
$cloudflared = @(Get-Process -Name cloudflared -ErrorAction SilentlyContinue)
$tunnelProcesses = @(
    foreach ($process in $cloudflared) {
        $cim = $tunnelCim | Where-Object ProcessId -EQ $process.Id | Select-Object -First 1
        $path = if ($cim -and $cim.ExecutablePath) { $cim.ExecutablePath } else { try { $process.Path } catch { $null } }
        if ($path -and $path -ne $GatewayTunnel) { continue }
        $commandLine = if ($cim) { $cim.CommandLine } else { $null }
        [pscustomobject]@{
            ProcessId = $process.Id
            Name = 'cloudflared.exe'
            CommandLine = if ($commandLine) { $commandLine } else { 'unavailable' }
            CommandLineAvailable = [bool]$commandLine
            TunnelCommandMatches = [bool]($commandLine -like '*tunnel run ai-workspace-mcp*')
        }
    }
)
@($processes) + @($tunnelProcesses) | Select-Object ProcessId,Name,CommandLine | Format-Table -Wrap
foreach ($port in @(48765,54108)) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    Write-Host "127.0.0.1:$port listener PID: $(if ($listener) { ($listener.OwningProcess -join ',') } else { 'NONE' })"
}
foreach ($base in @('http://127.0.0.1:48765','http://127.0.0.1:54108','https://ai-workspace-mcp.m1n4m0.me','https://ai-orchestration-review.m1n4m0.me')) {
    Write-Host "$base health=$(Get-GatewayResponse "$base/health") unauthenticated-mcp=$(Get-GatewayResponse "$base/mcp")"
}
$matchedTunnel = @($tunnelProcesses | Where-Object TunnelCommandMatches)
$unavailableTunnel = @($tunnelProcesses | Where-Object { -not $_.CommandLineAvailable })
$tunnelStatus = if ($matchedTunnel.Count) {
    "present (PID: $($matchedTunnel.ProcessId -join ','))"
} elseif ($unavailableTunnel.Count) {
    "present (PID: $($unavailableTunnel.ProcessId -join ','), commandline unavailable)"
} elseif ($cloudflared.Count) {
    'unknown (cloudflared running, expected tunnel command not verified)'
} else {
    'absent'
}
Write-Host "Tunnel process: $tunnelStatus; logs: $GatewayLogDir"
