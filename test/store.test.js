import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
