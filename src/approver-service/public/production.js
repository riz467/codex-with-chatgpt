const details = document.querySelector('#details'), action = document.querySelector('#action');
const result = document.querySelector('#result'), error = document.querySelector('#error');
const decode = v => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - v.length % 4) % 4)), c => c.charCodeAt(0));
const encode = v => btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const post = async (url, body) => {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw Error(`検証拒否 (${response.status})`);
  return response.json();
};
const [, mode, id] = location.pathname.split('/');
const labels = Object.freeze({ GitIntegrateMain: 'Git main integration', AptUpgradeNode: 'Node package upgrade',
  AptUpgradeGuest: 'Guest package upgrade', AppUpgrade: 'Application upgrade', RestartService: 'Service restart', RebootNode: 'Node reboot' });
if (mode === 'approve-typed-action') {
  const response = await fetch(`/api/typed-action-approval-requests/${encodeURIComponent(id)}`);
  if (!response.ok) throw Error('依頼が見つかりません');
  const { presentation, state, current } = await response.json();
  const payload = presentation.request, context = presentation.context;
  details.replaceChildren();
  const identity = { approvalRequestId: payload.approvalRequestId, presentationHash: presentation.presentationHash };
  const fields = [
    ['Action kind', `${labels[payload.actionKind]} (${payload.actionKind})`], ['Target ID', payload.targetId],
    ['Request ID', payload.approvalRequestId], ['Action ID', payload.actionId], ['Request hash', payload.requestHash],
    ['Attempt ID', payload.attemptId], ['Attempt sequence', payload.attemptSequence], ['Attempt hash', payload.attemptHash],
    ['Independent review', context.independentReviewResult], ['Review evidence hash', payload.independentReviewEvidenceHash],
    ['Policy hash', payload.policySha256], ['Target generation', payload.targetGeneration], ['Maintenance window ID', payload.maintenanceWindowId],
    ['Window start', context.maintenanceWindowStartsAt], ['Window expiry', context.maintenanceWindowExpiresAt], ['Approval expiry', payload.expiresAt],
    ['Presentation ID', presentation.presentationId], ['Presentation hash', presentation.presentationHash], ['Trusted source', presentation.trustedSourceIdentity],
    ['Current', current],
  ];
  for (const [label, value] of fields) { const row = document.createElement('p'); row.textContent = `${label}: ${value}`; details.append(row); }
  action.hidden = state !== 'PENDING' || !current;
  action.addEventListener('click', async () => {
    action.disabled = true;
    try {
      const { ceremony, options } = await post('/api/webauthn/typed-action/options', identity);
      const c = await navigator.credentials.get({ publicKey: { ...options, challenge: decode(options.challenge),
        allowCredentials: options.allowCredentials.map(c => ({ ...c, id: decode(c.id) })) } });
      await post('/api/webauthn/typed-action/verify', { ...identity, ceremony, credential: { id: c.id, rawId: encode(c.rawId), type: c.type,
        response: { clientDataJSON: encode(c.response.clientDataJSON), authenticatorData: encode(c.response.authenticatorData),
          signature: encode(c.response.signature), userHandle: c.response.userHandle ? encode(c.response.userHandle) : null },
        clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment } });
      result.textContent = '署名付き承認を発行しました';
    } catch (cause) { error.textContent = cause.message; }
  });
} else if (mode === 'enroll') {
  details.textContent = '本人の主・予備認証器を個別登録し、別保管してください。';
  action.textContent = 'パスキーを登録'; action.hidden = false;
  action.addEventListener('click', async () => {
    action.disabled = true;
    try {
      const { ceremony, options } = await post('/enrollment/options', { token: id });
      const c = await navigator.credentials.create({ publicKey: { ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: options.excludeCredentials.map(c => ({ ...c, id: decode(c.id) })) } });
      await post('/enrollment/verify', { token: id, ceremony, credential: { id: c.id, rawId: encode(c.rawId), type: c.type,
        response: { clientDataJSON: encode(c.response.clientDataJSON), attestationObject: encode(c.response.attestationObject), transports: c.response.getTransports?.() || [] },
        clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment } });
      result.textContent = '登録しました';
    } catch (cause) { error.textContent = cause.message; }
  });
}
