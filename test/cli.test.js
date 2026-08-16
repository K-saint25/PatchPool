import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchPoolStore } from '../src/store.js';
import { main, resolveWorkerId } from '../src/cli.js';

function memoryStore() {
  return PatchPoolStore.open(':memory:');
}

test('repo add registers an approved repository and reports JSON', async () => {
  const store = memoryStore();
  const output = [];
  try {
    const result = await main([
      'repo', 'add', '--repo', 'octo/example', '--config-digest', 'sha256:one',
      '--verification-argv', '["npm","test"]', '--required-label', 'patchpool-ready',
    ], { store, stdout: value => output.push(value) });
    assert.equal(result.fullName, 'octo/example');
    assert.deepEqual(JSON.parse(output.join('')), { ...result });
  } finally {
    store.close();
  }
});

test('repo add defaults verification to the Windows-safe Node test executable', async () => {
  const store = memoryStore();
  try {
    const result = await main(['repo', 'add', '--repo', 'octo/default', '--config-digest', 'sha256:one'], { store, stdout() {} });
    assert.deepEqual(result.verificationArgv, [process.execPath, '--test']);
  } finally {
    store.close();
  }
});

test('CLI compositions reuse a stable worker ID across runs', async () => {
  const first = resolveWorkerId({ PATCHPOOL_WORKER_ID: '' , COMPUTERNAME: 'machine-a', USERNAME: 'operator' });
  const second = resolveWorkerId({ PATCHPOOL_WORKER_ID: '' , COMPUTERNAME: 'machine-a', USERNAME: 'operator' });
  assert.equal(first, second);
  assert.match(first, /^worker-[a-f0-9]{16}$/);
});

test('two CLI run compositions pass the same worker ID to the workflow', async () => {
  const store = memoryStore();
  const ids = [];
  try {
    store.registerRepository({ fullName: 'octo/composed', configDigest: 'sha256:one', verificationArgv: ['npm', 'test'] });
    const options = {
      store,
      environment: { PATCHPOOL_WORKER_ID: '', COMPUTERNAME: 'machine-b', USERNAME: 'operator' },
      stdout() {},
      workflowFactory: input => { ids.push(input.workerId); return { run: async () => ({ state: 'verified' }) }; },
    };
    await main(['run', '--repo', 'octo/composed'], options);
    await main(['run', '--repo', 'octo/composed'], options);
    assert.equal(ids[0], ids[1]);
  } finally {
    store.close();
  }
});

test('repo list --json prints all registered repositories as JSON', async () => {
  const store = memoryStore();
  const output = [];
  try {
    store.registerRepository({ fullName: 'octo/example', configDigest: 'sha256:one', verificationArgv: ['npm', 'test'] });
    await main(['repo', 'list', '--json'], { store, stdout: value => output.push(value) });
    assert.deepEqual(JSON.parse(output.join('')).map(repo => repo.fullName), ['octo/example']);
  } finally {
    store.close();
  }
});

test('claim validates required repository, issue, and worker arguments', async () => {
  const store = memoryStore();
  try {
    await assert.rejects(
      () => main(['claim', '--repo', 'octo/example'], { store, stdout() {} }),
      error => error.code === 'INVALID_ARGS',
    );
  } finally {
    store.close();
  }
});

test('claim resolves the repository and creates an issue claim', async () => {
  const store = memoryStore();
  const output = [];
  try {
    store.registerRepository({ fullName: 'octo/example', configDigest: 'sha256:one', verificationArgv: ['npm', 'test'] });
    const claim = await main(['claim', '--repo', 'octo/example', '--issue', '7', '--worker', 'worker-a'], {
      store,
      stdout: value => output.push(value),
    });
    assert.equal(claim.issueNumber, 7);
    assert.equal(JSON.parse(output.join('')).workerId, 'worker-a');
  } finally {
    store.close();
  }
});

test('repo add rejects the private-registration path', async () => {
  const store = memoryStore();
  try {
    await assert.rejects(
      () => main(['repo', 'add', '--repo', 'octo/private', '--private', '--config-digest', 'sha256:one'], { store, stdout() {} }),
      error => error.code === 'INVALID_ARGS',
    );
  } finally {
    store.close();
  }
});

test('claim rejects an inactive registered repository', async () => {
  const store = memoryStore();
  try {
    store.registerRepository({ fullName: 'octo/inactive', active: false, configDigest: 'sha256:one', verificationArgv: ['npm', 'test'] });
    await assert.rejects(
      () => main(['claim', '--repo', 'octo/inactive', '--issue', '7', '--worker', 'worker-a'], { store, stdout() {} }),
      error => error.code === 'REPOSITORY_INACTIVE',
    );
  } finally {
    store.close();
  }
});
