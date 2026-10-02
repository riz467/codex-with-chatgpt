import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
const accountSid = (name: string) => `([Security.Principal.NTAccount]::new(${name})).Translate([Security.Principal.SecurityIdentifier]).Value`;
const prelude = String.raw`
# Fixture-only OS account lookup and Scheduled Task data constructors. No registration.
$FixtureWorkspaceSid = 'S-1-5-21-1389881484-3427664689-3699660927-1000'
function Resolve-FixtureAccountSid($Account) {
    if ($Account -in @('workspace', "$env:COMPUTERNAME\workspace")) { return $FixtureWorkspaceSid }
    if ($Account -eq 'OTHER\workspace') { return 'S-1-5-21-1-2-3-1000' }
    throw 'Fixture account not found'
}
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) [pscustomobject]@{ Execute=$Execute; Arguments=$Argument; WorkingDirectory=$WorkingDirectory } }
function New-ScheduledTaskTrigger {
    param([switch]$AtStartup, [switch]$AtLogOn)
    [pscustomobject]@{ Enabled=$true; CimClass=[pscustomobject]@{ CimClassName=$(if ($AtStartup) {'MSFT_TaskBootTrigger'} else {'MSFT_TaskLogonTrigger'}) } }
}
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) [pscustomobject]@{ UserId=$UserId; LogonType=$LogonType; RunLevel=$RunLevel } }
function New-ScheduledTaskSettingsSet {
    param([switch]$Hidden, $MultipleInstances, $RestartCount, [TimeSpan]$RestartInterval, [TimeSpan]$ExecutionTimeLimit,
        [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
    [pscustomobject]@{ Enabled=$true; Hidden=[bool]$Hidden; MultipleInstances=$MultipleInstances; RestartCount=$RestartCount;
        RestartInterval=[Xml.XmlConvert]::ToString($RestartInterval); ExecutionTimeLimit=[Xml.XmlConvert]::ToString($ExecutionTimeLimit);
        StartWhenAvailable=[bool]$StartWhenAvailable; DisallowStartIfOnBatteries=(-not $AllowStartIfOnBatteries);
        StopIfGoingOnBatteries=(-not $DontStopIfGoingOnBatteries); RunOnlyIfNetworkAvailable=$false }
}
function New-ScheduledTask { param($Action, $Trigger, $Principal, $Settings) [pscustomobject]@{ Actions=@($Action); Triggers=@($Trigger); Principal=$Principal; Settings=$Settings } }
`;

/** Copies preserve the real validators and script imports; only OS SID lookups use synthetic accounts. */
export function createWindowsTaskFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc01-task-fixture-"));
  const names = ["ai-workspace-dashboard-task.ps1", "observe-ai-workspace-health.ps1", "ai-workspace-gateway.ps1",
    "codex-worker-task-config.ps1", "workspace-interactive-session.ps1", "status-ai-workspace-dashboard.ps1",
    "launch-codex-interactive-worker.vbs", "start-codex-interactive-worker.ps1"];
  try {
    for (const name of names) {
      let source = fs.readFileSync(path.join(scripts, name), "utf8");
      const accounts = name === "ai-workspace-dashboard-task.ps1" ? ["$DashboardAccount", "$UserId"] :
        name === "observe-ai-workspace-health.ps1" ? ["$account"] : [];
      for (const account of accounts) {
        const expression = accountSid(account);
        if (source.split(expression).length !== 2) throw new Error(`OS SID fixture expression changed: ${name} ${account}`);
        source = source.replace(expression, `(Resolve-FixtureAccountSid ${account})`);
      }
      if (name === "ai-workspace-dashboard-task.ps1") source = `${prelude}\n${source}`;
      fs.writeFileSync(path.join(root, name), source, { flag: "wx" });
    }
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
  return {
    script(name: string) {
      if (!names.includes(name)) throw new Error("Unknown fixture script");
      return path.join(root, name);
    },
    dispose() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}
