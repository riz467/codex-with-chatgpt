# Engine-only adapter. Call after engine has saved prompt.txt and argv.json.
param([Parameter(Mandatory)][string]$Repo, [Parameter(Mandatory)][string]$TaskId, [Parameter(Mandatory)][ValidateRange(1,2)][int]$Attempt)
$ErrorActionPreference = 'Stop'
$node = 'C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node.exe'
$cli = 'C:\work\codex-with-chatgpt\dist\worker\cli.js'
$raw = & $node $cli engine $Repo $TaskId "$Attempt"
if ($LASTEXITCODE -ne 0) { throw 'Interactive Codex worker unavailable or request rejected' }
$result = $raw | ConvertFrom-Json -Depth 10
if ($result.task_id -cne $TaskId -or $result.attempt -ne $Attempt -or $result.session_id -le 0) { throw 'Interactive worker result mismatch' }
return $result
