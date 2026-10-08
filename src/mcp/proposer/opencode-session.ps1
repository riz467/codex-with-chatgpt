#requires -Version 7.5
# Port of ai-orchestration-config/scripts/autonomous-opencode-session.ps1.
# Private fixed-role transport: no executable, address, port or agent CLI overrides.
$AutoUtf8 = [Text.UTF8Encoding]::new($false, $true)
$AutoAgentName = 'c2c-bounded-proposer'
$AutoServerUrl = 'http://127.0.0.1:41739'
$AutoRelease = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'opencode-release.json') -Raw | ConvertFrom-Json
$AutoPlatform = if ($IsWindows) { 'win32' } elseif ($IsLinux) { 'linux' } else { 'unsupported' }
$AutoOpenCodeExecutable = $AutoRelease.$AutoPlatform.proposer
$AutoGit = if ($IsWindows) { 'C:\Program Files\Git\cmd\git.exe' } else { '/usr/bin/git' }

function Auto-SafePath([string]$Value) {
    if (![IO.Path]::IsPathFullyQualified($Value)) { throw 'INVALID_REPO' }
    $full = [IO.Path]::GetFullPath($Value)
    $part = [IO.Path]::GetPathRoot($full)
    foreach ($segment in $full.Substring($part.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
        $part = Join-Path $part $segment
        $item = Get-Item -LiteralPath $part -Force -ErrorAction Stop
        if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'OPENCODE_PATH_ALIAS' }
    }
    return $full.TrimEnd([IO.Path]::DirectorySeparatorChar)
}
function Auto-SamePath([string]$Left, [string]$Right) {
    try {
        $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
        return [string]::Equals((Auto-SafePath $Left), (Auto-SafePath $Right), $comparison)
    } catch { return $false }
}
function Auto-AssertBinary {
    if ($AutoPlatform -ceq 'unsupported' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
        throw 'OPENCODE_BINARY_PLATFORM_UNSUPPORTED'
    }
    try {
        $null = Auto-SafePath $AutoOpenCodeExecutable
        $item = Get-Item -LiteralPath $AutoOpenCodeExecutable -Force
        if ($item.PSIsContainer -or $item.LinkType -or
            (Get-FileHash -LiteralPath $AutoOpenCodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -cne $AutoRelease.$AutoPlatform.sha256) {
            throw 'identity'
        }
    } catch { throw 'OPENCODE_BINARY_IDENTITY_MISMATCH' }
}
function Auto-AssertSchema($Version, $Schema) {
    $create = $Schema.paths.PSObject.Properties['/api/session'].Value.post.requestBody.content.PSObject.Properties['application/json'].Value.schema
    $model = $Schema.components.schemas.PSObject.Properties['Model.Ref'].Value
    if ($Version -cnotin @('2.0.18','2.0.22') -or
        @($create.properties.model.anyOf | Where-Object { $_.'$ref' -ceq '#/components/schemas/Model.Ref' }).Count -ne 1 -or
        @($create.properties.permissions.anyOf | Where-Object { $_.'$ref' -ceq '#/components/schemas/Permission.Ruleset' }).Count -ne 1 -or
        'id' -cnotin @($model.required) -or 'providerID' -cnotin @($model.required) -or
        $model.properties.variant.type -cne 'string') { throw 'OPENCODE_MODEL_SCHEMA_MISMATCH' }
}
function Auto-AssertOAuth($Integrations, [string]$Repo) {
    if ($env:OPENAI_API_KEY -or $env:OPENAI_BASE_URL) { throw 'OPENCODE_AUTH_ROUTE_AMBIGUOUS' }
    $openai = @($Integrations.data | Where-Object { $_.id -ceq 'openai' })
    if (!(Auto-SamePath $Integrations.location.directory $Repo) -or $openai.Count -ne 1 -or
        @($openai[0].connections).Count -ne 1 -or $openai[0].connections[0].type -cne 'credential' -or
        $openai[0].connections[0].method -cne 'oauth') { throw 'OPENCODE_OAUTH_NOT_CONFIRMED' }
}
function Auto-AssertAgent($Agents, [string]$Repo, [string]$System) {
    $agent = @($Agents.data | Where-Object { $_.id -ceq $AutoAgentName })
    $rules = @($agent[0].permissions)
    if (!(Auto-SamePath $Agents.location.directory $Repo) -or $agent.Count -ne 1 -or
        $agent[0].mode -cne 'primary' -or !$System -or $agent[0].system.Trim() -cne $System.Trim() -or
        !$rules.Count -or $rules[-1].action -cne '*' -or $rules[-1].resource -cne '*' -or $rules[-1].effect -cne 'deny') {
        throw 'OPENCODE_AGENT_UNAVAILABLE'
    }
}
function Auto-Api($Client, [string]$Method, [string]$Path, $Body = $null, [string]$Failure = 'OPENCODE_SERVER_UNAVAILABLE') {
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), "$AutoServerUrl$Path")
    if ($Body -ne $null) { $request.Content = [Net.Http.StringContent]::new((ConvertTo-Json -InputObject $Body -Depth 20 -Compress), $AutoUtf8, 'application/json') }
    try {
        $response = $Client.SendAsync($request).GetAwaiter().GetResult()
        try {
            $script:AutoLastHttpStatus = [int]$response.StatusCode
            if (!$response.IsSuccessStatusCode) { throw $Failure }
            $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if ($text.Length -gt 2097152) { throw $Failure }
            return (ConvertFrom-Json -InputObject $text -Depth 30 -DateKind String -ErrorAction Stop)
        } finally { $response.Dispose() }
    } catch { if ($_.Exception -is [Threading.Tasks.TaskCanceledException]) { throw 'OPENCODE_TIMEOUT' }; throw $Failure }
    finally { $request.Dispose() }
}
function Auto-ServerStart([string]$Repo) {
    Auto-AssertBinary
    $handler = [Net.Http.HttpClientHandler]::new(); $handler.UseProxy = $false; $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler); $client.Timeout = [timespan]::FromSeconds(8)
    $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 41739)
    try { $socket.Start() } catch { $client.Dispose(); throw 'OPENCODE_SERVER_UNAVAILABLE' } finally { $socket.Stop() }
    $psi = [Diagnostics.ProcessStartInfo]::new($AutoOpenCodeExecutable)
    $password = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
    $psi.Environment['OPENCODE_SERVER_PASSWORD'] = $password
    $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Basic', [Convert]::ToBase64String($AutoUtf8.GetBytes("opencode:$password")))
    foreach ($arg in @('serve','--hostname','127.0.0.1','--port','41739')) { [void]$psi.ArgumentList.Add($arg) }
    $psi.WorkingDirectory = $Repo; $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    try { $process = [Diagnostics.Process]::Start($psi) } catch { $client.Dispose(); throw 'OPENCODE_SERVER_UNAVAILABLE' }
    $server = @{ client = $client; process = $process; stdout = $process.StandardOutput.ReadToEndAsync(); stderr = $process.StandardError.ReadToEndAsync() }
    return (Auto-ServerWait $server)
}
function Auto-ServerWait($Server) {
    $process = $Server.process; $client = $Server.client
    try {
        $deadline = [datetime]::UtcNow.AddSeconds(25)
        do {
            if ($process.HasExited) { throw 'OPENCODE_SERVER_UNAVAILABLE' }
            try {
                $info = Auto-Api $client 'GET' '/api/info'
                if ($info.pid -eq $process.Id -and $info.version -cne $AutoRelease.version) { throw 'OPENCODE_BINARY_VERSION_MISMATCH' }
                if ($info.pid -eq $process.Id -and $info.version -ceq $AutoRelease.version -and
                    !@($info.urls | Where-Object { $_ -match '0\.0\.0\.0|\[::\]' }).Count) {
                    $server.version = $info.version
                    return $server
                }
            } catch { if ($_.Exception.Message -ceq 'OPENCODE_BINARY_VERSION_MISMATCH') { throw } }
            Start-Sleep -Milliseconds 250
        } while ([datetime]::UtcNow -lt $deadline)
        throw 'OPENCODE_SERVER_UNAVAILABLE'
    } catch { Auto-ServerStop $server; throw }
}
function Auto-ServerStop($Server) {
    try {
        if (!$Server.process.HasExited) { $Server.process.Kill($true) }
        if (!$Server.process.WaitForExit(2000) -or !$Server.stdout.Wait(2000) -or !$Server.stderr.Wait(2000)) {
            throw 'PROCESS_TERMINATION_REQUIRES_INSPECTION'
        }
    } catch { throw 'PROCESS_TERMINATION_REQUIRES_INSPECTION' }
    finally { $Server.client.Dispose(); $Server.process.Dispose() }
}
function Auto-SessionCreate($Server, [string]$Repo, $Model) {
    $body = @{ agent = $AutoAgentName; location = @{ directory = $Repo }; title = 'Read-only bounded proposal'; model = $Model
        permissions = @(@{ action = '*'; resource = '*'; effect = 'deny' }) }
    $created = Auto-Api $Server.client 'POST' '/api/session' $body 'OPENCODE_SESSION_CREATE_FAILED'
    if ($created.data.id -cnotmatch '^ses_[a-zA-Z0-9]+$' -or $created.data.agent -cne $AutoAgentName -or
        !(Auto-SamePath $created.data.location.directory $Repo)) { throw 'OPENCODE_SESSION_CREATE_FAILED' }
    $saved = Auto-Api $Server.client 'GET' "/api/session/$($created.data.id)" $null 'OPENCODE_SESSION_MODEL_MISMATCH'
    if ($saved.data.id -cne $created.data.id -or $saved.data.agent -cne $AutoAgentName -or
        !(Auto-SamePath $saved.data.location.directory $Repo) -or
        $saved.data.model.providerID -cne $Model.providerID -or $saved.data.model.id -cne $Model.id -or
        $saved.data.model.variant -cne $Model.variant) { throw 'OPENCODE_SESSION_MODEL_MISMATCH' }
    return $created.data.id
}
function Auto-SelectTurn($Messages, [string]$SessionId, [string]$UserId) {
    if ($SessionId -cnotmatch '^ses_[a-zA-Z0-9]+$' -or $UserId -cnotmatch '^msg_[a-zA-Z0-9]+$') { throw 'OPENCODE_MESSAGE_MISSING' }
    $items = @($Messages.data); $index = -1
    for ($i = 0; $i -lt $items.Count; $i++) { if ($items[$i].id -ceq $UserId -and $items[$i].type -ceq 'user') { $index = $i; break } }
    if ($index -lt 0) { throw 'OPENCODE_MESSAGE_MISSING' }
    $candidates = @(); $idle = $null
    for ($i = $index + 1; $i -lt $items.Count; $i++) {
        $m = $items[$i]
        if ($m.type -eq 'user') { throw 'OPENCODE_MESSAGE_MISSING' }
        if ($m.type -eq 'idle') { $idle = $m; break }
        if ($m.type -eq 'assistant') {
            if ($m.agent -cne $AutoAgentName -or $m.id -cnotmatch '^msg_[a-zA-Z0-9]+$') { throw 'OPENCODE_AGENT_UNAVAILABLE' }
            if (@($m.content | Where-Object type -EQ 'tool').Count) { throw 'TOOL_BUDGET_EXCEEDED' }
            if ($m.time.completed -and $m.finish -eq 'stop') { $candidates += $m }
        }
    }
    # Preserve the proposer-specific completed-without-idle behavior (not the reviewer contract).
    if (!$idle -and $candidates.Count -ne 1) { return $null }
    if ($idle -and ($idle.outcome -cne 'succeeded' -or $candidates.Count -ne 1)) { throw 'OPENCODE_MESSAGE_MISSING' }
    $answer = $candidates[0]
    if ($answer.model.providerID -cne 'openai' -or $answer.model.id -cne 'gpt-6-sol' -or $answer.model.variant -cne 'default') { throw 'OPENCODE_RESPONSE_MODEL_MISMATCH' }
    $texts = @($answer.content | Where-Object type -EQ 'text' | ForEach-Object text)
    if ($texts.Count -ne 1 -or !$texts[0]) { throw 'OPENCODE_MESSAGE_MISSING' }
    return @{ id = $answer.id; text = $texts[0]; tools = 0; tokens = $answer.tokens; model = $answer.model }
}
function Auto-SessionPrompt($Server, [string]$SessionId, [string]$Prompt, [int]$TimeoutMs) {
    $path = "/api/session/$SessionId"
    $sent = Auto-Api $Server.client 'POST' "$path/prompt" @{ text = $Prompt } 'OPENCODE_PROMPT_FAILED'
    if ($sent.data.sessionID -cne $SessionId -or $sent.data.type -cne 'user' -or $sent.data.id -cnotmatch '^msg_[a-zA-Z0-9]+$') { throw 'OPENCODE_PROMPT_FAILED' }
    $deadline = [datetime]::UtcNow.AddMilliseconds($TimeoutMs)
    do {
        if ($Server.process.HasExited) { throw 'OPENCODE_SERVER_UNAVAILABLE' }
        $all = @(); $cursor = $null
        for ($page = 0; $page -lt 8; $page++) {
            $url = if ($cursor) { "$path/message?cursor=$([uri]::EscapeDataString($cursor))&limit=100" } else { "$path/message?order=asc&limit=100" }
            $messages = Auto-Api $Server.client 'GET' $url $null 'OPENCODE_MESSAGE_MISSING'
            $all += @($messages.data)
            if (@($messages.data).Count -lt 100 -or !$messages.cursor.next) { break }
            if ($messages.cursor.next -ceq $cursor) { throw 'OPENCODE_MESSAGE_MISSING' }
            $cursor = $messages.cursor.next
        }
        if ($page -ge 8) { throw 'OPENCODE_MESSAGE_MISSING' }
        $result = Auto-SelectTurn @{ data = $all } $SessionId $sent.data.id
        if ($result) { return $result }
        Start-Sleep -Milliseconds 400
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'OPENCODE_TIMEOUT'
}
