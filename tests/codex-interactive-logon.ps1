$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\scripts\codex-interactive-logon.ps1"

$workspaceSid = 'S-1-5-21-1389881484-3427664689-3699660927-1000'
$valid = @{
    UserSid = $workspaceSid
    UserName = 'AI-WORKSPACE-W\workspace'
    SessionId = 2
    GroupSids = @('S-1-5-4', 'S-1-5-14')
    InteractiveRoleEnabled = $true
}

function Assert-Logon {
    param([string] $Name, [hashtable] $Changes, [bool] $Expected)
    $inputValues = $valid.Clone()
    foreach ($key in $Changes.Keys) { $inputValues[$key] = $Changes[$key] }
    $actual = Test-CodexInteractiveLogon @inputValues
    if ($actual -ne $Expected) { throw "$Name`: expected $Expected, got $actual" }
    Write-Host "PASS: $Name"
}

Assert-Logon 'workspace RDP interactive, session 2 and matching SID' @{} $true
Assert-Logon 'plain workspace name and matching SID' @{ UserName = 'workspace' } $true
Assert-Logon 'session 0' @{ SessionId = 0 } $false
Assert-Logon 'batch token' @{ GroupSids = @('S-1-5-4', 'S-1-5-3') } $false
Assert-Logon 'network token without interactive role' @{ GroupSids = @('S-1-5-2') ; InteractiveRoleEnabled = $false } $false
Assert-Logon 'S4U token without interactive role' @{ GroupSids = @('S-1-5-11') ; InteractiveRoleEnabled = $false } $false
Assert-Logon 'interactive SID present but disabled' @{ InteractiveRoleEnabled = $false } $false
Assert-Logon 'different user' @{ UserName = 'AI-WORKSPACE-W\other' } $false
Assert-Logon 'workspace SID mismatch' @{ UserSid = 'S-1-5-21-1389881484-3427664689-3699660927-1001' } $false
Assert-Logon 'other user with workspace name' @{ UserSid = 'S-1-5-18'; UserName = 'workspace' } $false
