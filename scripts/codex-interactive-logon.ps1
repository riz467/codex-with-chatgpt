# Keep the worker bound to the known workspace account and an enabled interactive token.
function Test-CodexInteractiveLogon {
    param(
        [string] $UserSid,
        [string] $UserName,
        [int] $SessionId,
        [string[]] $GroupSids,
        [bool] $InteractiveRoleEnabled
    )

    $account = ($UserName -split '\\')[-1]
    return (
        $UserSid -ceq 'S-1-5-21-1389881484-3427664689-3699660927-1000' -and
        $account -ceq 'workspace' -and
        $SessionId -gt 0 -and
        $GroupSids -contains 'S-1-5-4' -and
        $InteractiveRoleEnabled -and
        $GroupSids -notcontains 'S-1-5-3'
    )
}
