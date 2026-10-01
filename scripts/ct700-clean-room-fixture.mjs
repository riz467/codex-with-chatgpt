// Copied to a disposable directory by verify-ct700-approver-package.mjs. Never shipped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, request } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { authenticator } from './webauthn-simulator.mjs';
import { verifyPackage, sha256 } from './package/ct700-package-integrity.mjs';

// Node 24 has no network permission flag. Guard every socket used by this fixture
// before loading the package; DNS/UDP/fetch are unnecessary and forbidden.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (!options || typeof options !== 'object' || options.host !== '127.0.0.1' || options.path) throw Error('EXTERNAL_NETWORK_FORBIDDEN');
  return connect.apply(this, args);
};
const deny = () => { throw Error('EXTERNAL_NETWORK_FORBIDDEN'); };
const lookup = dns.lookup;
dns.lookup = function (hostname, ...args) { if (hostname !== '127.0.0.1') deny(); return lookup.call(this, hostname, ...args); };
dns.resolve = deny; dgram.createSocket = deny; globalThis.fetch = deny;
syncBuiltinESMExports();
const root = path.resolve('package'), expectedHash = process.argv[2];
const manifest = verifyPackage(root, expectedHash);
assert(!Object.keys(manifest.files).some(p => /(^|\/)\.git\/|\.(pem|key|sqlite|db|map)$|approver-service\/cli.js$/.test(p)));
assert.throws(() => net.connect({ host: '192.0.2.1', port: 443 }), /EXTERNAL_NETWORK_FORBIDDEN/);
const { createProductionApprover } = await import('./package/runtime/approver-service/production.js');
const { ApproverStore } = await import('./package/runtime/approver-service/storage.js');
const { presentationHash } = await import('./package/runtime/approver-service/presentation.js');
const { actionBindingFields } = await import('./package/runtime/typed-action-approval/contract.js');
const { verifyTypedActionApproval } = await import('./package/runtime/typed-action-approval/verifier.js');
const clock = Date.parse('2026-10-01T12:00:00.000Z'), time = n => new Date(clock + n).toISOString();
const hash = () => randomBytes(32).toString('hex');
const config = { rp_id: 'human-approver-700.tail2f618d.ts.net', origin: 'https://human-approver-700.tail2f618d.ts.net',
  key_id: 'fixture', db_path: '/var/lib/ai-approver/approver.db', signing_key_path: '/var/lib/ai-approver/signing.key', port: 48768 };
const payload = { schemaVersion: 1, type: 'AI_WORKSPACE_TYPED_ACTION_APPROVAL_REQUEST', approvalRequestId: randomUUID(),
  actionId: randomUUID(), actionKind: 'RestartService', targetId: randomUUID(), requestHash: hash(), attemptId: randomUUID(), attemptHash: hash(),
  attemptSequence: 1, independentReviewEvidenceHash: hash(), policySha256: hash(), targetGeneration: 1, maintenanceWindowId: randomUUID(),
  issuedAt: time(0), expiresAt: time(240_000), jti: randomBytes(32).toString('base64url') };
const body = { schemaVersion: 1, presentationId: randomUUID(), request: payload, trustedSourceIdentity: 'fixture-ct701',
  context: { ...Object.fromEntries(actionBindingFields.map(f => [f, payload[f]])), independentReviewResult: 'PASS', reviewIsCurrent: true,
    requestIsCurrent: true, policyIsCurrent: true, maintenanceWindowValid: true, maintenanceWindowStartsAt: time(-1), maintenanceWindowExpiresAt: time(600_000) } };
const presentation = { ...body, presentationHash: presentationHash(body) };
const key = generateKeyPairSync('ed25519'), store = new ApproverStore(path.resolve('fixture.sqlite'), 'production'), servers = [];
async function listen(app) {
  const server = createServer(app).listen(0, '127.0.0.1'); servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  return (method, route, body) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, method, path: route,
      headers: { Host: config.rp_id, Origin: config.origin, 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => {
        let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode, body: value });
      });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
try {
  const defaults = createProductionApprover(config, store, key.privateKey, undefined, () => clock);
  const human = await listen(defaults.human), deniedPeer = await listen(defaults.peer);
  assert.equal((await human('GET', '/health')).status, 200);
  assert.equal((await deniedPeer('POST', '/api/typed-action-presentations', presentation)).status, 403);
  const trusted = createProductionApprover(config, store, key.privateKey,
    { verifyRegistration: () => presentation, authorizeLookup: () => true }, () => clock);
  const peer = await listen(trusted.peer);
  assert.equal((await peer('POST', '/api/typed-action-presentations', presentation)).status, 201);
  assert.equal((await peer('POST', '/enrollment/options', {})).status, 404);
  const view = await human('GET', `/api/typed-action-approval-requests/${payload.approvalRequestId}`);
  assert.deepEqual(view.body.presentation, presentation);
  assert.equal((await human('GET', `/approve-typed-action/${payload.approvalRequestId}`)).status, 200);
  assert.match((await human('GET', '/app.js')).body, /textContent/);
  const device = authenticator(), token = store.openEnrollment(clock);
  const registration = await human('POST', '/enrollment/options', { token });
  assert.equal((await human('POST', '/enrollment/verify', { token, ceremony: registration.body.ceremony,
    credential: device.registration(registration.body.options.challenge, config.origin, config.rp_id) })).status, 201);
  const identity = { approvalRequestId: payload.approvalRequestId, presentationHash: presentation.presentationHash };
  const options = await human('POST', '/api/webauthn/typed-action/options', identity);
  assert.equal(options.status, 200);
  assert.equal((await human('POST', '/api/webauthn/typed-action/verify', { ...identity, ceremony: options.body.ceremony,
    credential: device.assertion(options.body.options.challenge, config.origin, config.rp_id) })).status, 201);
  const evidence = await peer('GET', `/api/typed-action-evidence/${payload.approvalRequestId}`);
  assert.equal(verifyTypedActionApproval(evidence.body, presentation.context, new Map([['fixture', key.publicKey]]), clock).valid, true);
  const restarted = new ApproverStore(path.resolve('fixture.sqlite'), 'production');
  try { assert.deepEqual(restarted.typedEvidence(payload.approvalRequestId), evidence.body); } finally { restarted.close(); }
  const target = path.join(root, 'runtime/typed-action-approval/contract.js'), original = fs.readFileSync(target);
  fs.unlinkSync(target); assert.throws(() => verifyPackage(root, expectedHash), /INVENTORY/);
  fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\n// tamper')])); assert.throws(() => verifyPackage(root, expectedHash), /INVENTORY/);
  fs.writeFileSync(target, original);
  const rawManifest = fs.readFileSync(path.join(root, 'manifest.json'));
  fs.appendFileSync(path.join(root, 'manifest.json'), '\n'); assert.throws(() => verifyPackage(root, expectedHash), /MANIFEST_HASH/);
  fs.writeFileSync(path.join(root, 'manifest.json'), rawManifest);
  verifyPackage(root, expectedHash);
  assert.equal(sha256(rawManifest), expectedHash);
  console.log(`Clean-room PASS: ${Object.keys(manifest.files).length} files; health/deny-all/presentation/WebAuthn/signature/restart/missing/tamper; external network=0`);
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); store.close();
}
