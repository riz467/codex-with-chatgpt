// Test subprocesses use PowerShell 7 from PATH; production launchers stay pinned.
export function testPowerShellExecutable(): string {
  return process.platform === "win32" ? "pwsh.exe" : "pwsh";
}
