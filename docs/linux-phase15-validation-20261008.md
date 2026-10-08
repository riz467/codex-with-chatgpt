# Phase 1.5 全体回帰・Windows runtime影響確認

## 対象と証拠の区別

- 検証対象ソース: `d90aa35d1e4a53588d1542e7ff63e2e8eab1af96`。
- 作業先: `C:/work/ai-linux-phase1` / `linux-portability-phase15`。
- Phase 1参照: `linux-portability-phase1` / `9447a0c` を保持。
- 元worktree、稼働runtime、Scheduled Task、認証、VM/CTを変更しない。
- 実測、配備済みファイルからの実装確認、条件付き影響評価を区別する。
  以下のgate評価は、実proposer/reviewerによるprovider呼出しの再現ではない。

## 1. 全体回帰

対象commitのコードを固定して、Windowsから次を実行した。
依存は既存のworktree-local junctionを参照し、Vitest cache書込みを無効にした。

```text
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --no-cache
```

ログ: `C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/linux-phase15-full-regression.log`

結果: **2676 PASS、8 skip、失敗0**。104ファイル中103 PASS、1ファイル全件skip、754.50秒。
内訳は本書末尾の完了記録に記載する。Linux専用skipをLinux PASSとして数えない。
稼働runtime上でこのテストを実行したわけではなく、Phase 1.5ソースの回帰検証である。

## 2. 現行Windows実行経路（2026-10-08 読み取り実測）

### サービス／launcher

| 役割 | 観測 | 読み取った実行入口 |
|---|---|---|
| Gateway supervisor | PID3000、Scheduled Task Running、workspace/S4U/Limited | `C:/work/codex-with-chatgpt/scripts/run-ai-workspace-gateway.mjs` |
| Execution Bridge | PID6728、127.0.0.1:48765 | `.tooling/ai-workspace-execution-runtime/dist/cli/index.js` |
| Review Bridge | PID6824、127.0.0.1:54108 | 元worktreeの`dist/cli/index.js` |
| Dashboard | PID3024、127.0.0.1:48766、workspace/S4U/Highest | `scripts/run-ai-workspace-dashboard.mjs` → 元worktreeの`dist/dashboard/server.js` |
| Human OpenCode | PID7220と7252が同じ固定exeを使用、7252が127.0.0.1:49374をlisten | proposer/reviewer専用serveとは別プロセス |

観測時点で41739/41740のlistenerはなかった。必要時起動型なので、不在だけでは異常や
最近の実行成功・失敗を判断しない。Human backgroundのロード済みversionは未確定。
認証済みAPIやcredential storeを読んで補完していない。

DashboardはGatewayへのHTTP転送だけでなく、同じ`mcp/server.js`のproduction campaignを
直接呼ぶ。したがってGateway側だけのversion見直しでは十分ではない。

### OpenCode executable

proposerの外部`autonomous-opencode-session.ps1`と、配備済み`semantic-session.js`はともに
次の同一パスを固定参照する。

```text
C:/Program Files/nodejs/node_modules/@opencode/cli/bin/opencode.exe
```

- 絶対パスでの`--version`実測: **`opencode v2.0.24`**。
- package metadata: `@opencode/cli` **2.0.24**。
- exe SHA-256: `542c51f075026e1dbd5b676ebce685d0b454face48872b0813d08f867e2c4eaa`。
- サイズ: 206127144 bytes。LastWriteTimeUtc: `2026-10-08T06:03:21.4035493Z`。
- PE FileVersionは`1.4.2`だったが、アプリのversion判定には使用しない。
- 元worktree内embedded `@opencode/core` / `@opencode/ai` / `@opencode/util` は各2.0.22。
  CLI更新をembedded依存の更新と混同しない。

実行したOpenCodeコマンドは`--version`のみ。serve、service discovery/restart、session作成、
prompt送信、provider認証は実施していない。

### 配備runtimeの基準

元worktreeの`dist`と`.tooling/ai-workspace-execution-runtime/dist`は各286ファイルで一致。
両方の集約SHA-256:
`87283b753bcc73230818a7ff9ce1e502bf20d284e3ca3c5a044f774f1bb4d251`。

集約方法はPhase 1報告と同じ、sortしたnative-relative `path:sha256(file)` のLF結合。
主要ファイルのSHA-256:

| ファイル（両dist共通） | SHA-256 |
|---|---|
| mcp/bounded-task.js | `dd30a1152c17a5c12d9d7c66a35b638fc530aedf2ad6129ca2399395cca7d5f1` |
| mcp/semantic-session.js | `a82c4c8aa72d89738eb8fdb98295e2ade67499d587c480d227c48dc387bd4a12` |
| dashboard/server.js | `25c4c8766855c66a3c769fbea71f7e81a06f335289912602cecdb1c7a6caa938` |

launcher/processの実行パスと現在のdisk上の配備ファイルを照合した結果であり、実行中Nodeの
メモリ内容をdumpした証明ではない。外部PowerShellソースのhashも前回記録から不変だった。

## 3. 2.0.24更新の影響

| 対象 | 配備済みgate / 候補gate | 2.0.24についての評価 |
|---|---|---|
| **現行proposer** | 外部`bounded-opencode-proposal.ps1:47`が2.0.18/2.0.22だけを許可 | schema取得後のversion判定に到達すれば必ず拒否。`OPENCODE_MODEL_SCHEMA_MISMATCH`。その先のsession/promptには進まない |
| **現行semantic reviewer** | 配備`semantic-session.js`がPID一致＋`version.startsWith("2.")`を要求 | 2.0.24はversion条件を満たす。API/model/agent等の別条件で失敗し得るので動作保証ではない |
| **Phase 1.5 proposer** | 同梱`src/mcp/proposer/opencode-session.ps1`が2.0.18/2.0.22だけを許可 | 2.0.24を拒否。Linux対応の実装とversion認定は別 |
| **Phase 1.5 semantic reviewer** | `src/mcp/semantic-session.ts`が2.0.18/2.0.22だけを許可 | 2.0.24を拒否。現行の広い2.* gateを継承しない |

現行proposerは、専用serverのPIDと`--version`の一致、agent存在等を先に確認する。
これらやschema取得が失敗すればversion判定より前で止まるため、最近の実際の失敗codeを本調査から断定しない。
version拒否は実装上確定した条件であり、今回実workerを再実行して観測したerrorではない。

現行semantic reviewerには、候補で追加したschema/OAuth metadata/実効system・permissionの
照合や応答model厳密照合は未配備。現行の2.*許可を「2.0.24認定済み」と扱わない。

**影響の要点:** Human CLI更新で固定exeの中身が置き換わると、Windows自走の次回専用serveも
同じexeを起動する。固定パスはversion固定ではなく、GatewayやDashboardをrestartしなくても
次の起動対象が変わる。proposerの拒否条件はretryを重ねても解消しない。既存の有限retryが
あることと正常運用が成立することは別である。

またPhase 1.5をそのまま現在のWindowsへ配備すると、semantic reviewerも2.0.24を拒否する。
これは候補の意図したfail-closed動作であり、無承認の配備やgate緩和で解消してはならない。
runtime hashが同じでも、共有外部exe更新の影響はruntime manifestだけでは検出できない。

## 4. Linux fixtureの最終承認条件

### 共通構築条件

1. Solの配置調査後、Humanが**新規使い捨て・非本番**の対象/配置先を指定する。
   VM116/117/704、CT700～702を本計画だけで変更・流用しない。
2. x86_64、2 vCPU、4 GiB RAM、20 GiB diskを目安にする。Node 24、Git、PowerShell 7.5以上
   （今回確認した7.6.6推奨）、case-sensitive Linux filesystem、`/proc`、孤児を回収するPID 1。
   `/usr/bin/pwsh`と`/usr/bin/git`、テストに使うNodeの絶対パスを記録する。
3. 非root専用ユーザー。運用HOME、Windows共有、SSH agent、OAuth、GitHub/PVE/署名鍵、
   production台帳/lockをmount・コピーしない。cgroup資源上限はHuman管理側で設定・記録する。
4. Linux向け依存をlockfileに従って事前準備する。Windowsのnode_modules junctionを移送しない。
   資材準備の通信許可と、test時のegress遮断は別工程。test時はloopbackだけ使用する。
5. 承認source commit、checkout clean状態、OS/kernel、UID、Node/pwsh/Git版、lockfile hash、
   image/dependency manifestとネットワーク制限を記録。test前後のsource差分も確認する。
   空HOMEだけでなくfixture配置先のancestorにも運用OpenCode設定・pluginを置かない。

### A: providerなしのOS/process/復旧試験

非rootで実行:

```text
node scripts/verify-linux-portability-fixture.mjs
```

**合格条件:** 固定12ファイルすべて、全assertionがPASS。欠落・重複・相対ファイル名・
skip/pending/todo・timeout・異常終了は不合格。実PowerShellの子/孫group・session一致、
通常timeoutとleader先行終了の両経路でgroup消滅、stdio閉鎖、無関係peerの存続を確認。
2秒以内に消滅を確認できない場合はinspection停止を正解とし、正常cleanup PASSにはしない。
unknown/foreign/legacy lock保全、有限retry、二重dispatch防止、sealed recovery、commit
reconciliationは同梱された既存scratch fixtureを使う。

**提出証拠:** launcherが出力するevidence directoryの`receipt.json`、`vitest.json`、
stdout/stderr、上記環境manifest。`provider_qualification: NOT_RUN`を維持。
これがPASSでも2.0.24/provider互換性、VM704の敵対的process封じ込め、Production Dispatchの
有効化を承認したことにはならない。`setsid`でgroupを脱出する敵対コードの隔離は別試験。

### B: 2.0.22/2.0.24のrole別API資格確認

追加承認対象: 空HOMEの別fixture、正規binaryの配置/hash確認、専用loopback serveの起動・終了、
**production transportから独立した固定API probeの作成・実行**。
Human backgroundを使用せず、proposer(41739)とreviewer(41740)を別々に検証する。

- binary/application version、子PIDと`/api/info`、loopback bind、`/openapi.json`を照合。
- 管理agentをfixtureだけに配置し、実効role/system/末尾deny-all、model/permission schemaを確認。
- 無認証の通常transportは、2.0.24ならversion gate、認定版ならOAuth gateでprompt前に拒否する。
- session create/readback自体の2.0.24 API形状を見る必要がある場合は、別承認した固定probeで
  無権限fixture sessionだけを作成・照合する。通常transportのgateを書き換えて通過させない。
  provider promptは送らない。

**合格条件:** role別の実server証拠が期待contractと一致し、拒否条件・cleanupが成立。
「公開schema6ファイル一致」やsynthetic responseだけでは実API資格確認PASSにしない。
API確認だけでprovider/model応答E2Eまで合格とはしない。

### C: provider/model応答E2E

さらに別承認: 専用非本番providerアカウント、Humanによる新規認証、接続先・費用上限・
認証廃棄手順、role別の固定資格確認probe。運用認証の流用・移動は禁止。
proposerはSHA-bound提案・tools=0・選択model一致、reviewerは独立session/role・idle付き
semantic結果を確認。wrong model/agent/auth、timeout、不確定cleanupで拒否し、再dispatchが
抑止される証拠を必要とする。

**通常transportの2.0.24 gateを開くのは、資格確認・独立レビュー・Human承認後の別commit**。
Windowsサービスへの反映、Linux配備、Production Dispatch、Windows停止試験・cutoverも別承認。

## 完了記録

- 全体回帰開始: 2026-10-08 17:50:56。所要754.50秒。
- **2676 PASS / 8 skip / 0 failed**、104ファイル（103 passed / 1 skipped）。
- ログSHA-256: `aef0cf6f3a4a504f85992d0490865b1362b14c16ad02e6808d4f678e8271a3b1`。
- skip内訳: `linux-portability` 1、`owned-process` 1、`linux-process-lifecycle` 2の
  Linux実機専用4件と、既存`rc02-development-opencode-compatibility`、
  `rc02-development-fast-sandbox`、`rc02-development-sandbox`、
  `rc02-development-opencode-compatibility-sandbox`の環境条件付き各1件。
- 今回のコード・テスト・script・依存定義は`d90aa35d`から変更なし。追加成果物は本報告書のみ。
- 全体回帰終了後も元worktreeの両distは各286ファイル、上記集約hashから不変。
  元worktreeはclean。稼働runtimeへの統合、サービス操作、VM/CT操作、配備、pushなし。
- Linux Production Dispatchと候補の2.0.24 gateは引き続きfail-closed。

残件はLinux実機のA、role別実API資格確認のB、provider E2EのC。
次のHuman判断はAの対象・構築/実行許可と、Windows共有exeのversion整合をどう回復するか。
認定済みbinaryを役割別に固定配置する案、または2.0.24の資格確認後にgateを更新する案は、
いずれも今回実施しておらず、配置・runtime変更を伴う場合は別途承認が必要。
