# Security / Trust Control Plane — Bootstrap Campaign v1

**設計草案 / NOT EXECUTABLE / NOT AUTHORIZED — 2026-10-01**

本書は机上調査と設計のみ。実行可能なcampaign manifest、bootstrap script、承認証跡ではない。2026-10-01 decision-resolution passと後続HumanのHD-13決定により旧HD 16件を **A=4 / B=11 / C=1 / D=0** に分離した（§17）。Human判断解消だけでは実行可能にならず、implementation・preflight・exact manifest authorizationの全gateを要求する。今回の依頼・custodian決定をbootstrap実行承認に転用しない。

推奨は **AIがimmutable campaignを準備し、独立human-admin PCの固定executorが実行するhybrid**。CT701/702を新規候補、CT700を既存資源への明示的な追加配備対象、CT703をreservedとする。production mutationの全面Passkey化までを完了条件に含める。CT作成だけ、またはhealth-only service起動だけではCOMPLETEにならない。

## 1. 調査基準と正本

実機へ接続せず、ローカルGit状態・文書・ソースを読んだ。以下は記録時点の証拠であり、現在の稼働・空きIP・権限のlive保証ではない。

| 対象 | 調査時点 |
| --- | --- |
| `C:\work\codex-with-chatgpt` | decision-resolution基準: branch `ai-workspace`、HEAD `8a9bef37eceddb5190afc297e4d596e33e61f002` (`Design trust control plane bootstrap campaign`)、編集前working tree clean。初回コード調査基準は `3c6bbe6e1a6c88f7ae4675446f43b86dbf1db880` |
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

**HD-01=B: HEADをbase source、4差分を非実行dirty evidence bundleとしてfreezeする。別clean commitは不要。** 2026-10-01にdiff全体をread-only照合し、4 raw hashesは上表と一致、index差分なし、tracked差分は137 additions/45 deletionsと確認した。変更は9/28のv4選択的観測・2-PC membership・VPN/Exit KEEP・Funnel/selector設計履歴の補足/訂正であり、既にHEADにある9/30 verified先頭節を変更していない。古い本文中のCURRENT/PARTIAL/allow-allを9/30より優先しない。

| 既存差分 | 分類 / campaignへの影響 |
| --- | --- |
| readonly-evidence-pack | 観測provenance/collector制約の履歴補足。live evidenceや実行payloadではない |
| stage2a-plan | 旧allow-all/2-PC/tagの履歴訂正。9/30 PASSのscopeとDNS/inbound/lifecycle未確認を維持 |
| tailnet-flow-candidates | KEEP 22/REMOVE 9/UNKNOWN 6とHuman VPN要求の根拠。未確認trafficを必要性の否定に使わない |
| tailnet-policy-migration | category-level最小権限案とselector制約の補足。旧HuJSON skeletonは非実行資料、live policyとして採用不可 |
| untracked `.ai/` | task/baseline/audit等の作業成果物。campaign source allowlist外、内容を実行・正本化しない。削除/変更不要 |

HEAD単独で9/30 CURRENTとinventoryは引用できるが、今回読んだ根拠全体の再現には不足する。freeze時はbase full commit/tree ID、allowlisted 4文書のraw bytes/size/hash、HEADとの差分と各blob ID、由来・時点・CURRENT/HISTORY区分を含む非実行bundle rootを固定する。元dirty checkoutからscriptを起動せず、実行artifactは別のclean reviewed sourceからbuildする。将来のpve-doc方針反映はIR-12の文書化dependencyで、既存差分を先にcommitする必須条件ではない。hash一致は承認そのものではなく、bundleも最終manifest review対象。今回bundle生成・commit・pve-doc編集はしていない。

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
| 一度のchat承認でmulti-stage実行 | CT700の過去手順は段階ごとの別human-admin承認・typed confirmation。namespace予約も個別allocation許可ではない | **Human方針確定（HD-02=A）**。新campaignにexact CT701/702 allocationとCT700追加stageを列挙し、一回のhash-bound authorization対象にする。旧手順再実行なし。正本文書反映はIR-12、実際のauthorizationは将来の一回activation gate |
| CT701→CT700 | 現行は2台のhuman PCのみ443許可。server/CTはapproval client除外 | **境界変更案**。CT701はhuman clientに追加せず、独立service-only ingressを追加する別policy差分として固定。未承認なら通信不可 |
| CT701/702保護 | 現行tailnetはCT700のみexception | CT701/702 direct/LAN IPv4/IPv6をnormal destination setsから除外する拡張が必要。自動的な通常CT扱いは禁止 |
| Tailnet joinの完全無人化 | CT700ではhuman interactive loginを採用、admin credentialはAI/CTに置かない | interactive loginを継承。HD-06のidentity観測はC、loginはHuman ceremony、policy rendererはIR-05。追加の方式選択は不要 |
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
| `sources` | pve-doc base/codex build commit full hash、source tree identity、§1の非実行dirty evidence bundle root/hash、policy decision provenance。dirty execution checkout禁止 |
| `executor` | 固定artifact ID/hash、全payload hash、runtime/OS identity、host identity、operator identity、host-key pins、step catalog version/hash |
| `policyAdoptions` | §3/17の既存Human decisionまたはtechnical resolution ID、source commit＋evidence root、承認scope、before/after policy digestまたは固定renderer/binding contract hash |
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

ただし動的値を許すのは明示fieldのみ。node/IP/storage/resourceの代替候補やpackage version解決は出力ではなくscope変更。HD-06解消案は **hash固定deterministic renderer＋typed device binding receipt** とする（IR-05）。未作成CTのdevice ID/IPをfresh preflightで得られると偽らない。freezeするのはrenderer、before-policy、固定role/CT/name/owner条件、出力slot、test predicates。join ceremony後に管理側inventoryとCT内観測の一致を一度captureし、そのslotだけを埋める。既存deviceのselector変更、normal集合への自動追加、owner変更、余分なgrantを拒否する。最終bytes/hashをreceiptへbind、compiler/union testsとbefore-state CAS後だけinstall可能。任意のpost-approval HuJSON編集は不可。renderer未実装ならIR-05でBLOCKEDとし、追加Human判断や別identity campaignを既定にしない。

## 6. CT manifests（提案、allocation未承認）

台帳にCT701/702の実割当はない。以下をHD-03=Bのtechnical candidateとして採用する。好みのnode/IP選択をHumanへ求めない。空き資源・安全性のlive確認ではなく、PR-02/03失敗時はSTOP。freeze前の再設計は可能だが、freeze後の代替node/IPへの自動変更は禁止。

| field | CT701候補 | CT702候補 | 根拠・承認条件 |
| --- | --- | --- | --- |
| VMID / role | 701 / Approval Finalizer | 702 / Independent Review Authority | 正式reserved role。実allocation許可は将来のexact campaign承認内 |
| node | `pve2` | `pve5` | pve2のCT700運用patternを再利用、pve5でreview host障害を分離。両16GBの記録。cluster-rootは共通TCB |
| hostname | `approval-finalizer-701` | `independent-review-702` | role/VMIDから一意生成。PR-02でcollision検査 |
| LAN IP | `192.168.0.53/24` | `192.168.0.54/24` | 台帳空き連番、DHCP `.101–.200`外。PR-02で予約/static/全guest/ARP照合、無応答だけを空き証明にしない |
| gateway / bridge / VLAN | `192.168.0.1` / `vmbr0` / untagged | 同左 | CT700 precedent、PR-03でbridge実体/physical境界確認 |
| CPU / RAM / swap | 1 vCPU / 1024 MiB / **0 MiB** | 2 vCPU / 2048 MiB / **0 MiB** | reviewは外部model client、local modelなし。IR-06のbounded load試験で検証、host pagingもPR-07で確認 |
| rootfs | 8 GiB raw、専用protected storage | 16 GiB raw、専用protected storage | 初期予算: OS/release 4/6 GiB、state 2/6 GiB、余裕2/4 GiB。超過は停止し無断拡張なし |
| OS / runtime | Debian 13、Node 24.16.0を初期検証候補 | 同左 | `debian-13-standard_13.6-1_amd64.tar.zst` precedent。exact supported versions/deb/hashはIR-06でrelease固定、PR-03で配置確認。Human入力ではない |
| unprivileged / features | `1` / nesting=0, keyctl=0, other features disabled | 同左 | v1提案必須。TUN/device passthrough/shared mount/Docker/privileged化なし。実kernel compatibility失敗でSTOP |
| protection / onboot / initial power | `1` / `0` / stopped | 同左 | v1全期間onboot=0。Passkey maintenanceのbounded start/recoveryを用いる。OS bootstrap CT startは別step |
| Pool | `security-finalizer-701` | `security-review-702` | each CT only、AI user/token direct/inherited positive rights=0 |
| storage | `finalizer-701-private`、pve2-only `rootdir` | `review-702-private`、pve5-only `rootdir` | backing `/var/lib/vz/<storage-id>` root:root 0700。`local`/`local-lvm`のAI-readable content権限を継承しない。PR-03/04 |
| backup | PVE/PBS full image/snapshot/replication除外 | 同左 | v1必須。通常PBS jobへ追加しない。非秘密audit exportは§8 |
| DNS | persistent `1.1.1.1` | 同左 | CT700 runtime precedentを継承、fallback resolverなし。CT700も追加stageで永続化。PR-03/05 |
| Tailscale role/tag | finalizer / tag未使用 | reviewer / tag未使用 | 個別IPv4/IPv6 selector＋device ID binding。将来tag候補`tag:trust-finalizer-701` / `tag:trust-review-702`は新設不要。route/exit/RunSSH/Funnel off |
| service ports | loopback `127.0.0.1:7010`、tailnet-only mTLS `7443` | loopback `127.0.0.1:7020`、tailnet-only mTLS `7443` | 固定technical design。LAN/wildcard bind禁止、PR-06のlistener衝突とIR-05検証 |
| service user | `ct701-finalizer`、nologin、専用group | `ct702-review`、nologin、専用group | proxy別user、root所有code/config、state 0700/key 0600 |
| package identity | future production host-composition package + approved manifest SHA256 | future CT702 service/package + approved manifest SHA256 | **IMPLEMENTATION_REQUIRED / NOT BUILT (IR-03/06)**。現行CT701 deny-all packageでは完了不可 |
| PVE tags | `security;trust-control-plane;finalizer;no-image-backup` | `security;trust-control-plane;review;no-image-backup` | labelのみ。ACL/backup exclusionの実効証明にしない |
| audit/monitoring | human-only secret-free health/receipt | 同左 | §17 HD-12/15。通常AI監視にprotected filesystem/tokenを渡さない |

CT700は新規manifestに**既存target**として記載し、CT生成/Stage1/repair再実行なし。追加scopeは§17.2のverified app package、trusted window/display host、local key generation、public export、service ingress、Serve text→appのexact mapping、enrollment、service start、明示的DNS/swap変更。既存swap=512 MiBなので、署名鍵生成前にguest/host secret paging防止策を固定する。現在値との相違を隠して「既に安全」としない。

各CTのmanifestには上表のPVE tags、MAC（701=`02:00:00:00:07:01`、702=`02:00:00:00:07:02`、PR-02で重複検査）、physical IPv6 address/RA無効・Tailnet IPv6保持、rootfs volume binding、mounts/devices空集合、guest SSH不使用、各unitのenabled/active期待値も含める。作成時はPool/storage/CTを各々独立stepとして記録し、rootdirのvolume実体・node scope・permissionを検証する。Pool所属だけでstorage隔離を推定しない。AIのuserとprivilege-separated token両方についてdirect/inherited roleとeffective privilegesを照合し、config/status/snapshot/Pool/storage/PBS contentのGET拒否を確認する。console/power/backup/restore/migrate/delete/ACL変更は権限評価と隔離fixtureで検証し、liveに危険なmutationを投げるnegative testは禁止。

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

transport用CT-local keyは別生成、各CTの外へexportしない。Execution Bridgeのclient private keyは**Bridge host内**、human PCの既存admin keyはPC内。v1はhuman-admin境界でpublic SPKIをcross-pinするmTLSを採用し、CA private keyをcontrollerへ新設して配布する方式を必須としない。certificate identity/SAN/SPKI/validity/renewalは§17.5のtechnical profileをIR-07で実装・検証し、最終manifestへbindする。Tailscale node stateとTLS private keyもbackup/log禁止対象。

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
- production BridgeはAI Workspaceに置かず、AIがbinary/config/credential/inventory/target filesを書けないprotected execution hostに置く。CT701にはPVE mutation credentialを置かない。HD-08=Bとしてhuman-admin PC `hqo-039-13`をcandidate採用、PR-08で独立性/capabilityを検証する。

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
2. CT702のreviewはCT701 activation commit前は`SIGNED_PENDING_PUBLICATION`。CT701→CT702のhost-owned peerで取得し、signature/integrity/chronologyを検証したうえでpublication reservationを取り、CT701所有snapshotへadoptする。production-currentの線形化点はCT701 durable COMMITであり、publication ACKはその後のdurable obligation。ACK未確定中のconsumeは禁止。transport authenticationはIR-05。
3. CT702はreview authorでありproduction-currentnessの別writerではない。supersede/revokeはCT701のserialized admissionへ提出し、**CT701 authority DBのdurable COMMIT** をactivation/revocationの線形化点とする。CT702ローカルのpendingは「失効済み」を意味しない。新規consumeごとにCT701がsequence-bound readiness barrierをpollし、CT702は未提出invalidationがあれば拒否、応答後はそのbarrierの決着まで新publicationを保留する。CT701は失効要求を受けた時点で新規handoffを閉じ、既存handoffの確定/unknown記録と順序を付けてcommitする。応答喪失、sequence欠落、CT702不通はfail closed。「最後にpollできた」だけではdispatchしない。
4. host compositionはCT701 authority DBの`BEGIN IMMEDIATE`と同じ所有権でcurrentAuthority snapshotを固定する。current generationの別ファイル・AI supplied boolean・独立更新remote DBをcoreへ直結しない。
5. 既存authority-first→ledger lock順を保持し、consumeとBridge live handoffまでfenceを維持。Bridgeにはaction/target/attempt・fencing token・期限にbindした**live一回handoff**が必要。GETしたpermit/HTTP 200/cached JSONは実行capabilityではない。
6. Bridgeはdurable attempt tombstone、target executorのexclusive fence、最新generation照合、receiptを持つ。切断/lease expiryだけでlockを解放して再実行しない。remote handoff acknowledgement喪失、consume後失敗、clock rollbackはRECONCILE_REQUIRED。

HD-09=B。既存ingestorのauthority-first lock/host-owned snapshot条件に整合する単一coordinator設計で、distributed consensusは不要。CT702は独立内容判断を行い、CT701はその署名を偽造/変更できない。通信不能でも進むavailabilityは要求しない。remote admission/barrierとtarget fenceのoffline coreはIR-04 progress欄を参照。失効はcommitより前の不可逆dispatchを取り消さない。CT702の局所時刻で即時失効する別authorityを後から導入するのはscope変更。production transport/adapters/packageの別gateを満たすまでproduction packageを作動させない。

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
| 0: policy/design resolution | §17のHuman判断は解消済み、technical resolutions、pve-doc方針反映とsource evidence整合 | 既存Human方針を再質問せず、IR/PRを別registerで追跡 |
| 1: offline contracts | strict manifest/receipt/canonical hash validator、state/journal semantics、maintenance/new action schemas | unknown/duplicate field、manifest変更、expiry/replay、crash位置ごとのfixture PASS |
| 2: production authority composition | CT700 trusted UI/window feed、CT702 protected runtime/API/package、CT701 ingestion/coordinator、Bridge protocol | same-principal AI forgery不可、revocation/currentness concurrency、remote handoff unknown tests PASS |
| 3: immutable release packaging | complete import/dependency closure、offline exact packages、runtime/unit hashes、key helper/public-only transport | clean-room Linux load、systemd/DAC/sandbox、no secret/artifact余剰、current schemas PASS |
| 4: fixed executor | human PC専用、701/702固定create/guards、CT700 existing-only steps、key/pin/network journal | fake-PVE/SSH/transport failure injection、partial/key uncertainty/replay STOP、no root RPC |
| 5: production operations/repair | 全normal adapter、maintenance/recovery executor、self-maintenance、break-glass procedure | §13全rowとaudit/state continuity検証 |
| 6: isolated campaign rehearsal | disposable環境、real browser UV、full campaign/failure/cutover E2E | 6 mandatory PASS、test evidence release hashes固定 |
| 7: freeze and authorization | clean build commits＋非実行evidence bundle、exact packages/policy renderer、freeze直前fresh read-only preflight、closed manifest | HD=0、IR exit証拠、PR baseline PASS、Human chat binding＋独立PC一回activation |
| 8: future live bootstrap | fresh preflight→create→isolation→OS→key/pin→deploy→start→verify | mismatch/partialでSTOP、正常系のみREADYへ |
| 9: Passkey cutover/closure | Passkey-only admission、chat kill、audit/documentation receipts | old-chat replay denied、maintenance/repair/recovery復帰確認、COMPLETE |

将来の実行後文書更新はpve-doc `00_overview.md`、空きIP、サービス入口、platform実行一覧、backup/monitoring/Ansible/朝次/startupへの追加または明示除外、execution evidenceとtombstoneを対象とする。exact編集範囲と承認方式もcampaignへbindする。Git commit/pushはbootstrapの暗黙操作に含めない。必要なら別のPasskey Git actionとして実施する。

## 17. Decision-resolution pass / three registers

### 17.1 HD-01〜HD-16 disposition（2026-10-01）

A=`RESOLVED_BY_EXISTING_DECISION`、B=`AUTO_RESOLVABLE`、C=`PREFLIGHT_RESOLVABLE`、D=`TRUE_HUMAN_DECISION_REQUIRED`。主分類は各IDにつき一つ。Bはtechnical candidateを本書で決定した意味で、実装済み・live検証済み・mutation承認済みではない。A/BにもPR evidenceが必要な場合がある。Cはfreeze直前のfresh read-only evidenceを採用し、過去観測で代用しない。未構築componentはDへ戻さない。

| ID / 元の内容 | 分類 | 根拠 | 決定した具体値/方針 | manifest freeze前evidence | Human再質問 / 残す一問 |
| --- | --- | --- | --- | --- | --- |
| HD-01 source state/4差分 | B | §1の全diffとraw hash照合。変更は歴史補足、9/30 CURRENT不変 | HEAD＋4文書の非実行dirty evidence bundle。`.ai/`除外。別clean commit不要 | PR-01、IR-12: base/tree/blob/bytes/差分/bundle root、CURRENT優先規則 | 不要 / なし |
| HD-02 one-shot authorization | A | 本会話でfinite immutable campaign、一回chat＋独立PC activation、unknown STOP確定 | §4を採用。scope/hash変更は新authorization。6 PASS前にcutoverしない | IR-01/11のreceipt/state/cutover試験、PR-09のclock/期限 | 不要 / 将来のexact manifest authorizationは未実施の必須ceremony |
| HD-03 CT701/702 allocation | B | namespace正式予約、inventoryの空き帯、CT700専用storage precedent | §6の全candidateを採用。701=pve2/.53、702=pve5/.54 | PR-02/03/04: unfiltered inventory、IP/MAC/name、capacity、storage/ACL。IR-06 load/容量 | 不要 / なし。availabilityはC型PRへ分離 |
| HD-04 CT700 baseline/追加scope | B | Stage1/repair完了、9/30 network-only CURRENT。未配備app/keyを追加するだけ | §17.2のdelta stages。新create/旧Stage1/Stage2A再実行なし | PR-05のfresh exact baseline、IR-02/05/07、PR-07 paging/backup | 不要 / なし。baseline driftはSTOP |
| HD-05 network flows/ports | B | 2-PC UI、AI deny、additive grants、service-only分離で必要最小に導出可能 | §9＋§17.3。443 UI、7443 mTLS、7444 bounded proposal、7445 audit。physical LANアプリingressゼロ | PR-06の全policy/route/IPv6/forwarding、IR-05 compiler/union/fixture検証 | 不要 / 新境界は最終campaign scopeで承認、個別のport選択不要 |
| HD-06 fresh identities/join/selectors | C | 名前や過去IPだけでは現在のdevice/owner/adminを確定できない | 個別device selectors、interactive enrollment、tag新設なし。新CT IDは§5 typed output、既存IDはPR-06 | freeze直前の2-PC/CT700/AI/全normal node ID・owner・両IP family・admin/tagOwners・policy。新CT不在とrenderer証拠 | 技術選択は不要 / login本人操作はHD-13 custodianのceremony |
| HD-07 controller/receipt/budgets | B | hybridはHuman方針済み。v4 collection実績を持つ独立PCをtechnical候補化できる | `hqo-039-13`固定executor、human-only staging/receipt。§17.4 budgets | PR-08のhost identity/OS/DAC/pins/AI非管理、PR-09、IR-01 | 不要 / operatorはHD-13で現在のHuman本人に確定 |
| HD-08 Bridge/recovery host | B | 既存AI guest/通常runnerは特権境界を増やす。独立PCは既存root credential境界 | `hqo-039-13`に専用service principalとfixed Bridge/recovery。比較は§17.4 | PR-08のAI書込/remote-control/elevation排除、IR-04/09 target enforcement、credential scope | 不要 / 新CTの好みを聞かない |
| HD-09 currentness coordinator | B | ingestorのhost-owned snapshot/authority-first lock契約と整合 | CT701 authority DB COMMITが唯一のactivation/revocation線形化点。§10 barrier/fence | IR-04のrace/crash/partition/revocation順序証拠、PR-09のclock/state | 不要 / protocol未実装はIR-04 |
| HD-10 packages/hashes/contracts | B | package hashはbuild出力、Humanが選ぶidentityではない | closure完全なclean buildのcontent-addressed release。package ID=`role-sha256:<archive raw hash>` | IR-02/03/06/09/10/11、PR-10のexact release/test照合 | 不要 / NOT BUILTはimplementation dependency |
| HD-11 key topology/IDs | A | 本会話の3-role、transport分離、non-export、SPKI cross-pin、loss時new domain方針済み | §8＋§17.5の自動ID/path/profile。現時点で鍵を生成しない | IR-07のpublic-only/one-shot/loss試験、PR-07、domain/ID既使用照合 | 不要 / なし |
| HD-12 backup/audit anchor | B | full image禁止固定、通常PBS/NASは共有障害/管理domain | g-tune0719独立anchorを最小候補。§17.6のappend-only/high-watermark、非秘密のみ | PR-07/08のbackup/ACL/容量、IR-08 whole-store rollback/anchor-loss試験 | 不要 / 可用性不足はSTOP、CT703自動作成なし |
| HD-13 Passkey/人員/UX | A | 本会話の後続Human回答で選択肢A（本人単独・主/予備別保管）を明示採用。RPは一意、UXは実装 | 承認・Tailnet enrollment・break-glass custodianは現在のHuman本人。将来追加はPasskey/監査付き独立trust-change。§17.7 | Human決定記録、PR-06/08、IR-02/10/11のfixture UV/repair証拠。production enrollmentは後続ceremony | 不要 / 決定済み。bootstrap実行承認ではない |
| HD-14 E2E fixtures/operator/coverage | B | namespaceは900台temporary、security ID再利用/fixture昇格禁止。§13のcoverage既定 | §17.8のdisposable nested lab、一つのtest topology。operatorはHD-13本人 | IR-11 full suite/release binding、PR-02/03 fixture reservation/capability、PR-10 expiry | 不要 / test topologyを選ばせない |
| HD-15 monitoring/startup/docs | B | CT121/700の通常PBS/監視/朝次除外、document-map更新責任 | §17.9の明示include/exclude、onboot=0、human-only health/receipt、bounded maintenance更新 | IR-12 inclusion/exclusion差分、PR-11のselector/static list/動的検出照合 | 不要 / なし |
| HD-16 CT703 | A | 本会話でreserved、独立anchorで足りる限り作成不要 | create/deploy/key/ACLなし。anchor不成立はcutover BLOCKED | IR-08/PR-08の独立anchor証拠、manifest forbiddenMutations | 不要 / なし |

### 17.2 HD-04 — CT700に追加するstageのみ

CURRENTは§2.1/9月30日先頭節を採用し、inventoryの古いtailscaled inactive記録で上書きしない。PR-05でhostname/node/config、Stage1 repaired files、dpkg audit、Serve fixed text、tailscale identity、app/key不在、既存filter/unit hashesを再照合する。予期しないapp/keyやdriftは採用せずSTOP。

1. **追加isolation hardening:** physical LAN inboundとboot露出防止を新規scopeで実装、既存egressを保持/検証。persistent nameserverを`1.1.1.1`へ、guest swapを512→0 MiBへ変更するexact deltaをmanifest化。host swap/dump/hibernation防止の対象・before/afterも明示し、鍵生成前に検証。安全なhost変更が別guestへ影響するなら無断実施せずfreeze前に再設計。
2. **app/key/pin:** 完全closureのCT700 package、trusted request/review/window表示resolver、dedicated user/unit/proxyを追加。CT-local Human Approval/transport keyを一度生成し公開SPKIだけcross-pin。keyless/currentなCT700を新規CTとして扱わない。
3. **ingress/Serve:** CT701専用tailnet mTLS 7443を新設。既存443のexact text mappingだけを`127.0.0.1:48768`のUIへ置換。enrollment/UV/admin APIを7443から拒否。FQDN維持、既存tailscale stateのreset/rejoinなし。
4. **activation:** exact service start、Human Passkey enrollment/UV、isolated E2Eとproduction acceptance。Stage1、atomic repair、旧Stage2A/Serve resumeを呼ばない。通常OS一括upgradeはこの追加stageへ混入しない。

### 17.3 HD-05/06 — minimal network profile

§9の4 authority flowsを採用し、欠けていたproposal/audit flowを以下で閉じる。すべて新設候補であり現在のlisten/grantとは主張しない。`TS(x)`はPR-06またはtyped bindingでdevice ID/ownerに結び付けた**個別**IPv4/IPv6の集合で、account/group/wildcardではない。

| initiator selector → destination | TCP / scope | role制限 |
| --- | --- | --- |
| TS(hqo-039-13), TS(g-tune0719) → TS(CT700) | 443 UIのみ | WebAuthn UV、既存2-PC membership保持 |
| TS(CT701) → TS(CT700), TS(CT702) | 7443 | service-only mTLS、request/evidenceのみ |
| TS(hqo-039-13 Bridge) → TS(CT701) | 7443 | finalize/consume/handoff/result、target registry固定 |
| TS(ai-workspace-win) → TS(hqo-039-13 proposal gateway) | 7444 | bounded uploadのみ、最大64 MiB、path/URL/shell/authority booleanなし、mTLS submission専用keyは非特権。admin/dispatch/recovery APIなし |
| TS(hqo-039-13 audit relay) → TS(g-tune0719 anchor) | 7445 | append/checkpoint/readbackのみ、mTLS別role。既存recordの削除/更新権なし |
| hqo-039-13 fixed executor/Bridge → 固定PVE node IPs `.20–.24` | 22、pinned human-admin SSH | bootstrapまたはPasskey一回capability検証済みfixed catalogのみ。AI起動root RPCではない |

CT700は新規outbound authority接続なし、CT702はCT701へのpushなし。CT701が両authorityの非秘密receiptを収集しBridgeがanchorへrelayする。relayはauthority署名を作れず、chain sequence欠落で停止。これらのservice PC portsもhost firewallで明示sourceを制限する（通常VPNの広いPC到達権だけで開けない）。backendはloopback＋local peer制約、CT700 UIとservice ingressは別route table。

normal-tailnet集合からCT700/701/702の両familyを除外し、normal-LAN集合は`192.168.0.0/24`から`.52/.53/.54`を除外。both CT100/101 subnet/Exit capabilityとmember-self SSHを保持。protected CTをordinary **source**集合からも除外してoutbound broad grantを防ぐ。physical eth0のapp ingress全deny、physical IPv6/RA deny、tailscale IPv6保持。必要なunderlay outboundはDNS `1.1.1.1` UDP/TCP53、approved control/DERP HTTPS TCP443、必要なSTUN UDP3478に限定するcandidate、peer UDP直結はv1不要（DERP経路を検証）。宛先集合はreleaseの固定egress profileへbindし、無制限public IPv4への既存許可を新CTへcopyしない。CT内timeはPVE hostから継承、NTPの新guest flowなし。

CT702の外部review modelはruntimeが必要とするproviderのexact HTTPS endpoint/credential用途/送信data classをIR-03で固定し、無制限Internet/AI持参URLを禁止。既存権限を超える新たなデータ外部送信や課金が必要と判明した場合は別scopeとして止める。今回provider契約を承認したとは扱わない。

joinはHuman interactive、service tags新設なし。人間PCの既存tag/ownerはPR-06で観測し変更しない。tag候補名を選べることとassign可能なadmin principalの安全性を混同しない。freeze直前に全admin/network-admin/tagOwnersをread-only監査し、AIがidentityを付替えられるならSTOP。unjoined CTはquarantineからcontrol enrollmentのみ許可し、unknown identityへservice grantしない。IR-05 rendererと管理inventory一致を証明してからauthority通信を開く。

### 17.4 HD-07/08 — controller / Bridge placementとbudgets

| inventory候補 | security/capability比較 | 結論 |
| --- | --- | --- |
| `hqo-039-13` | v4で独立human-admin collection/pinned PVE SSH実績、CT700 UIの既存trusted member。AI非管理の証明はPR-08で更新 | **bootstrap controller＋production Bridge/recovery候補として採用**。既存credential境界を拡散しない |
| `g-tune0719` | 第2の既存trusted PC。primaryのdisk/OSと分離できる | independent receipt anchorに採用。read-only capability確認前に稼働済みとはしない |
| CT120 / NAS / CT200 / PVE host | CT120は通常PBS/Ansible管理、NASは共通backup、CT200は特権PBS、PVE rootは全authorityへ到達 | 新privileged Bridgeを同居させない。AI管理・secret-restorable backup・共有TCBの面で劣る |
| VM111 / CT700/701/702 | VM111はAI、authority CTへのtarget credential同居はrole分離を壊す | 不採用 |
| 新専用CT/host | 新identity、credential配布、隔離/backup例外と自身のbootstrapが増える。PVE CTではcluster-rootから独立しない | v1で不要。既存PCのcapability不足ならSTOPして再設計、黙って新CTへfallbackしない |

primary PCではproposal gateway（非特権）、Bridge verifier、fixed target executor、bootstrap executorを別principal/ACLにする。AIはcode/config/registry/staging/SSH agentを変更・invokeできず、gatewayからexecutorはvalid one-use live handoff以外で起動不可。credentialsは既存human-only store内、必要target/operationだけfixed adapterで利用。無制限command RPCは設けない。productionはPasskey承認後自動進行し、毎回Human SSH操作を要求しない。primaryがsleep/offlineならSTOP。起動は一回activationとOSによる固定service lifecycleであり、AIの任意service startではない。将来の新package/設定/permission変更はPasskey管理action。

非秘密配置candidate: primary `C:\ProgramData\TrustPlane\{releases,registry,journal}`、anchorは別PCの `C:\ProgramData\TrustPlane\audit-anchor`。AI/RDP共有・同期folder・repo checkout外、service ACLをPR-08で検査。PC名だけをtrusted証明にしない。Windows service runtime/OS対応はIR-06/09、現在利用可能とは未確認。

bounded既定値（B、必要ならfreeze前のoffline測定で再設計）: `authorizeBefore = freezeAt + 1 hour`、`expiresAt = freezeAt + 8 hours`、maxClockSkew=5秒、observationMaxAge=300秒、step数上限256、各mutation max attempts=1、並列mutation=1。exact step timeoutはIR-11実測から導出し上限30分、全DAG critical path＋ceremony待ちを8時間内に収める。収まらなければfreeze不可。nonce/campaign IDは将来CSPRNG UUIDv4、既使用IDをanchorで拒否。cancelはlocal human-only receipt→new dispatch停止、期限/unknown failureも同じSTOP規則。cutover未達を理由に期限を延長しない。

### 17.5 HD-11 — automatic ID/path/transport profile

既定topologyは§8のまま。将来のdomain準備でCSPRNG UUIDv4を生成し、production=`tp-prod-<uuid>`、fixture=`tp-fixture-<別uuid>`、bootstrap campaign domainは別IDとする。非秘密IDのみmanifestへ固定し、anchorのever-used registryと重複したらfreeze拒否。epoch初期値1、key ID=`<trustDomainId>:<role>:e0001`、roleは`ct700-human` / `ct701-finalizer` / `ct702-review`。loss時はepochだけ増やして同domain再使用せず新domain/new ID、旧IDはretired履歴検証専用。

private path候補はCT700 `/var/lib/ai-approver/signing.key`、CT701 `/var/lib/ct701-finalizer/signing.key`、CT702 `/var/lib/ct702-review/signing.key`。consumer public mapは各 `/etc/<service>/trust-map.json`、transportは各service state下`transport/`、所有専用user、directory 0700/file 0600。path変更はpackage contractとしてIR-07で固定、private bytesはexport/log/backupしない。

transportは独立鍵＋直接SPKI cross-pin、TLS1.3、client/server EKUとrole別SAN URI `urn:trust-plane:<domain>:<role>:transport:e0001`、365日validity、期限30日前にbounded rotation action、expiredはSTOP。CA秘密鍵配布不要。cert validityだけで認可せず、SPKI/domain/role/endpointを照合。rotationはnew ID、old/new transition windowと全consumer receiptを別Passkey actionでbindする。Human Approval/Finalizer/Review Ed25519鍵をTLS/SSHへ流用しない。今回ID/鍵/certは生成しない。

### 17.6 HD-12 — minimum independent audit anchor

**primary hqo-039-13 durable journal＋second PC g-tune0719 append-only anchor** を採用候補とする。primaryと別OS/disk/principalで、PVE/PBS credentialをanchorへ渡さない。NAS/CT200/PBSは共通backup経路/通常管理下、CT701同diskは同時rollback可能なので単独anchorに不適。新CT703は不要。これはTCB内human-adminによる悪意ある全置換からの暗号学的独立を主張しない。

anchor serviceはauthority署名、campaign/action sequence、previous hash、domain/generation high-watermark、consumed attempt/JTI、retirementを検証しexclusive append＋fsync後ack。writerにはtruncate/delete/overwrite/既存sequence再使用権なし。mutation前intent/consume tombstoneをanchorへdurable記録し、mutation後outcomeを追加、ack不明なら次mutation禁止・RECONCILE_REQUIRED。primary/CT DB全体を古い状態へ戻してもanchor high-watermarkで拒否する。anchor自体喪失/巻戻し/両PC同時喪失でcontinuity不明ならfail closed、新domain recovery。古いanchor backupを現authorityへ昇格しない。

allowlisted compact receipt/public registryはdomain存続期間中保持、retired IDs/tombstone/high-watermarkは自動削除なし。詳細sanitized diagnostic evidenceは90日、review source archiveはCT702 protected store内の最小期間のみ（v1最大90日）、anchorへはhashのみ。非秘密でも秘密source本文を自動exportしない。anchor予算32 GiB: 上限1000 receipts/day×16 KiB×365=約5.57 GiB/year、diagnostic上限100 MiB/day×90=約8.79 GiB、残りはindex/high-watermark/余裕。残容量20%未満またはrate/size上限でSTOP、tombstoneをpruneして継続しない。容量はPR-08で確認、retentionはPBSの日7/週4/月1と無関係。

CT700/701/702のprivate-key-restorable image/rootfs snapshot/replicationは禁止。CT key/Tailscale state/TLS/model credentials、Bridge transport/target credentialsもfull-PC image/同期/backupから除外する。host/guest swap、Windows pagefile/hibernation/crash dumpまでPR-07/08で対象を明示。設定が安全でなければ鍵生成不可。通常backupを無差別に停止せず、reviewed exact exclusionをIR-07/12で実装する。

### 17.7 HD-13 — technical Passkey profileと確定済みcustodian方針

RP ID=`human-approver-700.tail2f618d.ts.net`、origin=`https://human-approver-700.tail2f618d.ts.net`（末尾dot/追加portなし）、UI=443/backend=48768、UV required、cross-origin/任意RP/AI submit不可。PR-06でMagicDNS/SAN/ownerをfresh確認し、一意性不成立ならSTOP、別FQDNへ勝手に変更しない。trusted displayはexact request/attempt/target/policy/review/windowを非HTMLで表示するIR-02。Normal/Maintenance/Repair/self-repair contractやUX欠落はIR-09/10でありHuman判断ではない。

**Human決定（2026-10-01、本会話の後続回答）: HD-13の選択肢Aを採用、分類D→A。** 承認・Tailnet enrollment・break-glassのcustodianは現在のHuman本人とし、主認証器と予備認証器を別保管する単独体制とする。将来別custodianを追加する場合は、既存権限の暗黙共有ではなく、**独立したtrust-changeとしてPasskey承認・監査付きで追加**する。この決定はbootstrap campaignの実行承認ではない。

独立trusted PCからUVを行う。2台のPC membershipは認証器2個の存在/独立性を証明しない。複数人/同期アカウントを暗黙追加しない。主/予備の具体的credential IDは将来Human enrollment出力でprivate bytesではなくbinding receiptに記録。機器capability/UVとrecovery exerciseはIR-11/PR-08で検証し、方針決定をenrollment完了証拠にしない。

### 17.8 HD-14 — disposable fixture topology

technical candidateは **pve5上のtemporary VM930 `trust-e2e-lab-930`（4 vCPU / 8192 MiB / swap=0 / 64 GiB / onboot=0 / production backup除外）内のnested PVE lab**。外側VM930にはproduction bridge/LAN NIC・PVE credential・host mountを与えず、console経由でhash固定image/bundleを渡す。内側だけにuplinkなし `10.203.0.0/24` と `fd42:7470:930::/64` を持ち、CT931=Human Approval `.31`、CT932=Finalizer `.32`、CT933=Review `.33`、CT934=systemd disposable target `.34`、VM935=independent browser/Bridge fixture `.35`を作る計画。inner専用admin鍵/domain/ledger/auditを使用、外側PVE権限へ到達不可。931–935は外側clusterへ作成しない。既存VM921/922やCT121を流用せず、700–749も使用しない。

このlabでcreate/isolation/OS/key/pin、real Linux/systemd、Git bare remote、package/config/service/guest/node actions、repair/dpkg partial、offline capability、crash/replay/cutoverを通す。browser UVはHuman操作を伴う独立device/認証器redirectの適合性を検証し、mock WebAuthnで代用しない。real Tailscale/HTTPS境界試験にはproductionから分離したtest tailnetと限定egress gatewayをIR-11の別fixture phaseでhash固定し、production identity/ACLへ触れない。networkなしのlabだけでTailscale PASSを主張しない。

PR-02/03でVM930未使用、nested virtualization/console/UV capability、RAM/disk余裕を確認。不足はSTOPしてfreeze前に再設計する（PVE5の余裕を台帳から捏造しない）。E2E実施者はHD-13 custodian、fixture自動処理はfixed executor。fixtureはproduction昇格不可、cleanupも別bounded approved scope。rehearsal evidenceは同build/configでfreeze前7日以内、変更があれば失効。将来のfixture creation/keygen/service startはIR-11作業であり今回未実施。

### 17.9 HD-15 — operations/documentation include/exclude

- **include:** inventory/空きIP/namespace reservation、各service CURRENT/OPERATIONS、platform実行一覧、Human-only sanitized health/expiry/anchor-capacity/receipt-gap通知、Passkeyによるbounded OS/app保守、dependency-aware start/recovery runbook。
- **exclude:** 通常PBS/image/replication、一般Ansible `homelab`/update-all、朝次のroot/SSH probe、Pulse/Kumaへのprotected credential、一般CT tier/cluster-startup/shutdownの自動起動停止。onboot=0を維持。動的全guest検出も明示除外する。監視「対象外」を正常稼働PASSと数えない。
- 通常監視には必要なら非秘密の最終成功時刻/状態だけをhuman-only exporter経由で提供し、v1では新しいprotected CT向け監視grantを作らない。expected countは通常guest分と別に表示する。
- AIが文書差分を準備しHuman-adminが将来campaignのexact docs scopeで検証。配置=00_overview、共通規則=platform、サービス=子入口、未実施=TODO、証跡=日付記録（document-map準拠）。設定適用receiptと文書receiptを区別、git commit/pushは別明示action。本passではpve-docを編集しない。

### 17.10 HUMAN_DECISION_REQUIRED register — 0件

未解決項目なし。HD-13は§17.7の明示Human決定によりclosed、`RESOLVED_BY_EXISTING_DECISION`へ移動した。本人のbindingは後続ceremony receiptで検証する。

Human decisions remaining: **0**。追加質問なし。exact campaignの将来chat authorization、一回local activation、Passkey/Tailscale enrollment/UVは、設計選択数とは別の必須ceremony。今回回答をもって実行authorizationとしない。

### 17.11 IMPLEMENTATION_REQUIRED register — 12件

全件OPEN。本passで未実装のものを完成扱いしない。以下のexit証拠が揃うまでproduction campaign freeze不可。将来実装中にpolicy矛盾が見つかればSTOPし、単なる未実装をHumanの選択へ転嫁しない。

| ID | 未実装の成果物 / 関連HD | freeze前exit evidence |
| --- | --- | --- |
| IR-01 | manifest/receipt validator、fixed executor/DAG/journal、activation/cancel/expiry (02/07) | unknown/duplicate/変更/replay/crash/partial拒否、全stepのfixed enum/hash/timeout、nonce one-use |
| IR-02 | CT700 complete typed package、trusted display/window resolver、UI/service API分離 (04/10/13) | clean closure、UV/request/review/window binding、7443 enrollment拒否、legacy AI直接submitなし |
| IR-03 | CT702 daemon/API/protected runtime/content store、bounded model profile/egress (05/09/10) | source独立性、signed review chronology、bounded provider config、pending publication/invalidation sequence |
| IR-04 | CT701 single coordinator/barrier＋Bridge live handoff/target fence (08/09) | authority-first lock、commit線形化、partition/race/consume-before-revoke/revoke-before-consume/ack loss試験 |
| IR-05 | mTLS gateway、policy deterministic renderer/CAS、physical quarantine/persistence (04/05/06) | real compiler/union tests、両family/routers/portsのfixture検証、typed outputs以外編集拒否、boot露出なし |
| IR-06 | CT700/701/702/Bridge/anchor/executor immutable packaging、OS/deb/runtime closure (03/10) | archive/file/manifest/lock/toolchain hashes、clean-room Linux/Windows load、resources/retention budgets/sandbox |
| IR-07 | CT-local one-shot key helper、ID/profile/pin/loss、paging/backup exclusion (04/11/12) | public-only export、exclusive/fsync/PoP、uncertain生成でSTOP、non-exportとfresh isolation gates |
| IR-08 | independent anchor/receipt export/high-watermark (12/16) | append権限、disk-full/anchor-loss/whole-store rollback、intent-before-dispatch、secret redaction |
| IR-09 | production Bridge/target credential enforcement、§13.1全normal action adapters (08/10/13) | Git/deploy/apt/restart/start-stop/reboot/configのexact registry/UI/review/receipt、arbitrary root RPCなし |
| IR-10 | versioned Maintenance/Repair/offline self-maintenance＋break-glass (10/13) | bounded scope/revoke/expiry、trust-plane停止前handoff、local one-use、chat fallbackなし、復旧手順 |
| IR-11 | §13全6 PASSのisolated full E2E＋cutover kill (02/13/14) | real UV/systemd/transport、failure injection、break-glass、old chat/reboot/rollback rejection、same release binding |
| IR-12 | source evidence bundle/decision provenance、operational exclusions/health/docs templates (01/15) | §1再現性、各include/exclude exact差分、pve-doc既存差分保全、将来正本反映scope/receipt |

IR-01 progress（2026-10-01）: [offline core](bootstrap-campaign-core.md)にstrict fixture manifest/hash、local authorization receipt、SQLite journal/one-shot/DAG、§11準拠のrestart terminal判定と新bounded continuation、cancel/expiry/ceremony、cutover tombstone modelを実装。production subcontractsは閉じたversioned placeholder、operation catalogはoffline test専用。production adapters・独立anchor・live Passkey cutoverは未接続であり、IR-01のproduction freeze gateおよび他IRをclosedとしない。

IR-02 progress（2026-10-01）: [production-oriented CT700 package](ct700-production-approver.md)にHuman/Peer別app（loopback 48768/48769）、legacy route隔離、host-verifier default deny-all、immutable trusted presentation永続化・window/currentness再検証・trusted display、production schema fail-closed検査、runtime closure/manifestとcheckout外software-WebAuthn検証を実装。IR-04 remote currentnessおよびIR-05 authenticated ingress/mTLSは未接続。live配備・鍵生成・Human enrollment・7443実機検証は未実施で、production freeze/cutover完了とはしない。

IR-04 progress（2026-10-01）: [CT701 coordinator/barrier](ct701-currentness-coordinator.md)と[Protected Execution Bridge core](protected-execution-bridge.md)をoffline実装。authority v3 / ledger v2 / CT702 7023 / Bridge v1、既存DBのmigration/repairなし。CT701 durable COMMITによるactivation/revocation、exact ACK reconciliation、CT702 durable publication/readiness reservation、authority-first live one-shot handoff、durable fencing token/attempt tombstone/target fence/custody receiptを追加。restart/partition/ack loss/worker競合のoffline testsを追加。IR-05 mTLS/Tailscale transport、IR-06 production artifact freeze、IR-07 key helper、IR-09 real adaptersは未実装。live deployment・production cutover・鍵/TLS/systemd/Passkey操作は未実施。IR registerのproduction freeze gateをclosedとはしない。

### 17.12 PREFLIGHT_REQUIRED register — 11件

全件OPEN/未実施。**freeze直前のfresh read-only live preflight結果**をsource rootへbindする。PR-01はローカル再現性、PR-10は既存test証拠の読取照合も含む。live read-only収集は将来の別作業として独立human-admin PCで行い、filtered AI inventoryだけではPASS不可。freeze時点とexecution直前に各security predicateを再検査、observationMaxAge=300秒。期限超過/差分はSTOPしfreezeし直す。長時間の調査は保存済み証拠を利用して最後にbounded fresh sweep、可能でなければTTLを自動緩和しない。

| ID | read-onlyで解決する項目 / 関連HD | PASS条件 / fresh evidence |
| --- | --- | --- |
| PR-01 | source identity/dirty bytes (01/10) | base full commit/tree、4 raw hashes/blob/diff、allowlist evidence root、build clean provenanceがreviewしたbytesに一致 |
| PR-02 | unfiltered allocation/name/IP/MAC (03/14) | 全cluster guest/retired ID/storage/Pool、DHCP/static予約/ARP/他LAN台帳/DNS照合。701/702とVM930候補未使用、重複/unknownなし。ARP無応答だけでは不可 |
| PR-03 | node/storage/bridge/template/resources (03/14) | pve2/pve5 quorum、CPU/kernel/runtime、node-scope dir/raw/rootdir容量、bridge/VLAN、固定image hash、nested capability。割当後RAM余裕2 GiB以上、diskは割当＋同FS20%余裕、同時fixture最大負荷も含む |
| PR-04 | PVE ACL/root boundary (03/11) | AI user/token direct/inherited/effective rights、Pool/storage/PBS/config/status/snapshot deny、human-host pins/cluster identity。作成後権限は事前のpolicy proof＋各stage read-only postcheck |
| PR-05 | CT700 exact CURRENT baseline (04) | 9/30 scopeのfresh identity/config/Serve/filter/unit/DNS/swap/app/key absence、Stage1 repair証拠と不整合なし。稼働やpermissionを過去PASSから推定しない |
| PR-06 | complete network/identity/compiler baseline (05/06/13) | 全device/owner/IP/IPv6/admin/tagOwners、全grant/ACL/SSH/nodeAttrs/route/exit/forwarding、2-PC/CT700 RP/SAN、listener/port collision、両router exposure、normal service regression evidence。新CT IDは出力slotのまま |
| PR-07 | backup/paging/key isolation (04/11/12) | 全PVE/PBS/manual/all/Pool job/replication/host backup、guest/host swap/dump/hibernation、除外計画と現在設定の一致条件。新生成先の不在・ever-used ID registry |
| PR-08 | PC controller/Bridge/anchor/ceremony capability (07/08/12/13) | hqo/g-tuneのdevice/OS/DAC/admin/recovery/pins、AI書込/remote-control排除、service principal/credential custody、disk32GiB/独立high-watermark、UV認証器能力、pagefile/image/同期除外。未配備機能はIR証拠＋予定差分で扱う |
| PR-09 | clocks/authority/locks/budgets (02/07/09) | clock skew≤5秒、exact TTL/critical path/256 steps、journal/nonce未使用、no unresolved reconcile、host locksとcurrent generations/high-watermark一致 |
| PR-10 | release/fixture acceptance freshness (10/13/14) | IRの署名/hash/test evidenceをread-only検証、同build/config/OSと7日以内E2E。systemd testをpreflight中に起動せず既存rehearsal証拠を確認 |
| PR-11 | operations/include-exclude/docs baseline (15/16) | PBS/朝次/Ansible/監視/startupのstatic/dynamic selectors、onboot、expected counts、docs before hash、CT703 reserved、post-execution docs scope一致 |

**Preflightとstage acceptanceの区別:** 未作成CTのeffective rights、join出力、生成鍵SPKI、配備後service listen、production Human enrollment、live lifecycle越しの永続性はfreeze前read-onlyだけでは証明できない。freezeにはIR fixture proof＋現在のbefore-state＋閉じたmutation/postconditionを要求し、実行後のfresh read-only verificationをDAG gateにする。PVE reboot等のmutationをPRに紛れ込ませない。freeze前に「未作成CTのlive PASS」を必須としてdeadlockにしない一方、postcheckまで無条件PASSを発行しない。

## 18. この設計作業の終了状態

指定設計文書のみをworking treeへ更新。HDはA=4/B=11/C=1/D=0、HUMAN_DECISION_REQUIRED=0、IMPLEMENTATION_REQUIRED=12、PREFLIGHT_REQUIRED=11。live PVE/Tailscaleへの接続・mutation、CT creation、deploy、鍵生成、service activation、pve-doc変更、commit、pushは未実施。manifestSha256、production PASSは発行していない。次の入口はIR registerに沿う別offline実装作業。本書およびHD-13の本人/custody決定を実行承認として扱わない。
