# Linux qualification 最終修正（実機EXEC未承認）

基準commit `7187e744e3ae10a81354965016524c12f795035e`と既存public capsule-v8、
Broker/Controller/worker/固定13-suiteを再利用する。新Phase、隔離方式の再設計、既存サービス変更はしない。
旧package/承認票は今回の修正版実行許可に使用しない。

## 二段階とno-write PRE

`run-approved.py`はexact package全ファイルSHAをworkstationで検証し、既存strict-host-verified
Human SSHを使ってtrusted adapterをstdinでPVEへ渡す。`python3 -I -B`でmoduleをメモリ上だけに
展開し、QGAへ同様に渡す。両guestのPREはroot identity、新path/account/group不存在、資源、
toolchain/management prerequisite、保護baselineを読むだけ。guest/hostのmkdir、資材転送、
鍵生成、unit start、package配置、PRE receipt書込はこの段階では行わない。
監査ログや読取時のOS atime更新まで不存在と主張しない。

両PRE成功の証拠をworkstationのexclusive local fileへ保管する。両baselineを再取得・比較した
後のみEXECとしてhost directory作成とpublic inputs転送を開始する。host側mainも新SHA/
PRE receipt custodyを検査して両PREを再検証し、durable claim、鍵生成、guest mkdir/転送へ進む。
両VMのbaselineを各target EXEC直前（transfer後も）、fixed dispatch前、POSTで照合。
変化・失敗・結果不明は新規dispatch/replay禁止。追加したunitだけの限定stopか安全停止とする。

PRE-only CLIは`--pre-only`。このモードはlocal `READONLY-PRE-CANDIDATE.json`を保存するだけで、
実行用の`PRE-COMPLETED.json`を消費/作成しない。実EXEC用のexclusive fileとhost durable claim
は再実行をfenceする。Human approval referenceは実際の承認記録との対応用で、AI発行の
signatureや独立Human承認機構の代用品ではない。

## VM117保護境界

実機読取で12 service（running11 + inactive SSH、QGA含む）と29関連file、117保護tree、既存Node26/
RC-02 runtime3種・`/var/lib/rc02-stage1`のstateを確定した。Node26をqualification toolchainに
流用しない。稼働serviceのunit/drop-in/EnvironmentFiles、MainPID、monotonic start、実行binaryと
absolute file argv、credential source/実runtime credential directoryをmetadata/digestだけで保持する。
ExecStart/cmdlineやinline credentialの本文を出力せずhashのみとする。未解決credential directive/
path、file特殊型、size/count超過、未解決unitがあればPRE停止する。
DBus/journald/logind/networkd/resolved/timesyncd/udevd/unattended-upgrades/getty/SSH/QGAの
固定configuration profile（default/drop-in/不存在sentinel含む）を持ち、未知serviceは停止する。
directory symlinkのresolved targetもcycle/count/size上限でhashし、file symlinkのtarget owner/modeも検査する。
`/run`・`/usr/local/lib`を含むeffective config検索先、PAM共通include、安全policyも含める。

SSH host key・SSH/sudo/network/systemd/QGA config、既存account/group/shadow/gshadowのhash、
root/workspace既知credential path、RC-02既存runtime/stateのdigestを保持する。
新専用account/group/unitだけを比較から除外し、既存recordの変更は検出する。
稼働serviceの増減・PID/start/executable/config変化、credential bytes/owner/mode、network route/
address変化を検出。IPv6 lifetime/expiresの自然減少とJSON list順序だけを正規化し、gateway/
address/interface等は保持する。秘密本文は保存・出力しない。

これは全guestのsecret不存在証明ではない。VM117にはLAN/IPv6 routeとSSH host keyがあり、
credential-free KVM/本番Executorとは認定しない。資格情報を持ち込まないpublic-only namespace
内の一回資格確認だけを、新exact SHAへのHuman承認とlive probe成功後に実施する。

## 失敗・cleanup

`two_phase`の制御順序をfailure injectionで検証する: 片方PRE失敗時にexecute/rollbackなし、
両PRE→両baseline再検証→各target EXEC→両baseline/POST、service/network/credential変化停止、
途中/unknown failureのattempted targetだけ逆順cleanup、post driftの限定cleanup、replay fencing。
mkdir/transfer途中の失敗はinputs/evidenceを保持し、install claimがなければ推測したunitをstop
しない。install claimがあれば既存のchecked inactive/cgroup-empty rollbackを使用し、不明を
成功と報告しない。既存service/secret/stateの自動復元や広域削除をしない。
QGA timeout/disconnectは元guest-exec PIDと未確定状態を保持し、そのPIDの終了が確認できなければ
claim不存在を根拠にcleanup成功としない。再実行せずUNKNOWN/Human inspectionで停止する。
失敗cleanup後も両VMの保護POSTを必ず試行する。片方やhost資源の観測失敗でももう片方を
読取し、UNKNOWN/DRIFTを記録する。保護確認PASSだけでEXEC失敗/不明を成功へ変更しない。

QGAは同期delimiterの前のstale frameだけを破棄し、通常のerrorは拒否。random sync nonceとresponse IDも照合する。
これは既存transportの実機read-only compatibility修正で、管理権限拡大ではない。

## 検証と承認境界

型検査/build、対象JS regression、Python adversarial/failure regression、独立read-only source
review、committed-source isolated build、新packageの全SHA照合を実施し、最終receiptへ記録する。
独立レビューは実機承認・signature・Linux13-suite成功とは異なる。
今回read-only確認だけで、guest配備/probe/13-suite/PVE ACL/SSH/network/VM構成変更なし。
Production Dispatch CLOSED、authority NONE。旧staging SUCCESS・旧BLOCKED証拠は保持する。

次の承認は新commit/new package SHAの専用account/spool/runtime/鍵/unit追加、両VM PRE、
限定EXEC、harmless probe完全成功後のみfixed13-suite一回、署名回収・構造review、両VM POSTと
必要時限定rollbackを一件にまとめる。Humanに途中の操作依頼をしない。実行は新承認後だけ。
