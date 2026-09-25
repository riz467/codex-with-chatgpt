# Read-only validation of the pinned windowless scheduled-task chain.
function Test-CodexWorkerTaskConfig {
    param($Task, [string]$Root = 'C:\work\codex-with-chatgpt', [string]$ScriptRoot = $PSScriptRoot)
    if (-not $Task) { return $false }
    $account = "$env:COMPUTERNAME\workspace"
    $launcher = Join-Path $ScriptRoot 'launch-codex-interactive-worker.vbs'
    $entrypoint = Join-Path $ScriptRoot 'start-codex-interactive-worker.ps1'
    $expectedVbs = @'
' Fixed, windowless task entrypoint. Wait for the child so Task Scheduler tracks its lifetime.
Option Explicit
Dim shell, code
Set shell = CreateObject("WScript.Shell")
code = shell.Run("""C:\Program Files\PowerShell\7\pwsh.exe"" -NoProfile -NonInteractive -WindowStyle Hidden -File ""C:\work\codex-with-chatgpt\scripts\start-codex-interactive-worker.ps1""", 0, True)
WScript.Quit code
'@
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf) -or -not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { return $false }
    # Do not accept a task that points at a modified VBS with an additional command.
    $actualVbs = [IO.File]::ReadAllText($launcher).Replace("`r`n", "`n").TrimEnd("`n")
    if ($actualVbs -cne $expectedVbs) { return $false }
    $actions = @($Task.Actions)
    $triggers = @($Task.Triggers)
    return [bool]($Task.Settings.Enabled -and $Task.Principal.UserId -in @('workspace', $account) -and
        $Task.Principal.LogonType -eq 'Interactive' -and $Task.Principal.RunLevel -eq 'Highest' -and
        $triggers.Count -eq 1 -and $triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and
        $triggers[0].UserId -in @('workspace', $account) -and $actions.Count -eq 1 -and
        $actions[0].Execute -eq "$env:SystemRoot\System32\wscript.exe" -and
        $actions[0].Arguments -ceq "//B //Nologo `"$launcher`"" -and $actions[0].WorkingDirectory -eq $Root -and
        $Task.Settings.MultipleInstances -eq 'IgnoreNew' -and $Task.Settings.RestartCount -eq 3 -and
        $Task.Settings.RestartInterval -eq 'PT1M' -and $Task.Settings.ExecutionTimeLimit -eq 'PT0S')
}
