# One-shot Codex S4U profile/hive observation

This is separate from the existing runner diagnostic. It does not touch the production Gateway/task, change sandbox/approval or timeouts, load/unload a hive, change profile/ACL, or commit/push. It writes to `C:\work\ai-workspace-logs\codex-s4u-profile-diagnostic\` and refuses existing per-mode evidence. The profile observer only queries registry/profile/process identity; the subsequent S4U Codex call uses the **unchanged fixed read-only** prompt and flags from `codex-s4u-diagnostic-worker.ps1`, once.

The interactive profile observation was collected from `workspace` in a non-elevated interactive session. To collect S4U evidence, open **elevated PowerShell as workspace** and run from this checkout:

```powershell
pwsh -NoProfile -File .\scripts\run-codex-s4u-profile-diagnostic.ps1 -S4UOnly
```

Do not repeat a run when `s4u.profile.json` or `s4u.json` already exists. The temporary `AI-Workspace-Codex-Profile-Diagnostic` task uses S4U and is unregistered in `finally`. The observer runs inside that task **before** Codex, at `C:\work\pve-doc`. Review `interactive.profile.json`, `s4u.profile.json`, `s4u.json`, `s4u.stderr.log` and `comparison.json`. The comparison includes UTC observation/start/end and detects the exact 15000 ms runner-pipe timeout string; stderr has no timestamp for each timeout line, so its exact onset cannot be measured. HKCU/HKU root-listing equality is only supporting evidence of hive mapping, not conclusive proof of identical backing storage. If S4U evidence is incomplete, inspect the task result/error without retrying or changing production.
