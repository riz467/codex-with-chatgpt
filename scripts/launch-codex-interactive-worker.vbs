' Fixed, windowless task entrypoint. Wait for the child so Task Scheduler tracks its lifetime.
Option Explicit
Dim shell, code
Set shell = CreateObject("WScript.Shell")
code = shell.Run("""C:\Program Files\PowerShell\7\pwsh.exe"" -NoProfile -NonInteractive -WindowStyle Hidden -File ""C:\work\codex-with-chatgpt\scripts\start-codex-interactive-worker.ps1""", 0, True)
WScript.Quit code
