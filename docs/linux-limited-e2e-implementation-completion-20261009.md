# Linux限定E2E 実装完結 — 実機承認待ち

## 対象・境界

前段の42PASSを再利用し、health-only stagingは配備済みcommit/receiptのまま保全する。
この候補は別CLI・spool・temporary broker・one-shot executorだけで、既存staging runtime/unit、
Bridge、Tunnel、Windows、Trust Planeを変更しない。Production Dispatch CLOSED / authority NONE。
G1は前提にしない。実機変更、新VM、PVE ACL、SSH/sudoの変更、VMID704/CT703は実行していない。

## 完成した実装

### Capsule / public-input chain

`scripts/linux-qualification/pack-dependencies.mjs`は既存のdependency closure方式を拡張し、
root依存とdev依存のexact package graphを解決する。npm504 identitiesはcommitted
`pnpm-lock.yaml`のSHA512に照合した公開tarballからmaterializeする。installed treeの本文を
採用せず、lifecycleを実行しない。Linux-x64 native esbuild/rollupもcommitted-lock SRIに固定。
異なるnative architecture、Windows/Darwin artifactsを明示的に除外し、namespace内に配置する。

`verify-public-inputs.py`はisolated public-key homeとhard-pinned signing fingerprintを使用する。
gpg-agentを使わず、GPGが検証・復号したcleartextのSHA256 sectionだけでpackage indexを照合。
unsigned InRelease trailerを拒否し、73 reused OS packageの署名metadata→archive SHA連鎖を検証。
公開dashは同じ署名済みindexから取得する。cloud image、guest `/etc`/HOMEをコピーしない。
Node24.16.0は歴史的に明示承認されたVM116のbinary SHA
`b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd`を追加anchorとする。
**新たなNode upstream OpenPGP資格確認を完了したとは主張しない。**

`capsule.py`はNode24.16.0、Git2.43.0、PowerShell7.6.6、最小static config、public dependency
closureを組み立てる。ELF-x64/interpreter/DT_NEEDED closureを検査し、別ABIへの偽symlinkを作らない。
PowerShellの任意diagnostic tracing providerは除外し、diagnosticsを無効化する。
source/runtimeはplain read-only files、機密path/private-PEM/credential assignmentを拒否する。
これは難読化されたあらゆる秘密の数学的不存在証明ではなく、**public archiveだけを入力とし、
host/guestの秘密を持ち込まない境界**である。tar SHA、count/size、owner/mode、親directory、
traversal、alias、link、secretをfail-closedで検査する。guest verifierはarchive全体をメモリ展開しない。

### Authenticated fixed broker / execution

`broker-protocol.ts`はEd25519署名call/reply、exact operation（dispatch/collectのみ）、
request/source binding、短いfreshness window、nonce、pinned broker identityを強制する。
TLS1.3・固定IP192.168.0.54:48769・private self-signed certificate CA/pinでtransportを保護し、
brokerはsource IP192.168.0.45からの固定POSTだけを受け付ける。外部公開経路は追加しない。

`broker.ts`はnonceと単一campaign/taskのINTENTを実行前に永続化する。broker再起動、
timeout、不明な結果、失敗のいずれでもdispatch claimを解除/再実行しない。
`host-executor.ts`はfixed template instanceの起動・host側systemd proof・whole-cgroup empty確認と
stopを行う。workerの自己申告だけを採用せず、Result/ExecMainStatus/実行主体/limitsを照合する。
candidate出力に認可・Production permitを持たせない。

brokerはrootだがcapability setは空、privileged command API/PVE credentialは持たない。
systemd上のfixed nonroot templateを起動するための、Human承認対象の**一時的な限定root service**である。
rootを非特権と呼び替えない。run-time1800秒、Restart=no、enable/onbootなし。
専用reader groupだけでexecutor evidenceを読めるようにし、DAC overrideを追加しない。
executor専用SGID state/task directory2750、result0640、broker Groupとexecutor SupplementaryGroupsに
`ai-qualification-evidence`を指定する。既存accountや資格情報にはそのgroupを追加しない。

`worker.ts`はnonroot/VM117/fixed cgroup、capsule/source inventory、NoNewPrivileges、
3GiB/swap0/CPU100%/Tasks128/OOM0、deadline、durable claimを検査する。
既存RC-02 namespace argvとharmless OS isolation probeを再利用し、probe PASSの後だけ
fixed13-suiteを実行する。root minimal image、network/PID/user/mount/IPC/UTS/cgroup unshare、
host HOME/credentials不在、capability0、namespace外書込禁止をlive probeで確認する。
sourceの空`node_modules` mountpointへread-only public dependenciesをbindする。
Vitestはcacheを無効化し、configLoader=runnerでread-only sourceへのconfig bundle書込を避ける。

### Durable Linux control integration

`controller.ts`は永続台帳・単一job・固定dispatch/outbox・署名済みresult envelope検査・構造review・report。
pending recoveryだけでなく、final reportでもoutboxと保存署名/evidenceを再照合する。
`run.ts`/`cli.ts`はone-shot実行と再起動後のcollect-only復旧を統合する。
結果不明やSTOPPEDは新規admissionをfenceする。未署名/self-hashed resultは拒否する。
固定13-suite成功は**offline qualification + structural review**であり、AI semantic review、
provider qualification、autonomous DONE、本番稼働ではない。

## 実行可能な配備資材

- `pack-release.py`: clean committed sourceからisolated compile。ignored repo/distは使用しない。
  capsule/source lock一致、raw-source tar→inventory binding、compiled-file SHAを記録する。
  full capsuleは117だけに展開し、116/broker supervisorはNode+library+zodの小さいhost runtimeを使用。
- `deploy.py`: identity/hash/new-path/resource PRE、exclusive durable claim、new account/root-owned image/
  secret/unit設置EXEC、inventory/既存runtime595-file/既存service PID/start/unit/executable/script/
  SSH/sudo/boot保全POST。root-exclusive guest入力は`/var/lib/ai-linux-qualification-approved-input`。
- `broker.service` / `executor@.service` / `controller.service`: fixed temporary units。既存unitを上書きしない。
- `provision-keys.py`: 新しいcampaign専用transport鍵だけをprivate custodyで作成する。
  Human approval keyや既存SSH/PVE tokenを流用せず、本文をログ/argvへ出さない。
- `pve-operation.py`: pve5/116/117限定QGA transferとPRE/EXEC/POST、117 broker→116 one-shot start、
  署名検査CLIのreport、final protected baseline/resource照合、失敗時の限定cleanup。
- `run-approved.py`: public packageだけを既存Human SSH管理経路へ送るSHA-pinned workstation transport。
  実際のHuman承認referenceを必須にするが、reference文字列は署名・独立承認機構の代替ではない。

Rollbackは**このCampaignで作ったunit/processのみstop**し、inactive/whole-cgroup emptyを確認。
失敗/記録不明を成功と報告しない。新account/keys/public inputs/evidenceは保持し、広域削除や
既存VM/SSH/network/runtime復元上書きをしない。late POST failureも同じ限定cleanupへ進む。

## 検証・独立レビュー

Windows local回帰: qualification/broker/shared fixture/sandbox suitesは57PASS/1 Linux-only skip。
Python adversarial assetsは26PASS。固定13-suiteのWindows referenceは166PASS/4 Linux-only skip。
最初のWindows reference実行では固定Windows pwsh path不在による1FAILがあり、証拠を保持した。
既存WindowsAppsのPowerShell7.6.6をtest-only overrideで使い直してPASS。
production deployment path/Windows runtime設定やLinux qualifierの環境は変更しない。
typecheck/buildとartifact verificationの最終結果はcompletion receiptに記録する。

独立read-only agent reviewでdurability/origin/cleanup/custody/provenanceを修正。
最終source reviewは「残るブロッキング指摘なし、offline commit/push可」。
これはHuman実機承認・署名・Linux実証を代替しない。review結果と最終artifact SHAは
`C:\work\ai-orchestration-artifacts\linux-limited-e2e-20261009`に保存する。

## VM117判断と次の一括承認

VM117全体は今もLAN/SSH host key/QGAを持つ管理VMであり、credential-free VMとは認定しない。
既存service/資格情報を保護して、**独立namespace内のpublic-only固定job**へ限定転用する候補。
実機namespace/cgroup/toolchain proofは未実行。probe failや境界不明なら未信頼codeを実行せず停止。
full-guest secret-freeまたはより強いkernel境界が必要なら別isolated KVMが必要で、この許可には含めない。
現在のpve5予約11GiB/総15.7GiBへ4GiBの新VMを無条件追加しない。pve3等の別候補も
fresh capacity/credential/isolation確認と新VMの個別Human承認が必要。

一括承認対象は、final source commitと`DEPLOYMENT-PACKAGE.json`のexact SHAを指定した:

1. 既存pve5のHuman管理/QGA経路による116/117 identity/resource/保護baseline確認とpublic inputs transfer。
2. 117新専用account、evidence reader group、root-owned capsule/source、private broker/TLS keysと3 fixed units
   （broker/executor template、116 controller）だけを追加。既存117 account/service/秘密/SSH/networkは変更しない。
3. 116別CLI/spool/client鍵を追加。PVE root鍵/tokenは116に置かず、staging code/unitは不変更。
4. new broker一時start、harmless isolation probe PASS後のみfixed13-suite一回、署名回収、構造review/report、
   complete report/no-skip/OOM0/cgroup empty/既存595-file+service+boot不変/final resourcesをPOSTで確認。
5. PRE不足、probe failure、不明結果、POST driftは再実行せず限定rollback、安全停止、証拠保持。

resource gate: executor MemAvailable>=3.25GiB、controller>=512MiB、各disk>=8GiB、
pve5 MemAvailable>=4GiB・PSI avg10=0・全guest予約後3GiB以上のhost RAM余白。
G1/新VM/VM役割の追加変更/PVE ACL/Production activation/Windows停止/外部公開を含めない。
最終exact hash付きの一件の実行依頼はartifact directoryの`EXECUTION-APPROVAL-REQUEST.md`に集約する。
**今回の実装依頼を実機EXECの許可と解釈していない。**
