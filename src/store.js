import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PatchPoolError } from './errors.js';

const SCHEMA_VERSION = 1;
const ACTIVE_STATES = ['claimed', 'running', 'verified', 'committed', 'pushed', 'pr_opened'];
const STATES = new Set(['claimed', 'running', 'verified', 'committed', 'pushed', 'pr_opened', 'failed']);
const BUSY_RETRY_ATTEMPTS = 20;
const BUSY_RETRY_WAIT_MS = 10;
const TRANSITIONS = new Map([
  ['claimed', new Set(['running', 'failed'])],
  ['running', new Set(['running', 'verified', 'failed'])],
  ['verified', new Set(['verified', 'committed', 'failed'])],
  ['committed', new Set(['pushed', 'failed'])],
  ['pushed', new Set(['pr_opened', 'failed'])],
  ['pr_opened', new Set(['failed'])],
  ['failed', new Set(['failed'])],
]);
const REQUIRED_SCHEMA = new Map([
  ['schema_meta', ['id', 'version']],
  ['repositories', ['id', 'full_name', 'active', 'is_public', 'config_digest', 'verification_argv', 'required_label', 'blocking_labels', 'policy_json', 'created_at', 'updated_at']],
  ['claims', ['id', 'repo_id', 'issue_number', 'worker_id', 'state', 'fields_json', 'claimed_at', 'updated_at']],
  ['events', ['id', 'claim_id', 'event_type', 'payload_json', 'created_at']],
  ['execution_leases', ['claim_id', 'worker_id', 'token', 'acquired_at', 'expires_at', 'owner_pid', 'owner_session_id']],
]);

function now() {
  return new Date().toISOString();
}

export function requireCanonicalFullName(fullName) {
  const value = typeof fullName === 'string' ? fullName : '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
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

function normalizeRepository(input) {
  if (!input || !input.configDigest) {
    throw new PatchPoolError('INVALID_REPOSITORY', 'Repository configDigest is required');
  }
  const publicRepository = booleanValue(input.public ?? input.isPublic, true);
  if (!publicRepository || String(input.visibility ?? '').toLowerCase() === 'private') {
    throw new PatchPoolError('INVALID_REPOSITORY', 'Only public repositories may be registered');
  }
  const fullName = requireCanonicalFullName(input.fullName);
  if (!Array.isArray(input.verificationArgv) || input.verificationArgv.length === 0 ||
      input.verificationArgv.some(argument => typeof argument !== 'string' || argument.length === 0)) {
    throw new PatchPoolError('INVALID_REPOSITORY', 'Repository verificationArgv must be a non-empty string array');
  }
  return {
    fullName,
    active: booleanValue(input.active, true),
    public: publicRepository,
    configDigest: String(input.configDigest),
    verificationArgv: input.verificationArgv,
    requiredLabel: input.requiredLabel ?? input.policy?.requiredLabel ?? null,
    blockingLabels: input.blockingLabels ?? input.policy?.blockingLabels ?? [],
    policy: input.policy ?? {},
  };
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

function mapClaimSummary(row) {
  const fields = json(row.fields_json, {});
  const optionalString = key => typeof fields[key] === 'string' ? fields[key] : null;
  return {
    id: row.id,
    repoId: row.repo_id,
    repositoryFullName: row.repository_full_name,
    issueNumber: row.issue_number,
    workerId: row.worker_id,
    state: row.state,
    branch: optionalString('branch'),
    workspace: optionalString('workspace'),
    commitSha: optionalString('commitSha'),
    prUrl: optionalString('prUrl'),
    errorCode: optionalString('errorCode'),
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  };
}

function incompatibleStateDatabase() {
  return new PatchPoolError('STATE_DATABASE_INCOMPATIBLE', 'State database is not a compatible current PatchPool database');
}

function assertCurrentSchema(database) {
  const integrity = database.prepare('PRAGMA quick_check').all();
  if (integrity.length === 0 || integrity.some(row => row.quick_check !== 'ok')) throw incompatibleStateDatabase();
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  for (const [table, requiredColumns] of REQUIRED_SCHEMA) {
    if (!tables.has(table)) throw incompatibleStateDatabase();
    const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (requiredColumns.some(column => !columns.has(column))) throw incompatibleStateDatabase();
  }
  const metadata = database.prepare('SELECT id, version FROM schema_meta WHERE id = 1').get();
  if (metadata?.id !== 1 || metadata.version !== SCHEMA_VERSION) throw incompatibleStateDatabase();
  const claimsSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claims'").get()?.sql ?? '';
  if (!claimsSql.includes("'running'") || claimsSql.includes("'working'") || claimsSql.includes("'verifying'") || claimsSql.includes("'completed'") || claimsSql.includes("'released'")) {
    throw incompatibleStateDatabase();
  }
  const activeIndexSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'claims_one_active_issue'").get()?.sql ?? '';
  if (!activeIndexSql.includes("'running'") || activeIndexSql.includes("'working'") || activeIndexSql.includes("'verifying'") || activeIndexSql.includes("'released'")) {
    throw incompatibleStateDatabase();
  }
  const leaseTargets = database.prepare('PRAGMA foreign_key_list(execution_leases)').all().map(row => row.table);
  if (leaseTargets.length !== 1 || leaseTargets[0] !== 'claims') throw incompatibleStateDatabase();
}

function queryClaimSummaries(database) {
  return database.prepare(`
    SELECT claims.*, repositories.full_name AS repository_full_name
    FROM claims
    JOIN repositories ON repositories.id = claims.repo_id
    ORDER BY claims.id ASC
  `).all().map(mapClaimSummary);
}

function queryRepositories(database) {
  return database.prepare('SELECT * FROM repositories ORDER BY full_name COLLATE NOCASE').all().map(mapRepository);
}

function queryCurrentStateReadOnly(path, query) {
  const requestedPath = String(path ?? '.patchpool.sqlite');
  if (requestedPath === ':memory:') return [];
  const absolute = resolve(requestedPath);
  if (!existsSync(absolute)) return [];
  let database;
  try {
    database = new DatabaseSync(absolute, { readOnly: true });
    assertCurrentSchema(database);
    return query(database);
  } catch (error) {
    if (error?.code === 'STATE_DATABASE_INCOMPATIBLE') throw error;
    throw incompatibleStateDatabase();
  } finally {
    try { database?.close(); } catch { /* preserve the read result */ }
  }
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

function migrateWorkflowStates(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claims'").get()?.sql ?? '';
  if (table.includes("'running'") && !table.includes("'working'") && !table.includes("'released'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec('ALTER TABLE events RENAME TO events_legacy');
    db.exec('ALTER TABLE claims RENAME TO claims_legacy');
    db.exec('DROP INDEX IF EXISTS claims_one_active_issue');
    db.exec(`
      CREATE TABLE claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repositories(id),
        issue_number INTEGER NOT NULL CHECK (issue_number > 0),
        worker_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'running', 'verified', 'committed', 'pushed', 'pr_opened', 'failed')),
        fields_json TEXT NOT NULL DEFAULT '{}',
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO claims (id, repo_id, issue_number, worker_id, state, fields_json, claimed_at, updated_at)
        SELECT id, repo_id, issue_number, worker_id,
          CASE state WHEN 'working' THEN 'running' WHEN 'verifying' THEN 'running' WHEN 'completed' THEN 'failed' WHEN 'released' THEN 'failed' ELSE state END,
          fields_json, claimed_at, updated_at FROM claims_legacy;
      CREATE UNIQUE INDEX claims_one_active_issue
        ON claims(repo_id, issue_number) WHERE state IN ('claimed', 'running', 'verified', 'committed', 'pushed', 'pr_opened');
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id INTEGER NOT NULL REFERENCES claims(id),
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO events (id, claim_id, event_type, payload_json, created_at)
        SELECT id, claim_id, event_type, payload_json, created_at FROM events_legacy;
      DROP TABLE events_legacy;
      DROP TABLE claims_legacy;
      COMMIT;
    `);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration error */ }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function ensureExecutionLeasesSchema(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_leases'").get();
  const create = () => db.exec(`
    CREATE TABLE execution_leases (
      claim_id INTEGER PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
      worker_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      owner_pid INTEGER,
      owner_session_id TEXT
    );
  `);
  if (!exists) {
    create();
    return;
  }
  const targets = db.prepare('PRAGMA foreign_key_list(execution_leases)').all().map(row => row.table);
  if (targets.length === 1 && targets[0] === 'claims') {
    const columns = new Set(db.prepare('PRAGMA table_info(execution_leases)').all().map(row => row.name));
    if (!columns.has('owner_pid')) db.exec('ALTER TABLE execution_leases ADD COLUMN owner_pid INTEGER');
    if (!columns.has('owner_session_id')) db.exec('ALTER TABLE execution_leases ADD COLUMN owner_session_id TEXT');
    return;
  }
  const legacyColumns = new Set(db.prepare('PRAGMA table_info(execution_leases)').all().map(row => row.name));
  const ownerPid = legacyColumns.has('owner_pid') ? 'legacy.owner_pid' : 'NULL';
  const ownerSessionId = legacyColumns.has('owner_session_id') ? 'legacy.owner_session_id' : 'NULL';
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec('ALTER TABLE execution_leases RENAME TO execution_leases_legacy');
    create();
    db.exec(`
      INSERT INTO execution_leases (claim_id, worker_id, token, acquired_at, expires_at, owner_pid, owner_session_id)
        SELECT legacy.claim_id, legacy.worker_id, legacy.token, legacy.acquired_at, legacy.expires_at, ${ownerPid}, ${ownerSessionId}
        FROM execution_leases_legacy AS legacy
        JOIN claims ON claims.id = legacy.claim_id;
      DROP TABLE execution_leases_legacy;
      COMMIT;
    `);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration error */ }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function processIsAlive({ pid }) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function leaseIdentity(lease) {
  return {
    workerId: String(lease?.workerId ?? '').trim(),
    token: String(lease?.token ?? '').trim(),
  };
}

function assertLeaseRow(db, claimId, workerId, token, timestamp) {
  const row = db.prepare('SELECT * FROM execution_leases WHERE claim_id = ? AND worker_id = ? AND token = ?').get(claimId, workerId, token);
  if (!row || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= timestamp) {
    throw new PatchPoolError('LEASE_LOST', 'Execution lease is missing, expired, or owned by a replacement worker');
  }
  return row;
}

export class PatchPoolStore {
  static open(path = '.patchpool.sqlite', options) {
    return new PatchPoolStore(path, options);
  }

  static listClaimsReadOnly(path = '.patchpool.sqlite') {
    return queryCurrentStateReadOnly(path, queryClaimSummaries);
  }

  static listRepositoriesReadOnly(path = '.patchpool.sqlite') {
    return queryCurrentStateReadOnly(path, queryRepositories);
  }

  constructor(path, { clock = Date.now, randomId = randomUUID, isOwnerAlive = processIsAlive, ownerSessionId = randomUUID() } = {}) {
    this.path = path;
    this.clock = clock;
    this.randomId = randomId;
    this.isOwnerAlive = isOwnerAlive;
    this.ownerSessionId = ownerSessionId;
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
        state TEXT NOT NULL CHECK (state IN ('claimed', 'running', 'verified', 'committed', 'pushed', 'pr_opened', 'failed')),
        fields_json TEXT NOT NULL DEFAULT '{}',
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS claims_one_active_issue
        ON claims(repo_id, issue_number) WHERE state IN ('claimed', 'running', 'verified', 'committed', 'pushed', 'pr_opened');
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id INTEGER NOT NULL REFERENCES claims(id),
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    migrateWorkflowStates(this.db);
    ensureExecutionLeasesSchema(this.db);
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
    const repository = normalizeRepository(input);
    const timestamp = now();
    try {
      const result = this.db.prepare(`
        INSERT INTO repositories
          (full_name, active, is_public, config_digest, verification_argv,
           required_label, blocking_labels, policy_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        repository.fullName,
        repository.active ? 1 : 0,
        repository.public ? 1 : 0,
        repository.configDigest,
        JSON.stringify(repository.verificationArgv),
        repository.requiredLabel,
        JSON.stringify(Array.isArray(repository.blockingLabels) ? repository.blockingLabels : []),
        JSON.stringify(repository.policy),
        timestamp,
        timestamp,
      );
      return this.getRepositoryById(Number(result.lastInsertRowid));
    } catch (error) {
      if (String(error?.code ?? '').includes('CONSTRAINT') || /UNIQUE constraint/i.test(error?.message ?? '')) {
        throw new PatchPoolError('REPOSITORY_EXISTS', `Repository is already registered: ${repository.fullName}`);
      }
      throw error;
    }
  }

  reapproveRepository(input) {
    const repository = normalizeRepository(input);
    return withImmediateTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM repositories WHERE full_name = ? COLLATE NOCASE').get(repository.fullName);
      if (!existing) throw new PatchPoolError('REPOSITORY_NOT_FOUND', `Repository is not registered: ${repository.fullName}`);
      const activeClaim = this.db.prepare(`
        SELECT id FROM claims
        WHERE repo_id = ? AND state IN ('claimed', 'running', 'verified', 'committed', 'pushed', 'pr_opened')
        LIMIT 1
      `).get(existing.id);
      if (activeClaim) {
        throw new PatchPoolError('REPOSITORY_REAPPROVAL_BUSY', 'Repository approval cannot change while a claim is active');
      }
      this.db.prepare(`
        UPDATE repositories
        SET full_name = ?, active = ?, is_public = ?, config_digest = ?, verification_argv = ?,
            required_label = ?, policy_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        repository.fullName,
        repository.active ? 1 : 0,
        repository.public ? 1 : 0,
        repository.configDigest,
        JSON.stringify(repository.verificationArgv),
        repository.requiredLabel,
        JSON.stringify(repository.policy),
        now(),
        existing.id,
      );
      return this.getRepositoryById(existing.id);
    });
  }

  getRepositoryById(id) {
    return mapRepository(this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id));
  }

  getRepository(fullName) {
    return mapRepository(this.db.prepare('SELECT * FROM repositories WHERE full_name = ? COLLATE NOCASE').get(requireCanonicalFullName(fullName)));
  }

  listRepositories() {
    return queryRepositories(this.db);
  }

  claimIssue(input) {
    const repoId = Number(input?.repoId);
    const issueNumber = Number(input?.issueNumber);
    const workerId = String(input?.workerId ?? '').trim();
    const expectedConfigDigest = String(input?.expectedConfigDigest ?? '').trim();
    const existingOnly = input?.existingOnly === true;
    if (!Number.isInteger(repoId) || repoId < 1 || !Number.isInteger(issueNumber) || issueNumber < 1 || !workerId || !expectedConfigDigest) {
      throw new PatchPoolError('INVALID_CLAIM', 'repoId, positive issueNumber, workerId, and expectedConfigDigest are required');
    }
    return withImmediateTransaction(this.db, () => {
      const repository = this.getRepositoryById(repoId);
      if (!repository) throw new PatchPoolError('REPOSITORY_NOT_FOUND', `Unknown repository id: ${repoId}`);
      if (!repository.active) throw new PatchPoolError('REPOSITORY_INACTIVE', `Repository is inactive: ${repository.fullName}`);
      if (!repository.public) throw new PatchPoolError('REPOSITORY_NOT_PUBLIC', `Repository is not public: ${repository.fullName}`);
      if (repository.configDigest !== expectedConfigDigest) {
        throw new PatchPoolError('REPOSITORY_APPROVAL_CHANGED', 'Repository approval changed before the claim transaction');
      }
      const existing = this.db.prepare(`SELECT * FROM claims WHERE repo_id = ? AND issue_number = ? AND state IN ('claimed', 'running', 'verified', 'committed', 'pushed', 'pr_opened')`).get(repoId, issueNumber);
      if (existing) {
        const mapped = mapClaim(existing);
        if (mapped.approvalConfigDigest !== expectedConfigDigest) {
          throw new PatchPoolError('REPOSITORY_APPROVAL_CHANGED', 'Active claim belongs to another repository approval generation');
        }
        if (mapped.workerId === workerId) return mapped;
        throw new PatchPoolError('CLAIM_EXISTS', `Issue ${issueNumber} already has an active claim`);
      }
      if (existingOnly) return null;
      const timestamp = now();
      const fields = { ...(input.fields ?? {}), approvalConfigDigest: expectedConfigDigest };
      try {
        const result = this.db.prepare(`
          INSERT INTO claims (repo_id, issue_number, worker_id, state, fields_json, claimed_at, updated_at)
          VALUES (?, ?, ?, 'claimed', ?, ?, ?)
        `).run(repoId, issueNumber, workerId, JSON.stringify(fields), timestamp, timestamp);
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
    return withImmediateTransaction(this.db, () => this.transitionClaimInTransaction(id, nextState, fields));
  }

  transitionClaimWithLease(id, nextState, fields = {}, lease) {
    const claimId = Number(id);
    const { workerId, token } = leaseIdentity(lease);
    if (!Number.isInteger(claimId) || claimId < 1 || !workerId || !token) throw new PatchPoolError('INVALID_LEASE', 'A complete execution lease is required');
    return withImmediateTransaction(this.db, () => {
      assertLeaseRow(this.db, claimId, workerId, token, this.clock());
      return this.transitionClaimInTransaction(claimId, nextState, fields);
    });
  }

  transitionClaimInTransaction(id, nextState, fields = {}) {
    const claimId = Number(id);
    const requestedState = String(nextState ?? '').toLowerCase();
    const compatibilityWorking = requestedState === 'working';
    const compatibilityReleased = requestedState === 'released';
    const state = compatibilityWorking ? 'running' : (compatibilityReleased ? 'failed' : requestedState);
    if (!Number.isInteger(claimId) || claimId < 1 || !STATES.has(state)) {
      throw new PatchPoolError('INVALID_TRANSITION', `Unknown claim transition state: ${nextState}`);
    }
    const current = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    if (!current) throw new PatchPoolError('CLAIM_NOT_FOUND', `Unknown claim id: ${claimId}`);
    if (!TRANSITIONS.get(current.state).has(state)) {
      throw new PatchPoolError('INVALID_TRANSITION', `Cannot transition claim from ${current.state} to ${state}`);
    }
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new PatchPoolError('INVALID_TRANSITION', 'Transition fields must be an object');
    }
    const currentFields = json(current.fields_json, {});
    const merged = { ...currentFields, ...fields };
    if (Object.hasOwn(currentFields, 'approvalConfigDigest')) merged.approvalConfigDigest = currentFields.approvalConfigDigest;
    const timestamp = now();
    this.db.prepare('UPDATE claims SET state = ?, fields_json = ?, updated_at = ? WHERE id = ?')
      .run(state, JSON.stringify(merged), timestamp, claimId);
    this.db.prepare('INSERT INTO events (claim_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(claimId, state, JSON.stringify(fields), timestamp);
    const result = this.getClaim(claimId);
    if (compatibilityWorking) return { ...result, state: 'working' };
    if (compatibilityReleased) return { ...result, state: 'released' };
    return result;
  }

  getClaim(id) {
    return mapClaim(this.db.prepare('SELECT * FROM claims WHERE id = ?').get(Number(id)));
  }

  listClaims() {
    return queryClaimSummaries(this.db);
  }

  restartClaim(id, fields = {}) {
    return withImmediateTransaction(this.db, () => this.restartClaimInTransaction(id, fields));
  }

  restartClaimWithLease(id, fields = {}, lease) {
    const claimId = Number(id);
    const { workerId, token } = leaseIdentity(lease);
    if (!Number.isInteger(claimId) || claimId < 1 || !workerId || !token) throw new PatchPoolError('INVALID_LEASE', 'A complete execution lease is required');
    return withImmediateTransaction(this.db, () => {
      assertLeaseRow(this.db, claimId, workerId, token, this.clock());
      return this.restartClaimInTransaction(claimId, fields);
    });
  }

  restartClaimInTransaction(id, fields = {}) {
    const claimId = Number(id);
    const current = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    if (!current) throw new PatchPoolError('CLAIM_NOT_FOUND', `Unknown claim id: ${claimId}`);
    if (current.state !== 'committed') throw new PatchPoolError('INVALID_TRANSITION', `Cannot restart claim from ${current.state}`);
    const merged = { ...json(current.fields_json, {}) };
    const approvalConfigDigest = merged.approvalConfigDigest;
    for (const key of ['commitSha', 'committedAt', 'verifiedAt', 'workspace', 'pushedAt', 'prUrl', 'openedAt', 'errorCode', 'failedAt', 'startedAt', 'restartAt']) delete merged[key];
    Object.assign(merged, fields);
    if (approvalConfigDigest !== undefined) merged.approvalConfigDigest = approvalConfigDigest;
    const timestamp = now();
    this.db.prepare('UPDATE claims SET state = ?, fields_json = ?, updated_at = ? WHERE id = ?')
      .run('running', JSON.stringify(merged), timestamp, claimId);
    this.db.prepare('INSERT INTO events (claim_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(claimId, 'running', JSON.stringify(fields), timestamp);
    return this.getClaim(claimId);
  }

  acquireExecutionLease(claimIdValue, workerIdValue, { ttlMs = 300_000, ownerPid = process.pid, ownerSessionId = this.ownerSessionId } = {}) {
    const claimId = Number(claimIdValue);
    const workerId = String(workerIdValue ?? '').trim();
    const sessionId = String(ownerSessionId ?? '').trim();
    if (!Number.isInteger(claimId) || claimId < 1 || !workerId || !Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(ownerPid) || ownerPid <= 0 || !sessionId) {
      throw new PatchPoolError('INVALID_LEASE', 'claimId, workerId, owner process identity, and a positive ttlMs are required');
    }
    return withImmediateTransaction(this.db, () => {
      const claim = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
      if (!claim) throw new PatchPoolError('CLAIM_NOT_FOUND', `Unknown claim id: ${claimId}`);
      if (claim.worker_id !== workerId) throw new PatchPoolError('CLAIM_EXISTS', 'Claim belongs to another worker');
      if (!ACTIVE_STATES.includes(claim.state)) throw new PatchPoolError('LEASE_UNAVAILABLE', 'Claim is not active');
      const existing = this.db.prepare('SELECT * FROM execution_leases WHERE claim_id = ?').get(claimId);
      const timestamp = this.clock();
      if (existing && Date.parse(existing.expires_at) > timestamp) {
        throw new PatchPoolError('LEASE_BUSY', 'Claim is already being executed by this worker');
      }
      if (existing && (!Number.isInteger(existing.owner_pid) || existing.owner_pid <= 0 || typeof existing.owner_session_id !== 'string' || !existing.owner_session_id)) {
        throw new PatchPoolError('LEASE_BUSY', 'Expired legacy execution lease requires explicit recovery');
      }
      if (existing && Number.isInteger(existing.owner_pid) && existing.owner_pid > 0 && typeof existing.owner_session_id === 'string' && existing.owner_session_id) {
        let alive = true;
        try { alive = this.isOwnerAlive({ pid: existing.owner_pid, sessionId: existing.owner_session_id }) !== false; } catch { /* fail closed when liveness cannot be established */ }
        if (alive) throw new PatchPoolError('LEASE_BUSY', 'Expired execution lease owner process is still alive');
      }
      const acquiredAt = new Date(timestamp).toISOString();
      const expiresAt = new Date(timestamp + ttlMs).toISOString();
      const token = this.randomId();
      this.db.prepare(`
        INSERT INTO execution_leases (claim_id, worker_id, token, acquired_at, expires_at, owner_pid, owner_session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(claim_id) DO UPDATE SET worker_id = excluded.worker_id, token = excluded.token,
          acquired_at = excluded.acquired_at, expires_at = excluded.expires_at,
          owner_pid = excluded.owner_pid, owner_session_id = excluded.owner_session_id
      `).run(claimId, workerId, token, acquiredAt, expiresAt, ownerPid, sessionId);
      return { claimId, workerId, token, acquiredAt, expiresAt, ownerPid, ownerSessionId: sessionId };
    });
  }

  assertExecutionLease(claimIdValue, workerIdValue, tokenValue) {
    const claimId = Number(claimIdValue);
    const workerId = String(workerIdValue ?? '').trim();
    const token = String(tokenValue ?? '').trim();
    if (!Number.isInteger(claimId) || claimId < 1 || !workerId || !token) throw new PatchPoolError('INVALID_LEASE', 'claimId, workerId, and token are required');
    return withImmediateTransaction(this.db, () => {
      const row = assertLeaseRow(this.db, claimId, workerId, token, this.clock());
      return { claimId, workerId, token, acquiredAt: row.acquired_at, expiresAt: row.expires_at, ownerPid: row.owner_pid, ownerSessionId: row.owner_session_id };
    });
  }

  renewExecutionLease(claimIdValue, workerIdValue, tokenValue, { ttlMs = 300_000 } = {}) {
    const claimId = Number(claimIdValue);
    const workerId = String(workerIdValue ?? '').trim();
    const token = String(tokenValue ?? '').trim();
    if (!Number.isInteger(claimId) || claimId < 1 || !workerId || !token || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new PatchPoolError('INVALID_LEASE', 'claimId, workerId, token, and a positive ttlMs are required');
    }
    return withImmediateTransaction(this.db, () => {
      const timestamp = this.clock();
      const row = assertLeaseRow(this.db, claimId, workerId, token, timestamp);
      const expiresAt = new Date(timestamp + ttlMs).toISOString();
      this.db.prepare('UPDATE execution_leases SET expires_at = ? WHERE claim_id = ? AND worker_id = ? AND token = ?')
        .run(expiresAt, claimId, workerId, token);
      return { claimId, workerId, token, acquiredAt: row.acquired_at, expiresAt, ownerPid: row.owner_pid, ownerSessionId: row.owner_session_id };
    });
  }

  releaseExecutionLease(claimIdValue, workerIdValue, tokenValue) {
    const claimId = Number(claimIdValue);
    const workerId = String(workerIdValue ?? '').trim();
    const token = String(tokenValue ?? '').trim();
    if (!Number.isInteger(claimId) || claimId < 1 || !workerId || !token) throw new PatchPoolError('INVALID_LEASE', 'claimId, workerId, and token are required');
    return withImmediateTransaction(this.db, () => {
      const result = this.db.prepare('DELETE FROM execution_leases WHERE claim_id = ? AND worker_id = ? AND token = ?').run(claimId, workerId, token);
      return Number(result.changes) > 0;
    });
  }
}

export { ACTIVE_STATES, SCHEMA_VERSION };
