# Security / Trust Control Plane — Bootstrap Campaign v1

**設計草案 / NOT EXECUTABLE / NOT AUTHORIZED — 2026-10-01**

本書は机上調査と設計のみ。実行可能なcampaign manifest、bootstrap script、承認証跡ではない。`HUMAN_DECISION_REQUIRED` が残る間は承認募集・実行不可。今回の依頼をbootstrap実行承認に転用しない。

推奨は **AIがimmutable campaignを準備し、独立human-admin PCの固定executorが実行するhybrid**。CT701/702を新規候補、CT700を既存資源への明示的な追加配備対象、CT703をreservedとする。production mutationの全面Passkey化までを完了条件に含める。CT作成だけ、またはhealth-only service起動だけではCOMPLETEにならない。

## 1. 調査基準と正本

実機へ接続せず、ローカルGit状態・文書・ソースを読んだ。以下は記録時点の証拠であり、現在の稼働・空きIP・権限のlive保証ではない。

| 対象 | 調査時点 |
| --- | --- |
| `C:\work\codex-with-chatgpt` | branch `ai-workspace`、HEAD `3c6bbe6e1a6c88f7ae4675446f43b86dbf1db880` (`Add trusted authority ingestor`)、編集前working tree clean |
| `C:\work\pve-doc` | branch `main`、HEAD `6bb1b298fd2d3df9601989e38c9f4fab66ea8976`。下記4文書に既存変更、未追跡 `.ai/` あり。既存変更は保持 |

`pve-doc` の読取根拠（このcloneと隣接する配置でのリンク）:

- [配置・空きIP](../../pve-doc/00_overview.md#current): 2026-09-27までのCT700配置、CT701/702/703未作成、`.53–.69` は台帳上空き。
- [700–749 namespace](../../pve-doc/docs/security-vmid-namespace-plan.md): formal reservation、個別human-admin承認、fresh unfiltered preflight、security ID再利用禁止、fixture昇格禁止。
- [CT700 creation/isolation/repair履歴](../../pve-doc/docs/security-ct700-bootstrap-plan.md): CT700専用Pool/storage、AI tokenの6 GET拒否とeffective rights=0、旧AI root鍵の5ノード拒否。Stage 1のsparse-hole conffile事故と別承認atomic repairは完了し、どちらも再実行禁止。
- [Stage 2A](../../pve-doc/docs/security-ct700-stage2a-plan.md)、[tailnet方針](../../pve-doc/docs/security-ct700-tailnet-policy-migration.md)、[flow matrix](../../pve-doc/docs/security-ct700-tailnet-flow-candidates.md)、[証拠pack](../../pve-doc/docs/security-ct700-readonly-evidence-pack.md)、[Funnel監査](../../pve-doc/docs/security-ct700-funnel-all-nodes-audit.md): 先頭の2026-09-30 verified stateを採用。後段のallow-all/PARTIALは履歴。
- [PVE/SSH境界](../../pve-doc/docs/platform.md#接続)、[2026-09-27セキュリティ記録](../../pve-doc/07_security.md): AIは限定API token、human-admin秘密鍵は独立PCのみ。AIへのroot再付与やroot helper配置をしない。
- [backup](../../pve-doc/docs/backup.md)、[鍵喪失方針](../../pve-doc/docs/human-approver-ct-plan.md): 通常PBSとsigner例外を区別。
- [構成変更時の更新責任](../../pve-doc/docs/document-map.md#構成変更時の更新チェック): 実行後の台帳・空きIP・入口・監視/退避除外・履歴を整合させる。

既存変更を含む参照bytesのSHA-256（小文字hex、raw file bytes）:

| `pve-doc/docs/` 相対path | SHA-256 |
| --- | --- |
| `security-ct700-readonly-evidence-pack.md` | `3413ae21b34a7897054a268a3bcd5683dfd9ac6ac74665c7e2fb6897fc8fcb48` |
| `security-ct700-stage2a-plan.md` | `e7fc3d34ba4c556a5f00f6bae7d1cbcf313d97117dc1582fcfc370d451d1282f` |
| `security-ct700-tailnet-flow-candidates.md` | `b6b23426525c8b7af93f6a8daf307b685c436398c493b5cab81ff91e8a397857` |
| `security-ct700-tailnet-policy-migration.md` | `77b4066ff4e72551df00b14e2f4850ea8ee69487d81c950a5fdada777c3bb828` |

**HEADだけでは読んだ全内容を再現できない。** 将来のauthorization用releaseは、humanが既存差分の扱いを決めたcleanなpve-doc commitと必要証拠bundleを固定する。本書のhash記録を未承認差分の採用に使わない。この作業ではcommitしない。

## 2. Current architectureと実装境界

### 2.1 記録上のCT700

- pve2 / CT700 / `human-approver-700` / `192.168.0.52/24` / untagged `vmbr0`、1 core / 512 MiB RAM / 512 MiB swap / 4 GiB。
- unprivileged、nesting=0、protection=1、onboot=0、Pool `security-signer-700`、storage `signer-700-private`。CT121は別の既存pre-production資源で、廃止・コピー・名前の引継ぎは対象外。
- 9/27 creation/isolation/Stage 1 PASS後、9/30 Stage 2A PASS（限定scope）。Tailscale joined、Serveはnetwork-only text。Node 24.16.0/Tailscale 1.102.4は記録値。Approver app・署名鍵・Passkey enrollmentの完成証拠はない。
- direct tailnet HTTPS/443のhuman clientは `hqo-039-13` と `g-tune0719` のみ。CT700 identityは記録上 `nqWYzqEqct11CNTRL`、`100.124.154.19` / `fd7a:115c:a1e0::9d2e:9a14`、RP候補は既存 `human-approver-700.tail2f618d.ts.net`。
- 現行はfour-grant least-privilege layout、member-self SSH `check`を保持、member-wide Funnel capabilityなし。14/14のactive Funnel listener=0。CT100/101のsubnet/Exit Node capabilityはKEEP。
- pve2 `veth700i0` のphysical egress filterはPASS。ただしphysical LAN inboundは別scope、pve2全機械lifecycle越しの永続性はlive未検証。runtime DNS `1.1.1.1`、PVE persistent nameserver設定はpending。iPhoneのDNS失敗はdirect TCP拒否の証明ではない。

### 2.2 コードで確認した到達点

| 部品 | 現行根拠 | bootstrap前に残る接続・配備要件 |
| --- | --- | --- |
| Typed Action Core | `src/mcp/typed-actions.ts`、request/attempt hash、bounded timeout、automatic mutation retry=0 | inventory/target authorityと実adapterのproduction接続 |
| CT700 Typed Action Human Approval | `src/approver-service/server.ts`、`src/typed-action-approval/`、UV-required WebAuthn、strict signed bindings | CLIはtrusted window resolverを渡さずdefault null。独立goal/review表示、window authority、production ingressとenrollmentが必要 |
| CT701 Finalizer/ledger/service | `src/typed-action-finalizer/{signer,verifier,storage,server}.ts`、ledger v1、one-use consumption、loopback `127.0.0.1:7010` | authenticated remote boundary、live Execution Bridge、production host composition |
| CT701 package | `scripts/pack-ct701-finalizer.mjs`、`deploy/ct701-typed-action-finalizer/`、[配備契約](ct701-finalizer-deployment.md) | strict configは`deny-all`のみ。`host-injected`へのconfig編集は拒否。新しいreviewed packageが必要 |
| Trusted Context Provider | `trusted-context.ts` / `trusted-context-storage.ts`、[設計](ct701-trusted-context.md) | host所有snapshot、authority-first→ledger lock順、rollback防止運用 |
| Trusted Authority Ingestor | `authority-ingestor*.ts`、[現行説明](ct701-authority-ingestor.md) | in-processのみ。authority DBはv2、独立mutable remote sourceをそのまま読む構成は非対応 |
| CT702 Signed Independent Review Evidence Core | `src/typed-action-review/`、`tests/typed-action-review.test.ts` | production daemon/package/API、protected review runtime/content store/currentness coordinationは未配備 |
| GitIntegrateMain | `src/mcp/typed-action-git.ts` | fixture-only、local file remote、MCP/approval consumer未接続。production Git adapterではない |

CT700の現行packerは`approver-service`とlegacy `human-approval/contract`のみを明示copyしており、server/storageがimportするtyped-action modulesのclosureを含めない。現HEADのpackerをそのままTyped Action用releaseとして承認しない。将来、完全closure・依存lock・clean-room起動検証を必須化する。

`ct701-trusted-context.md`のv1/ingestor未実装記述は後続ingestor仕様とソースにより更新された到達点として解釈する。execution ledger v1とauthority store v2は別DBである。旧Review設計のCT122/123は旧提案名で、正式VMIDではない。

既存testファイルは実装範囲の根拠として読んだが、今回test/build/packageを実行していない。テストによる鍵生成・fixture service起動も今回の実施結果には含まれない。

## 3. 方針差分・衝突と承認前STOP

| 項目 | 既存方針との関係 | v1での扱い |
| --- | --- | --- |
| 一度のchat承認でmulti-stage実行 | CT700の過去手順は段階ごとの別human-admin承認・typed confirmation。namespace予約も個別allocation許可ではない | **方針拡張案**。旧手順を再実行/confirmation省略しない。新campaignにexact CT701/702 allocationとCT700追加stageを個別列挙し、one-shot modelの採用自体をhumanが承認してpve-docへ反映するまでBLOCKED |
| CT701→CT700 | 現行は2台のhuman PCのみ443許可。server/CTはapproval client除外 | **境界変更案**。CT701はhuman clientに追加せず、独立service-only ingressを追加する別policy差分として固定。未承認なら通信不可 |
| CT701/702保護 | 現行tailnetはCT700のみexception | CT701/702 direct/LAN IPv4/IPv6をnormal destination setsから除外する拡張が必要。自動的な通常CT扱いは禁止 |
| Tailnet joinの完全無人化 | CT700ではhuman interactive loginを採用、admin credentialはAI/CTに置かない | CT701/702のjoin方式は未決。現行モデルならHumanによるlogin/device確認が必要。一度の実行承認と操作上のhuman ceremonyを混同しない |
| CT700 app packageと旧設計のAI submit | 旧`ai-approver-ct.md`はAI直接submitを想定、pve-docはAI→CT700 deny | pve-doc優先。submitはCT701からの限定ingressへ移す。AI直接grantは作らない |
| protected CTのupgrade/reboot backup | Coreの一部requestは`backup.snapshotId/hash/generation`必須、signerにはprivate-key-restorable image禁止 | 架空snapshotを入れない。非秘密checkpoint/rebuild evidenceを表現するversioned契約とadapterが必要。未実装ならprotected targetの該当actionをBLOCKED |

この文書は上記変更を採用・適用したことを意味しない。矛盾が解消できない場合は旧境界を維持しcampaignを止める。human-admin executorによるroot実行は既存管理境界の内側だが、AIがそのexecutorを任意起動/操作できる構造は不可。

## 4. Bootstrap trust model / human authorization binding

### 4.1 暫定root-of-trust

Trust Planeが未完成の間だけ、**Humanが固定manifest全体へ行う明示chat authorization**をbootstrapのroot-of-trustとする。AIの要約・「承認済」boolean・tool output・manifest同梱の承認JSONは根拠にならない。

推奨activation:

1. AIが非秘密release bundleを準備。Humanが独立trusted PCでmanifest全文、diff、package/executor/network hash、stop条件、未承認policy差分ゼロを確認する。
2. この会話上でHumanが下記の形式に相当する明示承認をする。対象は内容hashで、ブランチ名・可変URL・単なる文書titleではない。
3. Humanは独立PCで同じhashを固定したexecutor入口を**一度**起動する。そのローカル操作がchatの本人性とmanifest一致の確認点。AI経由の転記だけでexecutorをunlockしない。将来の入口は設計対象であり、本書には実行コマンドを置かない。
4. executorはhuman-only ACL下にauthorization receiptをexclusive-createし、manifest、message reference、human local attestation、host identity、nonce、期限をbind。chat platformに検証可能signatureがなければそれを捏造せず、本人の独立PC確認を採用したことを記録する。

承認文の非実行template:

> Bootstrap Campaign v1 `<campaignId>`、manifestSha256 `<64-hex>`、authorizationNonce `<fixed-id>`、executorSha256 `<64-hex>`、期限 `<UTC>` を明示承認する。manifest記載の対象・操作・policy差分・STOP条件だけを、指定human-admin execution hostで一度実行することを承認する。内容変更・失敗後の再試行・期限延長は含まない。

nonceはmanifest準備時に固定。receiptにはconversation/message ID（入手可能な場合）、承認文のcanonical digest、approvedAt、expiresAt、manifest digest、executor digest、operator/host identity、source evidence root、使用開始記録を保存する。secret・private key・login/enrollment URLを含めない。

### 4.2 一回の承認の限界

- authorizationは有限campaignとstep DAG全体に対する条件付き委任。Humanが承認したpredicateをfresh observationが満たす場合のみ、次の未実行stepへ自動進行する。
- Passkey enrollment/UV、interactive tailnet login、独立デバイスからのE2EはHumanの操作が必要。これらをAIが代行したり、chat承認をPasskey assertionへ変換したりしない。
- manifest、dependency、package、scope、node/IP/storage/resources、key role/ID、policy、期限の変更は必ず新manifest＋新authorization。古いauthorizationをpatchで延長しない。
- authorization期限切れ・cancel・authority不明は即新規dispatch停止。既にin-flightのPVE taskをabort/deleteで戻さず、結果不明ならRECONCILE_REQUIRED。
- chat receiptはCT701のproduction Human Approval evidenceではない。production APIはbootstrap receipt形式を受け付けない。campaignとproductionのtrust domain、ID、DB、key用途を分ける。
- 有効期限、step数、時間/容量上限を固定し、切替未達でもbootstrap authorityを無期限保持しない。期限後はread-only観測と別承認reconciliationだけ。

## 5. Immutable campaign manifest schema draft

実装前の規範的field contract。型名は説明用で、JSON Schema/validator実装ではない。すべてrequired、objectはunknown field拒否、`latest`/wildcard target/free-form shellは禁止。optionalは明示nullableと理由を定義する。

| field | 型・内容・拘束 |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `SecurityTrustBootstrapCampaign` |
| `campaignId`, `authorizationNonce`, `trustDomainId` | 一意の非再利用ID。再試行campaignは別ID、`reconcilesCampaignId`で履歴連結 |
| `validity` | `notBefore`, `authorizeBefore`, `expiresAt`、UTCミリ秒精度、maxClockSkew、observationMaxAge。具体値は承認前必須 |
| `sources` | pve-doc/codex commit full hash、source tree identity、承認済evidence bundle root/hash。dirty execution checkout禁止 |
| `executor` | 固定artifact ID/hash、全payload hash、runtime/OS identity、host identity、operator identity、host-key pins、step catalog version/hash |
| `policyAdoptions` | §3の差分ごとのhuman decision ID、正本文書commit、承認scope、before/after policy digest |
| `ctManifests` | CT700 `existing-update-only`、CT701/702 `create-once`。§6の全field、base identity/absence条件とstage別期待値 |
| `artifacts` | CT別package ID、manifest raw SHA256、file inventory root、archive hash/size、build provenance、lock/toolchain/runtime hash、unit/config hashes、OS template/deb hashes |
| `network` | before policy version/hash、approved candidate hash、compiler/test evidence hash、selectors、all allowed flows、LAN/IPv6/exit exclusions、DNS/HTTPS/RP、join method、identity binding rules |
| `keyTopology` | §8のrole/domain/keyId/algorithm/path/owner/consumer、生成one-shot条件、public output binding規則、transport key別用途 |
| `authority` | currentness owner、target registry hash、generation/fence protocol version、clock policy、audit anchor/retention/recovery policy |
| `steps` | ordered DAG。`stepId`, fixed `operationKind`, targetRef, dependencies, exact input digest, precondition predicate/hash, postcondition predicate/hash, timeout, `maxMutationAttempts:1`, expected receipt schema |
| `allowedMutations` | exact resource/path/action/bytes digest/phaseの閉じた集合。package install、CT start、service start、Serve変更、ACL変更を個別区別 |
| `forbiddenMutations` | auto rollback/delete/recreate/rekey、AI privilege拡張、Funnel、未知target、CT121/703変更、manifest再編集 |
| `expectedPostCreateState` | stopped/keyless/appless、exact config/rootfs/Pool/storage、AI deny、backup除外、network quarantine。CT700には新規create条件を適用しない |
| `humanCeremonies` | tailnet enrollment方式、Passkey enrollment/UV、外部E2Eの実行者・期限・証跡型、待機中の不変条件 |
| `verification` | named acceptance cases、positive/negative expected result、fixture identities/artifact hashes、収集主体、freshness、coverage |
| `stopConditions`, `reconciliationPolicy` | §11/12、unknownをPASSへ変換不可、再試行は新bounded action |
| `cutover` | required PASS一覧、production-only mode、bootstrap revocation対象、irreversible disable protocol/hash |
| `audit` | durable journal path ID/owner、external receipt destination ID、hash-chain protocol、redaction、capacity/retention、independent checkpoint |

### Hash規則

`manifestSha256` はmanifest本文の自己参照fieldにせず、authorization/release envelopeに置く。digestは **SHA256(UTF-8(`security-trust-bootstrap-campaign-v1\n`) || canonicalJSON(manifest))**。canonicalJSONは再帰的key sort、array順序保存、BOM/末尾改行なし、safe integerのみ、duplicate keys/non-JSON/unknown fields拒否。path/IDは正規化後に一致確認し、パーサ間の解釈差をtestする。既存Typed Action wire hash方式とはdomainを共有しない。

artifact hashは別途raw bytesに対するSHA-256。LF正規化が必要ならbuild時に済ませ、配備時に変換しない。hash一覧自体もmanifestで固定。相対pathのescape、symlink/hardlink、archive traversal、余分なfile、サイズ不一致を拒否する。

### 事前に分からない出力

private/public key、CT生成volume ID、Tailscale device ID等は事前に値を捏造しない。manifestには **生成先と検証predicateと一度だけのcapture規則** を固定し、結果はappend-only `CampaignBindingReceipt` に保存する。receiptはcampaign/hash、step、CT/node identity、key role/key ID、public fingerprint、previous receipt hashにbindする。これはmanifest編集ではない。

ただし動的値を許すのは明示fieldのみ。node/IP/storage/resourceの代替候補やpackage version解決は出力ではなくscope変更。Tailscale policyが新IPを必要とする場合、承認済deterministic renderer＋固定device bindingで最終bytesを決める方式を別途検証するか、先にidentity準備を別campaignで完了しpolicy bytesを固定する。任意のpost-approval HuJSON編集は不可。v1は後者の**事前identity確定**を推奨し、完全一括joinを要求する場合はHUMAN_DECISION_REQUIRED。

## 6. CT manifests（提案、allocation未承認）

台帳にCT701/702の実割当はない。以下はCT700 isolation patternを再導出する候補値であり、空き資源・安全性のlive確認ではない。`HUMAN_DECISION_REQUIRED` の値はcandidateを明示採用し、fresh evidenceを添えるまで固定manifestへ昇格できない。

| field | CT701候補 | CT702候補 | 根拠・承認条件 |
| --- | --- | --- | --- |
| VMID / role | 701 / Approval Finalizer | 702 / Independent Review Authority | 正式reserved role。exact allocationはHUMAN_DECISION_REQUIRED |
| node | `pve2` | `pve5` | HUMAN_DECISION_REQUIRED。pve2はCT700運用pattern、pve5はhost障害分離候補。free RAM/disk/CPU未観測、別nodeでもcluster-root共通trust |
| hostname | `approval-finalizer-701` | `independent-review-702` | HUMAN_DECISION_REQUIRED。permanent unique名、DNS/tailnet collision検査 |
| LAN IP | `192.168.0.53/24` | `192.168.0.54/24` | HUMAN_DECISION_REQUIRED。台帳`.53–.69`空きのみ。DHCP/static/ARP/全guest衝突と独立human確認が必要 |
| gateway / bridge / VLAN | `.1` / `vmbr0` / untagged | `.1` / `vmbr0` / untagged | HUMAN_DECISION_REQUIRED。CT700 precedent、各node実bridgeとphysical ingress/egress設計を検証。自動VLAN変更なし |
| CPU / RAM / swap | 1 vCPU / 1024 MiB / **0 MiB** | 2 vCPU / 2048 MiB / **0 MiB** | HUMAN_DECISION_REQUIRED。load未測定。reviewは外部model client前提、local modelを同居させない。secretのswap排出を避ける。host swap/core/hibernationも別途防止 |
| rootfs | 8 GiB raw、専用protected storage | 16 GiB raw、専用protected storage | HUMAN_DECISION_REQUIRED。ledger/evidence retentionを容量算定、path/format実証 |
| OS / runtime | Debian 13、Node 24.16.0を初期検証候補 | 同左 | HUMAN_DECISION_REQUIRED。CT700 template `debian-13-standard_13.6-1_amd64.tar.zst`の既知hashは§1リンク参照。将来releaseでversion/hashを再固定、古い値を無条件採用しない |
| unprivileged / features | `1` / nesting=0, keyctl=0, other features disabled | 同左 | v1提案必須。TUN/device passthrough/shared mount/Docker/privileged化なし。実kernel compatibility失敗でSTOP |
| protection / onboot / initial power | `1` / `0` / stopped | 同左 | v1提案必須。OS bootstrap時のCT startは別step。production自動起動はHUMAN_DECISION_REQUIRED、無断onboot変更なし |
| Pool | `security-finalizer-701` | `security-review-702` | HUMAN_DECISION_REQUIRED。each CT only、AI user/token direct/inherited positive rights=0 |
| storage | `finalizer-701-private`、pve2-only `rootdir` | `review-702-private`、pve5-only `rootdir` | HUMAN_DECISION_REQUIRED。候補backing `/var/lib/vz/<storage-id>` root:root 0700。`local`/`local-lvm`のAI-readable content権限を継承しない |
| backup | PVE/PBS full image/snapshot/replication除外 | 同左 | v1必須。通常PBS jobへ追加しない。非秘密audit exportは§8 |
| DNS | exact resolver/persistent設定 | exact resolver/persistent設定 | HUMAN_DECISION_REQUIRED。CT700 runtime DNSを設定済と転記しない |
| Tailscale role/tag | finalizer node、候補`tag:trust-finalizer-701` | reviewer node、候補`tag:trust-review-702` | HUMAN_DECISION_REQUIRED。未作成tag、human-only owner/admin audit、join/reauth方法、exact ID/IP/IPv6固定。route/exit/RunSSH/Funnel off |
| service ports | loopback `7010`、service mTLS ingress候補`7443` | loopback候補`7020`、service mTLS ingress候補`7443` | 7010は現行契約、その他HUMAN_DECISION_REQUIRED。LAN/wildcard bind禁止 |
| service user | `ct701-finalizer`、nologin、専用group | 候補`ct702-review`、nologin、専用group | CT702はHUMAN_DECISION_REQUIRED。proxy別user、root所有code/config、state 0700/key 0600 |
| package identity | future production host-composition package + approved manifest SHA256 | future CT702 service/package + approved manifest SHA256 | **HUMAN_DECISION_REQUIRED / NOT BUILT**。現行CT701 deny-all packageでは完了不可 |
| audit/monitoring | human-only secret-free health/receipt | human-only secret-free health/receipt | HUMAN_DECISION_REQUIRED。通常AI監視にprotected filesystem/tokenを渡さない |

CT700は新規manifestに**既存target**として記載し、生成/Stage1/repairなし。追加scope候補はverified app package、trusted window/display host、local key generation、public export、service ingress、Serve text→appのexact mapping、enrollment、service start、必要なら明示的DNS/swap変更。既存swap=512 MiBなので、署名鍵生成前にguest/host secret paging防止策を固定する必要がある。現在値との相違を隠して「既に安全」としない。

各CTのmanifestにはPVE tag（未決）、MAC/IPv6設定、rootfs volume binding、mounts/devices空集合、guest SSH不使用、各unitのenabled/active期待値も含める。作成時はPool/storage/CTを各々独立stepとして記録し、rootdirのvolume実体・node scope・permissionを検証する。Pool所属だけでstorage隔離を推定しない。AIのuserとprivilege-separated token両方についてdirect/inherited roleとeffective privilegesを照合し、config/status/snapshot/Pool/storage/PBS contentのGET拒否を確認する。console/power/backup/restore/migrate/delete/ACL変更は権限評価と隔離fixtureで検証し、liveに危険なmutationを投げるnegative testは禁止。

### CT703 decision

**v1はreservedのまま、作成しない。** 必要なauditは各authorityのdurable event＋human-admin管理の独立receipt anchorで成立させる。CT703に署名鍵/サービス/backup/ACLを設ける費用と新しいtrust domainを増やさない。独立anchorの可用性/改竄・rollback耐性を実現できないならcutover BLOCKEDとし、CT703追加は新設計・新manifest。CT701と同じdiskへlogを足すだけで独立auditとは呼ばない。

## 7. Controller placementと権限

| 配置 | PVE privilege / SSH key | AI侵害blast radius | 自動化・audit | cutover / recovery |
| --- | --- | --- | --- | --- |
| human-admin PC | 既存human root資格情報、秘密鍵はPC外へ出さない | AIと別OS/principal、ただしroot executor自体は強い信頼対象 | 固定bundle/host pins/journalで高い。PC常時稼働は必要 | one-shot入口を失効、out-of-band復旧経路保持 |
| AI Workspace | 現行tokenでは作成・protected CT管理不可 | root/helperを渡すと全Trust Planeを破壊可能 | 操作は容易でも境界違反 | **不採用**。Passkey以前の恒久bypassになる |
| dedicated bootstrap runner | 新しいprotected identity、別credential設計が必要 | AI非管理なら限定可能、置き場所とrestore権限を追加監査 | durableで高いがrunner自身のbootstrapが必要 | 将来候補。CT703へ便乗配置しない |
| **hybrid（推奨）** | AIはbundleのみ、human PCのみPVE/admin秘密 | AIが作る入力は非信頼、固定executorでvalidate | Human一回起動後にDAG自動進行、AIへsanitized progress | bootstrap権限を切り離し、復旧はhuman PC |

```text
AI / OpenCode / Codex (proposal, no admin key)
              │ immutable reviewed bundle + non-secret evidence
              ▼
Human trusted PC ── explicit chat binding + one local activation
              │ fixed executor, durable one-shot journal
              │ strict pinned human-admin SSH (no forwarding)
              ▼
PVE fixed node(s) ── fixed CT-local payloads ── CT700 / CT701 / CT702
              │
              └── public-key bindings / redacted receipts → human-only anchor
```

Human PCはAI WorkspaceへのRDP画面内で動かすPCを意味しない。AIが書込/remote-controlできるuser directory、network share、Git checkoutを実行元にしない。bundleをhuman-only stagingへcopyし、全hash再検証、PATH/runtime/environment固定、`NODE_OPTIONS`/agent/hook無効、署名済承認先または独立照合済digestから実行。manifestに任意shell/URL/script pathを入れず、reviewed operation enumを固定payloadへ解決する。

SSHは既存human-admin key、explicit identity、publickey-only、strict known_hosts、agent forwardingなし、password/default-key fallbackなし。PVE hostname/node/cluster identityを再確認してからfixed `pct exec`相当を実行。host-key mismatchはSTOP、scanして自動pin更新しない。AIにはexecutorのroot RPC、SSH agent、tailnet admin credential、再登録可能なroot helperを公開しない。

PVE/cluster rootはCT private keyを技術的には取得できる。CT-local non-exportはそのrootからの暗号学的隔離ではない。human-admin、PVE host/cluster root、reviewed executor、OS/kernelとtailnet control planeがTCBであることを承認に明示する。

## 8. Key topology / non-export / cross-pinning

### 8.1 役割鍵とtransport鍵を分離

| 生成場所 | authority key | public key consumer |
| --- | --- | --- |
| CT700 | Human Approval Ed25519、domain-bound unique key ID | CT701 |
| CT701 | Execution Permit / Finalizer Ed25519、domain-bound unique key ID | Execution Bridge、human-only audit verifier |
| CT702 | Independent Review Ed25519、domain-bound unique key ID | CT701 |
| CT703 | なし | なし |

各key IDは役割・trustDomain・epochを固定。現行package既定`ct700-human-v1`/`ct701-finalizer-v1`を複数domainで使い回さないため、将来packageの契約変更・testが必要。署名鍵をSSH/TLS/transport authenticationに流用しない。

transport用CT-local keyは別生成、各CTの外へexportしない。Execution Bridgeのclient private keyは**Bridge host内**、human PCの既存admin keyはPC内。v1候補はhuman-adminがpublic SPKIをcross-pinするmTLSで、CA private keyをcontrollerへ新設して配布する方式を必須としない。certificate identity/SAN/SPKI/validity/renewalを固定したprofileを実装前に承認する。Tailscale node stateとTLS private keyもbackup/log禁止対象。

CT701→CT700の表示用packageはCT701のauthenticated channelから提供し、CT702原本evidenceとrequest hashをCT701で検証済みとして結合する。CT700がCT702の公開鍵を直接使う必要はv1では設けない。別display signing keyを必要とする実装を選ぶなら用途を明示追加し、新manifestへbindする。

### 8.2 Key generation transaction（将来executor仕様）

1. fresh isolation/backup/non-export checksとCT identity、approved keygen binary hashを検証。key不在、対応role/key ID未使用、生成journalなしを確認。
2. controllerに`KEY_GENERATION_INTENT`をdurable記録。CT-local helperがexclusive-create、umask 0077でEd25519 PKCS8を固定pathへ作成。private bytesはCT内process memoryとprotected fileのみ。core dump、swap、debug dump、shell tracing、backup agentを抑止。
3. owner/mode/type、symlink/hardlinkなし、正しいEd25519 keyをCT内で検証し、fsync file/directoryとlocal receiptを保存。stdoutにはpublic SPKI PEM、key ID、role、CT identity、fingerprintだけを許可。
4. fingerprintは **SHA256(SPKI DER)**、lowercase hexとする（PEM文字列hashやSSH fingerprintと混同しない）。controllerはpublic bytesから再計算し、pinned PVE/CT channelで得たidentityと照合して`CampaignBindingReceipt`へ一度だけ記録。
5. exact consumerのroot-owned trust mapへpublic keyをexclusive-install。role/domain/key IDをmapに固定、未知key ID/違うrole/同じIDで異なるkeyはSTOP。consumer側でSPKI DER fingerprintを独立再計算しreceiptへbind。
6. domain-separated nonce challengeへの署名/検証でproof-of-possessionを確認。任意payload signer APIを公開せず、bootstrap専用固定challenge formatだけ。
7. cross-pin全件とtrust-map digestの確認後のみproduction signer起動gateへ。生成後のprivate keyをpublic export helperが返さないことをfixtureで検証する。

生成応答喪失、keyはあるがreceiptがない、receiptとfingerprint不一致、partial fileはRECONCILE_REQUIRED。**再生成しない**。read-onlyでactual stateを確定し、人間が別bounded reconciliationを承認する。public receiptを失っただけでも新規生成へfallbackしない。

### 8.3 Backup / loss / audit

- 通常PBSは記録上毎日04:00 JST、snapshot、18 guests、日7/週4/月1、client encryptionなし。これをsecurity CTへ自動拡張しない。enabled/disabled/all/Pool selectors、manual backup/restore、PBS/offline media、replication、host filesystem backupまでfresh監査する。
- CT700/701/702全image/rootfs snapshotをv1では禁止し、private key、Tailscale state、TLS key、review credentialsがPBSへ混入しないよう除外を証明する。`backup=0`ひとつで全経路を覆ったことにしない。
- allowlisted非秘密export: public key registry、key validity/retirement、signed evidence、immutable action/receipt hash chain、consumption tombstones、generation/domain high-watermark、sanitized audit。source内容を含むreview archiveは機密分類とhuman-only保存先/retentionを別途固定する。
- non-secret checkpoint exportはstate復元の自動許可ではない。ledgerのconsume/JTI/attempt履歴を古いsnapshotへ戻さない。各mutationのdurable acknowledgementに独立anchorを要求し、anchor不能なら後続mutationを止める。anchor前にmutationが実行された可能性はunknownとして保存する。
- CT/key喪失は停止、旧keyをretired、新trust domain/new key ID、CT700はPasskey再enrollment。旧公開鍵は歴史検証専用、新規発行を拒否。retired security VMIDを再利用せず、新VMIDは別承認。private key restore/exportは通常復旧にしない。

## 9. Communication topology / Tailscale ACL

### 9.1 許可方向（新接続はすべて提案）

| initiator → responder | transport候補 | application authorization |
| --- | --- | --- |
| trusted human PC 2台 → CT700 | 既存tailnet HTTPS/443、stable RP/origin、backend loopback 48768 | WebAuthn UV、single-use challenge、exact displayed request/attempt/review/window。人間端末ACLだけで承認しない |
| CT701 → CT700 | **新service-only mTLS ingress候補7443**、CT700内proxy→loopback | typed approval request/display/windowの限定登録、exact IDのsigned approval evidence取得。enrollment/UV/admin APIは拒否 |
| CT701 → CT702 | mTLS ingress候補7443→loopback 7020 | frozen review request提出、signed evidenceとpublication status取得。caller PASSは受理しない |
| Execution Bridge → CT701 | mTLS ingress候補7443→loopback 7010 | strict finalization/consume/result、client roleとtarget scopeを検証。CT701のone-use ledger + fresh fenced context必須 |
| human-admin executor → PVE → CT | pinned admin SSH＋fixed CT-local payload | bootstrap/admin専用。production service APIには流用しない |

応答trafficは既存接続内のみ。CT700→CT701の新規接続、CT702→CT701のpush、CT700↔CT702、AI→CT700/702、service間SSHはdeny。CT701がpoll/submitすることでreverse service grantを不要にする。CT700↔CT702 directはv1不要。CT701がsource-authenticated reviewを取り込みHuman向け表示を構成する。

Execution Bridgeのcandidate submission経路は非authority入力として別認可し、CT701がexact bytesをfreeze/検証する。AIのfile path/URLをCTからfetchしない。必要bundle転送はbounded upload/content hash/size policyで固定する。

### 9.2 Transportとauthorityの二層

- Tailscale暗号化/ACLは到達制御。IP、MagicDNS、同一LAN、tag、TLS client identityだけでPASS/approval/permitを認めない。
- service transportは相互TLSのpinned client/server identity、期限、role、method/pathを検証。TLS termination proxyからbackendへのidentity headerは外部入力を除去し、root-owned local channelだけを信頼する。loopbackはlocal user認証ではないためpeer制限も必要。
- authorityはCT700/702署名、expected key ID、domain、request/attempt/review/policy/generation/window、fresh currentness、anti-replayにより判定。署名が正しくてもstale/revokedなら拒否。
- CT701現行bearer bridge-tokenはisolated authenticationでありproduction認証とはしない。future host gatewayがmTLSを検証してCT-local credentialへ変換するならtokenはCT701内のみ。既存tokenをAI/Bridgeへコピーする方式を既定にしない。
- production BridgeはAI Workspaceに置かず、AIがbinary/config/credential/inventory/target filesを書けないprotected execution hostに置く。CT701にはPVE mutation credentialを置かない。配置・権限はHUMAN_DECISION_REQUIRED。

### 9.3 Network policy installation

1. 現行policy全文/version、全device ID/owner/tag/IPv4/IPv6、admin/network-admin/tagOwners、route/exit/public forwardingをhuman-onlyで取得。過去のfour-grant説明からpolicyを再構築しない。
2. CT701/702をnormal-node/LAN destination集合から除き、human-443、CT701→700 service port、CT701→702 service port、Bridge→701 service portだけを追加。CT700への2-PC-only **UI**原則を保持する。新service port許可は§3の明示policy差分。
3. Tailscale grantsは加算。deny欄で上書きできると考えず、すべてのacceptの重なりからunauthorized pathを除く。両subnet router経由`.52/.53/.54`、IPv6、exit/public-forwarding、shared-node/SSH selectorも検査する。
4. Funnel capability/active listenerは引き続き禁止。通常Serve、CT100/101両subnet/Exit Node、PVE/NAS/AdGuard、bowling/povo/codex-usage regressionを保存。全tailnetを無断service単位zero-trustへ変更しない。
5. **秘密鍵生成前**にnetwork quarantineとphysical LAN ingress/egress境界を作りnegative検証。CTはNIC未接続またはdrop policy下のstopped状態で作る。boot時の露出窓を作らない。CT700のegress filterをCT701/702へ機械copyしない。
6. policyの最終service allowはSTARTING前にexact hash/versionでinstallし、expected before-stateとのCAS不一致はSTOP。OS bootstrap時は固定artifact転送と明示DNS/time/tailnet control通信だけ。packageのregistry/latest取得や無制限outbound許可を追加しない。
7. real compiler/test＋IPv4/IPv6/direct/LAN/both routers/off-tailnetのnegative E2E。DNS不解決だけをTCP deny PASSにしない。伝播不明・未検証経路はBLOCKED。

Tailscale enrollmentは別human credential境界。interactive方式ではhuman ceremony待ちをstateに保存する。自動joinを選ぶなら短命one-use/scoped enrollment手段を独立PC内だけで扱う方式を新たに審査し、AI/controller logs/repoへsecretを出さない。未解決のまま「one-click完全無人」と約束しない。

## 10. Currentness・Execution Bridge integration設計

CT分離後の最大の未実装gateは**署名検証と同時性の違い**。remote CT702への一回GETや期限付き署名だけでは、consume直前にreviewがsupersedeされたraceを防げない。

v1推奨はCT701を **target/request/policy/review activation generationの唯一のcoordinator** とする新protocol:

1. CT701がbounded candidateをfreezeし、trusted inventory/policyからrequest/attemptをauthorする。CT702はそのexact packetで独立reviewを実行・署名する。review runtime/profile/model credentialはCT702管理、AIから書換不能。AIが持参したPASSやsession IDを再署名しない。
2. CT702のreviewはCT701 activation commit前は`PENDING_PUBLICATION`。CT701→CT702のauthenticated pollingで取得し、signature/integrity/chronologyを検証したうえでCT701所有snapshotへadoptする。ack後に初めてproduction-currentと表示する。
3. CT702のsupersede/revoke要求もこのcoordinatorでcommitする。CT701がpolling不可能、CT702にunacknowledged invalidationがある、または履歴連続性を確認できない場合は新しいfinalize/consumeをfail closedにする。pending invalidationとconsumeの順序をtransaction/fence protocolで定義し、単なる「直近poll済」にはしない。
4. host compositionはCT701 authority DBの`BEGIN IMMEDIATE`と同じ所有権でcurrentAuthority snapshotを固定する。current generationの別ファイル・AI supplied boolean・独立更新remote DBをcoreへ直結しない。
5. 既存authority-first→ledger lock順を保持し、consumeとBridge live handoffまでfenceを維持。Bridgeにはaction/target/attempt・fencing token・期限にbindした**live一回handoff**が必要。GETしたpermit/HTTP 200/cached JSONは実行capabilityではない。
6. Bridgeはdurable attempt tombstone、target executorのexclusive fence、最新generation照合、receiptを持つ。切断/lease expiryだけでlockを解放して再実行しない。remote handoff acknowledgement喪失、consume後失敗、clock rollbackはRECONCILE_REQUIRED。

これは新protocolの設計要件で、現coreで実現済とはしない。CT702が独自に即時currentnessを変更する運用を選ぶなら、代わりにdistributed fencing/commit protocolが必要。coordinatorの意味とrevocation線形化点をHumanが承認し、concurrency/crash試験で証明できるまでproduction packageを作動させない。

## 11. Campaign state machine

campaign journalはhuman-only durable store。1 campaignに1 writer、global campaign lock＋target/resource lock。stepごとに`NOT_STARTED → INTENT_DURABLE → DISPATCHED → OBSERVED → VERIFIED`をappendし、receipt/high-watermarkをanchorする。通信成功だけでVERIFIEDにしない。

| state | entry / 実行内容 | exit gate |
| --- | --- | --- |
| PREPARED | designからclosed manifestへ。未解決decisionをzeroにし、全artifact/step hash固定 | offline validation/review PASS |
| WAITING_HUMAN_AUTHORIZATION | digest付き全文表示、mutation禁止 | exact chat binding＋独立PC activation receipt |
| AUTHORIZED | nonce/host/期限/未使用状態確認、exclusive campaign lock | immutable bytes一致 |
| PREFLIGHT | fresh authoritative unfiltered PVE/PBS/ACL/host-key/IP/policy/template/capacity/clock/backup確認 | 全predicate PASS。filtered AI inventoryだけでは不可 |
| CREATING | approved quarantine、専用storage/Pool、CT701、CT702を順次create-once | each CT stopped、exact post-create state。CT700 create不可 |
| ISOLATION_VERIFY | human PVE effective rights＋AI GET-only denials、host root/backup/restore/physical network確認 | each new CT独立PASS。CT700もfresh確認 |
| BOOTSTRAPPING | exact CT start、OS/runtime package、user/path、service auto-start抑止、hash-pinned key helper staging | dpkg/conffile/owner/runtime/sandbox PASS、app signerは未起動 |
| KEYING | §8のCT-local generation、transport/public outputsを一度だけbind | complete generation receipts、不明ゼロ |
| CROSS_PINNING | public keysを指定consumerへinstall、readback hash/role/possession検査 | complete trust-map digest、秘密非export |
| DEPLOYING | exact approved app/unit/config、CT701 separate DB/CT702 state、service network policy install | package bytes/schema/policy/backup exclusion PASS、未起動 |
| STARTING | manifest順でCT702 authority→CT701 composition→CT700 app/proxy→Bridgeを起動、bootstrap admissionはfixture-only | no unexpected listener、trusted context ready。順序循環をhealth-only startupで解消 |
| VERIFYING | pins/TLS/ACL/receipt/currentness/negative integration、human enrollment ceremony | integration PASS、Human UV実測 |
| E2E | isolated targetsで全normal/maintenance/repair/break-glass/negative cases | §13のPASS証跡が同release/domainへbind |
| READY_FOR_PASSKEY_CUTOVER | 本番mutationはまだlocked、cutover条件を再観測 | Passkeyによるbounded cutover action＋bootstrap kill receipt |
| COMPLETE | Passkey-only mode、bootstrap reject probe PASS、audit/docs receipt | terminal。再起動/再launchでmutationしない |
| BLOCKED | mismatch/期限/authority不明等でdispatch禁止。変更未着手または結果確定 | このrunではterminal。read-only確認のみ、新authorization/actionでのみ解消 |
| RECONCILE_REQUIRED | mutation intent後のcrash/partial/unknown outcome。actual stateを保全 | このrunではterminal。新bounded reconciliation planへ移行 |

Human ceremony待ちは対応state内の`WAITING_HUMAN_CEREMONY` substatusで、次phaseへ進めない。期限内かつunknown mutationなしの場合に同runで待機解除できる。trusted executorの生存中に次の未実行stepへ進むことと、停止後のmutation retryは別。

**再実行semantics:** completed stepはreceipt確認だけでskip、mutation再送不可。プロセス再起動はjournalのread-only inspectionから開始。`INTENT_DURABLE`以降に不確定なstepがあればRECONCILE_REQUIRED。verified boundaryで停止した場合もautomatic mutation resumeをv1では行わず、新bounded continuationをfresh observation＋新authorizationで承認する。COMPLETE/BLOCKED/RECONCILE_REQUIREDの同runをACTIVEへ戻すAPIを設けない。

PREFLIGHTはexecution直前に繰り返し、各stepにも直前preconditionと直後postconditionを置く。動的free space等は承認済下限predicateで判定し、変化すべてを全体hash mismatchにせず、security/config fieldと容量値の意味を区別する。TTL、容量不足、lock競合、unknown schemaはSTOPで、値を緩めない。

## 12. Failure / reconciliation semantics

禁止: automatic destructive rollback、blind retry、partial CT delete/recreate、uncertain key generation後の再生成、completed mutation replay、node/IP/storage/resourceを変えて成功させること。

| failure | 結果/次の行為 |
| --- | --- |
| preflight mismatch、VMID/IP既存、authority不明 | BLOCKED、変更なし。新観測とHuman判断 |
| storage/Poolのみ作成済、CT create失敗/timeout | RECONCILE_REQUIRED、既存resource/task/volumeを保持。削除もcreate再送もしない |
| CT701成功後CT702失敗 | CT701を温存、後続key/service phaseへ進まない。CT702だけの新bounded planでも全体bindingを再承認 |
| apt/dpkg/conffile partial | actual package/conffile/policy-rc.d状態を保存、汎用`dpkg --configure -a`やStage1 rerunなし。exact file/package repairを別承認 |
| key応答喪失、pin片側のみ | secret不触、read-only identity照合、key再生成/上書きなし |
| deploy interrupted、DB schema違い、stale lock | bytes/pointer/DB/journalを保全、auto migration/ledger reset/lock deleteなし |
| network install/propagation/startup失敗 | 新規dispatch停止、現policy/servicesを保全。旧allow-allの自動復帰や自動stop/deleteなし |
| consume/handoff/receipt不明 | consumed identity永久保持、Bridge/target actual stateを照合。再発行しない |
| audit保存失敗/clock後退/anchor不一致 | fail closed。実行済み可能性を隔離、restartで解決したと扱わない |

Reconciliation planは`originalCampaignId/hash`, failed step/action/attempt, last verified receipt, intent/dispatched markers, fresh observed state/hash/time/source, unknowns, resource ownership/dependencies, proposed exact new bounded operation, pre/postconditions, new expiry, evidence/audit destinationを含む。Humanに「確定済・未実行・結果不明」を表示する。

read-onlyで成功が証明された元stepはobservational resolutionを記録し、元mutationを再実行しない。未実行と証明された場合も新action ID/attempt/new authorizationからだけ実行。破壊的cleanupは別承認、key/backup/dependency/tombstone検査が必須。DB内部のtransaction rollbackと、PVE/CTのdestructive rollbackを混同しない。

## 13. Passkey production cutover / acceptance

### 13.1 Normal operations coverage

productionはHuman UV→CT700 signed bound approval→CT702 independent review→CT701 current/fenced finalization→Bridge one-use dispatch→verified receipt。実際の発行順はreview→Human approval→finalizeで、UI上もその順序を固定する。

| 必須operation | 現行core | cutover前に必要なもの |
| --- | --- | --- |
| Git integration | `GitIntegrateMain`、fixture adapter | protected repository registry、real remote identity/credential boundary、local deltas preservation、production adapter。隔離bare remoteでE2E |
| deploy | `AppUpgrade` contract | exact artifact/target/unit/config、approved bounded adapter、receipt。trust-plane自身の更新も含む |
| apt upgrade | `AptUpgradeNode/Guest` contract | exact package manifest/locks、reboot別承認、capacity/conffile failure検証、protected target用非秘密recovery契約 |
| service restart | `RestartService` contract | exact service registry、control permission、health/receipt |
| CT start/stop | **未定義** | versioned `StartGuest`/`StopGuest`等、target generation/dependency/impactをbind、startとstopを区別 |
| node/guest reboot | `RebootNode`のみ | guest reboot contract/adapter追加、quorum/依存/boot ID/health、destructive/reboot approval binding |
| bounded config change | **未定義** | versioned file/config operation、exact target/path registry、before/after hash、syntax validation、bounded reload別操作 |

Coreに型があることはproduction adapterがあることではない。全rowの契約・adapter・UI・review・receipt・target credential enforcementが揃い、隔離実環境でPasskeyのみの経路がPASSするまでcutover不可。routine mutationでhuman-admin SSHを要求する穴を残さない。

### 13.2 Mandatory PASS matrix

- **Normal Typed Action PASS:** 全row、wrong target/action/attempt/hash/key/generation/window/expiry、署名改変、duplicate consume、restart後replay、concurrent request拒否を検証。
- **Passkey Maintenance PASS:** §14のsessionをreal UVで開き、有限diagnosis/command/file scopeとexpiry/revokeを検証。
- **Repair workflow PASS:** isolated service failure、permission/file corruption、dpkg/config partialを、chat/root通常経路なしで観測→bounded repair→検証→receiptまで実行。
- **break-glass rehearsal PASS:** §15のTrust Plane unavailable場面、out-of-band本人アクセス、audit、state/key照合、Passkey復帰。production鍵を消して試験しない。
- **audit/receipt PASS:** per-step/body/hash/chain/domain/currentness/one-use、disk-full/anchor-loss、unknown receipt、whole-store rollback検知。redactionも検証。
- **isolated full E2E PASS:** disposable Linux/systemd環境と独立trusted browser、productionと別domain/key/ledger/targetで、create→isolation→OS→key/pin→deploy→policy→start→review→UV→consume→adapter→receipt→recovery→cutover→旧chat rejectionを通す。

isolated fixtureは700–749へ作成せず、productionへ昇格しない。将来のfixture作成/鍵生成/サービス起動も別implementation taskの承認scope。本書の設計作業中には行わない。テストPASSの有効期間、build/config hash、OS/kernel、sources/denial coverageを固定し、mock PASSをlive ACL/systemd/Passkey PASSへ代用しない。

### 13.3 Chat bootstrap authorityを永久無効化する条件と手順

1. 上記6 PASS、全HUMAN_DECISION_REQUIRED解消、CT700/701/702のfresh isolation/backup/key/current-state verify、外部audit anchor正常、unresolved reconciliation=0を要求。
2. bootstrapの最後に、人間がPasskey経路でexact `CutoverToPasskeyOnly` bounded actionを承認する。このceremonyは初期chat authorizationの再承認ではなく、稼働したPasskey経路の実証。manifestは最初からこのgateを要求する。
3. まずすべてのproduction mutation入口で`BOOTSTRAP_DISABLED_PENDING`をdurableに設定し、**chat/bootstrap入力を拒否**。CT701、Bridge、target executors、controller admissionでmonotonic epoch/tombstoneを保存、独立anchorへ記録。途中crashなら両経路で新規mutationを止め、chatへfallbackしない。
4. bootstrap artifact起動権/temporary credentials/staging execution経路を失効し、one-shot nonceを永久consumedにする。human-admin既存credentialはbreak-glass専用として保持するが、AIが呼べるscript/service/RPCを残さない。
5. `PASSKEY_ONLY`へactivateし、古いchat receipt、同campaign、期限改変、古いpackage、DB/config rollback、別process/rebootからのbootstrap再起動が拒否されることを検証。config flagを戻すだけで再有効化できる設計は不採用。
6. current package/mode、revocation receipts、policy/pins、normal/repair/recovery入口をhuman-only auditへ保存、正本文書更新receiptを確認してCOMPLETE。

「永久」は当trust domain/epochについて、一度cutoverしたchat bootstrapを通常API/maintenance/config復元で再開できないという意味。PVE/root自体による全置換はTCB外の攻撃であり、独立anchorで不一致を検出して停止する。全損は新trust domainのhuman-admin recoveryで、旧chat承認復活ではない。Passkey cutover未達を理由にchatによるproduction mutationを常態化させない。

## 14. Passkey Maintenance / Repair model

通常経路にgeneric unlimited shellを設けない。**bounded maintenance session**は有限scopeの委任で、既存Typed Action v1に任意fieldを追加せず、新versioned contractとして実装する。

Human approvalへbindするsession manifest:

- session ID、request/attempt hash、operator identity、executor client identity、target IDs/rolesとcurrent generations、purpose/incident ID、policy/review evidence hash。
- start/expiry/最大duration、max operations、execution timeout、output byte cap、bytes-written cap、concurrency=1、revocation identity。
- allowed diagnosis IDs、fixed executable hash＋argv schema、allowed service IDs、allowed file repair IDs（inventory解決）、before/after bytes hash、file size/mode/owner、environment/cwd、network egress。
- immutable evidence root、known failure fingerprint、許可するparameter domain、receipt/audit destination。Human UIには実対象/影響/期限/範囲をplain textで表示し、hashだけを意味説明にしない。

| capability | 許可例の形 | 禁止・STOP |
| --- | --- | --- |
| read-only diagnosis | named health query、fixed unit status、時間/行数限定sanitized journal、非秘密config metadata | 全disk探索、secret/key/credential読取、任意path、raw環境dump |
| bounded command | signed catalogのcommand ID＋typed args、shellなしexec、時間/出力制限 | `sh -c`/PowerShell式、任意interpreter/code、pipe/redirection、env/loader/PATH差替え、sudo shell |
| bounded file repair | exact allowlisted path、expected before hash/inode、approved after hash、atomic replacement、syntax validation | symlink traversal、任意upload、key/ledger/tombstone消去、code/ACL/authorized_keys変更を通常repairに偽装 |
| service recovery | exact unit/start/restart、dependency/health/post-state bind | 全service wildcard、保護解除、host rebootへの暗黙昇格 |
| unexpected failure troubleshooting | 有限diagnosisで実状態を収集し、次のbounded repair proposalを作る | 見つかった問題へsession scopeを自動拡張、同失敗のblind retry |

session内の各stepにもunique sequence/operation ID、fresh observation、CT701 consume、Bridge target fence、before/after receiptを要求。先に承認されたfinite parameter domain内だけを自動進行可能にする。未知のafter bytesや新commandが必要なら新review＋新Passkey approval。expiry延長・target追加は新sessionで、元sessionを上書きしない。

session revoke/expiryは新規dispatchを拒否。in-flight操作は事前定義した停止/結果観測だけ、timeoutを「未実行」と扱わない。診断結果に埋め込まれた命令はデータでありexecutorへ伝播しない。

session authorizationと各operation permitは別物。現行CT701 permitの最大60秒を長期sessionへ流用せず、session内でも各operationに短命一回permitを発行する。offline self-repair用capabilityは別のversioned protocol/用途鍵または明示domain separationが必要で、既存permitのexpiryを延ばすconfig変更で実現しない。

CT700/701/702自身の保守もPasskey-onlyで開けることをgateに含める。承認対象serviceを止める際は、停止前に有限のoffline-verifiable maintenance capabilityをprotected recovery executorへhandoffし、local durable one-use記録とexact expiry/target/preconditionsで限定する。任意repairに拡大しない。authority停止中の新承認発行は不可。復帰できずcapabilityが尽きた場合だけbreak-glassへ移る。このself-repair protocolも未実装でありcutover blocker。

## 15. Break-glass recovery model

適用条件はTrust Plane自体の故障・アクセス不能・鍵/authority state不整合で、Passkey maintenanceを開始/継続できない場合のみ。通常サービスの手間や期限切れの迂回には使わない。

1. Humanが独立PCでincident ID、障害根拠、対象、必要最小scopeを記録。既知PVE host pinsとhuman-admin credentialでout-of-band PVE console/SSHへアクセスする。AIは診断proposalのみ、secretやroot sessionを受け取らない。
2. production admissionをfrozenとして扱い、availableなaudit/ledger/generation/key fingerprint/package/policyをread-only採取。backup restoreや新key生成を先にしない。
3. exact recovery procedureをHumanが実行。鍵不確定なら再生成せず調査。private-key loss/compromise、ledger rollback、state continuity不明なら旧domainをretireし、新domain/ID/新enrollmentのre-establishment planを作る。
4. 全操作にintent/time/operator/target/before-after hash/resultを記録。secret本文は記録しない。未解決consumeは永久quarantine、新しい操作も旧attemptを再利用しない。
5. current key pins、role/epoch、target generation、revocations、package/OS、PVE AI denial、tailnet/physical ACL、backup exclusion、audit high-watermarkを独立照合。古いPVE/PBS設定から旧AI root認可が復活していないことも確認。
6. fresh review、real Passkey normal＋maintenance canary、receipt/negative E2E後だけproduction admissionを再開。temporary accessを撤去し、human-only auditとpve-docへ復旧記録、Passkey control planeへ復帰する。

break-glassはchat authorization endpointを再有効化しない。Human-adminの明示的local recovery procedureであり、AIが「人間がchatで了承」と申告してroot commandを流せる恒久backdoorは作らない。rehearsalは独立fixtureで、admin PC紛失・Tailscale不通・CT701 DB不明・CT700鍵喪失のcaseと復帰までを含める。

## 16. Implementation phases / exit criteria

全phaseは今後の別作業。本書にはbootstrap scriptsを含めない。

| phase | 成果物 | exit criterion |
| --- | --- | --- |
| 0: policy/design resolution | §3/17のHuman判断、pve-docの新CURRENT方針、source snapshot整合 | one-shot authority、service-only CT700 ingress、CT manifests/backup/controller承認 |
| 1: offline contracts | strict manifest/receipt/canonical hash validator、state/journal semantics、maintenance/new action schemas | unknown/duplicate field、manifest変更、expiry/replay、crash位置ごとのfixture PASS |
| 2: production authority composition | CT700 trusted UI/window feed、CT702 protected runtime/API/package、CT701 ingestion/coordinator、Bridge protocol | same-principal AI forgery不可、revocation/currentness concurrency、remote handoff unknown tests PASS |
| 3: immutable release packaging | complete import/dependency closure、offline exact packages、runtime/unit hashes、key helper/public-only transport | clean-room Linux load、systemd/DAC/sandbox、no secret/artifact余剰、current schemas PASS |
| 4: fixed executor | human PC専用、701/702固定create/guards、CT700 existing-only steps、key/pin/network journal | fake-PVE/SSH/transport failure injection、partial/key uncertainty/replay STOP、no root RPC |
| 5: production operations/repair | 全normal adapter、maintenance/recovery executor、self-maintenance、break-glass procedure | §13全rowとaudit/state continuity検証 |
| 6: isolated campaign rehearsal | disposable環境、real browser UV、full campaign/failure/cutover E2E | 6 mandatory PASS、test evidence release hashes固定 |
| 7: freeze and authorization | clean reviewed commits、exact packages/policy/identity、closed immutable manifest、human-readable summary | HUMAN_DECISION_REQUIRED=0、Human chat binding＋独立PC一回activation |
| 8: future live bootstrap | fresh preflight→create→isolation→OS→key/pin→deploy→start→verify | mismatch/partialでSTOP、正常系のみREADYへ |
| 9: Passkey cutover/closure | Passkey-only admission、chat kill、audit/documentation receipts | old-chat replay denied、maintenance/repair/recovery復帰確認、COMPLETE |

将来の実行後文書更新はpve-doc `00_overview.md`、空きIP、サービス入口、platform実行一覧、backup/monitoring/Ansible/朝次/startupへの追加または明示除外、execution evidenceとtombstoneを対象とする。exact編集範囲と承認方式もcampaignへbindする。Git commit/pushはbootstrapの暗黙操作に含めない。必要なら別のPasskey Git actionとして実施する。

## 17. HUMAN_DECISION_REQUIRED register

| ID | 決定・入力が必要な内容 | 未解決時 |
| --- | --- | --- |
| HD-01 | pve-doc既存4差分の正本化/除外判断、clean reviewed source commitsとevidence root | manifest freeze不可 |
| HD-02 | 段階別承認からfinite campaign一回承認への方針拡張、exact allowance、期限/nonce/本人確認/取消方法 | AUTHORIZED不可 |
| HD-03 | CT701/702 exact allocation、node/IP/hostname/bridge/VLAN/CPU/RAM/swap/rootfs/storage/Pool/PVE tags、capacity | CREATING不可 |
| HD-04 | CT700既存状態のfresh baseline、DNS永続化/secret paging防止、app/key/enrollment/Serve変更のexact scope | CT700 key/start不可 |
| HD-05 | CT701→CT700 service-only ingress追加、CT701/702 exception拡張、ports/selectors/physical boundary | network policy freeze不可 |
| HD-06 | trusted PC 2台のfresh identity、tailnet admin/tagOwners、service tagsまたはindividual selectors、join/reauth方法、dynamic output方針 | identity/policy install不可 |
| HD-07 | human-admin execution host/operatorとlocal receipt確認方式、host pins、audit storage、TTL/step budgets | executor activation不可 |
| HD-08 | production Bridge/recovery executor配置、target credentials/inventory/ACL、AI書込/Elevation排除 | production action/repair不可 |
| HD-09 | authority coordinator/currentness/revocation線形化点、distributed fence/handoff profile | finalization/consume production不可 |
| HD-10 | immutable CT700/701/702/Bridge package identities、OS/runtime/deb hashes、新契約version、release test証拠 | DEPLOYING不可 |
| HD-11 | trustDomain/epoch/key IDs、固定paths、transport identity/renewal、public pin consumers、loss/re-enrollment方針 | KEYING不可 |
| HD-12 | PVE/PBS/image exclusion、host swap/core/backup対策、非秘密audit/consumption anchor保存先・retention・容量・復旧 | secret生成/cutover不可 |
| HD-13 | Passkey RP/origin/credential enrollmentとrecovery人員、trusted display、normal全actions＋maintenance self-repair UX | Passkey cutover不可 |
| HD-14 | normal/repair/break-glass/isolated full E2Eのexact fixture targets、実施者、期限、coverage | READY不可 |
| HD-15 | onboot/監視/朝次/Ansible/startupの明示除外・追加、実行後docs update scope/責任 | COMPLETE不可 |
| HD-16 | CT703 reserved＋human-only独立audit anchorでv1要件を満たす判断 | 不成立なら新audit設計。自動CT703作成なし |

## 18. この設計作業の終了状態

設計文書のみをworking treeへ追加。live PVE/Tailscaleへの接続・mutation、CT creation、deploy、鍵生成、service activation、commit、pushは実施しない。設計のaccepted status、manifestSha256、production PASSは発行していない。次の入口はHD registerの判断とoffline実装依頼であり、本書を実行承認として扱わない。
