#requires -Version 7.0
# Fixed fixture transport; never selected for a non-fixture task.
$prompt = [Console]::In.ReadToEnd()
if ($prompt -cnotmatch 'Allowed paths: src/workspace/git.ts' -or
    $prompt -cnotmatch 'Goal: .+30_000 to exactly 60_000 milliseconds' -or
    $prompt -cnotmatch "task_id must be '(rpc-[a-f0-9]{32})'") { exit 2 }
$taskId = $Matches[1]
$value = if ($env:CONSOLIDATION_WRONG_CHANGE -eq '1') { '45_000' } else { '60_000' }
$proposal = [ordered]@{ task_id = $taskId; state = 'EXECUTING'; approval_required = $false
    message = 'Isolated bounded fixture proposal'; proposed_command = ''
    edits = @([ordered]@{ path = 'src/workspace/git.ts'; old_text = 'timeout: 30_000,'; new_text = "timeout: $value," }) }
[Console]::Out.Write((ConvertTo-Json -InputObject $proposal -Depth 5 -Compress))
