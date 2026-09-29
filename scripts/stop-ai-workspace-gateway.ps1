$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\ai-workspace-gateway.ps1"

$task = Get-ScheduledTask -TaskName $GatewayTask -ErrorAction Stop
if ($task.State -ne 'Running') {
    throw 'Gateway task is not running; refusing to stop unrelated foreground processes.'
}

function Stop-ExactBridge {
    param(
        [Parameter(Mandatory)][string]$Cli,
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][int]$Port
    )

    $processes = @(
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object {
            $_.ExecutablePath -eq $GatewayNode -and
            $_.CommandLine -like "*$Cli serve --workspace $Workspace --port $Port*"
        }
    )

    if ($processes.Count -gt 1) {
        throw "More than one verified Bridge process found for port $Port."
    }

    if ($processes.Count -eq 0) {
        return
    }

    $before = $processes[0]

    & $GatewayNode $Cli stop --workspace $Workspace
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Bridge stop returned $LASTEXITCODE for $Workspace"
    }

    Start-Sleep -Milliseconds 500

    $remaining = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId=$($before.ProcessId)" `
        -ErrorAction SilentlyContinue

    if ($remaining) {
        if (
            $remaining.ExecutablePath -ne $before.ExecutablePath -or
            $remaining.CommandLine -ne $before.CommandLine
        ) {
            throw "Bridge PID $($before.ProcessId) identity changed; refusing fallback stop."
        }

        Stop-Process `
            -Id $before.ProcessId `
            -Force `
            -ErrorAction Stop
    }
}

Stop-ScheduledTask -TaskName $GatewayTask

$previousStateDir = $env:C2C_STATE_DIR

try {
    # Both workspaces use the same workspace-user state root.
    # The execution Bridge receives this explicitly in the supervisor;
    # the review Bridge reaches the same path through the default profile.
    $env:C2C_STATE_DIR = $GatewayStateDir

    Stop-ExactBridge `
        -Cli $GatewayExecutionCli `
        -Workspace $GatewayRoot `
        -Port 48765

    Stop-ExactBridge `
        -Cli $GatewayReviewCli `
        -Workspace $GatewayReviewRoot `
        -Port 54108
}
finally {
    if ($null -eq $previousStateDir) {
        Remove-Item Env:C2C_STATE_DIR -ErrorAction SilentlyContinue
    }
    else {
        $env:C2C_STATE_DIR = $previousStateDir
    }
}

$cloudflared = @(
    Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    Where-Object {
        $_.ExecutablePath -eq $GatewayTunnel -and
        $_.CommandLine -like '*--config*config.yml*tunnel run ai-workspace-mcp*'
    }
)

if ($cloudflared.Count -gt 1) {
    throw "More than one verified ai-workspace-mcp cloudflared process found."
}

if ($cloudflared.Count -eq 1) {
    Stop-Process `
        -Id $cloudflared[0].ProcessId `
        -ErrorAction Stop
}

Write-Host 'Gateway stop requested; inspect status and listener PIDs.'
