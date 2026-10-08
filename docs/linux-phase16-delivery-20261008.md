# Phase 1.6 実物受渡し記録 — 2026-10-08

## Task A: ソース候補

- source commit: `95e3fd8ecebd799a85418392eadbba6d6bf7057a`
- branch/worktree: `linux-portability-phase16` / `C:/work/ai-linux-phase1`
- 前段基準: `005932f1c3938224424ed07e1ff30b87f45be810`
- 固定binary/起動検査: `src/mcp/opencode-binary.ts`、
  `src/mcp/proposer/opencode-release.json`、`src/mcp/proposer/opencode-session.ps1`、
  `src/mcp/semantic-session.ts`。共有CLI設定を`src/config/deployment.ts`から除去。
- schema/OAuth/agent/model/tools検査と既存campaign/recovery/reconciliationは維持。
- 関連回帰168 PASS/4 Linux skip、Python bundle tests 13 PASS、typecheck/build PASS。
- 独立レビュー: 指摘修正後、残存blockingなし。
- 運用反映/復旧/rollbackは `docs/linux-portability-phase16.md` を参照。
- **運用未反映、現行Windows自走は未復旧**。Human CLIを変更せず、role専用binaryを
  管理者が配置し、両runtimeを承認releaseへ切り替える工程が必要。

## Task B: 作成済みsource bundle

| 項目 | 実測値 |
|---|---|
| ファイル名 | `linux-fixture-source-95e3fd8ecebd799a85418392eadbba6d6bf7057a.zip` |
| 絶対パス | `C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/phase16-handoff/linux-fixture-source-95e3fd8ecebd799a85418392eadbba6d6bf7057a.zip` |
| サイズ | **1,078,396 bytes** |
| SHA-256 | `82409f151b75f6092e52cb35a3a3ee496aba0ea544e76d7350843bb8fc60bffc` |
| 固定source commit | `95e3fd8ecebd799a85418392eadbba6d6bf7057a` |
| 内容 | **363 source files + SOURCE-MANIFEST.json** |
| 判定 | **SOURCE_READY / OFFLINE_EXECUTION BLOCKED** |

隣接する同名`.sha256`と`.manifest.json`を作成済み。
manifest SHA-256: `ae0c6cec4f2bc843c234cd60415863006e52fd4bc3c5deead8aaa2500762b5a0`。
全file hash/size/mode、source commit、直接依存一覧とpackageManager情報を含む。
package/lockfileは同梱。推移依存のversion/integrityは固定`pnpm-lock.yaml`を正とする。

独立verifier: 同じ保存先の `linux-fixture-bundle-95e3fd8.py`。
SHA-256: `e91930b7f526b1c771fb5e05ffb8352447172e350f2090437a276f394c3d4dc1`。
Python 3.12以上の標準libraryだけで検証/展開できる。検証対象ZIPから取り出した未検証scriptを
最初に実行せず、Humanがこのverifierとhashを別途信頼できる経路で渡す。

### 展開確認

別隔離dir `C:/Users/bootstrap-admin/AppData/Local/Temp/opencode/phase16-handoff/extracted-95e3fd8`
へ展開し、展開後も363件のbyte hash/sizeと全inventoryを再照合した。
**missing=0、extra=0、symlink/junction=0、hash不一致=0**。
元repoを作業directoryにしない独立verifier実行もPASS。
悪意あるpath traversal、symlink、特殊file、case衝突、missing/extra、改変manifestの拒否は
13件のPython self-testで確認した。Git replaceを設定したscratch repoでも元commitのbytesを取得する。

### 内容・不足資材

- Phase1.5を継承した固定13-suite runner、source、関連test/fixture、同梱PS proposer/agent、
  release manifest、build script、package/lockfile、手順書を含む。
- 追加suite `opencode-binary`を含み、model/auth検査はfake API、PSは実関数を使う。
  実OpenCode binary/providerは起動しない。
- 依存宣言: embedded OpenCode core/AI/util 2.0.22、MCP SDK、Effect、Express等と、
  Vitest/TypeScript/tsx。`latest`/範囲宣言もlockfileの解決値に固定する。
- **不足:** Ubuntu24.04 x64向けNode24.16.0、PowerShell7.5以上、Git、Python3.12以上、
  pnpm11.24.0の準備済みtoolchain、およびlockfile全体のLinux native/optional/dev依存store。
  Windows node_modules/junctionで代用しない。インストールのoffline完全性は未証明。
- Human HOME、OAuth store、実台帳、鍵、token、実session、取得したOpenCode binaryは含めない。
  secret検査はGit blob allowlist＋一般的な鍵/token patternの拒否で、任意の秘密文字列を
  自動判別できると主張しない。受渡し対象inventoryを確認済み。

## Human/Sol受渡し

1. HumanがZIP、verifier、隣接manifestと本記録をHQOへ承認済み経路で移送する。
   Astraからのリモート転送は行っていない。共有filesystemを前提としない。
2. Solが本記録のtrusted hashと照合。承認対象Linux fixtureとLinux依存storeを別途準備。
3. 非root・private dirにて、移送先の実際のpathを指定して実行:

```sh
python3 -B linux-fixture-bundle-95e3fd8.py extract \
  --archive linux-fixture-source-95e3fd8ecebd799a85418392eadbba6d6bf7057a.zip \
  --commit 95e3fd8ecebd799a85418392eadbba6d6bf7057a \
  --sha256 82409f151b75f6092e52cb35a3a3ee496aba0ea544e76d7350843bb8fc60bffc \
  --destination /fixture/source
cd /fixture/source
pnpm install --offline --frozen-lockfile --store-dir /fixture/pnpm-store
node scripts/verify-linux-portability-fixture.mjs
```

`/fixture/source`は不存在、parentはユーザー所有で書込可能、aliasなしが必要。
NICなし・非root・空HOME・運用mount/credentialなし・孤児をreapするinitの条件を維持。
toolchain/store欠落ならBLOCKEDのまま止める。依存を揃える通信工程はHumanが別途承認する。
全13 suite/全assertion PASS、skip/pending/timeoutなしが合格。receipt/JSON/logと環境manifestを返す。

## 最終保全

- 元worktree clean。両稼働distは各286ファイル、集約hash
  `87283b753bcc73230818a7ff9ce1e502bf20d284e3ca3c5a044f774f1bb4d251`から不変。
- Human exeも`542c51f075026e1dbd5b676ebce685d0b454face48872b0813d08f867e2c4eaa`で不変。
- Execution/Review/Dashboard/Human backgroundのlisten PIDはそれぞれ6728/6824/3024/7252を再観測。
  stop/restartやHuman background API接続をしていない。
- Linux Production Dispatch閉鎖、remote push・配備・VM/CT/PVE操作なし。
- 未実施: Linux実機、2.0.22/2.0.24実API資格確認、provider E2E、本番反映。
