# Linux Portability Phase 1.5

## 範囲と保全

- 基準: `9447a0cead9beb1deb419ef7ba4867fcbb3f1737`。
- Phase 1 branch `linux-portability-phase1` は基準commitに保持。
- 作業branch: `linux-portability-phase15`、worktree: `C:/work/ai-linux-phase1`。
- 元worktree `C:/work/codex-with-chatgpt` / `ai-workspace` は統合対象にしない。
- Linux Production Dispatchは引き続き `deployment.localExecutionEnabled = false`。
- VM116/117/704、CT700～702、VM111、reserved CT703に対する操作なし。

本書のoffline PASSは実OpenCode/provider/Linux稼働の認定ではない。
公開schema調査、Windows上のfixture実行、Linux専用未実行項目を区別する。

## OpenCode 2.0.24: 役割別の判定

| 役割 | 今回の確認 | 判定 |
|---|---|---|
| Human CLI | Windowsインストール済みpackage metadataが2.0.24 | サーバー互換性の証拠に流用しない |
| Human background | 接続・起動・変更しない | proposer/reviewerの代用不可 |
| proposer専用serve (41739) | 移植した実PowerShell関数でversion/schema、OAuth metadata、実効agent、session/model、tool=0、completed-without-idleをfixture検証 | 2.0.24は拒否継続。実バイナリ・実OAuth・実応答は未検証 |
| semantic reviewer専用serve (41740) | 既存の独立transport fixtureで2.0.24拒否、認証経路・model不一致、deny-all、idle付き完了を検証 | 2.0.24は拒否継続。proposerの完了条件を適用しない |
| embedded core/AI/util | 依存2.0.22を維持 | CLIのversionと混同せず、SDK置換なし |

### 公開ソース比較（実測、2026-10-08）

次のURL形式で **2.0.22と2.0.24の本文を取得して比較**した。
`https://unpkg.com/@opencode/schema@VERSION/dist/NAME.js`

| NAME | 両versionの本文一致 | 2.0.24公開metadataのSHA-256 (base64) |
|---|---|---|
| agent | 一致 | `wY69wEYv+wYlwoa2q4ofbyUIHzlcoGtTVTuj0xR90l4=` |
| model | 一致 | `rYVPrwjahBhfjKSn4TahEzPMWi+XNfnKm6/yiZ4S8vQ=` |
| permission | 一致 | `Y2/OGNtgvauuZVza/m08bmnHT4MFtLSjfoUaRvIe91A=` |
| session | 一致 | `RNCSXLtBdk4/CfOx6GTTOHdTsb9ZlTuYba6M2hSwslI=` |
| session-message | 一致 | `6rALiRhQ+gVNWqzpeH6D0v9M1VUKf/i6aP+ZUPBkHFQ=` |
| integration | 一致 | `8FM4lUbxF2y4Uf2m7M1UR6EkheeHVd7HlvQpg8q8Phc=` |

これは型定義側の互換性に関する証拠であり、CLI内蔵HTTPルート、実serverの
`/openapi.json`、agent設定探索、OAuth接続、モデル利用可能性の同一性は証明しない。
したがってproduction allowlistは2.0.18/2.0.22を維持する。fixtureのversion値を
2.0.24にした拒否テストを「実2.0.24起動PASS」と表現しない。

## PowerShell transportの移植

`src/mcp/proposer/` に既存transportの必要部分と非秘密agent定義を移植した。
`autonomous-readonly-core.ps1`全体はbounded proposerが使うUTF-8定義以外不要だったため、
Windows固定repo台帳やresearch機構を一緒に複製していない。

- `bounded-opencode-proposal.ps1`: stdin promptと管理側repoだけを受け取るprivate launcher。
- `opencode-session.ps1`: 専用serve/session、schema・OAuth・agent・model検証と有限polling。
- `c2c-bounded-proposer.md`: 既存のSHA-bound line-range提案契約。tool使用禁止。
- `bounded-task.ts`: 配布された自身のmoduleに隣接するscriptを固定選択する。
- `copy-runtime.mjs`: 上記3ファイルをworktree内buildへ含める。

Linux executableは `/usr/bin/pwsh`、`/opt/opencode/bin/opencode`、`/usr/bin/git`。
Windows executableは従来の固定場所。呼出側がexecutable、shell、port、agentを指定する
新しいMCP/Dashboard入力は追加しない。provider認証を設定・移動する機能も追加しない。

`ConvertFrom-Json -DateKind String`を実際に使用するため、最低PowerShellは**7.5**とする
（元コードの7.0宣言ではこの引数を保証できない）。今回のWindows検証は7.6.6。

Linuxの大小文字を区別し、既存ancestorも含むsymlink/reparse aliasを拒否する。
project-local agentはtracked/cleanであること、installed agentは管理同梱agentと
byte hashが一致することを要求。加えて実効systemと末尾deny-allを照合し、sessionにも
deny-allを明示する。元proposerのmodel、OAuth単一路、tool=0、8ページ制限、prompt budgetを保持。

同梱agentの改行を含むbyte hashが旧installed agentと異なる場合、暗黙に正規化せず拒否する。
採用時のagent配置とACL確認は別承認事項であり、今回グローバルagentを書き換えない。

終了未確認は `PROCESS_TERMINATION_REQUIRES_INSPECTION` として親へ伝え、既存台帳・campaignの
再試行対象外にする。正常出力は専用server停止後にのみ返す。repo予約を残す既存の
安全停止機構を使い、新しいretry/recovery/commit機構を作らない。

`owned-process.ts` はleader終了後もgroupの消滅（signal 0のESRCH）を全体2秒以内で確認する。
group残存・観測拒否では成功にしない。zombieの回収が遅い環境でも保守的にinspection停止する。
semantic側もcleanup不明なら `SEMANTIC_PROCESS_REQUIRES_INSPECTION` を既存revision診断へ
永続化し、再入してもprovider試行を繰り返さない。Dashboardの既存診断表示にこの固定コードを
通す変更を含む。画面構成やUI/UXの刷新ではない。

### 移植元（読み取りのみ）

所有者不一致のconfig repoのGit設定を変更せず、次の非秘密ソースbyte hashを記録した。
移植元repoのHEAD/clean性は未確認のままであり、commit provenanceを捏造しない。

| ファイル（`C:/work/ai-orchestration-config/`配下） | SHA-256 |
|---|---|
| scripts/bounded-opencode-proposal.ps1 | `827b377ff22a7778d6b3062597bf5152db3645a15388452aaac82e30e1849089` |
| scripts/autonomous-opencode-session.ps1 | `cb63ed3aee0fdc0d1c6296493b26bcceaa1a1cde66d6380ba27ae26e06c2d195` |
| agents/c2c-bounded-proposer.md | `75fe3e4da45240df74cd4b206565dd0701e0fec936bd7bcf65277daf9acb3195` |

## 隔離Linux実機fixture: Human承認依頼

### 対象・資源

- 対象: **新規の使い捨て非本番Linux fixture**。配置先/VMIDはSol調査後にHumanが指定する。
  VM116/117/704やCT700～702への流用・配置を本書だけで許可しない。
- 目安: x86_64 Linux、2 vCPU、4 GiB RAM、20 GiB disk、15分のtest budget。
- Node 24、Git、PowerShell 7.5以上（7.6.6推奨）、固定lockfileの依存を事前準備。
- 非root専用ユーザー。sudo/PVE/GitHub/署名/Human承認/provider権限なし。
- 運用環境のmount、HOME、SSH agent、credential helper、OAuth store、台帳、lockを持ち込まない。
- egress遮断、公開listenerなし。PID 1は孤児を回収できるinitを使う。
  ホスト側でCPU/RAM/PID上限を設定する場合はHumanが別途行い、記録する。

### A. Offline OS/process/復旧検証

承認後だけ行う操作:

1. 承認commitのソースと依存をfixture専用directoryへ配置し、hashを記録する。
2. 非root・空の専用HOMEで `node scripts/verify-linux-portability-fixture.mjs` を実行する。
3. launcherが固定12 test filesを、provider環境変数を継承しない新しいHOME/XDG/stateで実行。
4. 実PowerShell→Node→孫Nodeのgroup/session IDが同じことを`/proc`で確認する。
   timeout後のgroup終了、leaderが先に終了した場合の子孫終了、pipe閉鎖、無関係peer存続を検証。
5. legacy/foreign lock保全、campaignの有限retry、二重dispatch防止、sealed recovery、
   不確定commitのreconciliationを既存のGit scratch fixtureで検証する。
6. 指定全ファイル・全assertionがPASSであることをJSONから確認。欠落・重複・skip・
   pending・timeoutはLinux fixture PASSにしない。Windows/rootでの実行も拒否する。
7. 出力先 `linux-portability-evidence-*` のreceipt、JSON、ログを保全してHumanへ返す。

このlauncherはOpenCode実binaryを起動しない。`provider_qualification: NOT_RUN` を記録する。
process groupは`setsid`で逃げる敵対的子孫の隔離証明ではなく、VM704/cgroupの実証とも別。

### B. 実OpenCode 2.0.22/2.0.24のrole別API確認（追加承認）

上記とは別の空HOMEを用意し、管理側固定binaryを1versionずつ配置する。checksumと
`--version`を記録し、proposer/reviewerの専用serveを個別に起動する。Human backgroundへ
attachしない。検証対象はPID、loopback bind、`/openapi.json`、model/permission request形状、
agent実効system/permissions、session create/readbackのmodel/role/location一致。
providerを持たない状態ではOAuth gateが拒否し、prompt未送信で停止することまでを確認する。
これはprovider E2E認定ではない。version gateをfixtureのために書き換えない。

### C. OAuth/model応答E2E（今回は対象外、さらに別承認）

将来必要ならHumanが専用の非本番providerアカウント、最小scope、費用上限、接続先を
承認する。Windowsや運用VMの認証をコピーせず、そのfixture専用の認証をHumanが設定する。
proposerはtools=0とSHA-bound提案、reviewerは独立session/roleとidle付きsemantic結果を
それぞれ確認する。wrong model/agent/auth、timeout、cleanup不成立で拒否する証拠を含める。
実証・独立レビュー・Human承認が揃った後にのみ、**別commit**で各役割のgate変更を検討する。

## 検証結果・独立レビュー

- Windows typecheck / worktree内build / `git diff --check`: PASS。
- 同梱proposer assets 3ファイルのsource/build byte一致、entrypoint PowerShell parse: PASS。
- 関連12ファイル: **158 PASS、Linux専用4 skip、失敗0**。
- 続くDashboard/MCP/fixture追補5ファイル: **65 PASS、失敗0**。上記との重複を含む別run。
- PowerShell 7.6.6実関数fixture: schema、path、OAuth、agent、model、tool budgetと
  exit/stdout/stderr終了未確認の拒否・disposeを検証。provider呼出し0。
- ログ: `C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/linux-phase15-related.log` と
  `linux-phase15-dashboard-final.log`。
- Phase 1の全体101ファイルPASSを、Phase 1.5の全体再実行結果として流用しない。
  今回は変更に関係する回帰テストを実行した。

独立レビューの指摘（group終了確認不足、新transportの終了不明fixture不足、Dashboardの
診断欠落）を修正。最終再レビューは**ソース候補の取り込み可、残存blockingなし**。
独立レビュアー自身はテストや実機操作を行っていない。

新規npm依存なし。追加運用要件はPowerShell 7.5以上と、承認後Linux fixtureの上記条件。
Linux実機fixtureと実OpenCode 2.0.24/provider/API資格確認は未実行。移植ソースとoffline
契約検証の完了を、Linux運用・2.0.24の資格確認PASSとして扱わない。

## rollback

Phase 1 branch `linux-portability-phase1` は `9447a0c` に保持されている。
Phase 1.5を採用しなければ元runtimeへの影響はない。将来ソースだけ取り込んだ後の撤回は
Phase 1.5 commitの通常revertを使い、reset/forceや台帳/lock削除を行わない。
fixtureの撤去・運用への統合・配備・認証・Windows停止・pushは本Phaseの許可に含めない。
