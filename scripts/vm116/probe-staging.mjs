// Can probe approved Linux deployment or an isolated local package. Never probes Bridge authority APIs.
import assert from 'node:assert/strict';
const basePorts = process.argv.slice(2).map(Number);
assert.equal(basePorts.length, 2);
let assertions = 0;
for (const [index, role] of ['gateway', 'dashboard'].entries()) {
  const port = basePorts[index];
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  for (const [method, route, status] of [
    ['GET', '/health', 200], ['HEAD', '/health', 200], ['POST', '/health', 503],
    ['GET', '/', 503], ['GET', '/health?x=1', 503], ['GET', '/api/bounded/start-session', 503],
    ['POST', '/api/bounded/start', 503], ['POST', '/mcp', 503], ['GET', '/oauth/authorize', 503],
    ['POST', '/approve', 503], ['POST', '/dispatch', 503], ['POST', '/finalize', 503],
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, status); assertions++;
    assert.equal(res.headers.get('cache-control'), 'no-store'); assertions++;
    assert.equal(res.headers.get('x-powered-by'), null); assertions++;
    if (method !== 'HEAD') {
      const body = await res.json();
      assert.deepEqual(body, status === 200 ? { ok: true, service: `ai-linux-${role}-staging`, dispatch: 'CLOSED', authority: 'NONE' } : { error: 'CONTROL_PLANE_STAGING_ONLY' });
      assertions++;
    }
  }
}
console.log(JSON.stringify({ status: 'PASS', requests: 24, assertions, platform: process.platform, node: process.version }));
