#requires -Version 7.5
# Port of ai-orchestration-config/scripts/bounded-opencode-proposal.ps1.
param(
    [Parameter(Mandatory)][string]$Repo,
    [ValidateSet(120000,300000)][int]$PromptTimeoutMs = 120000
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'opencode-session.ps1')
[Console]::InputEncoding = $AutoUtf8
[Console]::OutputEncoding = $AutoUtf8
$OutputEncoding = $AutoUtf8
$server = $null; $phase = 'PREFLIGHT'; $id = $null
$selectedModel = @{ providerID = 'openai'; id = 'gpt-6-sol'; variant = 'default' }
try {
    try {
        $repoPath = Auto-SafePath $Repo
        if (!(Test-Path -LiteralPath $repoPath -PathType Container)) { throw 'INVALID_REPO' }
        $source = Auto-SafePath (Join-Path $PSScriptRoot 'c2c-bounded-proposer.md')
        $projectAgent = Join-Path $repoPath '.opencode/agents/c2c-bounded-proposer.md'
        $installed = if (Test-Path -LiteralPath $projectAgent -PathType Leaf) { $projectAgent }
            else { Join-Path $HOME '.config/opencode/agents/c2c-bounded-proposer.md' }
        $installed = Auto-SafePath $installed
        if (!(Test-Path -LiteralPath $installed -PathType Leaf) -or
            (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash) {
            throw 'OPENCODE_PROPOSAL_AGENT_NOT_INSTALLED'
        }
        if (Auto-SamePath $installed $projectAgent) {
            $tracked = & $AutoGit -C $repoPath -c core.fsmonitor=false ls-files --error-unmatch -- '.opencode/agents/c2c-bounded-proposer.md' 2>$null
            if ($LASTEXITCODE -ne 0 -or $tracked -cne '.opencode/agents/c2c-bounded-proposer.md') { throw 'OPENCODE_PROPOSAL_AGENT_UNTRUSTED' }
            $diff = & $AutoGit -C $repoPath -c core.fsmonitor=false diff --no-ext-diff --no-textconv HEAD -- '.opencode/agents/c2c-bounded-proposer.md'
            if ($LASTEXITCODE -ne 0 -or $diff) { throw 'OPENCODE_PROPOSAL_AGENT_UNTRUSTED' }
        }
        $sourceText = [IO.File]::ReadAllText($source, $AutoUtf8)
        if ($sourceText -cnotmatch '(?s)\A---\r?\n.*?\r?\n---\r?\n(.+)\z') { throw 'OPENCODE_AGENT_UNAVAILABLE' }
        $system = $Matches[1].Trim()
        $prompt = [Console]::In.ReadToEnd()
        if (!$prompt -or $prompt.Length -gt 262144) { throw 'INVALID_PROMPT' }
        $server = Auto-ServerStart $repoPath
        $phase = 'SCHEMA'
        Auto-AssertSchema $server.version (Auto-Api $server.client 'GET' '/openapi.json')
        $phase = 'OAUTH_METADATA'
        Auto-AssertOAuth (Auto-Api $server.client 'GET' '/api/integration') $repoPath
        $phase = 'AGENT'
        Auto-AssertAgent (Auto-Api $server.client 'GET' '/api/agent') $repoPath $system
        $phase = 'SESSION_CREATE'
        $id = Auto-SessionCreate $server $repoPath $selectedModel
        $phase = 'PROMPT_ATTEMPTED'
        $answer = Auto-SessionPrompt $server $id $prompt $PromptTimeoutMs
        $result = [ordered]@{ worker = 'opencode'; session_id = $id; execution_id = $answer.id;
            provider = $answer.model.providerID; model = $answer.model.id; usage = $answer.tokens; output = $answer.text;
            state = 'completed'; tools = $answer.tools }
    } finally { if ($server) { Auto-ServerStop $server } }
    # Never report successful completion before private server cleanup succeeds.
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 12))
} catch {
    $errorCode = $_.Exception.Message
    if ($errorCode -cnotmatch '^[A-Z][A-Z0-9_]{2,80}$') { $errorCode = 'OPENCODE_WORKER_UNKNOWN' }
    [Console]::Error.WriteLine('BOUNDED_EVIDENCE:' + (ConvertTo-Json -InputObject ([ordered]@{
        phase = $phase; session_id = $id; requested_provider = $selectedModel.providerID
        requested_model = $selectedModel.id; requested_variant = $selectedModel.variant
        oauth_metadata_confirmed = ($phase -in @('AGENT','SESSION_CREATE','PROMPT_ATTEMPTED'))
        prompt_attempted = ($phase -eq 'PROMPT_ATTEMPTED'); error_code = $errorCode
        http_status = $script:AutoLastHttpStatus }) -Compress))
    exit 1
}
