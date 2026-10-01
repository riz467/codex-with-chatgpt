import fs from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { approverConfigSchema } from './server.js';
import { createProductionApprover, humanPort, peerPort } from './production.js';
import { ApproverStore } from './storage.js';

// Fixed composition: IR-04/05 must supply a reviewed authenticated host dependency.
// This executable cannot enable it through JSON, environment or a module path.
function main() {
  if (process.platform !== 'linux' || !process.getuid?.() || process.argv.slice(2).join(' ') !== 'serve') throw Error('Expected unprivileged Linux production serve');
  process.umask(0o077);
  const configPath = '/etc/ai-approver/config.json';
  const cfg = fs.lstatSync(configPath);
  if (!cfg.isFile() || cfg.isSymbolicLink() || cfg.nlink !== 1 || cfg.uid !== 0 || (cfg.mode & 0o022)) throw Error('UNSAFE_CONFIG');
  const config = approverConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  if (config.key_id === 'REPLACE_WITH_REVIEWED_DOMAIN_KEY_ID' || config.port !== humanPort || config.rp_id !== 'human-approver-700.tail2f618d.ts.net' ||
      config.db_path !== '/var/lib/ai-approver/approver.db' || config.signing_key_path !== '/var/lib/ai-approver/signing.key') throw Error('INVALID_PRODUCTION_CONFIG');
  const state = fs.lstatSync('/var/lib/ai-approver');
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid() || (state.mode & 0o077)) throw Error('UNSAFE_STATE_DIRECTORY');
  for (const file of [config.signing_key_path, config.db_path, `${config.db_path}-wal`, `${config.db_path}-shm`]) {
    if (file.endsWith('-wal') || file.endsWith('-shm')) { if (!fs.existsSync(file)) continue; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('UNSAFE_STATE_FILE');
  }
  const key = createPrivateKey(fs.readFileSync(config.signing_key_path));
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw Error('INVALID_SIGNING_KEY');
  const store = new ApproverStore(config.db_path, 'production');
  const { human, peer } = createProductionApprover(config, store, key);
  const listeners = [human.listen(humanPort, '127.0.0.1'), peer.listen(peerPort, '127.0.0.1')];
  for (const listener of listeners) listener.on('error', () => { for (const s of listeners) s.close(); store.close(); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    let pending = listeners.length;
    for (const s of listeners) s.close(() => { if (--pending === 0) store.close(); });
  });
}
main();
