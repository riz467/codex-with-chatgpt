# Fixed deployment settings; no credentials belong in this file.
$GatewayTask = 'AI-Workspace-Gateway'
$GatewayRoot = 'C:\work\codex-with-chatgpt'
$GatewayNode = 'C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node.exe'
$GatewayAccount = 'workspace'
$GatewayTunnel = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$GatewayConfig = 'C:\Users\workspace\.cloudflared\config.yml'
$GatewayLogDir = 'C:\work\ai-workspace-logs'

function Get-GatewayResponse($Url) {
    try {
        $r = Invoke-WebRequest -Uri $Url -TimeoutSec 10 -SkipHttpErrorCheck -ErrorAction Stop
        return [int]$r.StatusCode
    } catch { return "error: $($_.Exception.Message)" }
}
