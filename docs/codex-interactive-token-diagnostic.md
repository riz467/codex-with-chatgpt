# InteractiveToken vs existing S4U: one-shot runner diagnostic

Run from **elevated PowerShell as the logged-on `workspace` user** in this checkout:

```powershell
pwsh -NoProfile -File .\scripts\run-codex-interactive-token-diagnostic.ps1
```

The script refuses an existing diagnostic log directory or task. It registers a triggerless, temporary `AI-Workspace-Codex-InteractiveToken-Diagnostic` task (`workspace`, `Interactive` / *run only when user is logged on*, `Highest`, working directory `C:\work\pve-doc`). It starts the task once and unregisters it in `finally`. The task records identity, SessionId, interactive/batch group and its actual principal before invoking the **same fixed read-only Codex worker/prompt exactly once**, with its original approval, sandbox and timeout settings. It reads (but never reruns) `C:\work\ai-workspace-logs\codex-s4u-diagnostic\s4u.*` for comparison. Nothing is changed in the production Gateway or task; do not commit/push as part of diagnosis.

Results are under `C:\work\ai-workspace-logs\codex-interactive-token-diagnostic\` (`task-context.json`, `interactive.json`, stdout/stderr, `comparison.json`). Four read checks require successful execution lines in the Codex stderr transcript, not merely a natural-language assertion. `0xc0000142` is reported only if captured in the respective stdout/stderr; the historical S4U trace records a runner pipe timeout but does **not** itself record the runner's native exit status. The prior S4U SessionId was not recorded, so the comparison leaves it unknown rather than assuming Session 0. Do not retry production or change the Gateway resident mode from this one test alone.
