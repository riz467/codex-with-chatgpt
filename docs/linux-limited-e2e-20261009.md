# Linux限定E2E Campaign — 2026-10-09

> 以下は42PASS時点の準備記録。後続の実装完結状態・独立レビュー・配備資材は
> [実装完結記録](linux-limited-e2e-implementation-completion-20261009.md)とcompletion receiptを参照。

## 現状と証拠の扱い

**実装準備のみ。Linux限定E2E未成立、実機13-suite未実行。**
VM116 health-only staging SUCCESSは既存receiptをそのまま保全する。今回のsource候補を
`/srv/ai-orchestration/codex-with-chatgpt`へ上書きしない。Gateway/Dashboard/Bridge/Tunnel、
Windows、Trust Plane、PVE ACL/Pool/storageを変更していない。Production Dispatch CLOSED、authority NONE。

実機read-only結果とローカルテストJSONの置場:
`C:\work\ai-orchestration-artifacts\linux-limited-e2e-20261009`。
`vm117-inspect.json`は秘密本文を含まないmetadata/環境変数名/ネットワーク情報。
既知のcredential pathの不在は、全disk上の秘密不存在の証明ではない。

## Executor判断

- VM117/pve5は既存Debian13 `rc02-executor-117`、192.168.0.54、2vCPU/4GiB/32GiB。
  既存用途と資材を保全し、役割変更やapplication実行はしていない。
- guest MemAvailable 3,662,296KiB。`/opt/rc02-sandbox-runtime`と`/opt/rc02-fast-runtime`が存在する。
  存在metadataのみ確認済み。内容・hash・toolchain・動作の証明ではない。
  `/opt/node-v26.10.0-linux-x64`というpathがあり、今回の固定Node v24.16.0と異なる。
  実際のversionはapplicationを起動せず未確認。既存Nodeを変更せず別capsuleで固定版を準備する必要がある。
- LAN IPv4/IPv6 default route、SSH host秘密鍵、QGA管理経路が存在する。
  VM全体をcredential-free/network-isolatedとは認定しない。無効化されたSSH public keyの
  backupは秘密鍵ではない。`CREDENTIALS_DIRECTORY`名だけではprovider tokenと判定しない。
- pve5はRAM約15,715MiB、MemAvailable約9,672MiB、既存guest予約11,264MiB、
  memory PSI平均0（inspect時点）。新VM/増設/overcommit不要。既存117内で**単一job、
  MemoryMax=3GiB、MemorySwapMax=0、CPUQuota=100%、TasksMax=128**を候補とする。
  EXEC前に鮮度あるPREを再取得し、guest available>=3.25GiB / pve5 available>=4GiB /
  memory PSI avg10=0 / disk空き>=8GiBを満たさなければ停止。現snapshotは予約許可ではない。

## 実装と再利用

- `src/linux-qualification/contract.ts`: 独立・strictなデータ契約。source/capsule pins、
  request/result hash、task/time/profile、13-suite完全性を照合。hashは署名ではない。
- `controller.ts`: 非特権Linux control spool、永続task、単一job admission、固定dispatch
  intent、結果回収、構造review、report。既存bounded process lockを再利用。
  file fsync/atomic publication/Linux directory fsync。停止理由は結果不明として保持する。
- `plan.ts` / `worker.ts`: 既存RC-02のbwrap namespace argvとlive isolation probeを再利用。
  nonroot VM117限定、root-owned capsule/sourceのinventory、cgroup v2制限、固定13-suiteのみ。
  host HOME/credentials/networkをmountせず、runtime/source read-only、evidenceだけwrite可能。
  probeは隔離後に外部socketが拒否されることを確認する。hostからのnetwork probeはしない。
- `cli.ts`: stagingサービスと別のCLI候補。固定配置・root-owned pinsを要求。
  arbitrary command/path/env/VMID、認可issuer、Production dispatch APIはない。
- `scripts/verify-linux-portability-fixture.mjs`: Phase1.6の固定13-suite一覧を共有。
  suiteの増減、skipのPASS扱い、provider qualificationの偽装をしない。

復旧は同一dispatch requestの再投影と結果回収のみ。欠落結果からNOT_STARTEDを推測しない。
dispatch/workerは自動再実行しない。deadlineでSTOPPEDになったtaskは新規admissionもfenceし、
実行・cgroup・evidenceをHuman管理経路で確認するまで解除しない。
未知/partial/別hostのlockを削除しない。invalid resultは台帳を進めずエラーで停止する。
controller rootとbroker inboxはtrusted-host exclusive custodyが前提。
同一user/特権の敵対プロセスに対する認証をJSON hashだけで提供しない。

## 検証と未実装

- Windows上のtypecheck/build PASS。qualification protocol + fixture validatorは18件PASS。
  既存sandbox回帰は24件PASS、Linux live専用1件skip。合計42PASS/1skip/0FAIL。
  synthetic resultはmock証拠であり、Linux実機/OS隔離/providerの証明ではない。
- 最小capsuleの構築/既存117資材の内容資格確認/固定brokerの実装・認証済み配送/
  systemd one-shot配備/PRE-EXEC-POST adapterは未完。CLI/workerは配備していない。
- worker guard/inventory/cgroup/probe/全13-suiteはLinux実機で未実証。
  toolchain closureにはNode v24.16.0、Git、pwsh、Vitest、transitive dependenciesと必要libraryが必要。
  capsuleはsourceのnode_modulesをread-only bindする。Vitest cacheやtoolのwrite要件が
  read-only sourceと競合する場合は停止し、固定のephemeral write領域を設計・再検証する。
- 今回はoffline qualificationの構造reviewだけ。限定タスクのAI proposal→変更→独立semantic
  review→報告、Linux provider transport、正式なbounded task連携、autonomous schedulerは未成立。
  Windows実装をLinux完成品と呼ばない。G1/UI/Enhancementは今回の必須gateから除外する。

## 次の一括Human承認案（未承認・EXEC可能な最終票ではない）

対象はVM117の既存Executor用途の限定検証利用と、VM116の**独立qualification CLI/spool**。
VM116 stagingのruntime/unit、Bridge/Tunnelは変更禁止。VM作成/再起動/役割の追加変更、
VMID704/CT703、pve1/pve2/pve4上の重いtest、SSH/sudo/ACL/Production/Windows変更は含めない。

承認対象候補:
1. VM117の専用非特権account・0700 state、root-owned固定capsule/sourceとone-shot unit。
   VM全体の秘密削除やnetwork再設定ではなく、実行process namespaceを無資格情報・無networkに隔離。
2. VM116の別root-owned CLIと非特権spool。既存staging account/runtimeには追加しない。
3. 独立Human管理のfixed brokerで117のみ固定dispatch/結果配送。116にPVE root key/tokenを
   配置しない。AIの恒久root command権限を新設しない。brokerの具体的custody/固定入出力/認証と
   hash-pinned adapterの完成・検査後に、最終一括票を作る。
4. PRE: 116保存receipt照合、既存service/PID/hash/boot、117用途・資格情報境界、resource/
   capsule/source/unit hash、実行重複なし、独立承認scopeを照合。不足なら変更せず停止。
5. EXEC: 新規専用物だけ設置。namespace live probe→固定13-suite一回→Linux controlに回収。
   trusted brokerがorigin/cgroup/OS証拠を封印し、candidate出力をhost proofと混同しない。
6. POST: 完全13-suite report、nonroot identity、namespace/cgroup/OOM0、source/capsule一致、
   116既存service/PID/hash/boot不変、resource余力、結果永続化/再読取を確認。
7. rollback: 当Campaignの新規unit/processのみ停止、専用物を隔離・証拠保全。
   既存116/117資材/SSH/秘密/VM/networkを削除・復元上書きしない。

capsule/brokerの準備が未完の現在、承認済みと解釈してEXECしない。細かなHumanコマンド作業は依頼しない。
