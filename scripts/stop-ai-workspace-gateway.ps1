$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\ai-workspace-gateway.ps1"
$task = Get-ScheduledTask -TaskName $GatewayTask -ErrorAction Stop
if ($task.State -ne 'Running') { throw 'Gateway task is not running; refusing to stop unrelated foreground processes.' }
Stop-ScheduledTask -TaskName $GatewayTask
# Stop only the fixed child commands, not arbitrary node/cloudflared instances.
$cli = 'C:\work\codex-with-chatgpt\dist\cli\index.js'
foreach ($workspace in @($GatewayRoot, 'C:\work\ai-orchestration-review')) {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.ExecutablePath -eq $GatewayNode -and $_.CommandLine -like "*$cli serve --workspace $workspace --port *"
    })
    if ($processes.Count -gt 0) {
        & $GatewayNode $cli stop --workspace $workspace
        if ($LASTEXITCODE -ne 0) { Write-Warning "Bridge stop returned $LASTEXITCODE for $workspace" }
    }
}
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object {
    $_.ExecutablePath -eq $GatewayTunnel -and $_.CommandLine -like '*--config*config.yml*tunnel run ai-workspace-mcp*'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }
Write-Host 'Gateway stop requested; inspect status and listener PIDs.'
