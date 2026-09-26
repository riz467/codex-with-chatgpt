#requires -Version 7.0
# Isolated negative fixture only. Never run for an actual user task.
$prompt = [Console]::In.ReadToEnd()
if ($prompt -cnotmatch "task_id must be '(rpc-[a-f0-9]{32})'") { exit 2 }
$taskId = $Matches[1]
if ($prompt -cnotmatch 'Goal: .+30_000 to exactly 60_000 milliseconds' -or
    $prompt -cnotmatch 'Allowed paths: src/workspace/git.ts') { exit 2 }
$proposal = [ordered]@{ task_id = $taskId; state = 'EXECUTING'; approval_required = $false
    message = 'Fixture wrong-change proposal for independent semantic veto'; proposed_command = ''
    edits = @([ordered]@{ path = 'src/workspace/git.ts'; old_text = 'timeout: 30_000,'; new_text = 'timeout: 45_000,' }) }
[Console]::Out.Write((ConvertTo-Json -InputObject $proposal -Depth 5 -Compress))
