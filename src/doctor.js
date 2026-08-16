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

const DIAGNOSTICS = Object.freeze({
  NODE_VERSION_UNSUPPORTED: {
    message: 'Node.js 24 or newer is required.',
    hint: 'Install Node.js 24 or newer, then rerun PatchPool doctor.',
  },
  GITHUB_AUTH_REQUIRED: {
    message: 'The GitHub CLI is unavailable or not authenticated.',
    hint: 'Install or ensure the `gh` CLI is available, run `gh auth login`, then verify with `gh auth status`.',
  },
  GITHUB_COMMAND_FAILED: {
    message: 'The GitHub CLI is unavailable or not authenticated.',
    hint: 'Install or ensure the `gh` CLI is available, run `gh auth login`, then verify with `gh auth status`.',
  },
  CODEX_AUTH_REQUIRED: {
    message: 'The Codex CLI is unavailable or not authenticated with the ChatGPT subscription flow.',
    hint: 'Install or ensure the Codex CLI is available, run `codex login` with the ChatGPT subscription flow, then verify with `codex login status`.',
  },
  CODEX_NOT_FOUND: {
    message: 'The Codex CLI could not be located safely.',
    hint: 'Install the Codex CLI, run `codex login` with the ChatGPT subscription flow, then verify with `codex login status`.',
  },
  GIT_IDENTITY_MISSING: {
    message: 'Git author name and email are not configured.',
    hint: 'Set `git config --global user.name` and `git config --global user.email`, then rerun PatchPool doctor.',
  },
  STATE_DATABASE_PARENT_UNAVAILABLE: {
    message: 'The state database parent directory is unavailable or not writable.',
    hint: 'Create the parent directory or choose a writable PATCHPOOL_DB path, then rerun PatchPool doctor.',
  },
  STATE_DATABASE_NOT_WRITABLE: {
    message: 'The existing state database is not a readable and writable file.',
    hint: 'Check the state file permissions or choose a writable PATCHPOOL_DB path, then rerun PatchPool doctor.',
  },
  STATE_DATABASE_SCHEMA_INCOMPATIBLE: {
    message: 'The state database schema is incompatible with this PatchPool version.',
    hint: 'Use a compatible PatchPool state database; back it up before any manual recovery.',
  },
  STATE_DATABASE_INVALID: {
    message: 'The existing state database failed read-only validation.',
    hint: 'Check the database integrity and compatibility; back it up before any manual recovery.',
  },
  STATE_DATABASE_UNAVAILABLE: {
    message: 'The state database could not be checked.',
    hint: 'Check the PATCHPOOL_DB path, its parent permissions, and database compatibility, then rerun PatchPool doctor.',
  },
});

const FAILURE_POLICIES = Object.freeze({
  node: { failureCode: 'NODE_VERSION_UNSUPPORTED', safeCodes: new Set(['NODE_VERSION_UNSUPPORTED']) },
  github: { failureCode: 'GITHUB_AUTH_REQUIRED', safeCodes: new Set(['GITHUB_AUTH_REQUIRED', 'GITHUB_COMMAND_FAILED']) },
  codex: { failureCode: 'CODEX_AUTH_REQUIRED', safeCodes: new Set(['CODEX_AUTH_REQUIRED', 'CODEX_NOT_FOUND']) },
  gitIdentity: { failureCode: 'GIT_IDENTITY_MISSING', safeCodes: new Set(['GIT_IDENTITY_MISSING']) },
  stateDatabase: {
    failureCode: 'STATE_DATABASE_UNAVAILABLE',
    safeCodes: new Set([
      'STATE_DATABASE_PARENT_UNAVAILABLE',
      'STATE_DATABASE_NOT_WRITABLE',
      'STATE_DATABASE_SCHEMA_INCOMPATIBLE',
      'STATE_DATABASE_INVALID',
      'STATE_DATABASE_UNAVAILABLE',
    ]),
  },
});

for (const { failureCode, safeCodes } of Object.values(FAILURE_POLICIES)) {
  for (const code of new Set([failureCode, ...safeCodes])) {
    if (!DIAGNOSTICS[code]?.message || !DIAGNOSTICS[code]?.hint) {
      throw new Error(`Doctor diagnostic is incomplete for ${code}`);
    }
  }
}

async function checked(operation, { failureCode, safeCodes, fields } = {}) {
  try {
    return { ok: true, ...(await operation()) };
  } catch (error) {
    const code = safeCodes?.has(error?.code) ? error.code : failureCode;
    return { ok: false, code, ...(fields ?? {}), ...DIAGNOSTICS[code] };
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
  const absolute = resolve(path);
  checkParent(absolute);
  if (!existsSync(absolute)) {
    return { path: absolute, exists: false, writable: true, openable: true, creatable: true };
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
  return { path: absolute, exists: true, writable: true, openable: true, integrity: 'ok', schemaVersion };
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
    : { ok: false, code: 'NODE_VERSION_UNSUPPORTED', version: String(nodeVersion), minimumMajor: MINIMUM_NODE_MAJOR, ...DIAGNOSTICS.NODE_VERSION_UNSUPPORTED };
  const githubCheck = await checked(() => github.preflight(), FAILURE_POLICIES.github);
  const codexCheck = await checked(() => codex.preflight(), FAILURE_POLICIES.codex);
  const gitIdentity = await checked(async () => ({
    name: await gitValue(runner, 'user.name'),
    email: await gitValue(runner, 'user.email'),
  }), FAILURE_POLICIES.gitIdentity);
  const statePath = dbPath === ':memory:' ? ':memory:' : resolve(dbPath ?? '.patchpool.sqlite');
  const stateDatabase = await checked(() => checkStateDatabase(statePath), {
    ...FAILURE_POLICIES.stateDatabase,
    fields: { path: statePath },
  });
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
    const detail = check.code ?? (name === 'commitSigning' ? check.mode : undefined);
    lines.push(`${check.ok ? 'OK' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    if (check.path) lines.push(`  Path: ${check.path}`);
    if (check.message) lines.push(`  ${check.message}`);
    if (check.hint) lines.push(`  Hint: ${check.hint}`);
  }
  return `${lines.join('\n')}\n`;
}
