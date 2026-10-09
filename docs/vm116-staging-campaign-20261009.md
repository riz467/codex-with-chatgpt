# VM116 Linux staging Campaign — 2026-10-09

## Win11限定の後続開発

- `handoff/linux-staging-opt-node-20261009`は指定基準commitからのhealth専用修正を継承。
- 両Linux serviceのNode固定pathを`/opt/node-v24.16.0/bin/node`へ統一。
  policy・unit・回帰testで一致を検査し、旧`/usr/bin/node`は拒否する。
- 型検査/build PASS、関連Vitest **83 PASS / 1 Linux-only skip**、
  Node launcher/policy regression **16 PASS / 0 skip**。
- 独立review: code blockerなし。指摘されたNode pathとunit資源の記載を修正。
- この後続作業はWin11内のみ。SSH、秘密鍵要求、Linux service変更、VM/CT操作、
  Production Activationは実施しない。下記PRE記録は前回作業の履歴。
- 前回runtime archiveは旧Node pathのため、後続commitの配備成果物として使用しない。

## 状態

- **実装・Win11検証: PASS。VM116実機稼働: 未実証。本番稼働: 未実施。**
- 作業起点: VM112 / `AI-ORCH-W11`。HQO再構築なし。
- 基準remote branch: `handoff/linux-control-plane-20261008-2c97057`。
- `git ls-remote` / fetch / 新worktree HEADの基準SHA:
  `883066961592b19c324d3ca2c96c777be1b3d324`（一致）。
- 専用worktree: `C:/work/vm116-linux-staging`。
- 専用branch: `staging/vm116-health-only-20261009`（ローカル保全、remote push未実施）。
- 証跡: `C:/work/ai-orchestration-artifacts/vm116-staging-20261009/`。

## 実装・検証

通常Dashboard factoryはCampaign起動関数を呼び、通常Gateway bootstrapは
HTTP staging gateに到達する前にAuthStoreを読み、state directoryを作成する。
そのためLinux launcherだけを共通のhealth専用factoryへ切り替えた。
Windowsのfactory、CLI、launcher、稼働dist、サービス設定は変更していない。

- `src/bridge/control-plane-staging.ts`はExpressのみをimport。
- GET/HEADのliteral `/health`のみ200、それ以外は503。
  query、末尾slash、大文字、encoded path、absolute-formも拒否。
- healthは`dispatch=CLOSED`、`authority=NONE`。実際にもMCP、承認、Campaign、
  AuthStore、Git、Executor、Review Authority、Finalizerの初期化・経路は存在しない。
- 両launcherは環境をallowlistへ置換し、非root、Linux、`/opt/node-v24.16.0/bin/node`、
  `v24.16.0`、固定pathと引数を検査してからfactoryをimport。
- 固定rootのsymlink禁止は維持。配備でroot symlinkを利用しない。
- 既存systemd unitのloopback限定、source read-only、capabilityなし、
  資源上限は変更なし。Gatewayは`MemoryMax=512M` / `TasksMax=64`、
  Dashboardは`MemoryMax=384M` / `TasksMax=48`、両方`CPUQuota=50%`。
- 型検査・build: PASS。関連Vitest: **83 PASS / 1 Linux-only skip**。
- Node launcher/policy regression: **15 PASS / 0 skip**（Vitestとは別に実行）。
- 独立review: literal URL照合とbootstrap import回帰を修正後、
  **ローカル実装のblocking指摘なし**。実機保証とは区別する。

## 成果物準備

`prepare-runtime.mjs`はfrozen lockfileからインストール済みのExpress推移依存を
versionごとに実ディレクトリへ複製する。pnpmのWindows junctionは移送しない。
native/OS依存、install hook、alias、特殊fileを拒否し、file SHAを保存する。
成果物にはstaging factoryとlauncher/policy/unit、Express閉包のみを含める。
通常Dashboard/Gateway、候補実行、鍵、HOME、運用stateは同梱しない。

- Express 5.2.1、推移依存 **66 package/version**、**6,605 files**。
- alias/native payload: 0。package/lockfileを改変せず依存を取得。
- 完成runtimeから両roleのhealth／操作拒否smoke: Win11 Node24.16.0でPASS。
- **Linux上のlauncher/systemd検証は未実施。配備承認済み成果物ではない。**
- runtime manifest、tar、source archive、SHA一覧を証跡directoryに保全する。
  hashは完全性確認であり、Linux互換性・署名・配備承認の代替ではない。

## PRE / EXEC / POST

| 区分 | 実績 |
|---|---|
| PRE | `ssh`をBatchMode、StrictHostKeyChecking=yes、10秒timeoutで試行。`vm116`の名前解決失敗。Humanは接続情報を後日提供と回答。実機項目は全て未確認、PRE未合格。 |
| EXEC | 未実施。VM116のfile/user/unit/state/portは変更していない。 |
| POST | 未実施。起動、health、拒否、再起動、Bridge/Tunnel継続、OOM、実機SHAは未実証。 |

PREにはVM116/pve5のidentity、Ubuntu24.04.5、Node path/version、既存Bridge/Tunnel、
RAM/CPU/disk、port競合、固定rootの所有権・alias、専用user/state、unit依存と
実効network filter、成果物SHAと依存閉包を含める。未合格ならEXECへ進まない。
VM116でbuild・フル回帰・候補test・13-suiteを代替実行しない。

## 実機変更のHuman承認ゲート

接続情報とPRE結果が揃った後、既存配置の利用状況を踏まえて具体的な承認を求める。
以下は想定scopeであり、承認済みではない。

- 対象: 固定rootへの検証済みruntime、専用非root user/state、
  `ai-linux-gateway-staging.service` / `ai-linux-dashboard-staging.service`の新規配置・起動。
- 影響: localhost 48767/48768、Gateway上限512MiB・64 tasks、
  Dashboard上限384MiB・48 tasks、両方50% CPU。
  既存Bridge/Tunnel、Windows、Trust Plane、外部公開、Production Dispatchを変更しない。
- 合格: 両起動・health・health以外拒否・権威/書込み不能・再起動復帰・
  Bridge/Tunnel継続・メモリ/OOM/競合なし・実機log/SHA保存の8条件。
- 復旧: root切替前に既存利用者を確認し、同一filesystemの実directoryを退避して
  renameで切替する（symlinkなし）。異常時は今回の2 unitだけ停止し、
  今回変更分と退避rootを復元。既存unit/user/stateは削除・変更しない。
  具体的なbackup pathと復旧commandはPREの実配置確認後に確定する。

## Linux限定E2Eへの残件

1. 承認済みVM116接続経路・ホスト鍵、既存の非VM116 Linux成果物検証環境。
2. Linux成果物検証、PRE合格、具体的変更scopeのHuman承認、EXEC、POST。
3. **資格情報なしの隔離KVM Executor確保まで実機13-suiteは未実施。**
   staging health稼働はtask E2E／権威接続／Production Activationを意味しない。
4. Executor資源の準備目安（未実測）: x86_64、4 vCPU、8GiB RAM、
   20GiB以上の空きdisk。Ubuntu24.04、Node24.16.0、PowerShell7.5以上、
   Git、Python3.12以上、pnpm11.24.0とLinux native/optional/dev依存閉包を事前準備。
5. 13-suite実行時NICなし、非root、空HOME、運用mount/鍵/token/sessionなし、
   Trust Plane・stagingから独立、PID1による孤児reap、資源上限、証跡回収。
   providerを要するE2Eは別途承認された接続設計が必要で、資格情報なしsuiteと混同しない。
   VM/CT新設・破壊、VMID704/CT703、pve1/2/4重負荷は今回の範囲外・禁止。
