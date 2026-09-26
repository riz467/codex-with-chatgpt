const details = document.querySelector('#details');
const action = document.querySelector('#action');
const result = document.querySelector('#result');
const error = document.querySelector('#error');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = async (url, body) => {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`検証拒否 (${response.status})`);
  return response.json();
};
const parts = location.pathname.split('/');
const mode = parts[1];
const id = parts[2];
if (mode === 'approve') {
  const response = await fetch(`/api/approval-requests/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error('依頼が見つかりません');
  const { payload, state } = await response.json();
  // Use textContent, never render AI-supplied markup or a free-form goal.
  details.replaceChildren();
  for (const [label, value] of [['Task ID', payload.task_id], ['Run ID', payload.run_id],
    ['Review PASS (依頼元の申告・Approver側では独立検証なし)', payload.authoritative_review_id],
    ['Goal summary (SHA-256 digest; 原文は表示しません)', payload.canonical_goal_sha256],
    ['Review evidence SHA-256', payload.review_evidence_hash], ['Bundle manifest SHA-256', payload.bundle_manifest_sha256],
    ['Approval expiry', payload.expires_at]]) {
    const row = document.createElement('p'); row.textContent = `${label}: ${value}`; details.append(row);
  }
  action.hidden = state !== 'PENDING';
  action.addEventListener('click', async () => {
    action.disabled = true; error.textContent = '';
    try {
      const { ceremony, options } = await post('/api/webauthn/authentication/options', { request_id: id });
      const publicKey = { ...options, challenge: decode(options.challenge),
        allowCredentials: options.allowCredentials?.map(c => ({ ...c, id: decode(c.id) })) };
      const c = await navigator.credentials.get({ publicKey });
      if (!c) throw new Error('パスキー認証がキャンセルされました');
      await post('/api/webauthn/authentication/verify', { request_id: id, ceremony, credential: { id: c.id,
        rawId: encode(c.rawId), type: c.type, response: { clientDataJSON: encode(c.response.clientDataJSON),
          authenticatorData: encode(c.response.authenticatorData), signature: encode(c.response.signature),
          userHandle: c.response.userHandle ? encode(c.response.userHandle) : null },
        clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment } });
      result.textContent = '署名付き承認を発行しました';
    } catch (cause) { error.textContent = cause.message; action.disabled = false; }
  });
} else if (mode === 'enroll') {
  details.textContent = '管理者の一時招待によるパスキー登録。秘密鍵・PIN・生体情報は送信しません。';
  action.textContent = 'パスキーを登録'; action.hidden = false;
  action.addEventListener('click', async () => {
    action.disabled = true; error.textContent = '';
    try {
      const { ceremony, options } = await post('/enrollment/options', { token: id });
      const publicKey = { ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: options.excludeCredentials?.map(c => ({ ...c, id: decode(c.id) })) };
      const c = await navigator.credentials.create({ publicKey });
      if (!c) throw new Error('登録がキャンセルされました');
      await post('/enrollment/verify', { token: id, ceremony, credential: { id: c.id, rawId: encode(c.rawId), type: c.type,
        response: { clientDataJSON: encode(c.response.clientDataJSON), attestationObject: encode(c.response.attestationObject),
          transports: c.response.getTransports?.() || [] }, clientExtensionResults: c.getClientExtensionResults(),
        authenticatorAttachment: c.authenticatorAttachment } });
      result.textContent = '登録しました';
    } catch (cause) { error.textContent = cause.message; action.disabled = false; }
  });
}
