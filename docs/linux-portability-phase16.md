# Linux Migration Phase 1.6 — 固定OpenCodeとfixture受渡し

## 基準・状態

開始HEAD: `005932f1c3938224424ed07e1ff30b87f45be810`、clean。
`C:/work/ai-linux-phase1`内で`linux-portability-phase16`を作成。
Phase 1/1.5の参照branchは維持。ソース候補のみであり、Windows自走は**未反映・未復旧**。
Linux Production Dispatchは引き続き閉鎖。認証・サービス・VM/CT・remoteへの操作なし。

## A. 読取調査と原因

現行Gateway/Dashboard Scheduled TaskはworkspaceユーザーでRunning。
現行proposerは外部config repoのPowerShellから、reviewerは配備済みsemantic-session.jsから
Humanと同じ `C:/Program Files/nodejs/node_modules/@opencode/cli/bin/opencode.exe` を参照。
現在そのexeは2.0.24（前回実測）。現行proposerの2.0.18/2.0.22 gateを満たさない。
現行reviewerは2.*を許容するが、これは2.0.24資格確認ではない。

proposer専用41739とreviewer専用41740は子PID・loopbackと専用passwordを持つ新規serve。
Human backgroundにはattachしない。候補でもこの独立起動・独立sessionを維持する。
候補は両役割ともgpt-6-sol/default、管理agent、tools=0/deny-all。reviewerは別sessionと
idle付き完了を要求し、proposerのcompleted-without-idle条件とは混同しない。

launcherはサービスユーザーの環境を継承する。候補はOPENAI_API_KEY/OPENAI_BASE_URLを拒否し、
単一openai credential/oauth接続をmetadataで確認する。agentはproject-local tracked/cleanまたは
ユーザーHOMEの`.config/opencode/agents`（reviewerはHOME側）と管理sourceの一致を要求する。
実効system・末尾deny-all・model照合も保持。workspaceプロセスの環境値やOAuth store内容は
取得していないため、現在のcredential実体・XDG override・認証成立は未確認。
今回新しいHOME/認証へ切り替える実装はなく、認証コピーもしない。

## A. 採用構造

release管理の `src/mcp/proposer/opencode-release.json` にversion、OS別digest、役割別パスを固定。
このファイルは同梱assetsとしてbuildにコピーされ、環境変数・MCP・Dashboard・repo入力で
書き換えない。実行ユーザーにはbinaryとmanifestを含む配備sourceへの書込み権限を与えない。

| 役割 | Windows固定パス |
|---|---|
| Human CLI | `C:/Program Files/nodejs/node_modules/@opencode/cli/bin/opencode.exe`（管理対象外、2.0.24維持） |
| proposer | `C:/Program Files/AI-Orchestration/opencode/2.0.22/proposer/opencode.exe` |
| reviewer | `C:/Program Files/AI-Orchestration/opencode/2.0.22/reviewer/opencode.exe` |

Linux側予約パスは `/opt/ai-orchestration/opencode/2.0.22/{proposer,reviewer}/opencode`。
**今回はどの固定配置先にもインストールしていない**。Linux binaryの配置はoffline fixture Aに不要。
Embedded core/AI/utilは既存lockfileの2.0.22を維持する。

同一配布binaryを役割ごとに**独立した通常ファイルとしてコピー**する。symlink/junction/hardlinkで
Humanと共有しない。起動前にancestor alias、通常ファイル性、hardlink、SHA-256を検査し拒否する。
固定digestは2.0.22のbytesを実行前に保証し、起動した子PIDの`/api/info`でも正確に2.0.22を要求。
不一致は `OPENCODE_BINARY_IDENTITY_MISMATCH` / `OPENCODE_BINARY_VERSION_MISMATCH`、
非対応OS/CPUは `OPENCODE_BINARY_PLATFORM_UNSUPPORTED`。Linux/Windows x64のみを対象とする。
既存schema/auth/model/agent検査はその後も必要。SHA一致を実API/provider資格確認の代用にしない。

配備dirは管理者所有、workspaceはread/executeのみが必須。hash確認からspawnまでの間の
管理者による書換えを防ぐ原子的OS実行機構ではないため、稼働中の上書き更新は禁止。
更新は新しいversion dir・新manifest・レビュー済みcommitで行う。Human更新は別パスだけを変更する。

## A. 正規配布・固定hashの根拠（2026-10-08）

`https://registry.npmjs.org/@opencode/cli/2.0.22` のoptionalDependenciesにより
`@opencode/cli-windows-x64@2.0.22` / `@opencode/cli-linux-x64@2.0.22`を特定。
metadata記載の公式registry tarballを取得し、SHA-512 integrityとnpm registry公開鍵による
ECDSA signatureを両packageで検証した。archive entriesは各package.jsonと通常binaryの2件。
展開先は隔離tempで、install/postinstallは実行していない。

| artifact | SHA-256 |
|---|---|
| cli-windows-x64-2.0.22.tgz | `55002d241561ef8a5ab46aa318614037b1221e921511add5ab98f9ebdd8d399e` |
| Windows opencode.exe | `036a92f886fb4b738921ba29b21e490148c3f01ec73d772a920ba951b76cf0b4` |
| cli-linux-x64-2.0.22.tgz | `65434cbe256f23df397a4941039e5eee28b1a37c1bad5376a5217f583a353583` |
| Linux opencode | `32cf5aa0a69a650e36277e3315d189835ddc79fb9aa1d0aef5025be5af5ad122` |

取得物とregistry metadata/検証鍵の保存先:
`C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/phase16-binaries/`。
このディレクトリはLinux offline source bundleに含めない。
Windows版は空HOME、provider環境なし、絶対パスで`--version`のみ実行し`opencode v2.0.22`を確認。
Linux版は未実行。両版のserve・provider E2Eは今回起動していない。

2.0.24採用との比較: 共有CLIをそのまま使うとHuman更新による再発を防げない。
役割別固定配置＋2.0.24資格確認後の別release更新は可能だが、今回gateは開かない。
2.0.22も選択した配布binaryと既存認定証拠の対応、実API/認証条件を切替前に確認する。

## A. Human承認後のWindows復旧・切替

1. Humanが対象commitとruntime baselineを承認。新規dispatchを管理側で抑止し、稼働campaign・
   worker・reviewが完了したことを確認。不確定commit/receiptはreconciliationし、台帳を削除しない。
2. 管理者が正規archiveと上記hashを再照合し、proposer/reviewer固定dirに独立コピーを配置。
   既存ファイルを上書きせず、ACLを管理者書込・workspace読取実行に限定。alias/hardlinkなしを確認。
3. **個別に**Human CLIのpath/hash/version=2.0.24、proposerとreviewer各path/hash/version=2.0.22を記録。
   Human CLIの再インストール/ダウングレードは不要。Human backgroundを停止しない。
4. 対象sourceを専用buildし、proposer全assets（release JSON/agent/2 scripts）とhelperを含む
   完全なbuild manifestを検証。Gateway execution runtimeとReview/Dashboard側runtimeの両方を
   同じ承認releaseへpromotionする手順を管理者が承認・実施する。旧外部PSだけの書換えでは不十分。
5. source/runtime/agent/ACLの整合をworkspace実行ユーザーで確認。認証をコピーせず既存の参照条件を
   確認する。role別専用serveのPID/schema/agent/model/auth metadataと、承認済みprovider smokeを実施。
   provider試験は追加の費用・認証承認が必要。不成立なら自走開始しない。
6. 承認されたサービス切替後、bounded scratch task→review→receipt reconciliationまで確認してから
   dispatchを再開。旧host/platformなしlockやtermination inspectionはHumanが確認し、自動削除しない。

この手順は今回実行していない。旧runtimeを動かしたまま新binaryを置くだけでは参照先は変わらず、
proposerの不整合は復旧しない。今回の成果は安全な修正候補である。

### rollback

未採用なら現在のruntimeを継続し、source候補を採用しない。将来採用後はdispatchを抑止し、
稼働子孫の終了・receipt照合を確認して保存済みruntime/agent/manifestへ戻す（別途Human承認）。
台帳・receipt・lockを巻き戻さず保全。共有2.0.24を参照する旧runtimeへ戻すとproposerは再び
拒否するので、それを「自走復旧」と呼ばない。認定済みrole別releaseへのroll-forwardを管理側で選ぶ。
source撤回は通常revertを使い、reset/force/pushをしない。

## B. Linux資材

別紙 `docs/linux-fixture-handoff.md` と生成されたmanifest/receiptを参照。
Phase 1.5固定runnerを継承し、Phase 1.6のbinary隔離offline testを加えた固定13ファイルを使う。
実OpenCode/providerは起動しない。Node/PowerShell/GitおよびLinux依存閉包が揃い、NICなしの
対象Linuxで検証されるまで、source bundleを**offline execution READY**とはしない。

## 検証・レビュー

- Windows Node 24.16.0: typecheck/build PASS。
- 関連14 test files: **168 PASS、Linux専用4 skip、失敗0**（134.23秒）。
  ログ: `C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/linux-phase16-related.log`。
- bundle安全性self-test: **Python 13 tests PASS**。Git replaceの無効化、
  traversal/links/missing/extra/hash/祖先case/file-dir collision拒否を含む。
- build同梱4 assetsのsource byte一致を確認。compiled helperも固定role pathを使い、
  未配置binaryを起動せず拒否した。
- 初回のbinaryテスト1件はWindows tempのshort-path aliasで拒否され、scratch rootを
  realpath化して修正後PASS。productionのalias拒否は弱めていない。
- 独立レビューの指摘（PS startup version/cleanupのfixture不足、Git replace、祖先パス衝突）を
  修正。最終再レビュー: **残存blockingなし、A/B取り込み可**。レビュアー自身はテスト未実行。
- Phase1.5の2676 PASSは過去の全体回帰。Phase1.6の全体再実行として流用せず、今回の変更には
  上記関連回帰を実施。実OpenCode API/provider資格確認とLinux実機は未実施。

最終確認時、元worktree両distは各286ファイルで集約SHA-256が
`87283b753bcc73230818a7ff9ce1e502bf20d284e3ca3c5a044f774f1bb4d251`のまま。
Human exe SHA-256も`542c51f075026e1dbd5b676ebce685d0b454face48872b0813d08f867e2c4eaa`で不変。
本番反映・サービス/VM/CT操作・remote pushを行っていない。
