import { DatabaseSync } from 'node:sqlite';
import { PatchPoolError } from './errors.js';

const SCHEMA_VERSION = 1;
const ACTIVE_STATES = ['claimed', 'working', 'verifying'];
const STATES = new Set(['claimed', 'working', 'verifying', 'completed', 'failed', 'released']);
const BUSY_RETRY_ATTEMPTS = 20;
const BUSY_RETRY_WAIT_MS = 10;
const TRANSITIONS = new Map([
  ['claimed', new Set(['working', 'failed', 'released'])],
  ['working', new Set(['verifying', 'failed', 'released'])],
  ['verifying', new Set(['completed', 'failed', 'released'])],
  ['completed', new Set()],
  ['failed', new Set()],
  ['released', new Set()],
]);

function now() {
  return new Date().toISOString();
}

function canonicalFullName(fullName) {
  const value = String(fullName ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new PatchPoolError('INVALID_REPOSITORY', 'Repository must use the owner/name form');
  }
  return value;
}

function json(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function mapRepository(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    active: Boolean(row.active),
    public: Boolean(row.is_public),
    configDigest: row.config_digest,
    verificationArgv: json(row.verification_argv, []),
    requiredLabel: row.required_label,
    blockingLabels: json(row.blocking_labels, []),
    policy: json(row.policy_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClaim(row) {
  if (!row) return null;
  const fields = json(row.fields_json, {});
  return {
    ...fields,
    id: row.id,
    repoId: row.repo_id,
    issueNumber: row.issue_number,
    workerId: row.worker_id,
    state: row.state,
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  };
}

function withImmediateTransaction(db, operation) {
  let begun = false;
  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      db.exec('BEGIN IMMEDIATE');
      begun = true;
      break;
    } catch (error) {
      const busy = /busy|locked/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
      if (!busy) throw error;
      if (attempt === BUSY_RETRY_ATTEMPTS - 1) {
        throw new PatchPoolError('STORE_BUSY', 'SQLite store remained locked during the bounded claim transaction retry window', { cause: error?.message });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUSY_RETRY_WAIT_MS);
    }
  }
  if (!begun) throw new PatchPoolError('STORE_BUSY', 'Unable to begin the SQLite transaction');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  }
}

export class PatchPoolStore {
  static open(path = '.patchpool.sqlite') {
    return new PatchPoolStore(path);
  }

  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 50');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO schema_meta (id, version) VALUES (1, ${SCHEMA_VERSION})
        ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS repositories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
        config_digest TEXT NOT NULL,
        verification_argv TEXT NOT NULL,
        required_label TEXT,
        blocking_labels TEXT NOT NULL DEFAULT '[]',
        policy_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repositories(id),
        issue_number INTEGER NOT NULL CHECK (issue_number > 0),
        worker_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'working', 'verifying', 'completed', 'failed', 'released')),
        fields_json TEXT NOT NULL DEFAULT '{}',
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS claims_one_active_issue
        ON claims(repo_id, issue_number) WHERE state IN ('claimed', 'working', 'verifying');
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id INTEGER NOT NULL REFERENCES claims(id),
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    const version = this.db.prepare('SELECT version FROM schema_meta WHERE id = 1').get()?.version;
    if (version !== SCHEMA_VERSION) {
      this.db.close();
      throw new PatchPoolError('SCHEMA_VERSION_UNSUPPORTED', `Unsupported store schema version: ${version}`);
    }
  }

  close() {
    this.db.close();
  }

  registerRepository(input) {
    if (!input || !input.configDigest) {
      throw new PatchPoolError('INVALID_REPOSITORY', 'Repository configDigest is required');
    }
    if (input.public === false || input.isPublic === false || String(input.visibility ?? '').toLowerCase() === 'private') {
      throw new PatchPoolError('INVALID_REPOSITORY', 'Only public repositories may be registered');
    }
    const fullName = canonicalFullName(input.fullName);
    if (!Array.isArray(input.verificationArgv) || input.verificationArgv.length === 0 ||
        input.verificationArgv.some(argument => typeof argument !== 'string' || argument.length === 0)) {
      throw new PatchPoolError('INVALID_REPOSITORY', 'Repository verificationArgv must be a non-empty string array');
    }
    const timestamp = now();
    const requiredLabel = input.requiredLabel ?? input.policy?.requiredLabel ?? null;
    const blockingLabels = input.blockingLabels ?? input.policy?.blockingLabels ?? [];
    const policy = input.policy ?? {};
    try {
      const result = this.db.prepare(`
        INSERT INTO repositories
          (full_name, active, is_public, config_digest, verification_argv,
           required_label, blocking_labels, policy_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fullName,
        booleanValue(input.active, true) ? 1 : 0,
        booleanValue(input.public ?? input.isPublic, true) ? 1 : 0,
        String(input.configDigest),
        JSON.stringify(input.verificationArgv),
        requiredLabel,
        JSON.stringify(Array.isArray(blockingLabels) ? blockingLabels : []),
        JSON.stringify(policy),
        timestamp,
        timestamp,
      );
      return this.getRepositoryById(Number(result.lastInsertRowid));
    } catch (error) {
      if (String(error?.code ?? '').includes('CONSTRAINT') || /UNIQUE constraint/i.test(error?.message ?? '')) {
        throw new PatchPoolError('REPOSITORY_EXISTS', `Repository is already registered: ${fullName}`);
      }
      throw error;
    }
  }

  getRepositoryById(id) {
    return mapRepository(this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id));
  }

  getRepository(fullName) {
    return mapRepository(this.db.prepare('SELECT * FROM repositories WHERE full_name = ? COLLATE NOCASE').get(canonicalFullName(fullName)));
  }

  listRepositories() {
    return this.db.prepare('SELECT * FROM repositories ORDER BY full_name COLLATE NOCASE').all().map(mapRepository);
  }

  claimIssue(input) {
    const repoId = Number(input?.repoId);
    const issueNumber = Number(input?.issueNumber);
    const workerId = String(input?.workerId ?? '').trim();
    if (!Number.isInteger(repoId) || repoId < 1 || !Number.isInteger(issueNumber) || issueNumber < 1 || !workerId) {
      throw new PatchPoolError('INVALID_CLAIM', 'repoId, positive issueNumber, and workerId are required');
    }
    return withImmediateTransaction(this.db, () => {
      const repository = this.getRepositoryById(repoId);
      if (!repository) throw new PatchPoolError('REPOSITORY_NOT_FOUND', `Unknown repository id: ${repoId}`);
      if (!repository.active) throw new PatchPoolError('REPOSITORY_INACTIVE', `Repository is inactive: ${repository.fullName}`);
      if (!repository.public) throw new PatchPoolError('REPOSITORY_NOT_PUBLIC', `Repository is not public: ${repository.fullName}`);
      const timestamp = now();
      try {
        const result = this.db.prepare(`
          INSERT INTO claims (repo_id, issue_number, worker_id, state, fields_json, claimed_at, updated_at)
          VALUES (?, ?, ?, 'claimed', ?, ?, ?)
        `).run(repoId, issueNumber, workerId, JSON.stringify(input.fields ?? {}), timestamp, timestamp);
        const claim = this.getClaim(Number(result.lastInsertRowid));
        this.db.prepare('INSERT INTO events (claim_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)')
          .run(claim.id, 'claimed', JSON.stringify({ workerId }), timestamp);
        return claim;
      } catch (error) {
        if (String(error?.code ?? '').includes('CONSTRAINT') || /UNIQUE constraint/i.test(error?.message ?? '')) {
          throw new PatchPoolError('CLAIM_EXISTS', `Issue ${issueNumber} already has an active claim`);
        }
        throw error;
      }
    });
  }

  transitionClaim(id, nextState, fields = {}) {
    const claimId = Number(id);
    const state = String(nextState ?? '').toLowerCase();
    if (!Number.isInteger(claimId) || claimId < 1 || !STATES.has(state)) {
      throw new PatchPoolError('INVALID_TRANSITION', `Unknown claim transition state: ${nextState}`);
    }
    return withImmediateTransaction(this.db, () => {
      const current = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
      if (!current) throw new PatchPoolError('CLAIM_NOT_FOUND', `Unknown claim id: ${claimId}`);
      if (!TRANSITIONS.get(current.state).has(state)) {
        throw new PatchPoolError('INVALID_TRANSITION', `Cannot transition claim from ${current.state} to ${state}`);
      }
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new PatchPoolError('INVALID_TRANSITION', 'Transition fields must be an object');
      }
      const merged = { ...json(current.fields_json, {}), ...fields };
      const timestamp = now();
      this.db.prepare('UPDATE claims SET state = ?, fields_json = ?, updated_at = ? WHERE id = ?')
        .run(state, JSON.stringify(merged), timestamp, claimId);
      this.db.prepare('INSERT INTO events (claim_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(claimId, state, JSON.stringify(fields), timestamp);
      return this.getClaim(claimId);
    });
  }

  getClaim(id) {
    return mapClaim(this.db.prepare('SELECT * FROM claims WHERE id = ?').get(Number(id)));
  }
}

export { ACTIVE_STATES, SCHEMA_VERSION };
