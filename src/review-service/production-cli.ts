import fs from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { loadProductionConfig } from './hardening.js';
import { ReviewStore } from './store.js';
import { createReviewRuntime } from './runtime.js';
import { createReviewServer, reviewPort } from './server.js';

function main() {
  if (process.argv.slice(2).join(' ') !== 'serve') throw Error('Expected serve');
  const config = loadProductionConfig();
  const privateKey = createPrivateKey(fs.readFileSync(config.signingKey));
  const store = new ReviewStore(config.database);
  const runtime = createReviewRuntime({ store, privateKey, keyId: config.keyId });
  const server = createReviewServer(runtime);
  server.listen(reviewPort, '127.0.0.1');
  server.on('error', () => { store.close(); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => server.close(() => store.close()));
}
main();
