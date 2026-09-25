# AI Workspace Orchestration — 運用 Runbook (Windows VM)

日常利用は [Quick Start](ai-workspace-quickstart.md)、設計・権限境界と[Bridge 別ツール一覧](ai-workspace-architecture.md#tool-catalog-and-permissions)は [Architecture](ai-workspace-architecture.md)。以下はリポジトリ内の固定デプロイスクリプトと Bridge 実装に基づく構成です。ChatGPT の UI と Cloudflare DNS/ingress 設定そのものはこのリポジトリで管理していません。

`job_id` は実行中の追跡用、`task_id` は長期的な正式識別子です。DONE 後も `get_orchestration_status` / `get_orchestration_result` に `task_id` を渡して読み取れます（registry がなければ固定 allowlist の task ledger を参照）。

## 常駐構成と確認

Task Scheduler の `AI-Workspace-Gateway` は `workspace` ユーザーの **AtStartup / S4U** タスク。`scripts/run-ai-workspace-gateway.mjs` が次の3プロセスを監視・再起動します（`serve` は常駐、`start` は別の起動方式）。

| 役割 | 固定の接続先 | 公開 URL |
| --- | --- | --- |
| Execution Bridge (`C:\work\codex-with-chatgpt`) | `127.0.0.1:48765` | `https://ai-workspace-mcp.m1n4m0.me/mcp` |
| Review Bridge (`C:\work\ai-orchestration-review`) | `127.0.0.1:54108` | `https://ai-orchestration-review.m1n4m0.me/mcp` |
| cloudflared | `C:\Users\workspace\.cloudflared\config.yml` の named tunnel `ai-workspace-mcp` | 上記2 hostname の経路 |

**AI Workspace Orchestration / AI Orchestration Review は ChatGPT 側の接続表示名**です。表示名自体はこのリポジトリのコードで固定していません。誤接続を防ぐには接続先 URL と `workspace_info` / `/health` の workspaceId を照合します。

Node は `C:\Users\workspace\AppData\Local\Author Software\nvm\installs\v24.16.0\node.exe`、cloudflared は `C:\Program Files (x86)\cloudflared\cloudflared.exe` を固定指定。Node の切替時はスクリプト両方のパスを確認します。`serve` はポート競合の瞬間に別ポートへ退避し得るため、**ポートと workspaceId の両方**を確認してください。

リポジトリのルートから PowerShell 7 で、まず**確認だけ**行います:

```powershell
pwsh -NoProfile -File scripts/status-ai-workspace-gateway.ps1
```

起動・停止が必要と判断した場合に限り、**どちらか一方**を個別に実行します（停止しても AtStartup は無効になりません）:

```powershell
pwsh -NoProfile -File scripts/start-ai-workspace-gateway.ps1
# または: pwsh -NoProfile -File scripts/stop-ai-workspace-gateway.ps1
```

`install-ai-workspace-gateway.ps1` は初回のみ、**workspace アカウントの管理者権限 PowerShell** から実行。既存タスクがあると拒否し、既存の前景プロセスを止めません。切替時は前景の対象 PID・command line を確認してから個別に停止し、無関係なプロセスや認証ストアを触らないでください。

```powershell
pwsh -NoProfile -File scripts/install-ai-workspace-gateway.ps1
```

## VM 再起動後の確認（再起動そのものは人の許可を得て実施）

1. `status-ai-workspace-gateway.ps1` でタスクが `Running`、S4U の `workspace`、supervisor と2 Bridge + cloudflared、LastTaskResult と固定ポートの listener PID を確認。S4U はネットワーク資格情報を持たないので実タスク権限での通信も確認。
2. 両ローカル・両公開 URL の `/health` が **200** で、それぞれの `workspaceId` が意図した workspace と一致することを確認（同じ環境の再起動前 ID があれば照合）。`/mcp` の**未認証**アクセスは **401** が期待値。`status` スクリプトは4経路を表示します。
3. ChatGPT の2つの MCP 接続で、意図した workspace の `workspace_info` 等が使えることを確かめる。200/401 だけでは OAuth 許可やツール利用成功を証明しません。
4. `C:\work\ai-workspace-logs\` の `execution-bridge.log`、`review-bridge.log`、`cloudflared.log` と Task Scheduler の起動結果を確認。Supervisor は子プロセスの標準出力を記録しません（各ファイル5 MiB 閾値で3世代ローテーション）。Bridge 自身のログは `%LOCALAPPDATA%\codex-with-chatgpt\logs\`（`c2c logs -w <workspace>`）。タスクの標準出力を見たい場合は別途認証情報の漏洩に注意。

## OAuth / pairing / ツール更新

各 Bridge は別 workspace の認証ストア（`C:\Users\workspace\AppData\Local\codex-with-chatgpt\auth\<workspace-id>.json`）を使用します。`review.read` は repo 検索・状態/結果・integrity・approval inspection・retry plan、`orchestration.start` は start/retry と Execution Bridge の completion に必要。既存 OAuth grant に新 scope は自動で追加されません。接続先と同意画面の scope を確認して再認可します。Review hostname や `workspace_info.readOnly` は Bridge 全体のアクション禁止を意味しません。ただし review-bound Bridge は `complete_orchestration` / `complete_integrated_orchestration` を登録しません。必要なクライアント以外に `orchestration.start` を付与しないでください。

配対コードは該当 workspace の Bridge が起動している状態で、ChatGPT の Authorize 画面を開いてから **VM ローカル**で発行します:

```powershell
# 接続する側の一行だけ実行する
node bin/c2c.js pair -w C:\work\codex-with-chatgpt
# Review 側なら代わりに: node bin/c2c.js pair -w C:\work\ai-orchestration-review
```

使用する接続先のコードだけ発行します。単回・約5分有効で、再発行すると古いコードは無効。コードや token をログ・チャットに貼らないでください。`unpair` は既存認可を取り消すため、通常の再接続手順として実行しません。

**MCP Refresh / Scan Tools** が必要になるのは、ChatGPT 接続が以前取得したツール一覧を保持しており、新ツールが出てこない場合です。まず Bridge のビルド・起動・OAuth を確認し、その後接続側でツールの再取得を試します。UI 表示名や操作はクライアントに依存します。MCP schema / 登録ツールのコードを変えたときは `corepack pnpm build` 後に **両 Bridge を再起動**して新しい `dist` をロードする必要があります。文書だけの変更では不要。再取得だけでは古い稼働プロセスに新ツールは追加されません。

## よくある障害と切り分け順序

1. **tool が見えない:** 正しい MCP/会話か → status と workspaceId → 両 `/health` / 匿名 `/mcp` → OAuth scope → 接続側 Refresh / Scan Tools。新コードなら build + Bridge 再起動。`INSUFFICIENT_SCOPE` なら同意を再確認。
2. **`Required at mode`:** この文字列はこのリポジトリの MCP エラー定義にはありません。原因を決めつけず、表示全文・利用中の ChatGPT 接続・選択モードを採取し、正しい MCP と tool が選択されているかを確認する。
3. **workspace 違い:** 2つの `/health` の `workspaceId`、`workspace_info` の接続先、ChatGPT の選択 MCP を比較。Review の `CURRENT_REVIEW.json` を `read_file` で読むには Review Bridge の接続が必要。integrity ツールの固定 review root と、`read_file` の Bridge-bound workspace は別。
4. **`HUMAN_SCOPE_CONFIRMATION_REQUIRED`:** `change` で編集範囲の確定が必要。scope discovery が task ledger 作成前に止まる場合、MCP result だけでは候補パスが見えない。VM ローカルの job stdout を確認し、repo 検索・ファイル閲覧と人の確認後、既存相対ファイル 1～5 件を `edit_paths` で指定。無条件に再試行しない。
5. **`HUMAN_APPROVAL_REQUIRED` / `NEEDS_APPROVAL`:** ChatGPT に「何で止まった？ proposal を確認したい」と依頼。`get_orchestration_status` / `get_orchestration_result` と read-only `get_orchestration_approval` に job/task ID を渡すと、engine の status と最終構造化proposalから理由・予定のfile scope・変更案のハッシュ・risky action・commit/push要求・検証状態が分かる。生ログや置換本文は返さない。`approval reason unavailable` は証拠に理由がない意味。**現行engineに `NEEDS_APPROVAL → EXECUTING` の正式な承認・再開経路はない**。`HUMAN_APPROVAL_REQUIRED` は新task再試行も拒否。`EVIDENCE_INSUFFICIENT` 等は下記のread-only判定に合格し、利用者が明示依頼した場合に限り新taskとして再試行可能。goal言い換え、ledger書換えは禁止。
6. **`cloudflared commandline unavailable`:** status スクリプトがプロセスの command line を取得できない状態。トンネル停止と断定しない。公開 `/health` と接続先の PID/権限、Task Scheduler と supervisor ログを照合。Supervisor は識別に失敗したとき重複起動を避けるため起動を見送る場合がある。確認なしに別トンネルを起動しない。

`process: exited` でも state が null の場合、Bridge が子の stdout/stderr を MCP に返さない設計です。VM ローカルの `C:\work\ai-orchestration-review\rpc-jobs\<job-id>\` 内 `job.json` / `stdout.log` / `stderr.log` を権限管理下で調査してください。`REPO_BUSY` なら同じ repo の稼働中 job を確認。復旧時も auth ファイル削除・無関係なプロセス停止・再起動を先にしないこと。

### 停止理由の読み方

MCP の `stop_reason_category` はengine stateとは別の、status・最終structured proposal・記録済み結果に基づく表示用分類です。`stop_reason_summary` は根拠の短い引用、`recommended_next_action` は行動の案内です。`human_action_required` は承認/範囲確定という**人の判断**の要否であり、実行権限を与えるフラグではありません。engineの `NEEDS_APPROVAL` と `HUMAN_APPROVAL_REQUIRED` は証拠不足も含め従来のまま残ります。

| 分類 | 主な根拠 | 対応 |
| --- | --- | --- |
| `HUMAN_APPROVAL_REQUIRED` | 提案に操作・承認要求がある、または安全に細分化できない | 人がproposalを確認。正式な承認再開経路は未実装 |
| `SCOPE_CONFIRMATION_REQUIRED` | ledger前のscope確認結果、またはproposalに編集範囲不明と明記 | 候補を調査し範囲を確定。gateを迂回しない |
| `EVIDENCE_INSUFFICIENT` | structured proposalが調査失敗/読取タイムアウトを明示し、編集案・コマンドなし | 原因を調べ、運用担当の確認後に同範囲の再調査を検討。停止中taskは再開しない |
| `VERIFY_BLOCKED` | `VERIFYING → BLOCKED` と `VerifyInternal failed`、verify exit証拠 | 検証証拠を確認。`ai-resume` はengine preflightに合格する場合のみ |
| `EXECUTION_BLOCKED` | その他の `BLOCKED` またはledger未生成の失敗 | 環境・実行証拠を調査 |
| `READY_FOR_REVIEW` | engineの `READY_FOR_REVIEW` | 独立したレビュー |

証拠不足と表示されても `state: NEEDS_APPROVAL` は維持されます。`human_action_required: false` を「同一taskの再実行が許可された」と解釈しないでください。根拠が不明な場合は保守的に人の確認へ戻します。

### 安全な新task再試行

「もう一回調べて」と明示された場合、まず `get_orchestration_retry_plan`（`review.read`、read-only）で `eligible` と理由、引き継ぐgoal・repo・mode・edit_pathsを確認します。元jobは終了済み、goalは登録済みSHA-256と一致、変更taskは元の1～5既存ファイル・engine allowlistが一致しパスが現在も安全、適用済み編集がないことが条件です。scope確認は**元の明示scopeがjob registryに記録済み**の場合のみ。古いledger前停止でgoalやscopeを復元できなければ拒否します。`EXECUTION_BLOCKED` は元の編集scopeが安全に復元できる場合だけ、`VERIFY_BLOCKED` は別の正式なRetryVerify preflightへ、`HUMAN_APPROVAL_REQUIRED` と `READY_FOR_REVIEW` は禁止です。

`retry_orchestration` は `orchestration.start` 権限を必要とし、入力は `id`（job IDまたはtask ID）と任意の短い `retry_reason` だけです。callerがrepo・goal・実行コマンド・edit_pathsを変更することはできません。元task/元jobの証跡は書き換えず、固定の `ai-run` を元のgoal・scopeで呼び、新task側のjob registryに `parent_task_id`、rootを表す `retry_of`、`retry_reason`、`attempt` を保存します。同じ親からの重複起動は予約ファイルで拒否し、最大3試行（初回を含む）。元jobと新jobそれぞれのstatus/resultをIDで追跡してください。元の `NEEDS_APPROVAL` はそのままであり、新taskもengineの通常gateで再判定されます。繰り返し回避や無条件再試行に使わないでください。
## Independent review completion

`READY_FOR_REVIEW → independent review → PASS → human complete → DONE`. First run `ai-complete -Repo C:\work\pve-doc -TaskId <task-id> -Preflight` (read-only). After independently reviewing the exact current published bundle, a human may run `ai-complete -Repo C:\work\pve-doc -TaskId <task-id> -ReviewResult PASS -DoneApproved`, or explicitly instruct the Orchestration MCP to call `complete_orchestration` with `task_id`, `review_result: PASS`, `done_approved: true`. Never call it merely because the bundle exists. The Review MCP remains read-only. The engine checks snapshot seal, manifest, ledger and source hashes; on success inspect `.ai/tasks/<task-id>/review-decision.json` and the audit transition. A post-publication commit is permitted when edited content still matches the published hash; subsequent edits or a different current review pointer block completion.
## Post-integration completion

`Review PASS → commit/rebase/push → post-integration completion → DONE`. If strict `ai-complete` rejects a post-commit raw-file hash, **do not relax that gate**. Run `ai-complete-integrated -Repo C:\work\pve-doc -TaskId <task-id> -Preflight` to check the exact reviewed whole patch, path set and reachability, HEAD/index blobs and explained worktree line endings. After independent PASS and explicit human DONE approval, use the same CLI with `-ReviewResult PASS -DoneApproved`, or instruct the Orchestration MCP to call `complete_integrated_orchestration` with `task_id`, `review_result: PASS`, `done_approved: true`. Review MCP remains read-only. Inspect `integration-completion.json`, `review-decision.json` and task audit afterward. A merely similar patch, changed content or unreachable commit is refused.
