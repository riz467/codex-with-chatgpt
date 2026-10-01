import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, parseStrict } from '../typed-action-approval/contract.js';
import { bindActionAttempt, hashActionRequest, parseActionRequest } from '../mcp/typed-actions.js';
import { reviewInputSchema } from '../typed-action-review/contract.js';

export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const limits = Object.freeze({ files: 64, bytes: 1024 * 1024, wireBytes: 1500000 });
const portablePath = z.string().min(1).max(200).refine(p => p.split('/').every(s =>
  /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(s) && !s.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s)));
export const submissionSchema = z.object({ binding: reviewInputSchema, files: z.array(z.object({
  path: portablePath, base64: z.string().max(Math.ceil(limits.bytes / 3) * 4),
}).strict()).min(2).max(limits.files) }).strict();
export type Submission = z.infer<typeof submissionSchema>;
export type Material = ReturnType<typeof freezeCandidate>;
export function freezeCandidate(input: unknown) {
  const request = parseStrict(submissionSchema, input);
  let total = 0;
  const seen = new Set<string>();
  const files = request.files.map(f => {
    const bytes = Buffer.from(f.base64, 'base64');
    const folded = f.path.toLowerCase();
    if (bytes.toString('base64') !== f.base64 || [...seen].some(p => p === folded || p.startsWith(folded + '/') || folded.startsWith(p + '/'))) throw Error('INVALID_OR_DUPLICATE_SOURCE');
    seen.add(f.path.toLowerCase()); total += bytes.length;
    if (total > limits.bytes) throw Error('MATERIAL_TOO_LARGE');
    return { path: f.path, bytes, sha256: hash(bytes) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const json = (name: string) => {
    const f = files.find(f => f.path === name);
    if (!f) throw Error('BINDING_SOURCE_MISSING');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(f.bytes);
    const value: unknown = JSON.parse(text);
    if (canonicalJson(value) !== text) throw Error('NONCANONICAL_BINDING_SOURCE');
    return { value, digest: f.sha256 };
  };
  const sourceRequest = json('request.json'), sourceAttempt = json('attempt.json');
  const r = parseActionRequest(sourceRequest.value);
  const { attempt: a, attemptHash } = bindActionAttempt(sourceAttempt.value, r);
  const b = request.binding;
  if (b.actionId !== r.actionId || b.actionKind !== r.kind || b.targetId !== r.target.id || b.requestHash !== hashActionRequest(r) ||
      b.attemptId !== a.attemptId || b.attemptSequence !== a.sequence || a.requestHash !== b.requestHash || b.attemptHash !== attemptHash) throw Error('SOURCE_BINDING_MISMATCH');
  const manifest = canonicalJson({ version: 1, files: files.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes.length })) });
  const manifestHash = hash(manifest);
  const root = hash(`CT702_FROZEN_MATERIAL_V1\n${manifest}`);
  return { binding: b, files, manifest, manifestHash, root, predecessor: r.retryOf };
}
