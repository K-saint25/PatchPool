import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { PatchPoolError } from './errors.js';

export function resolveWorkerId(environment = process.env) {
  const explicit = String(environment?.PATCHPOOL_WORKER_ID ?? '').trim();
  if (explicit) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(explicit)) throw new PatchPoolError('INVALID_WORKER_ID', 'PATCHPOOL_WORKER_ID must contain only letters, numbers, dot, underscore, or hyphen');
    return explicit;
  }
  const machine = String(environment?.COMPUTERNAME ?? environment?.HOSTNAME ?? hostname());
  const user = String(environment?.USERNAME ?? environment?.USER ?? (() => { try { return userInfo().username; } catch { return 'unknown'; } })());
  const digest = createHash('sha256').update(`${machine}\0${user}`).digest('hex').slice(0, 16);
  return `worker-${digest}`;
}
