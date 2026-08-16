import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { PatchPoolStore } from '../src/store.js';

function openTempStore() {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-store-'));
  const path = join(directory, 'state.sqlite');
  const store = PatchPoolStore.open(path);
  return { store, path, directory };
}

function approvedRepo(overrides = {}) {
  return {
    fullName: 'octo/example',
    configDigest: 'sha256:config-v1',
    verificationArgv: ['npm', 'test'],
    requiredLabel: 'patchpool-ready',
    blockingLabels: ['blocked', 'wontfix'],
    ...overrides,
  };
}

test('registers one canonical repository and persists its approval snapshot', () => {
  const { store, path, directory } = openTempStore();
  try {
    const repo = store.registerRepository(approvedRepo());
    assert.equal(repo.fullName, 'octo/example');
    assert.equal(repo.configDigest, 'sha256:config-v1');
    assert.deepEqual(repo.verificationArgv, ['npm', 'test']);
    assert.equal(store.getRepository('octo/example').configDigest, 'sha256:config-v1');
    assert.deepEqual(store.listRepositories().map(item => item.fullName), ['octo/example']);
    assert.throws(() => store.registerRepository(approvedRepo()), error => error.code === 'REPOSITORY_EXISTS');
    assert.ok(path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repository names use the same canonical owner/name grammar as the GitHub adapter', () => {
  const { store, directory } = openTempStore();
  try {
    for (const fullName of ['owner name/repo', 'owner/repo name', 'owner/repo?', '@owner/repo', 'owner//repo']) {
      assert.throws(
        () => store.registerRepository(approvedRepo({ fullName })),
        error => error.code === 'INVALID_REPOSITORY',
      );
    }
    const accepted = store.registerRepository(approvedRepo({ fullName: 'owner.name/repo_name-1' }));
    assert.equal(accepted.fullName, 'owner.name/repo_name-1');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('persists the approval snapshot across close and reopen', () => {
  const { store, path, directory } = openTempStore();
  try {
    store.registerRepository(approvedRepo());
    store.close();
    const reopened = PatchPoolStore.open(path);
    try {
      const repo = reopened.getRepository('OCTO/EXAMPLE');
      assert.equal(repo.configDigest, 'sha256:config-v1');
      assert.deepEqual(repo.verificationArgv, ['npm', 'test']);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only one active claim can own a repository issue', () => {
  const { store, directory } = openTempStore();
  try {
    const repo = store.registerRepository(approvedRepo());
    const first = store.claimIssue({ repoId: repo.id, issueNumber: 7, workerId: 'worker-a' });
    assert.equal(first.state, 'claimed');
    assert.throws(
      () => store.claimIssue({ repoId: repo.id, issueNumber: 7, workerId: 'worker-b' }),
      error => error.code === 'CLAIM_EXISTS',
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('two store connections normalize concurrent ownership to one claim', async () => {
  const { store, path, directory } = openTempStore();
  const second = PatchPoolStore.open(path);
  try {
    const repo = store.registerRepository(approvedRepo());
    const workerUrl = pathToFileURL(join(process.cwd(), 'support', 'store-claim-worker.js')).href;
    const barrier = new SharedArrayBuffer(4);
    const results = await Promise.all(['worker-a', 'worker-b'].map(workerId => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(workerUrl), { workerData: { path, repoId: repo.id, workerId, barrier } });
      worker.once('message', resolve);
      worker.once('error', reject);
    })));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.code === 'CLAIM_EXISTS').length, 1);
    assert.equal(second.listRepositories().length, 1);
  } finally {
    store.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses claims for inactive and non-public repositories', () => {
  const { store, directory } = openTempStore();
  try {
    const inactive = store.registerRepository(approvedRepo({ fullName: 'octo/inactive', active: false }));
    assert.throws(() => store.claimIssue({ repoId: inactive.id, issueNumber: 1, workerId: 'worker-a' }), error => error.code === 'REPOSITORY_INACTIVE');
    assert.throws(() => store.registerRepository(approvedRepo({ fullName: 'octo/private-registration', public: false })), error => error.code === 'INVALID_REPOSITORY');
    const privateRepo = store.registerRepository(approvedRepo({ fullName: 'octo/private' }));
    store.db.prepare('UPDATE repositories SET is_public = 0 WHERE id = ?').run(privateRepo.id);
    assert.throws(() => store.claimIssue({ repoId: privateRepo.id, issueNumber: 1, workerId: 'worker-a' }), error => error.code === 'REPOSITORY_NOT_PUBLIC');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps canonical claim fields authoritative over metadata collisions', () => {
  const { store, directory } = openTempStore();
  try {
    const repo = store.registerRepository(approvedRepo());
    const claim = store.claimIssue({
      repoId: repo.id,
      issueNumber: 7,
      workerId: 'worker-a',
      fields: { id: 999, repoId: 999, issueNumber: 999, workerId: 'worker-b', state: 'completed' },
    });
    assert.deepEqual(
      { id: claim.id, repoId: claim.repoId, issueNumber: claim.issueNumber, workerId: claim.workerId, state: claim.state },
      { id: claim.id, repoId: repo.id, issueNumber: 7, workerId: 'worker-a', state: 'claimed' },
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validates claim transitions and records transition events', () => {
  const { store, directory } = openTempStore();
  try {
    const repo = store.registerRepository(approvedRepo());
    const claim = store.claimIssue({ repoId: repo.id, issueNumber: 7, workerId: 'worker-a' });
    const working = store.transitionClaim(claim.id, 'working', { branch: 'patch/7' });
    assert.equal(working.state, 'working');
    assert.equal(working.branch, 'patch/7');
    assert.throws(() => store.transitionClaim(claim.id, 'claimed'), error => error.code === 'INVALID_TRANSITION');
    const released = store.transitionClaim(claim.id, 'released', { reason: 'dry-run' });
    assert.equal(released.state, 'released');
    assert.equal(store.getClaim(claim.id).reason, 'dry-run');
    const replacement = store.claimIssue({ repoId: repo.id, issueNumber: 7, workerId: 'worker-b' });
    assert.equal(replacement.state, 'claimed');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('active running and verified claims prevent a different worker from taking the issue', () => {
  const { store, directory } = openTempStore();
  try {
    const repo = store.registerRepository(approvedRepo());
    const schema = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claims'").get().sql;
    assert.equal(/working|verifying|completed/.test(schema), false);
    const claim = store.claimIssue({ repoId: repo.id, issueNumber: 8, workerId: 'worker-a' });
    const running = store.transitionClaim(claim.id, 'running', { branch: 'patchpool/issue-8-1' });
    assert.equal(running.state, 'running');
    assert.throws(() => store.claimIssue({ repoId: repo.id, issueNumber: 8, workerId: 'worker-b' }), error => error.code === 'CLAIM_EXISTS');
    const verified = store.transitionClaim(claim.id, 'verified');
    assert.equal(verified.state, 'verified');
    assert.throws(() => store.claimIssue({ repoId: repo.id, issueNumber: 8, workerId: 'worker-b' }), error => error.code === 'CLAIM_EXISTS');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates a legacy working claim to running without allowing a duplicate worker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-legacy-'));
  const path = join(directory, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (1, 1);
    CREATE TABLE repositories (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL COLLATE NOCASE UNIQUE, active INTEGER NOT NULL DEFAULT 1, is_public INTEGER NOT NULL DEFAULT 1, config_digest TEXT NOT NULL, verification_argv TEXT NOT NULL, required_label TEXT, blocking_labels TEXT NOT NULL DEFAULT '[]', policy_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, issue_number INTEGER NOT NULL, worker_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('claimed','working','verifying','completed','failed','released')), fields_json TEXT NOT NULL DEFAULT '{}', claimed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX claims_one_active_issue ON claims(repo_id, issue_number) WHERE state IN ('claimed','working','verifying');
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    INSERT INTO repositories VALUES (1, 'octo/example', 1, 1, 'sha256:one', '["npm","test"]', NULL, '[]', '{}', '2026-01-01', '2026-01-01');
    INSERT INTO claims VALUES (1, 1, 11, 'worker-a', 'working', '{}', '2026-01-01', '2026-01-01');
  `);
  legacy.close();
  const store = PatchPoolStore.open(path);
  try {
    assert.equal(store.getClaim(1).state, 'running');
    assert.throws(() => store.claimIssue({ repoId: 1, issueNumber: 11, workerId: 'worker-b' }), error => error.code === 'CLAIM_EXISTS');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('execution leases serialize same-claim workers and recover after explicit release', () => {
  const { store, directory } = openTempStore();
  try {
    const repo = store.registerRepository(approvedRepo());
    const claim = store.claimIssue({ repoId: repo.id, issueNumber: 12, workerId: 'worker-a' });
    const first = store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 60_000 });
    assert.ok(first.token);
    assert.throws(() => store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 60_000 }), error => error.code === 'LEASE_BUSY');
    store.releaseExecutionLease(claim.id, 'worker-a', first.token);
    const second = store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 60_000 });
    assert.notEqual(second.token, first.token);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates released legacy claims to failed without exposing released in the new schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-released-'));
  const path = join(directory, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (1, 1);
    CREATE TABLE repositories (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL COLLATE NOCASE UNIQUE, active INTEGER NOT NULL DEFAULT 1, is_public INTEGER NOT NULL DEFAULT 1, config_digest TEXT NOT NULL, verification_argv TEXT NOT NULL, required_label TEXT, blocking_labels TEXT NOT NULL DEFAULT '[]', policy_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, issue_number INTEGER NOT NULL, worker_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('claimed','working','verifying','completed','failed','released')), fields_json TEXT NOT NULL DEFAULT '{}', claimed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX claims_one_active_issue ON claims(repo_id, issue_number) WHERE state IN ('claimed','working','verifying');
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    INSERT INTO repositories VALUES (1, 'octo/example', 1, 1, 'sha256:one', '["npm","test"]', NULL, '[]', '{}', '2026-01-01', '2026-01-01');
    INSERT INTO claims VALUES (1, 1, 13, 'worker-a', 'released', '{}', '2026-01-01', '2026-01-01');
  `);
  legacy.close();
  const store = PatchPoolStore.open(path);
  try {
    assert.equal(store.getClaim(1).state, 'failed');
    const schema = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claims'").get().sql;
    assert.equal(/released/.test(schema), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('renews a live execution lease and fences an expired token from state transitions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-lease-clock-'));
  const path = join(directory, 'state.sqlite');
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  const store = PatchPoolStore.open(path, {
    clock: () => currentTime,
    randomId: () => 'lease-token-one',
  });
  try {
    const repo = store.registerRepository(approvedRepo());
    const claim = store.claimIssue({ repoId: repo.id, issueNumber: 14, workerId: 'worker-a' });
    const lease = store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 100 });
    assert.equal(lease.expiresAt, '2026-01-01T00:00:00.100Z');

    currentTime += 75;
    const renewed = store.renewExecutionLease(claim.id, 'worker-a', lease.token, { ttlMs: 100 });
    assert.equal(renewed.expiresAt, '2026-01-01T00:00:00.175Z');
    store.assertExecutionLease(claim.id, 'worker-a', lease.token);

    currentTime += 101;
    assert.throws(
      () => store.assertExecutionLease(claim.id, 'worker-a', lease.token),
      error => error.code === 'LEASE_LOST',
    );
    assert.throws(
      () => store.transitionClaimWithLease(claim.id, 'running', { branch: 'stale' }, lease),
      error => error.code === 'LEASE_LOST',
    );
    assert.equal(store.getClaim(claim.id).state, 'claimed');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired lease holder cannot renew or overwrite after a replacement token is acquired', () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-lease-takeover-'));
  const path = join(directory, 'state.sqlite');
  let currentTime = 1_000;
  let tokenNumber = 0;
  const store = PatchPoolStore.open(path, {
    clock: () => currentTime,
    randomId: () => `lease-token-${++tokenNumber}`,
    isOwnerAlive: () => false,
  });
  try {
    const repo = store.registerRepository(approvedRepo());
    const claim = store.claimIssue({ repoId: repo.id, issueNumber: 15, workerId: 'worker-a' });
    const stale = store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 10 });
    currentTime += 11;
    const replacement = store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 100 });
    assert.notEqual(replacement.token, stale.token);
    assert.throws(
      () => store.renewExecutionLease(claim.id, 'worker-a', stale.token, { ttlMs: 100 }),
      error => error.code === 'LEASE_LOST',
    );
    assert.throws(
      () => store.transitionClaimWithLease(claim.id, 'running', { branch: 'stale' }, stale),
      error => error.code === 'LEASE_LOST',
    );
    const running = store.transitionClaimWithLease(claim.id, 'running', { branch: 'current' }, replacement);
    assert.equal(running.branch, 'current');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired lease cannot be taken over while its owner process session is alive', () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-live-owner-'));
  const path = join(directory, 'state.sqlite');
  let currentTime = 1_000;
  const checkedOwners = [];
  const store = PatchPoolStore.open(path, {
    clock: () => currentTime,
    randomId: () => 'live-owner-token',
    isOwnerAlive: owner => { checkedOwners.push(owner); return true; },
  });
  try {
    const repo = store.registerRepository(approvedRepo());
    const claim = store.claimIssue({ repoId: repo.id, issueNumber: 17, workerId: 'worker-a' });
    store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 10, ownerPid: 4321, ownerSessionId: 'session-one' });
    currentTime += 11;
    assert.throws(
      () => store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 100, ownerPid: 9876, ownerSessionId: 'session-two' }),
      error => error.code === 'LEASE_BUSY',
    );
    assert.deepEqual(checkedOwners, [{ pid: 4321, sessionId: 'session-one' }]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired lease can be recovered after its owner process is dead', () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-dead-owner-'));
  const path = join(directory, 'state.sqlite');
  let currentTime = 1_000;
  let token = 0;
  const store = PatchPoolStore.open(path, {
    clock: () => currentTime,
    randomId: () => `dead-owner-token-${++token}`,
    isOwnerAlive: () => false,
  });
  try {
    const repo = store.registerRepository(approvedRepo());
    const claim = store.claimIssue({ repoId: repo.id, issueNumber: 18, workerId: 'worker-a' });
    const stale = store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 10, ownerPid: 4321, ownerSessionId: 'session-one' });
    currentTime += 11;
    const replacement = store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 100, ownerPid: 9876, ownerSessionId: 'session-two' });
    assert.notEqual(replacement.token, stale.token);
    assert.equal(replacement.ownerPid, 9876);
    assert.equal(replacement.ownerSessionId, 'session-two');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired legacy lease without owner identity cannot be taken over automatically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-legacy-lease-owner-'));
  const path = join(directory, 'state.sqlite');
  let currentTime = 1_000;
  const checkedOwners = [];
  const store = PatchPoolStore.open(path, {
    clock: () => currentTime,
    randomId: () => 'replacement-token',
    isOwnerAlive: owner => { checkedOwners.push(owner); return false; },
  });
  try {
    const repo = store.registerRepository(approvedRepo());
    const claim = store.claimIssue({ repoId: repo.id, issueNumber: 19, workerId: 'worker-a' });
    store.db.prepare(`
      INSERT INTO execution_leases (claim_id, worker_id, token, acquired_at, expires_at, owner_pid, owner_session_id)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `).run(claim.id, 'worker-a', 'legacy-token', new Date(900).toISOString(), new Date(999).toISOString());

    assert.throws(
      () => store.acquireExecutionLease(claim.id, 'worker-a', { ttlMs: 100, ownerPid: 9876, ownerSessionId: 'session-two' }),
      error => error.code === 'LEASE_BUSY',
    );
    assert.deepEqual(checkedOwners, []);
    assert.equal(store.db.prepare('SELECT token FROM execution_leases WHERE claim_id = ?').get(claim.id).token, 'legacy-token');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy workflow migration leaves execution lease foreign keys pointing at claims', () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-legacy-lease-fk-'));
  const path = join(directory, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (1, 1);
    CREATE TABLE repositories (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL COLLATE NOCASE UNIQUE, active INTEGER NOT NULL DEFAULT 1, is_public INTEGER NOT NULL DEFAULT 1, config_digest TEXT NOT NULL, verification_argv TEXT NOT NULL, required_label TEXT, blocking_labels TEXT NOT NULL DEFAULT '[]', policy_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, issue_number INTEGER NOT NULL, worker_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('claimed','working','verifying','completed','failed','released')), fields_json TEXT NOT NULL DEFAULT '{}', claimed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX claims_one_active_issue ON claims(repo_id, issue_number) WHERE state IN ('claimed','working','verifying');
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id INTEGER NOT NULL, event_type TEXT NOT NULL DEFAULT 'claimed', payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE execution_leases (claim_id INTEGER PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE, worker_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    INSERT INTO repositories VALUES (1, 'octo/example', 1, 1, 'sha256:one', '["npm","test"]', NULL, '[]', '{}', '2026-01-01', '2026-01-01');
    INSERT INTO claims VALUES (1, 1, 16, 'worker-a', 'working', '{}', '2026-01-01', '2026-01-01');
  `);
  legacy.close();

  const store = PatchPoolStore.open(path);
  try {
    const foreignKeys = store.db.prepare('PRAGMA foreign_key_list(execution_leases)').all();
    assert.deepEqual(foreignKeys.map(key => key.table), ['claims']);
    const lease = store.acquireExecutionLease(1, 'worker-a', { ttlMs: 1_000 });
    assert.ok(lease.token);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
