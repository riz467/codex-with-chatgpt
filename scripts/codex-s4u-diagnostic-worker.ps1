param(
    [Parameter(Mandatory)][ValidateSet('interactive', 's4u')][string]$Mode,
    [string]$LogDir = 'C:\work\ai-workspace-logs\codex-s4u-diagnostic'
)

$ErrorActionPreference = 'Stop'
$root = 'C:\work\pve-doc'
$logDir = $LogDir
$node = 'C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node.exe'
$codex = 'C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node_modules\@openai\codex\bin\codex.js'
$prompt = 'Fixed read-only runner diagnostic. In C:\work\pve-doc, run commands to (1) report pwd/current directory, (2) git status --short, (3) read AGENTS.md, (4) read the first 40 lines of 03_services/ai-workspace.md. Do not write or edit any files, run an orchestration task, commit, or push. Report briefly whether all four reads succeeded.'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$evidence = [ordered]@{
    mode = $Mode
    start = (Get-Date).ToUniversalTime().ToString('o')
    end = $null
    parent_pid = $PID
    codex_pid = $null
    child_runner_pids = @()
    process_tree = @()
    pipe_names = @()
    exit_code = $null
    error = $null
    environment = [ordered]@{
        TEMP = $env:TEMP; TMP = $env:TMP; USERPROFILE = $env:USERPROFILE
        PATH = $env:PATH; SESSIONNAME = $env:SESSIONNAME
        whoami = (& whoami); current_directory = (Get-Location).Path
    }
}
$summary = Join-Path $logDir "$Mode.json"
$stdout = Join-Path $logDir "$Mode.stdout.log"
$stderr = Join-Path $logDir "$Mode.stderr.log"
if (Test-Path -LiteralPath $summary) { throw "Refusing to repeat $Mode diagnostic: $summary exists" }

try {
    foreach ($file in @($node, $codex, "$root\AGENTS.md", "$root\03_services\ai-workspace.md")) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing prerequisite: $file" }
    }
    if ((Get-Location).Path -ne $root) { throw "Expected working directory $root" }
    if ((& whoami) -notmatch '\\workspace$') { throw 'Expected workspace identity' }
    # Start-Process joins ArgumentList into one command line; quote the two arguments containing spaces.
    $args = @("`"$codex`"", '-a', 'never', '-C', $root, 'exec', '-s', 'read-only', '--ephemeral', "`"$prompt`"")
    $process = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $root -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -NoNewWindow
    $evidence.codex_pid = $process.Id
    $seen = @{}
    do {
        # Record only PID, PPID and executable name; command lines and env of child processes may contain secrets.
        $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,Name)
        $frontier = @($process.Id)
        while ($frontier.Count -gt 0) {
            $next = @()
            foreach ($entry in $all) {
                if ($frontier -contains [int]$entry.ParentProcessId -and -not $seen.ContainsKey([int]$entry.ProcessId)) {
                    $seen[[int]$entry.ProcessId] = [ordered]@{ pid = [int]$entry.ProcessId; parent_pid = [int]$entry.ParentProcessId; name = $entry.Name }
                    $next += [int]$entry.ProcessId
                }
            }
            $frontier = $next
        }
        # Named-pipe enumeration is best effort; only Codex/runner names are retained.
        try {
            $pipes = @(Get-ChildItem '\\.\pipe\' -ErrorAction Stop | Where-Object Name -Match '(?i)codex|runner|pipe-in' | Select-Object -First 30 -ExpandProperty Name)
            $evidence.pipe_names = @($evidence.pipe_names + $pipes | Select-Object -Unique -First 30)
        } catch { }
        Start-Sleep -Milliseconds 500
        $process.Refresh()
    } while (-not $process.HasExited)
    $evidence.exit_code = $process.ExitCode
    $evidence.process_tree = @($seen.Values)
    $evidence.child_runner_pids = @($seen.Values | Where-Object { $_.name -match '(?i)runner' } | ForEach-Object { $_.pid })
} catch {
    $evidence.error = $_.Exception.Message
} finally {
    $evidence.end = (Get-Date).ToUniversalTime().ToString('o')
    $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summary -Encoding utf8 -NoNewline
}
if ($null -ne $evidence.error) { throw $evidence.error }
