# Read-only reboot readiness check. Never reads or accepts an autologon password.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\ai-workspace-gateway.ps1"
. "$PSScriptRoot\workspace-interactive-session.ps1"
. "$PSScriptRoot\codex-worker-task-config.ps1"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run elevated as workspace for the read-only preflight.' }
$key = Get-Item -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$names = @($key.GetValueNames())
$user = $key.GetValue('DefaultUserName')
$domain = $key.GetValue('DefaultDomainName')
$auto = $key.GetValue('AutoAdminLogon')
$account = "$env:COMPUTERNAME\workspace"
$autologon = $auto -eq '1' -and $user -ceq 'workspace' -and $domain -ieq $env:COMPUTERNAME -and $names -notcontains 'DefaultPassword'
Write-Host "Autologon non-secret registry configuration: $(if ($autologon) {'OK'} else {'NOT READY'}) (user=$user domain=$domain AutoAdminLogon=$auto plaintext DefaultPassword present=$($names -contains 'DefaultPassword'))"
Write-Host 'LSA secret cannot be proven from this preflight. Verify Sysinternals Autologon GUI says Enabled; never print or export the secret.'
$task = Get-ScheduledTask -TaskName 'AI-Workspace-Codex-InteractiveWorker' -ErrorAction SilentlyContinue
$taskOK = Test-CodexWorkerTaskConfig -Task $task -Root $GatewayRoot -ScriptRoot $PSScriptRoot
Write-Host "Interactive worker task AtLogOn/InteractiveToken/Highest/IgnoreNew/restart/pinned action: $taskOK"
$sessions = @(Get-WorkspaceInteractiveSessions | Where-Object { $_.User -ieq $account -and $_.SessionId -gt 0 -and $_.State -in @('Active', 'Disconnected') })
$file = 'C:\work\ai-workspace-logs\codex-worker\heartbeat.json'
$beat = if (Test-Path -LiteralPath $file -PathType Leaf) { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } else { $null }
$process = if ($beat) { Get-Process -Id $beat.pid -ErrorAction SilentlyContinue } else { $null }
$cim = if ($process) { Get-CimInstance Win32_Process -Filter "ProcessId=$($beat.pid)" -ErrorAction SilentlyContinue } else { $null }
$age = if ($beat) { try { ([DateTime]::UtcNow - ([DateTime]$beat.observed_utc).ToUniversalTime()).TotalSeconds } catch { [double]::PositiveInfinity } } else { [double]::PositiveInfinity }
$workerOK = [bool]($process -and $cim.ExecutablePath -eq $GatewayNode -and $cim.CommandLine -like '*\dist\worker\cli.js worker*' -and
    $process.SessionId -eq $beat.session_id -and $beat.session_id -gt 0 -and $age -ge 0 -and $age -lt 10 -and @($sessions | Where-Object SessionId -EQ $beat.session_id).Count -gt 0)
Write-Host "Interactive worker live: $workerOK (PID=$(if ($workerOK) {$beat.pid} else {'NONE'}), SessionId=$(if ($workerOK) {$beat.session_id} else {'NONE'}), heartbeatAgeSeconds=$([math]::Round($age,1)))"
$gatewayTask = Get-ScheduledTask -TaskName $GatewayTask -ErrorAction SilentlyContinue
$s4u = [bool]($gatewayTask -and $gatewayTask.Principal.LogonType -eq 'S4U')
$gateway = (Get-GatewayResponse 'http://127.0.0.1:48765/health') -eq 200
$review = (Get-GatewayResponse 'http://127.0.0.1:54108/health') -eq 200
Write-Host "S4U Gateway task: $s4u; Gateway health: $gateway; Review Bridge health: $review"
Write-Host "Pre-reboot technical checks: $(if ($autologon -and $taskOK -and $workerOK -and $s4u -and $gateway -and $review) {'PASS (GUI secret and rollback still require human verification)'} else {'FAIL'})"
Write-Host 'No reboot performed. Confirm rollback and obtain explicit authorization before a reboot test.'
