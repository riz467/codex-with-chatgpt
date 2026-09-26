# Human Approver / WebAuthn PoC

`pnpm build` の後、**production の Gateway / Dashboard / Scheduled Task を再起動せず**、別プロセスで `pnpm human-approver` を起動します。Windows の対話セッションで `http://localhost:48767/` を開き、「Windows Helloを登録」→「Windows Helloで承認テスト」を操作してください。開発時は `pnpm human-approver:dev` も使用できます。Dashboard に追加したリンクはこの別サービスを開くだけで、DONE、Review、承認証拠への書き込みは行いません。

- 固定 RP ID: `localhost`、固定 origin: `http://localhost:48767`、listen: `127.0.0.1:48767`。ブラウザでは **localhost** の URL を使用します (`127.0.0.1` の URL とは異なる origin)。localhost はブラウザの secure context 例外です。
- 登録は platform authenticator 指定、UV required。認証も UV required。各 challenge はサーバーの `randomBytes(32)` で生成され、2 分で失効し、検証試行時に消費されます。サーバーは署名、challenge、origin、RP ID hash、UV flag、counter を検証します。
- 初回登録後は追加登録を拒否します。保存先は `%LOCALAPPDATA%\ai-workspace-human-approver-poc\credential.json`（LOCALAPPDATA がなければ OS の temp）。credential ID、COSE 公開鍵、counter、任意の transport hints だけを保存します。PIN、生体情報、秘密鍵、assertion、成功証拠は保存しません。再登録を試す場合は PoC を停止して、この専用ファイルを管理者が明示的に退避・削除してください。production のデータには触れません。
- `Human verification: VERIFIED` はそのページでの認証成功時だけ表示する一時的な表示です。永続的な承認・人間識別の証明ではありません。自動テストはソフトウェア鍵で WebAuthn のデータ構造と暗号検証を確認しますが、**Windows Hello の実機 UI や PIN/指紋の成功を検証するものではありません**。platform 指定や attestation `none` だけでは authenticator が Windows Hello であることも証明できません。

## production 化しない理由

同じ Windows principal の AI プロセスがサーバーコード、公開鍵ファイル、認証結果の受け手、あるいは将来の evidence store を編集できれば human-only boundary は成立しません。さらにこの PoC の初回登録には人間本人の独立した enrollment 認可がなく、ソフトウェア認証器で先に登録される可能性があります。production では AI と人間用サーバーを別 principal に分け、コード・資格情報・証拠・設定と更新経路を ACL で AI から書込不可にし、登録/復旧も別管理下に置く必要があります。RP と認証結果を最終承認の固定対象に紐付け、サーバー側で一度だけ消費する設計も別途必要です。

## Tailscale Serve / cross-device PoC

このホスト専用に `HUMAN_APPROVER_MODE=tailscale` を設定すると、固定 RP ID は `ai-workspace-win.tail2f618d.ts.net`、固定 origin は `https://ai-workspace-win.tail2f618d.ts.net` になります。backend は従来どおり **127.0.0.1:48767 のみ**で待ち受けます。Tailscale Serve の HTTPS 終端を使用し、**Funnel は使用しません**。tailnet の HTTPS と MagicDNS が有効で、接続端末が tailnet に参加している必要があります。HTTPS 443 の Serve URL 以外からは WebAuthn 登録・認証できません。

PowerShell で（既存の localhost PoC プロセスだけを停止し、production Gateway / Dashboard は触らずに）:

```powershell
pnpm build
$env:HUMAN_APPROVER_MODE = 'tailscale'
pnpm human-approver
```

別の PowerShell で設定の変更前に `tailscale serve status --json` を確認し、**既存設定がある場合は上書きせず調整**してください。空なら:

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:48767
tailscale serve status
```

`tailscale funnel` / `tailscale serve reset` は実行しません。管理画面の tailnet ACL と HTTPS 証明書の設定も確認してください。別端末の tailnet 内ブラウザで `https://ai-workspace-win.tail2f618d.ts.net/` を開き、「パスキーを登録 (Bitwarden / Windows Hello)」→「パスキーで承認テスト」を操作します。Bitwarden を使う場合はブラウザ拡張の passkey 選択 UI で Bitwarden を選択し、vault のロック解除または UV 操作を完了してください。cross-device モードでは `authenticatorAttachment: platform` を要求しませんが、`userVerification: required` とサーバー側の UV flag 検証は維持します。検証成功時のみ `Human verification: VERIFIED` と表示します。

このホストでは 2026-09-26 時点で `tailscale dns status` に **Tailscale DNS: disabled** と表示され、ホスト自身から通常の DNS 解決はできませんでした。Serve と TLS の到達性は `curl.exe --resolve ai-workspace-win.tail2f618d.ts.net:443:100.122.9.7 https://ai-workspace-win.tail2f618d.ts.net/status` で確認しました（IP は変わるため `tailscale ip -4` で都度確認）。別端末で名前解決できない場合はその端末の Tailscale DNS 設定を確認してください。このホストの DNS 設定は既存サービスへの影響を避け変更していません。`--resolve` は診断用であり、WebAuthn のブラウザ利用には正しい HTTPS hostname での到達が必要です。

localhost 用 `%LOCALAPPDATA%\ai-workspace-human-approver-poc\credential.json` は再利用しません。tailnet 用は別の `credential-tailscale.json` で、内部にも RP ID を記録します。localhost の passkey は RP が異なるため新しい RP へコピーせず、tailnet の HTTPS origin で**新規登録**してください。初回登録は無認可の PoC なので、tailnet 内の他者に先に登録される可能性があります。登録前に tailnet ACL で対象端末を制限してください。

クロスデバイスの手動確認記録: Serve URL 到達、Bitwarden 登録、Bitwarden 認証、UV=true、偽造 POST 拒否、replay 拒否をそれぞれ**実際の別端末で**確認してください。自動テストは同じ RP/origin の署名付き応答、UV、replay、期限切れ、localhost RP 混同の拒否をソフトウェア鍵で検証しますが、Bitwarden の実機操作の代用ではありません。HTTP の Origin / Host は偽装可能なので、POST ヘッダだけで本人性は判定せず、検証済み署名と single-use challenge が必要です。

### 次段階の隔離アーキテクチャ

Human Approver を別 VM / LXC / host の専用 principal に移動し、AI からその host の管理権・書込権・デプロイ権を除外します。Serve は新ホストの固定 HTTPS RP に移し、RP 変更に伴い再 enrollment します。登録・復旧を独立管理者の制御下に置き、署名鍵を Approver の隔離環境（可能なら TPM / HSM）から取り出せないようにします。承認結果はサーバー側で固定された task/review hash、有効期限、一意 ID に署名し、AI から書込不能な append-only evidence store に保存します。Gateway は Approver の公開鍵で対象・期限・署名・single-use を検証し、消費結果も同じ隔離側で原子的に記録します。この PoC はその仕組みを実装しておらず、同じ Windows principal で稼働する限り production human-only boundary とは判定しません。
