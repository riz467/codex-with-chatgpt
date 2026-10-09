# Linux qualification — upload custody v2（実機EXEC未承認）

基準commit `1d89cf08d9779c0531e573047ef042d140dcfa41`。
旧package `35a3cb96e791f0e42d8e658dc54c4a676f6464b1e7ea22fa37ca16eff7c9068d`は保全証拠であり再実行しない。
既存Capsule/Broker/Controller/固定13-suiteと保護条件は再利用し、新PhaseやProduction authorityを追加しない。

## 固定した新旧境界

旧pve5 root `/var/tmp/ai-linux-qualification-release`、旧guest
`/var/lib/ai-linux-qualification-approved-input`を削除・chmod・上書きしない。
新host rootは`/var/tmp/ai-linux-qualification-custody-v2-release`、新guest inputは
`/var/lib/ai-linux-qualification-custody-v2-input`。新rootが存在すればfail-closed。
新bundle内exclusive PRE、新host exclusive execution claim、新root内keysを使用し、
旧秘密鍵・claim・PREを新実行へ流用しない。旧PREは照合対象としてだけ使用する。

旧host manifest/claim/PREのSHAを固定し、旧host tree（private keysはhashのみ）と旧guest treeを
PRE/EXEC/各start/各POSTで照合する。旧117 input inventory/owner/mode/nlink/SHAを要求し、
既知の0666公開filesをroot0700の旧領域にそのまま保持する。旧116 inputは不存在を要求する。
tree digestはowner/group/mode/device/inode/nlinkを含む。旧claim不明・変化で停止。
既存service/config profileの256MiB per-file limitは維持し、既知843MB公開archiveを含む
旧campaign領域だけ1GiB per-fileとする。aggregate4GiB/count100000の上限は維持する。

以前のguest account/runtime/unitは未作成なので、従来の固定account/runtime/spool/unit名を
変更しない。それらが存在すれば従来どおり停止する。old inputsと新runtimeが混在しない。

## Guest QGA secure upload

メモリ上のtrusted adapterが固定basename allowlistだけを受け付け、新root0700 inputへ
`O_CREAT|O_EXCL|O_NOFOLLOW`/0600でファイルを作成し、descriptorとpathnameのroot所有、
通常file、0600、nlink1、device/inodeと空sizeを確認してfsyncする。umask000でも0600を要求。
QGAはこの既存0600ファイルへ`r+b`で書き込み、`wb`による生成/切詰めをしない。
QGA open後・書込前にidentity/empty sizeを再確認し、全chunkのwrite countを検査。
QGA flush/closeを確認した後、descriptor fsync/最終size/SHA256/identity/custodyを再確認する。
`deploy.package`のPATH_CUSTODY判定は緩和しない。

既存・symlink・hardlink・0666・owner/mode変更・size/SHA不一致は停止し、ファイルを修復/
削除せず証拠保持。QGA timeout/open/write/flush/close不明はno replay。close呼出前から
unknownを保持し、後続verified完了なしに成功と扱わない。cleanupは元guest-exec PIDが
終了したことを確認できない場合にUNKNOWNを返し、unit stop成功やclaim不存在に置き換えない。

## Host public reuse / bounded transport

まず両VM read-only PRE・resources・旧custodyを成立させ、repeat baseline比較してからEXEC。
旧hostのcapsule.tar/host-runtime.tarだけをroot custody、non-symlink、通常file、nlink1、
not group/world-writable、全SHA一致で再利用する。専用新領域へ独立した0600ファイルを
O_EXCL/O_NOFOLLOWでコピーし、descriptor/path identity、size、fsync、SHAを検証する。
部分archive・旧adapter/source/manifest/PRE/鍵をコピーしない。

host ancestorsはroot-owned non-symlink/non-writableを要求し、`/var/tmp`のみsticky条件で
書込可能parentを許容する。これはhost専用rootに対する明示policyで、guest safe条件を緩和しない。
新directoryと全fileのcustodyを後段mainも確認する。
小容量の新adapter/manifest/sourceだけをSSH -Cのlength-framed stdinで転送する。
source<=1MiB、file<=32MiB、各1200秒。約843MB capsuleのworkstation再送と300秒deadlineを廃止。
host reuseは600秒、資格確認全体の外部transportは2100秒で、timeoutはno resume/no retry。
Windowsのcommand-line limitを避け、public sourceはargvへ埋め込まない。private key本文も出力しない。

## Validation / live gate

offlineのPOSIX metadata simulationと実file byte/inode/exclusive create検査、QGA mock failure
regressionを追加する。Windows上のsimulationはLinux kernel permission/QGA/live namespace証明ではない。
元のPRE先行/保全/rollback/no-replay regressionsと型検査/build/qualification回帰を再実行。
独立レビュー後、committed-source isolated buildで新12-file packageを作り、新exact SHA承認票を発行する。

新packageのHuman一括承認と適用される独立承認成立後だけ、fresh両PRE→host reuse/
secure input配置→限定EXEC→probe完全PASS時だけ13-suite一回→signed result/構造review→
両VM/旧保全POST、必要時新unitだけbounded rollbackを行う。未知/失敗で追加Campaignなし。
今回の作業はread-only custody確認とoffline修正/検証のみで、新root/keys/account/unit/probe/suiteなし。
VM117はcredential-free KVM/本番Executorではない。Production CLOSED、authority NONE。
