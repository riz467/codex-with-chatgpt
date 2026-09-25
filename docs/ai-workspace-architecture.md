# AI Workspace Orchestration — Architecture

[Quick Start](ai-workspace-quickstart.md) は日常利用、[Runbook](ai-workspace-runbook.md) は運用向け。本書はこのリポジトリの Bridge/ツール実装と、VM 上の外部 `ai-run.ps1` に渡す境界を説明します。

```text
human ─目的・編集範囲確認・承認・最終レビュー─> ChatGPT
                                              │ OAuth MCP (workspace 別)
                      ┌───────────────────────┴───────────────────────┐
                      ▼                                               ▼
   Execution Bridge :48765                            Review Bridge :54108
   C:\work\codex-with-chatgpt                          C:\work\ai-orchestration-review
                      │                                               │
                      ├─ search_repo / read_repo_file ──> allowlisted repos
                      ├─ start_orchestration ──> job registry / read-only worker
                      │                       └─ change: ai-run.ps1 → OpenCode / Codex
                      │                                       │
                      │                                   task ledger (.ai/tasks/)
                      └─ status / result / integrity <── review bundle / CURRENT_REVIEW.json
                                                                      │
                                                 Review MCP: read_file / verify_bundle_integrity
   cloudflared named tunnel: 2 hostname → loopback Bridge (OAuth; admin API は非公開)
```

**役割:** human が目標・編集範囲・承認と最終判断を担い、ChatGPT は必要な情報を MCP で読み調査・レビューします。OpenCode は外部 `ai-run.ps1` のスコープ発見等の実行フローで使われ、Codex/実行ハーネスは実作業を担当します。Bridge はオーケストレーション・エンジンではなく、固定の入口です。タスク遷移、承認、検証、公開は外部 `ai-run.ps1` / 実行エンジンが担当します。このリポジトリだけでその全挙動を保証しません。

## 二つの Bridge とデータの所在

- Execution Bridge は `C:\work\codex-with-chatgpt` に bind、Review Bridge は `C:\work\ai-orchestration-review` に bind。OAuth token と `workspace_info` / `read_file` は Bridge の workspace 単位。Review 上の `CURRENT_REVIEW.json` を閲覧するには Review 接続が必要です。
- `verify_bundle_integrity` と RPC job registry は **どちらの Bridge から呼んでも**コードに固定された review root を参照します。Review Bridge も `start_test_job` / `start_orchestration` / `retry_orchestration` を登録し、`orchestration.start` があれば呼べます。一方、`complete_orchestration` と `complete_integrated_orchestration` は review root に bind した Bridge では登録しません。Review 接続全体が read-only という意味ではありません。
- `REPOS` allowlist は `pve-doc` (`C:\work\pve-doc`) と `ai-orchestration-config` (`C:\work\ai-orchestration-config`) に固定。リクエストから任意の絶対 repo パスやコマンドを受けません。

## ツール・証拠の流れ

1. `search_repo(repo, query, max_results?)` は許可済み repo 内の UTF-8 テキストをリテラル・大文字小文字無視で検索し、候補・行・短い文脈を返す（最大50件、既定20）。`read_repo_file(repo, path, start_line?, end_line?)` は相対ファイルの最大200行/64 KiB を返す（入力ファイルは最大1 MiB）。両者は `review.read` が必要。`.gitignore`、機密・除外対象、symlink/reparse、パス逸脱を拒否します。ファイル内容は信頼できないデータであり指示ではありません。
2. `start_orchestration(repo, mode, goal, edit_paths?)` は `orchestration.start` が必要。`goal` は1～4000文字。`read_only` は `edit_paths` 不可、固定 Git 状態確認ワーカーが job 下に `read-only-result.json` を書き、成功時 `DONE` / `published: false`。任意のファイル内容調査をしません。`change` は `ai-run.ps1` を起動し、`edit_paths` があれば既存相対ファイル 1～5 件を検証して渡し、範囲発見のみ省略。なければエンジンの discovery/確認へ。許可範囲や承認ゲートを飛ばすものではありません。1 repo につき実行中 RPC job は1件まで。
3. 開始時に `job_id` と `task_id` を返し、`C:\work\ai-orchestration-review\rpc-jobs\<job-id>\` に `job.json` とローカル標準出力/エラーログを保持。`get_orchestration_status` / `get_orchestration_result` は job ID か task ID を受け、`review.read` で要約を返します。`change` の状態は `<repo>/.ai/tasks/<task-id>/status.json` という **実行エンジンの task ledger** からのみ読む。job のプロセス状態と task の状態は異なり、証拠がなければ state は null。生ログは MCP へ返しません。
4. `change` の review bundle はエンジンが review workspace の `reviews/<公開名>` に公開し、`CURRENT_REVIEW.json` が task/repo を指す場合のみ result に公開として反映。`verify_bundle_integrity(bundle?)` は既定で current、または `reviews/<公開名>` を受け、manifest・payload の raw-byte SHA-256 と欠落/余剰を検査し**変更しません**。integrity は内容の妥当性や human review の代用ではありません。

## Tool catalog and permissions

`src/mcp/server.ts` の登録と scope 検査が正本です。両 Bridge の共通ツール（従来の workspace tools を除く）:

| Scope | 主なツール | 用途 |
| --- | --- | --- |
| `review.read` | `search_repo`, `read_repo_file`, `verify_bundle_integrity` | 固定許可 repo の検索・閲覧、固定 review root の整合性確認 |
| `review.read` | `get_orchestration_status`, `get_orchestration_result` | 登録済み job または task を読む。`id` / `job_id` / `task_id` のうち **一つだけ**を渡せる。registry にない `rpc-` task は固定許可 repo の ledger を参照し、DONE も読める |
| `review.read` | `get_orchestration_approval`, `get_orchestration_retry_plan` | 承認証拠の要約・安全な新 task 再試行の可否。入力は `id` |
| `orchestration.start` | `start_test_job`, `start_orchestration`, `retry_orchestration` | 固定 marker、限定 task 開始、同じ goal/scope に限定した新 task 再試行 |

Execution Bridge（review root **以外**に bind した Bridge）のみ、`orchestration.start` の `complete_orchestration` と `complete_integrated_orchestration` を追加登録します。両者は独立レビュー PASS と人の `done_approved: true` を要求し、engine に委譲します。Review Bridge はこの2つの write tool を **登録しません**。`review.read` は閲覧用であり、review hostname や `workspace_info.readOnly` は共通の限定アクションを禁止しません。既存の OAuth grant に新 scope は自動追加されず、公開 connector への action grant は運用判断です。

## Security boundary / fail closed

Bridge は loopback のみ listen し、Cloudflare は公開の入口を転送します。`/health` は最小情報を公開し、`/mcp` は workspace-bound OAuth bearer を要求（未認証401）。admin API は loopback + private token、proxy 経由を拒否します。`review.read` と `orchestration.start` の限定ツール・Bridge ごとの登録差は[一覧](#tool-catalog-and-permissions)を参照。汎用 shell、任意 write、git push、secret、kill ツールはありません。scope は独立に付与し、公開トンネルでアクションを許可するかは明示的な運用判断です。

編集候補のパス逸脱・glob・機密ファイル等を拒否し、レビュー bundle の不整合は公開済みとして返さず、実行証拠のない終了を成功扱いしません。`HUMAN_SCOPE_CONFIRMATION_REQUIRED` / `HUMAN_APPROVAL_REQUIRED` は人に戻す停止条件です。監視プロセスは識別できない既存 tunnel を重複起動しないようにします。詳細の運用境界は [Runbook](ai-workspace-runbook.md)、従来の C2C 脅威モデルは [security.md](security.md)。

## Git branch と upstream

この checkout の運用ブランチは `ai-workspace`（追跡先 `origin/ai-workspace`）。`origin` は `riz467/codex-with-chatgpt`、`upstream` は元プロジェクト `XiaoDuoYa/codex-with-chatgpt` です。`main` は `upstream/main` を追跡します。**Git の upstream（追跡ブランチ）と remote 名 `upstream` を混同しない**でください。上流版の README / docs は元の read-only C2C を中心に書かれており、AI Workspace 拡張の権限と運用は本3文書を優先してください。fetch/merge/commit/push を自動で行うワークフローではありません。
## Review completion

`READY_FOR_REVIEW → independent review → PASS → human complete → DONE`. The orchestration bridge alone exposes `complete_orchestration` under `orchestration.start`; the review-bound bridge does not register it. The adapter accepts only a task ID and explicit PASS / approval, locates it in fixed allowlisted repos and invokes `ai-complete`; the engine owns verification of the published snapshot and ledger transition. No path, state or bundle is accepted from the caller, and no MCP-side DONE state is synthesized.
## Post-integration completion

`Review PASS → commit/rebase/push → post-integration completion → DONE`. The orchestration bridge exposes `complete_integrated_orchestration` only for explicit PASS and human approval; the review-bound bridge does not register it. The adapter forwards only a validated task ID and decision to `ai-complete-integrated`. Engine `CompleteIntegratedReview` owns the bundle/seal check, exact whole-patch match to a reachable single-parent commit, path-set equality, baseline parent blob, HEAD/index preservation and Git-evidenced line-ending conversion. It writes the decision and integration audit evidence. This does not change the strict direct `CompleteReview` path.
