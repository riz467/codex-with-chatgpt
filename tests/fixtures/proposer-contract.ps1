#requires -Version 7.5
# Offline checks of the real PowerShell functions. No OpenCode server/provider is started.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../src/mcp/proposer/opencode-session.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('proposer-contract-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$script:checks = 0
function Check([bool]$Condition) { if (!$Condition) { throw 'FIXTURE_ASSERTION_FAILED' }; $script:checks++ }
function Reject([scriptblock]$Action, [string]$Expected) {
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message -cne $Expected) { throw }
        $script:checks++; return
    }
    throw "EXPECTED_REJECTION_$Expected"
}
try {
    $savedRelease = $AutoRelease; $savedExecutable = $AutoOpenCodeExecutable
    $AutoOpenCodeExecutable = Join-Path $root 'pinned-fixture'
    [IO.File]::WriteAllText($AutoOpenCodeExecutable, 'fixture-release')
    $AutoRelease = @{ version = '2.0.22' }
    $AutoRelease[$AutoPlatform] = @{ sha256 = (Get-FileHash -LiteralPath $AutoOpenCodeExecutable).Hash.ToLowerInvariant() }
    Auto-AssertBinary; $script:checks++
    [IO.File]::WriteAllText((Join-Path $root 'human-cli'), 'unrelated-2.0.24')
    Auto-AssertBinary; $script:checks++
    [IO.File]::WriteAllText($AutoOpenCodeExecutable, 'wrong-version-bytes')
    Reject { Auto-AssertBinary } 'OPENCODE_BINARY_IDENTITY_MISMATCH'
    Remove-Item -LiteralPath $AutoOpenCodeExecutable
    Reject { Auto-AssertBinary } 'OPENCODE_BINARY_IDENTITY_MISMATCH'
    $null = New-Item -ItemType HardLink -Path $AutoOpenCodeExecutable -Target (Join-Path $root 'human-cli')
    $AutoRelease[$AutoPlatform].sha256 = (Get-FileHash -LiteralPath $AutoOpenCodeExecutable).Hash.ToLowerInvariant()
    Reject { Auto-AssertBinary } 'OPENCODE_BINARY_IDENTITY_MISMATCH'
    Remove-Item -LiteralPath $AutoOpenCodeExecutable
    $AutoRelease = $savedRelease; $AutoOpenCodeExecutable = $savedExecutable
    $schema = @'
{"paths":{"/api/session":{"post":{"requestBody":{"content":{"application/json":{"schema":{"properties":{"model":{"anyOf":[{"$ref":"#/components/schemas/Model.Ref"}]},"permissions":{"anyOf":[{"$ref":"#/components/schemas/Permission.Ruleset"}]}}}}}}}}},"components":{"schemas":{"Model.Ref":{"required":["id","providerID"],"properties":{"variant":{"type":"string"}}}}}}
'@ | ConvertFrom-Json -Depth 30
    foreach ($version in @('2.0.18','2.0.22')) { Auto-AssertSchema $version $schema; $script:checks++ }
    foreach ($version in @('2.0.24','2.0.23','2.1.0','2.0.22-extra')) { Reject { Auto-AssertSchema $version $schema } 'OPENCODE_MODEL_SCHEMA_MISMATCH' }
    $schema.components.schemas.'Model.Ref'.required = @('id')
    Reject { Auto-AssertSchema '2.0.22' $schema } 'OPENCODE_MODEL_SCHEMA_MISMATCH'
    $schema.components.schemas.'Model.Ref'.required = @('id','providerID')
    Check (Auto-SamePath $root (Join-Path $root '.'))
    Check (!(Auto-SamePath 'relative' 'relative'))
    Check (!(Auto-SamePath (Join-Path $root 'missing') (Join-Path $root 'missing')))
    $lower = Join-Path $root 'case'; $upper = Join-Path $root 'CASE'
    $null = New-Item -ItemType Directory -Path $lower
    if (!$IsWindows) { $null = New-Item -ItemType Directory -Path $upper; Check (!(Auto-SamePath $lower $upper)) }
    else { Check (Auto-SamePath $lower $upper) }
    $link = Join-Path $root 'alias'
    $null = New-Item -ItemType $(if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }) -Path $link -Target $lower
    Reject { Auto-SafePath $link } 'OPENCODE_PATH_ALIAS'
    Reject { Auto-SafePath (Join-Path $link 'child') } 'OPENCODE_PATH_ALIAS'
    $integrations = [pscustomobject]@{ location = @{ directory = $root }; data = @(@{ id = 'openai'; connections = @(@{ type = 'credential'; method = 'oauth' }) }) }
    Auto-AssertOAuth $integrations $root; $script:checks++
    $integrations.data[0].connections[0].method = 'key'
    Reject { Auto-AssertOAuth $integrations $root } 'OPENCODE_OAUTH_NOT_CONFIRMED'
    $integrations.data[0].connections[0].method = 'oauth'
    $env:OPENAI_API_KEY = 'fixture-not-a-credential'
    Reject { Auto-AssertOAuth $integrations $root } 'OPENCODE_AUTH_ROUTE_AMBIGUOUS'
    Remove-Item Env:OPENAI_API_KEY
    $deny = @{ action = '*'; resource = '*'; effect = 'deny' }
    $agents = @{ location = @{ directory = $root }; data = @(@{ id = $AutoAgentName; mode = 'primary'; system = 'fixture'
        permissions = @(@{ action = '*'; resource = '*'; effect = 'allow' }, $deny) }) }
    Auto-AssertAgent $agents $root 'fixture'; $script:checks++
    $agents.data[0].permissions += @{ action = 'shell'; resource = '*'; effect = 'allow' }
    Reject { Auto-AssertAgent $agents $root 'fixture' } 'OPENCODE_AGENT_UNAVAILABLE'
    $agents.data[0].permissions = @($deny)
    Reject { Auto-AssertAgent $agents $root 'overridden' } 'OPENCODE_AGENT_UNAVAILABLE'
    $model = @{ providerID = 'openai'; id = 'gpt-6-sol'; variant = 'default' }
    $script:requested = $null
    function Auto-Api($Client, $Method, $Path, $Body, $Failure) {
        if ($Method -ceq 'POST') { $script:requested = $Body }
        return @{ data = @{ id = 'ses_fixture'; agent = $AutoAgentName; location = @{ directory = $root }; model = $model } }
    }
    Check ((Auto-SessionCreate @{ client = $null } $root $model) -ceq 'ses_fixture')
    Check ($script:requested.permissions[0].effect -ceq 'deny')
    $messages = @{ data = @(@{ id = 'msg_user'; type = 'user' }, @{ id = 'msg_answer'; type = 'assistant'; agent = $AutoAgentName
        time = @{ completed = 1 }; finish = 'stop'; model = $model; content = @(@{ type = 'text'; text = '{"edits":[]}' }) }) }
    Check ((Auto-SelectTurn $messages 'ses_fixture' 'msg_user').tools -eq 0)
    $messages.data += @{ type = 'idle'; outcome = 'succeeded' }
    Check ((Auto-SelectTurn $messages 'ses_fixture' 'msg_user').id -ceq 'msg_answer')
    $model.id = 'wrong'
    Reject { Auto-SelectTurn $messages 'ses_fixture' 'msg_user' } 'OPENCODE_RESPONSE_MODEL_MISMATCH'
    $model.id = 'gpt-6-sol'
    $messages.data[1].content += @{ type = 'tool' }
    Reject { Auto-SelectTurn $messages 'ses_fixture' 'msg_user' } 'TOOL_BUDGET_EXCEEDED'
    $messages.data[1].content = @(@{ type = 'text'; text = '{}' })
    $messages.data[1].agent = 'wrong'
    Reject { Auto-SelectTurn $messages 'ses_fixture' 'msg_user' } 'OPENCODE_AGENT_UNAVAILABLE'
    $messages.data[1].agent = $AutoAgentName; $messages.data[2].outcome = 'failed'
    Reject { Auto-SelectTurn $messages 'ses_fixture' 'msg_user' } 'OPENCODE_MESSAGE_MISSING'
    foreach ($failAt in @('exit','stdout','stderr')) {
        $process = [pscustomobject]@{ HasExited = $false; disposed = $false; exited = ($failAt -cne 'exit') }
        $process | Add-Member ScriptMethod Kill { param($tree) if (!$tree) { throw 'TREE_REQUIRED' } }
        $process | Add-Member ScriptMethod WaitForExit { param($timeout) return $this.exited }
        $process | Add-Member ScriptMethod Dispose { $this.disposed = $true }
        $client = [pscustomobject]@{ disposed = $false }
        $client | Add-Member ScriptMethod Dispose { $this.disposed = $true }
        $stdout = [pscustomobject]@{ completed = ($failAt -cne 'stdout') }
        $stderr = [pscustomobject]@{ completed = ($failAt -cne 'stderr') }
        foreach ($stream in @($stdout,$stderr)) { $stream | Add-Member ScriptMethod Wait { param($timeout) return $this.completed } }
        Reject { Auto-ServerStop @{ process = $process; client = $client; stdout = $stdout; stderr = $stderr } } 'PROCESS_TERMINATION_REQUIRES_INSPECTION'
        Check ($client.disposed -and $process.disposed)
    }
    foreach ($apiVersion in @('2.0.22','2.0.24')) {
        $process = [pscustomobject]@{ Id = 12345; HasExited = $false; disposed = $false; killed = $false }
        $process | Add-Member ScriptMethod Kill { param($tree) $this.killed = $tree }
        $process | Add-Member ScriptMethod WaitForExit { param($timeout) return $true }
        $process | Add-Member ScriptMethod Dispose { $this.disposed = $true }
        $client = [pscustomobject]@{ disposed = $false }
        $client | Add-Member ScriptMethod Dispose { $this.disposed = $true }
        $stream = [pscustomobject]@{}
        $stream | Add-Member ScriptMethod Wait { param($timeout) return $true }
        $server = @{ process = $process; client = $client; stdout = $stream; stderr = $stream }
        $script:routes = @()
        function Auto-Api($Client, $Method, $Path, $Body, $Failure) {
            $script:routes += $Path
            return @{ pid = 12345; version = $apiVersion; urls = @('http://127.0.0.1:41739') }
        }
        if ($apiVersion -ceq '2.0.24') {
            Reject { Auto-ServerWait $server } 'OPENCODE_BINARY_VERSION_MISMATCH'
            Check ($process.killed -and $process.disposed -and $client.disposed)
        } else {
            Check ((Auto-ServerWait $server).version -ceq '2.0.22')
            Check (!$process.killed)
            Auto-ServerStop $server
        }
        Check ($script:routes.Count -eq 1 -and $script:routes[0] -ceq '/api/info')
    }
    [Console]::Out.Write((@{ checks = $script:checks; platform = $(if ($IsWindows) { 'win32' } else { 'linux' }); powershell = $PSVersionTable.PSVersion.ToString(); provider_calls = 0 } | ConvertTo-Json -Compress))
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
