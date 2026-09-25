param([Parameter(Mandatory)][ValidateSet('interactive', 's4u')][string]$Mode)

$ErrorActionPreference = 'Stop'
$logDir = 'C:\work\ai-workspace-logs\codex-s4u-profile-diagnostic'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
if ($identity.Name.Split('\')[-1] -ne 'workspace' -or $sid -notmatch '-1000$') { throw 'Expected workspace identity with SID ending -1000.' }
$file = Join-Path $logDir "$Mode.profile.json"
if (Test-Path -LiteralPath $file) { throw "Refusing to overwrite $file" }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Read-Reg([string]$key) {
    $output = @(& reg.exe query $key 2>&1 | ForEach-Object { "$($_)" })
    return [ordered]@{ key = $key; exit_code = $LASTEXITCODE; output = $output }
}

$groups = @(& whoami.exe /groups /fo csv 2>&1 | ForEach-Object { "$_" })
$profile = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction Stop
$data = [ordered]@{
    mode = $Mode
    observed_utc = (Get-Date).ToUniversalTime().ToString('o')
    whoami = (& whoami.exe)
    whoami_user = @(& whoami.exe /user | ForEach-Object { "$_" })
    identity_sid = $sid
    userprofile = $env:USERPROFILE
    temp = $env:TEMP
    tmp = $env:TMP
    hkcu = (Read-Reg 'HKCU')
    hku_workspace = (Read-Reg "HKU\$sid")
    profile_list = (Read-Reg "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid")
    win32_userprofile = if ($null -eq $profile) { $null } else { [ordered]@{ SID = $profile.SID; LocalPath = $profile.LocalPath; Loaded = $profile.Loaded; Special = $profile.Special } }
    session_id = (Get-Process -Id $PID).SessionId
    logon_groups = $groups
    logon_type_inferred = if ($groups -match ',"S-1-5-3",') { 'Batch' } elseif ($groups -match ',"S-1-5-4",') { 'Interactive' } else { 'Unknown (inspect logon_groups)' }
    task_principal = if ($Mode -eq 's4u') { $p = (Get-ScheduledTask -TaskName 'AI-Workspace-Codex-Profile-Diagnostic' -ErrorAction Stop).Principal; [ordered]@{ UserId = $p.UserId; LogonType = "$($p.LogonType)"; RunLevel = "$($p.RunLevel)" } } else { $null }
    ntuser_dat_exists = (Test-Path -LiteralPath 'C:\Users\workspace\NTUSER.DAT' -PathType Leaf)
    current_directory = (Get-Location).Path
}
$data | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $file -Encoding utf8 -NoNewline
Write-Host "Evidence: $file"
