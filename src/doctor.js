import { accessSync, constants as fsConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MINIMUM_NODE_MAJOR = 24;

async function checked(operation, failureCode) {
  try {
    return { ok: true, ...(await operation()) };
  } catch (error) {
    return { ok: false, code: error?.code ?? failureCode };
  }
}

async function gitValue(runner, key) {
  const result = await runner.run('git', ['config', '--get', key]);
  const value = String(result?.stdout ?? '').trim();
  if (result?.exitCode !== 0 || !value || /[\r\n\0]/.test(value)) throw Object.assign(new Error(`Git ${key} is not configured`), { code: 'GIT_IDENTITY_MISSING' });
  return value;
}

function checkStateDatabase(store, dbPath) {
  const path = dbPath ?? store?.path ?? '.patchpool.sqlite';
  if (!store?.db || store.db.prepare('SELECT 1 AS value').get()?.value !== 1) {
    throw Object.assign(new Error('State database is not open'), { code: 'STATE_DATABASE_UNAVAILABLE' });
  }
  if (path !== ':memory:') {
    const absolute = resolve(path);
    accessSync(absolute, fsConstants.R_OK | fsConstants.W_OK);
    accessSync(dirname(absolute), fsConstants.W_OK);
  }
  return { path, writable: true, openable: true };
}

export async function runDoctor({
  store,
  dbPath,
  runner,
  github,
  codex,
  nodeVersion = process.versions.node,
} = {}) {
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  const node = Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR
    ? { ok: true, version: String(nodeVersion), minimumMajor: MINIMUM_NODE_MAJOR }
    : { ok: false, code: 'NODE_VERSION_UNSUPPORTED', version: String(nodeVersion), minimumMajor: MINIMUM_NODE_MAJOR };
  const githubCheck = await checked(() => github.preflight(), 'GITHUB_AUTH_REQUIRED');
  const codexCheck = await checked(() => codex.preflight(), 'CODEX_AUTH_REQUIRED');
  const gitIdentity = await checked(async () => ({
    name: await gitValue(runner, 'user.name'),
    email: await gitValue(runner, 'user.email'),
  }), 'GIT_IDENTITY_MISSING');
  const stateDatabase = await checked(() => checkStateDatabase(store, dbPath), 'STATE_DATABASE_UNAVAILABLE');
  const checks = {
    node,
    github: githubCheck,
    codex: codexCheck,
    gitIdentity,
    stateDatabase,
    commitSigning: { ok: true, enabled: false, mode: 'disabled-by-worker' },
  };
  const ok = Object.values(checks).every(check => check.ok === true);
  return { ok, exitCode: ok ? 0 : 1, checks };
}

export function formatDoctor(result) {
  const lines = [`PatchPool doctor: ${result.ok ? 'ready' : 'not ready'}`];
  for (const [name, check] of Object.entries(result.checks)) {
    lines.push(`${check.ok ? 'OK' : 'FAIL'} ${name}${check.code ? ` (${check.code})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
