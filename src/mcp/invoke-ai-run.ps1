#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Repo, [Parameter(Mandatory)][string]$TaskId,
      [Parameter(Mandatory)][string]$Goal, [Parameter(Mandatory)][string]$EditPathsBase64)
$ErrorActionPreference = 'Stop'
try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EditPathsBase64))
    $decoded = ConvertFrom-Json -InputObject $json -NoEnumerate
    if ($decoded -isnot [array] -or $decoded.Count -lt 1 -or $decoded.Count -gt 5 -or
        @($decoded | Where-Object { $_ -isnot [string] }).Count -ne 0) { throw 'Invalid EditPaths array' }
    [string[]]$paths = @($decoded)
    & 'C:\Users\workspace\.local\bin\ai-run.ps1' -Repo $Repo -TaskId $TaskId -Goal $Goal -EditPaths $paths
    exit $LASTEXITCODE
} catch {
    'RESULT: BLOCKED'
    'Reason: Invalid EditPaths adapter invocation'
    exit 1
}
