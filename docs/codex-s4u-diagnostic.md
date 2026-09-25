# Codex runner S4U / Session 0 one-shot diagnostic

This diagnostic never starts an orchestration job, stops the production Gateway, changes the sandbox/approval policy, or changes Codex's runner timeout. It invokes Codex once per mode in `C:\work\pve-doc` with `-a never -C C:\work\pve-doc exec -s read-only` and a fixed inspection-only prompt. The additional `--ephemeral` avoids persisting a Codex session. Do not commit or push as part of the diagnostic.

From **elevated PowerShell as `workspace`** in this checkout, run:

```powershell
pwsh -NoProfile -File .\scripts\run-codex-s4u-diagnostic.ps1
```

The script refuses existing evidence and an existing `AI-Workspace-Codex-Diagnostic` task. It runs the interactive comparison once, registers a separate S4U task (`workspace`, highest run level, working directory `C:\work\pve-doc`), starts it once, waits for completion, and unregisters it in `finally`. The task has no production trigger. If interactive evidence was already collected but S4U registration failed (for example, from a non-elevated shell), **do not re-run the interactive diagnostic**; from elevated PowerShell as `workspace`, run:

```powershell
pwsh -NoProfile -File .\scripts\run-codex-s4u-diagnostic.ps1 -S4UOnly
```

Evidence remains under `C:\work\ai-workspace-logs\codex-s4u-diagnostic\`: `interactive.json`, `s4u.json`, `comparison.json`, and stdout/stderr logs per mode. The worker records UTC start/end, parent and Codex PIDs, observed descendant PIDs/names, exit code, only the requested environment variables, identity, working directory, and best-effort matching named-pipe names. A short-lived runner may escape process sampling; `child_runner_pids: []` is not proof it never started. Do not publish the raw logs without review: Codex stdout/stderr can contain read file contents. No auth store contents or other processes' command lines are collected. No task or temporary prompt file should remain afterward.

Compare exit codes, the exact `timed out after 15000ms connecting runner pipe-in` line in stderr, descendants, and `TEMP`, `TMP`, `USERPROFILE`, `PATH`, `SESSIONNAME`, identity and working directory in `comparison.json`. A timeout **only** under S4U strongly suggests a session/environment dependency, not proof of a specific pipe ACL failure; next inspect pipe creation/ACL and runner spawn with appropriately scoped tools. If S4U succeeds, investigate transient runner failure or other conditions in the original job. In either case do not change production execution mode or retry production orchestration on this evidence alone.
