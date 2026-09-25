# AI Workspace Orchestration — 5分で再開

この文書は **設定済みの Windows VM / ChatGPT 接続を日常利用する人向け** です。初回接続や障害対応は [Runbook](ai-workspace-runbook.md)、仕組みと[Bridge 別ツール・権限一覧](ai-workspace-architecture.md#tool-catalog-and-permissions)は [Architecture](ai-workspace-architecture.md) を参照してください。

## まずはこれを頼む

ChatGPT に目的を自然言語で伝えます。ツール名を覚える必要はありません。

> pve-doc の AI Workspace 周りを調べて、必要なら修正してください。まず該当箇所を探して読んでください。変更が必要なら編集対象の既存ファイルと修正内容を示し、私が範囲を確認してから開始してください。commit / push はしないでください。結果と公開されたレビュー資料を確認して報告してください。

できることは、許可されたリポジトリ内の検索・ファイル閲覧、限定されたタスクの起動、状態・結果と公開済みレビュー資料の確認です。**MCP が任意のコマンドや git push を実行できるわけではありません。** 対象リポジトリは `pve-doc` と `ai-orchestration-config` のみです。

通常は接続済みの **AI Workspace Orchestration** で調査・タスク開始・状態確認を行い、**AI Orchestration Review** で公開レビュー資料を読みます。後者はレビュー用 workspace に接続された別の Bridge です。これらは接続の表示名で、コードが表示名を保証するわけではありません。両方とも接続先 workspace を確認してください。名称だけで権限は決まりません。Review Bridge でも `orchestration.start` があれば start/retry を呼べますが、`complete_orchestration` と `complete_integrated_orchestration` は登録されません。

## 普段の流れ

1. 「どのリポジトリの何を調べたいか」を伝える。ChatGPT が `search_repo` で候補を探し、`read_repo_file` で対象行を確認する。検索は文字列の部分一致（大文字小文字を区別しない）で、ファイル内容は読み取り専用です。
2. **変更する場合だけ**、調査で確認した既存ファイルの repo 相対パスを 1～5 件まで `edit_paths` として確定する。候補が不明なら先に調査し、人が範囲を確認する。`edit_paths` なしでも `change` は起動できますが、実行側の自動範囲発見と確認ゲートに委ねられます。
3. `start_orchestration` を `repo`、`mode`、`goal`（変更時は必要に応じて `edit_paths`）で開始する。すぐに返る `job_id` / `task_id` を控える。同じ repo に実行中の RPC job があれば開始は拒否されます。
4. `get_orchestration_status` を ID で確認し、`get_orchestration_result` で要約・検証状態を読む。`job_id` は実行中の追跡用、`task_id` は長期的な正式識別子です。DONE 後も `task_id` で status/result を取得できます。`process: exited` だけで成功とは判定しません。証拠ができず `state: null` の場合は運用担当に渡します。
5. `change` のレビュー資料が公開された場合、AI Orchestration Review で `CURRENT_REVIEW.json` とレビュー資料を読み、`verify_bundle_integrity` で整合性を確認してから人が内容をレビューする。`published: false` や `review_bundle: null` なら公開済み資料があるとは扱いません。`read_only` はレビュー資料を公開しません。

**迷ったらこう頼む:**

> `ai-orchestration-config` のこの要件について、まず関連箇所を検索・閲覧して、変更候補と影響範囲だけを教えてください。まだ変更しないでください。

## `read_only` と `change`

| 選択 | 何をするか | 注意 |
| --- | --- | --- |
| 調べたいだけ | `search_repo` → `read_repo_file` | 詳細な調査はこの2つ。タスク起動不要。 |
| 固定の状態確認を記録したい | `start_orchestration` の `mode: read_only` | Git の HEAD・branch・status とルートのディレクトリ数を確認する固定ワーカー。`goal` を解釈して任意のファイルを調査するわけではない。`edit_paths` は指定不可。変更・公開なし。 |
| ファイルを変更したい | `mode: change` | `ai-run.ps1` に渡して実行側の承認・検証・公開フローに従う。`edit_paths` は既存の repo 相対ファイルのみ。 |

`HUMAN_SCOPE_CONFIRMATION_REQUIRED` は編集範囲を機械的に確定できず、人の確認が必要という意味です。検索・閲覧した候補を人が確認してから明示的なファイルパスを指定してください。MCP の結果に候補が載らない場合は運用担当が VM ローカルの job ログを確認します。`HUMAN_APPROVAL_REQUIRED` / `NEEDS_APPROVAL` は実行側が人の判断を要求しています。**言い換えや再試行でゲートを回避しない**で、理由と証拠を人に見せて判断を待ちます。

### 承認待ちになったら

ChatGPT に「この task は何で止まってる？ 次は何をすればよい？」と聞いてください。`get_orchestration_status` / `get_orchestration_result` の `stop_reason_category`、`stop_reason_summary`、`human_action_required`、`recommended_next_action` が停止の**意味**を示します。`state` / `result_category` は従来どおりengineの記録であり、例えば `state: NEEDS_APPROVAL` / `result_category: HUMAN_APPROVAL_REQUIRED` でも、最終structured proposalに読取タイムアウトと編集案なしが記録されていれば意味上は `EVIDENCE_INSUFFICIENT` です。`human_action_required: false` は「危険操作の承認判断は不要」の意味で、停止中taskの再開許可ではありません。

| 意味的な分類 | 次にすること |
| --- | --- |
| `HUMAN_APPROVAL_REQUIRED` | 記録済みproposalを人が確認する |
| `SCOPE_CONFIRMATION_REQUIRED` | 候補ファイルを確認して `edit_paths` を確定する |
| `EVIDENCE_INSUFFICIENT` | 調査の証拠不足を確認し、同じ範囲で再調査を検討する（自動再試行しない） |
| `VERIFY_BLOCKED` | 検証証拠を確認し、engineのRetryVerify preflightが許す場合だけ `ai-resume` を検討する |
| `EXECUTION_BLOCKED` | 実行環境・task証拠を確認する |
| `READY_FOR_REVIEW` | 独立したレビューを行う |

`get_orchestration_result` は承認対象の予定ファイル、構造化proposalの要約、変更案のハッシュ、危険操作・commit/push要求、検証状態も返します。詳細は read-only の `get_orchestration_approval` で確認できます。`planned_paths` は予定の範囲で、実際の変更ではありません。提案本文が存在しない場合や理由が記録されていない場合はその旨を表示します。

**現在のengineには `NEEDS_APPROVAL` taskを承認して同一taskで再開する正式経路がありません。** 「この内容なら承認して続けて」や「今回はやめて」と伝えてもMCPは承認・却下・同一task再開を実行しません。`ai-resume` は `BLOCKED` のVerify再試行専用です。goalの言い換えや手動status書換えでgateを回避しないでください。

**証拠不足なら「同じ範囲でもう一回調べて」:** ChatGPT が読み取り専用の `get_orchestration_retry_plan` で元のgoal/hash、repo、mode、編集範囲と許可条件を確認します。`eligible: true` の場合に限り、あなたの明示依頼を受けて `retry_orchestration` が同一goal・scopeで**新しいjob/task**を1件起動します。元taskとその証跡は変更しません。返された新しいIDでstatus/resultを追跡し、`parent_task_id`・`retry_of`・`attempt` で関係を確認してください。`HUMAN_APPROVAL_REQUIRED` と `READY_FOR_REVIEW` は再試行不可、`VERIFY_BLOCKED` は既存のVerify再試行経路を優先します。scope確認停止では元の明示的 `edit_paths` を証明できる場合のみ再試行できます。失敗した調査が再び失敗する場合や、原因が解消していない場合もあります。**新taskも通常のapproval gateを通ります。**

## コピペ用の依頼

```text
pve-doc で「復元手順」の記述を探し、該当ファイルと行を読んで要約してください。変更はまだしないでください。
```

```text
ai-orchestration-config の既存設定を確認し、変更候補のファイルを挙げてください。範囲を私が確認するまで change を開始しないでください。
```

```text
ai-orchestration-config の README.md を調べ、私が指定した誤記があればその箇所だけを修正してください。指定した誤記が不明なら開始前に確認してください。実行後は status/result を確認し、公開された場合は Review 側で整合性と変更内容を確認してください。commit / push は禁止です。
```

ツールを直接指定したい場合（以下のパス・語句は実在する対象に置き換える）:

```text
AI Workspace Orchestration の search_repo に {"repo":"pve-doc","query":"復元手順"} を渡し、候補を read_repo_file で読んでください。
```

```text
具体的な誤記と既存ファイルを調査・確認した後だけ start_orchestration を呼んでください（下の goal は具体的な修正内容に置き換える）:
{"repo":"ai-orchestration-config","mode":"change","goal":"私が指定した誤記のみ修正する。commit / push しない","edit_paths":["README.md"]}
返された job_id を使って get_orchestration_status → get_orchestration_result を確認し、公開されていれば AI Orchestration Review の verify_bundle_integrity も確認してください。
```

上の例では `ai-orchestration-config/README.md` を指定していますが、具体的な誤記は指定していません。**このまま起動しないで**対象と修正内容を検索・閲覧し、人が確認してください。`verify_bundle_integrity` は省略時に `CURRENT_REVIEW.json` を検査し、過去の公開分は `bundle: "reviews/<公開名>"` を指定します。

**commit / push:** この MCP に汎用の commit/push ツールはありませんが、`change` は外部の実行エンジンへ goal を渡します。禁止したいときは上記のように明記し、完了後に git 状態を確認してください。commit/push を許可したい場合も別途人の判断を要します。ここでは自動実行を約束しません。
## 独立レビュー後の完了

`READY_FOR_REVIEW → independent review → PASS → human complete → DONE`。人がレビューPASSと完了承認を明示した場合のみ、Orchestration MCPの `complete_orchestration` に `{ "task_id": "<task-id>", "review_result": "PASS", "done_approved": true }` を渡します。Review MCPは読み取り専用です。ローカルでは `ai-complete -Repo C:\work\pve-doc -TaskId <task-id> -Preflight` で読取確認後、`-ReviewResult PASS -DoneApproved` を付けて実行します。bundleやstateのpathは入力できません。engineがレビュー証跡を保存します。
## Git統合後の完了

`Review PASS → commit/rebase/push → post-integration completion → DONE`。既存の厳密SHA経路とは別に、ローカルで `ai-complete-integrated -Repo C:\work\pve-doc -TaskId <task-id> -Preflight` を読み取り専用で実行し、独立レビューPASSとDONE承認を人が明示した後だけ `-ReviewResult PASS -DoneApproved` で完了します。Orchestration MCPでは `complete_integrated_orchestration` に `{ "task_id": "<task-id>", "review_result": "PASS", "done_approved": true }`。Review MCPからは書き込めません。commitはengineが特定・検証し、callerはpathやstateを指定できません。
