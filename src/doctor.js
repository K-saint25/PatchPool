import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from './store.js';

const MINIMUM_NODE_MAJOR = 24;
const REQUIRED_SCHEMA = new Map([
  ['schema_meta', ['id', 'version']],
  ['repositories', ['id', 'full_name', 'active', 'is_public', 'config_digest', 'verification_argv', 'required_label', 'blocking_labels', 'policy_json', 'created_at', 'updated_at']],
  ['claims', ['id', 'repo_id', 'issue_number', 'worker_id', 'state', 'fields_json', 'claimed_at', 'updated_at']],
  ['events', ['id', 'claim_id', 'event_type', 'payload_json', 'created_at']],
  ['execution_leases', ['claim_id', 'worker_id', 'token', 'acquired_at', 'expires_at', 'owner_pid', 'owner_session_id']],
]);

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

function stateError(code, message) {
  return Object.assign(new Error(message), { code });
}

function checkParent(path) {
  const parent = dirname(resolve(path));
  try {
    if (!statSync(parent).isDirectory()) throw new Error('not a directory');
    accessSync(parent, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw stateError('STATE_DATABASE_PARENT_UNAVAILABLE', 'State database parent directory is unavailable or not writable');
  }
}

function assertCompatibleSchema(database) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  for (const [table, requiredColumns] of REQUIRED_SCHEMA) {
    if (!tables.has(table)) throw stateError('STATE_DATABASE_SCHEMA_INCOMPATIBLE', 'State database is missing required PatchPool schema');
    const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (requiredColumns.some(column => !columns.has(column))) {
      throw stateError('STATE_DATABASE_SCHEMA_INCOMPATIBLE', 'State database is missing required PatchPool columns');
    }
  }
  const metadata = database.prepare('SELECT id, version FROM schema_meta WHERE id = 1').get();
  if (metadata?.id !== 1 || metadata?.version !== SCHEMA_VERSION) {
    throw stateError('STATE_DATABASE_SCHEMA_INCOMPATIBLE', 'State database schema version is not supported');
  }
  return metadata.version;
}

function checkStateDatabase(path = '.patchpool.sqlite') {
  if (path === ':memory:') {
    return { path, exists: false, writable: true, openable: true, ephemeral: true };
  }
  checkParent(path);
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    return { path, exists: false, writable: true, openable: true, creatable: true };
  }
  try {
    if (!statSync(absolute).isFile()) throw new Error('not a file');
    accessSync(absolute, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw stateError('STATE_DATABASE_NOT_WRITABLE', 'Existing state database is not a readable and writable file');
  }
  let database;
  let schemaVersion;
  try {
    database = new DatabaseSync(absolute, { readOnly: true });
    const integrity = database.prepare('PRAGMA quick_check').all();
    if (integrity.length === 0 || integrity.some(row => row.quick_check !== 'ok')) {
      throw new Error('integrity check failed');
    }
    schemaVersion = assertCompatibleSchema(database);
  } catch (error) {
    if (error?.code === 'STATE_DATABASE_SCHEMA_INCOMPATIBLE') throw error;
    throw stateError('STATE_DATABASE_INVALID', 'Existing state database could not be checked read-only');
  } finally {
    try { database?.close(); } catch { /* preserve the state check result */ }
  }
  return { path, exists: true, writable: true, openable: true, integrity: 'ok', schemaVersion };
}

export async function runDoctor({
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
  const stateDatabase = await checked(() => checkStateDatabase(dbPath), 'STATE_DATABASE_UNAVAILABLE');
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
