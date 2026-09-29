const $ = id => document.getElementById(id);
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let current = null, busy = false;
async function update() {
  const response = await fetch('/passkey-fixture/status', { cache: 'no-store' });
  if (!response.ok) throw new Error('試験案件を読み取れません');
  current = await response.json();
  const r = current.request, list = $('request'); list.replaceChildren();
  for (const [label, value] of [['試験の明示', r.notice], ['対象', r.target], ['操作', r.action], ['案件ID', r.request_id],
    ['task ID', r.task_id || '未接続'], ['revision', r.revision], ['manifest SHA-256', r.manifest_sha256 || '未接続'],
    ['変更概要', r.summary || '未接続'], ['ChatGPTレビュー', r.review === 'PASS' ? `PASS (${r.review_id})` : '未実施'],
    ['diff SHA-256', r.diff_sha256 || '未接続'], ['内容 SHA-256', current.request_sha256], ['有効期限', r.expires_at],
    ['結果', current.completion?.result || '未処理']]) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = String(value); list.append(dt, dd);
  }
  $('state').textContent = current.state === 'APPROVED_TEST_ONLY' ? '承認済み：隔離領域への試験完了記録を確認' :
    current.state === 'PENDING' ? '本人確認待ち' : current.state === 'EXPIRED' ? '期限切れ：実行されません' :
      current.state === 'CHANGED' ? '内容が変更されています：実行されません' : '承認記録を検証できません：実行されません';
  $('approve').disabled = busy || current.state !== 'PENDING' || !current.credential_registered;
  if (!current.credential_registered) $('message').textContent = '登録済みパスキーなし。このoriginで既存のパスキーを確認できません。新規登録は自動実行しません。';
}
async function post(route, body) {
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`承認できません (${response.status})`);
  return response.json();
}
$('approve').addEventListener('click', async event => {
  if (!event.isTrusted || busy || current?.state !== 'PENDING') return;
  busy = true; $('approve').disabled = true; $('message').textContent = '';
  const binding = { request_id: current.request.request_id, request_sha256: current.request_sha256 };
  try {
    const { ceremony, options } = await post('/passkey-fixture/options', binding);
    const publicKey = { ...options, challenge: decode(options.challenge),
      allowCredentials: options.allowCredentials?.map(c => ({ ...c, id: decode(c.id) })) };
    const c = await navigator.credentials.get({ publicKey });
    if (!c) throw new Error('本人確認がキャンセルされました');
    await post('/passkey-fixture/verify', { ...binding, ceremony, credential: { id: c.id, rawId: encode(c.rawId), type: c.type,
      response: { clientDataJSON: encode(c.response.clientDataJSON), authenticatorData: encode(c.response.authenticatorData),
        signature: encode(c.response.signature), userHandle: c.response.userHandle ? encode(c.response.userHandle) : null },
      clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment } });
    $('message').textContent = 'サーバーがパスキー署名と本人確認を検証しました。';
  } catch (error) { $('message').textContent = error.message || '承認できません'; }
  finally { busy = false; await update(); }
});
update().catch(error => { $('message').textContent = error.message; });
setInterval(() => { if (!busy) update().catch(() => {}); }, 3000);
