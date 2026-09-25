# Fixed deployment identity. This file defines inspection helpers; dot-sourcing it never changes a task.
$DashboardTask = 'AI-Workspace-Dashboard'
$DashboardRoot = 'C:\work\codex-with-chatgpt'
$DashboardNode = 'C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node.exe'
$DashboardLauncher = 'C:\work\codex-with-chatgpt\scripts\run-ai-workspace-dashboard.mjs'
$DashboardServer = 'C:\work\codex-with-chatgpt\dist\dashboard\server.js'
$DashboardAccount = "$env:COMPUTERNAME\workspace"
$DashboardPort = 48766
$DashboardHost = '127.0.0.1'
$DashboardActionArguments = '"C:\work\codex-with-chatgpt\scripts\run-ai-workspace-dashboard.mjs"'

function Test-DashboardFixedFile([string]$File) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
    $current = [IO.Path]::GetPathRoot($File)
    foreach ($part in $File.Substring($current.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $part
        $entry = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    }
    return $true
}

function Test-DashboardAccountIdentity($UserId) {
    if ($UserId -isnot [string] -or -not $UserId.Trim()) { return $false }
    try {
        # Resolve both identities independently: a same-named domain account must not pass.
        $expected = ([Security.Principal.NTAccount]::new($DashboardAccount)).Translate([Security.Principal.SecurityIdentifier]).Value
        $actual = if ($UserId -match '^S-1-') {
            ([Security.Principal.SecurityIdentifier]::new($UserId)).Value
        } else {
            ([Security.Principal.NTAccount]::new($UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
        }
        return $actual -eq $expected
    } catch { return $false }
}

function Test-DashboardDuration($Value, [TimeSpan]$Expected) {
    if ($null -eq $Value) { return $false }
    try {
        $duration = if ($Value -is [TimeSpan]) { $Value } else { [System.Xml.XmlConvert]::ToTimeSpan([string]$Value) }
        return $duration -eq $Expected
    } catch { return $false }
}

function Get-DashboardTaskConfigIssues($Task) {
    $issues = [Collections.Generic.List[string]]::new()
    if (-not $Task) { $issues.Add('Task.NotRegistered'); return $issues.ToArray() }
    if ($Task.TaskName -and $Task.TaskName -cne $DashboardTask) { $issues.Add('Task.TaskName') }
    $actions = @($Task.Actions); $triggers = @($Task.Triggers)
    if ($actions.Count -ne 1) { $issues.Add('Actions.Count') }
    if ($triggers.Count -ne 1) { $issues.Add('Triggers.Count') }
    if ($actions.Count -eq 1) {
        if ($actions[0].Execute -cne $DashboardNode) { $issues.Add('Actions.Execute') }
        if ($actions[0].Arguments -cne $DashboardActionArguments) { $issues.Add('Actions.Arguments') }
        if ($actions[0].WorkingDirectory -cne $DashboardRoot) { $issues.Add('Actions.WorkingDirectory') }
    }
    if ($triggers.Count -eq 1) {
        if ($triggers[0].CimClass.CimClassName -ne 'MSFT_TaskBootTrigger') { $issues.Add('Triggers.Type') }
        if ($triggers[0].Enabled -ne $true) { $issues.Add('Triggers.Enabled') }
    }
    $principal = $Task.Principal
    if (-not (Test-DashboardAccountIdentity $principal.UserId)) { $issues.Add('Principal.UserId') }
    if ($principal.LogonType -ne 'S4U') { $issues.Add('Principal.LogonType') }
    if ([string]$principal.RunLevel -cnotin @('Highest', 'HighestAvailable')) { $issues.Add('Principal.RunLevel') }
    $settings = $Task.Settings
    if ($settings.Enabled -ne $true) { $issues.Add('Settings.Enabled') }
    if ($settings.Hidden -ne $true) { $issues.Add('Settings.Hidden') }
    if ($settings.MultipleInstances -ne 'IgnoreNew') { $issues.Add('Settings.MultipleInstances') }
    if ($settings.RestartCount -ne 3) { $issues.Add('Settings.RestartCount') }
    if (-not (Test-DashboardDuration $settings.RestartInterval ([TimeSpan]::FromMinutes(1)))) { $issues.Add('Settings.RestartInterval') }
    if (-not (Test-DashboardDuration $settings.ExecutionTimeLimit ([TimeSpan]::Zero))) { $issues.Add('Settings.ExecutionTimeLimit') }
    if ($settings.DisallowStartIfOnBatteries -ne $false) { $issues.Add('Settings.DisallowStartIfOnBatteries') }
    if ($settings.StopIfGoingOnBatteries -ne $false) { $issues.Add('Settings.StopIfGoingOnBatteries') }
    if ($settings.RunOnlyIfNetworkAvailable -ne $false) { $issues.Add('Settings.RunOnlyIfNetworkAvailable') }
    if ($settings.StartWhenAvailable -ne $true) { $issues.Add('Settings.StartWhenAvailable') }
    return $issues.ToArray()
}

function Test-DashboardTaskConfig($Task) {
    return @(Get-DashboardTaskConfigIssues $Task).Count -eq 0
}

function Get-DashboardTaskVerified {
    $task = Get-ScheduledTask -TaskName $DashboardTask -ErrorAction Stop
    if (-not (Test-DashboardTaskConfig $task)) { throw "Dashboard task configuration mismatch; refusing to operate on $DashboardTask." }
    return $task
}

function Get-DashboardObservation {
    $task = $null; $taskQueryFailed = $false
    try { $task = Get-ScheduledTask -TaskName $DashboardTask -ErrorAction SilentlyContinue }
    catch { $taskQueryFailed = $true }
    $issues = if ($taskQueryFailed) { @('Task.QueryUnavailable') } else { @(Get-DashboardTaskConfigIssues $task) }
    $configured = $issues.Count -eq 0
    $actions = if ($task) { @($task.Actions) } else { @() }
    $actionFixed = $actions.Count -eq 1 -and $actions[0].Execute -ceq $DashboardNode -and
        $actions[0].Arguments -ceq $DashboardActionArguments -and $actions[0].WorkingDirectory -ceq $DashboardRoot
    $lastResult = 'unknown'
    if ($task) {
        try {
            $info = Get-ScheduledTaskInfo -TaskName $DashboardTask -ErrorAction Stop
            if ($null -ne $info.LastTaskResult) { $lastResult = $info.LastTaskResult }
        }
        catch { /* status remains available even without history access */ }
    }
    $allProcesses = @(try { Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop } catch { @() })
    $processes = @($allProcesses | Where-Object {
        $_.ExecutablePath -ieq $DashboardNode -and $_.CommandLine -match ('^\s*"?' + [regex]::Escape($DashboardNode) + '"?\s+' +
            '"?' + [regex]::Escape($DashboardLauncher) + '"?\s*$')
    })
    $allListeners = @(try { Get-NetTCPConnection -LocalPort $DashboardPort -State Listen -ErrorAction Stop } catch { @() })
    $listeners = @($allListeners | Where-Object {
        $_.LocalAddress -eq $DashboardHost
    })
    $verified = @($processes | Where-Object { $listeners.OwningProcess -contains $_.ProcessId })
    $healthStatus = 'unavailable'; $healthIdentity = $false; $apiStatus = 'unavailable'
    try {
        $response = Invoke-WebRequest -Uri "http://${DashboardHost}:${DashboardPort}/health" -TimeoutSec 3 -SkipHttpErrorCheck -ErrorAction Stop
        $healthStatus = [int]$response.StatusCode
        if ($healthStatus -eq 200) {
            $body = $response.Content | ConvertFrom-Json -ErrorAction Stop
            $healthIdentity = [bool]($body.ok -eq $true -and $body.service -ceq 'ai-workspace-dashboard')
        }
    } catch { $healthStatus = 'unavailable' }
    try {
        $response = Invoke-WebRequest -Uri "http://${DashboardHost}:${DashboardPort}/api/status" -TimeoutSec 5 -SkipHttpErrorCheck -ErrorAction Stop
        $apiStatus = [int]$response.StatusCode
    } catch { $apiStatus = 'unavailable' }
    return [pscustomobject]@{
        Registered = if ($taskQueryFailed) { 'UNKNOWN' } elseif ($task) { 'YES' } else { 'NO' }
        ConfigValid = $configured
        MismatchReasons = @($issues)
        TaskState = if ($task) { [string]$task.State } else { 'NotRegistered' }
        LastTaskResult = $lastResult
        ActionFixed = [bool]$actionFixed
        ProcessPID = if ($verified.Count -eq 1) { $verified[0].ProcessId } else { $null }
        ListenerPID = if ($listeners.Count -eq 1) { $listeners[0].OwningProcess } else { $null }
        HealthHTTP = $healthStatus
        HealthIdentity = $healthIdentity
        ApiStatusHTTP = $apiStatus
        Ready = [bool]($configured -and $task.State -eq 'Running' -and $verified.Count -eq 1 -and
            $listeners.Count -eq 1 -and $healthStatus -eq 200 -and $healthIdentity -and $apiStatus -eq 200)
    }
}
