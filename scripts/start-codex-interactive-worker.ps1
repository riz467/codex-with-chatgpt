# Fixed InteractiveToken task entrypoint; no caller-supplied executable or arguments.
$ErrorActionPreference = 'Stop'
$root = 'C:\work\codex-with-chatgpt'
$node = 'C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node.exe'
. "$PSScriptRoot\codex-interactive-logon.ps1"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$groups = @($identity.Groups | ForEach-Object { $_.Value })
$interactive = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole(
    [Security.Principal.SecurityIdentifier]::new('S-1-5-4')
)
$session = (Get-Process -Id $PID).SessionId
if (-not (Test-CodexInteractiveLogon -UserSid $identity.User.Value -UserName $identity.Name -SessionId $session -GroupSids $groups -InteractiveRoleEnabled $interactive)) {
    throw 'Interactive workspace logon required; refusing Codex execution.'
}
$env:AI_WORKER_SESSION_ID = "$session"
& $node "$root\dist\worker\cli.js" worker
exit $LASTEXITCODE
