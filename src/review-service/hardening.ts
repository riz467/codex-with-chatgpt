import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { keyIdSchema, parseStrict } from '../typed-action-approval/contract.js';

export const configPath = '/etc/ct702-review/config.json';
export const statePath = '/var/lib/ct702-review';
export const productionConfigSchema = z.object({ version: z.literal(1), uid: z.number().int().min(100).max(60000),
  user: z.literal('ct702-review'), listen: z.literal('127.0.0.1'), port: z.literal(7020),
  database: z.literal('/var/lib/ct702-review/review.db'), signingKey: z.literal('/var/lib/ct702-review/signing.key'),
  provider: z.literal('deny-all'), peerAuthorization: z.literal('deny-all'), keyId: keyIdSchema,
}).strict();
export function validateMetadata(stat: Pick<fs.Stats, 'uid' | 'mode' | 'nlink' | 'isFile' | 'isDirectory' | 'isSymbolicLink'>,
  uid: number, directory: boolean, privateMode: boolean) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (!directory && stat.nlink !== 1) ||
      stat.uid !== uid || (stat.mode & (privateMode ? 0o077 : 0o022)) || !(stat.mode & 0o400)) throw Error('UNSAFE_PRODUCTION_PATH');
}
function parents(file: string) {
  for (let p = path.posix.dirname(file); ; p = path.posix.dirname(p)) {
    const s = fs.lstatSync(p);
    validateMetadata(s, 0, true, false);
    if (p === '/') break;
  }
}
export function loadProductionConfig() {
  if (process.platform !== 'linux' || !process.getuid?.() || process.geteuid?.() !== process.getuid()) throw Error('UNPRIVILEGED_LINUX_REQUIRED');
  process.umask(0o077);
  if (process.umask() !== 0o077) throw Error('UNSAFE_UMASK');
  parents(configPath); validateMetadata(fs.lstatSync(configPath), 0, false, false);
  const config = parseStrict(productionConfigSchema, JSON.parse(fs.readFileSync(configPath, 'utf8')));
  if (config.uid !== process.getuid() || config.keyId === 'REPLACE_WITH_REVIEWED_KEY_ID') throw Error('WRONG_IDENTITY');
  const account = fs.readFileSync('/etc/passwd', 'utf8').split('\n').filter(line => line.split(':')[0] === config.user);
  if (account.length !== 1 || Number(account[0].split(':')[2]) !== config.uid) throw Error('WRONG_ACCOUNT');
  parents(statePath); validateMetadata(fs.lstatSync(statePath), config.uid, true, true);
  for (const file of [config.signingKey, config.database, `${config.database}-wal`, `${config.database}-shm`]) {
    if ((file.endsWith('-wal') || file.endsWith('-shm')) && !fs.existsSync(file)) continue;
    validateMetadata(fs.lstatSync(file), config.uid, false, true);
  }
  return config;
}
