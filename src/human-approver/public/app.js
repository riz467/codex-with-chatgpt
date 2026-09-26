const register = document.querySelector('#register');
const authenticate = document.querySelector('#authenticate');
const verified = document.querySelector('#verified');
const error = document.querySelector('#error');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function post(url, body = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}
async function refresh() {
  const response = await fetch('/status');
  const { registered, mode } = await response.json();
  register.textContent = mode === 'tailscale' ? 'パスキーを登録 (Bitwarden / Windows Hello)' : 'Windows Helloを登録';
  authenticate.textContent = mode === 'tailscale' ? 'パスキーで承認テスト' : 'Windows Helloで承認テスト';
  register.hidden = registered;
  authenticate.hidden = !registered;
}
async function run(button, action) {
  button.disabled = true;
  verified.hidden = true;
  error.textContent = '';
  try { await action(); await refresh(); }
  catch (cause) { error.textContent = `検証できませんでした: ${cause.message}`; }
  finally { button.disabled = false; }
}
register.addEventListener('click', () => run(register, async () => {
  const { ceremony, options } = await post('/registration/options');
  const publicKey = { ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map(c => ({ ...c, id: decode(c.id) })) };
  const c = await navigator.credentials.create({ publicKey });
  if (!c) throw new Error('登録がキャンセルされました');
  await post('/registration/verify', { ceremony, credential: { id: c.id, rawId: encode(c.rawId), type: c.type,
    response: { clientDataJSON: encode(c.response.clientDataJSON), attestationObject: encode(c.response.attestationObject),
      transports: c.response.getTransports?.() || [] }, clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: c.authenticatorAttachment } });
}));
authenticate.addEventListener('click', () => run(authenticate, async () => {
  const { ceremony, options } = await post('/authentication/options');
  const publicKey = { ...options, challenge: decode(options.challenge),
    allowCredentials: options.allowCredentials?.map(c => ({ ...c, id: decode(c.id) })) };
  const c = await navigator.credentials.get({ publicKey });
  if (!c) throw new Error('認証がキャンセルされました');
  const result = await post('/authentication/verify', { ceremony, credential: { id: c.id, rawId: encode(c.rawId), type: c.type,
    response: { clientDataJSON: encode(c.response.clientDataJSON), authenticatorData: encode(c.response.authenticatorData),
      signature: encode(c.response.signature), userHandle: c.response.userHandle ? encode(c.response.userHandle) : null },
    clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment } });
  if (result.humanVerification === 'VERIFIED' && result.userVerified === true) verified.hidden = false;
}));
refresh().catch(() => { error.textContent = 'サービスに接続できません'; });
