import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
