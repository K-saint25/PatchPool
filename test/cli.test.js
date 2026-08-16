import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PatchPoolStore } from '../src/store.js';
import { main, resolveWorkerId } from '../src/cli.js';
import { digestApprovedRepositoryConfig } from '../src/config.js';

function memoryStore() {
  return PatchPoolStore.open(':memory:');
}

function writeApprovedConfig(directory, verifyCommand = [process.execPath, '--test']) {
  const configPath = join(directory, '.patchpool.json');
  writeFileSync(configPath, JSON.stringify({
    verifyCommand,
    requiredIssueLabel: 'patchpool-ready',
    timeoutMinutes: 30,
  }));
  return configPath;
}

function eligibleGitHub(calls = []) {
  return {
    async getRepository(fullName) {
      calls.push(fullName);
      return { fullName, public: true, archived: false, defaultBranch: 'main' };
    },
  };
}

function approvedRepositoryInput(overrides = {}) {
  const approvedConfig = {
    verifyCommand: [process.execPath, '--test'],
    requiredIssueLabel: 'patchpool-ready',
    timeoutMinutes: 30,
  };
  return {
    fullName: 'octo/example',
    configDigest: digestApprovedRepositoryConfig(approvedConfig),
    verificationArgv: [...approvedConfig.verifyCommand],
    requiredLabel: approvedConfig.requiredIssueLabel,
    policy: { approvedConfig },
    ...overrides,
  };
}

test('repo add registers an approved repository and reports JSON', async () => {
  const store = memoryStore();
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-cli-add-'));
  const configPath = writeApprovedConfig(directory);
  const output = [];
  try {
    const result = await main(['repo', 'add', '--repo', 'octo/example', '--config', configPath], {
      store,
      github: eligibleGitHub(),
      stdout: value => output.push(value),
    });
    assert.equal(result.fullName, 'octo/example');
    assert.deepEqual(JSON.parse(output.join('')), { ...result });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repo add loads and persists an approved config snapshot without a caller-provided digest', async () => {
  const store = memoryStore();
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-cli-config-'));
  const configPath = join(directory, '.patchpool.json');
  writeFileSync(configPath, JSON.stringify({
    verifyCommand: [process.execPath, '--test'],
    requiredIssueLabel: 'patchpool-ready',
    timeoutMinutes: 30,
  }));
  try {
    const result = await main(['repo', 'add', '--repo', 'octo/configured', '--config', configPath], {
      store,
      github: eligibleGitHub(),
      stdout() {},
    });
    assert.match(result.configDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(result.verificationArgv, [process.execPath, '--test']);
    assert.equal(result.requiredLabel, 'patchpool-ready');
    assert.deepEqual(result.policy.approvedConfig, {
      verifyCommand: [process.execPath, '--test'],
      requiredIssueLabel: 'patchpool-ready',
      timeoutMinutes: 30,
    });
    assert.deepEqual(Object.keys(result.policy), ['approvedConfig']);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repo add safely reapproves a legacy registration after repeating GitHub eligibility', async () => {
  const store = memoryStore();
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-cli-reapprove-'));
  const configPath = writeApprovedConfig(directory);
  const calls = [];
  try {
    const original = store.registerRepository({
      fullName: 'octo/reapprove',
      configDigest: 'sha256:legacy',
      verificationArgv: ['legacy'],
      requiredLabel: 'legacy',
      policy: {},
      active: false,
    });
    const updated = await main(['repo', 'add', '--repo', 'octo/reapprove', '--config', configPath], {
      store,
      github: eligibleGitHub(calls),
      stdout() {},
    });

    assert.deepEqual(calls, ['octo/reapprove']);
    assert.equal(updated.id, original.id);
    assert.equal(updated.active, true);
    assert.match(updated.configDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(updated.policy.approvedConfig, {
      verifyCommand: [process.execPath, '--test'],
      requiredIssueLabel: 'patchpool-ready',
      timeoutMinutes: 30,
    });
    assert.equal(store.listRepositories().length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repo add defaults to the repository cwd .patchpool.json without caller approval fields', async () => {
  const store = memoryStore();
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-cli-default-config-'));
  writeApprovedConfig(directory);
  try {
    const result = await main(['repo', 'add', '--repo', 'octo/default'], {
      store,
      cwd: directory,
      github: eligibleGitHub(),
      stdout() {},
    });
    assert.deepEqual(result.verificationArgv, [process.execPath, '--test']);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repo add rejects legacy caller-provided digest and verification argv approval bypasses', async () => {
  const store = memoryStore();
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-cli-legacy-config-'));
  const configPath = writeApprovedConfig(directory);
  const calls = [];
  try {
    for (const legacyOption of [
      ['--config-digest', 'sha256:caller'],
      ['--verification-argv', '["node","--test"]'],
    ]) {
      await assert.rejects(
        () => main([
          'repo', 'add', '--repo', 'octo/legacy', '--config', configPath, ...legacyOption,
        ], { store, github: eligibleGitHub(calls), stdout() {} }),
        error => error.code === 'INVALID_ARGS',
      );
    }
    assert.deepEqual(calls, []);
    assert.equal(store.listRepositories().length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repo add verifies the exact canonical public non-archived repository before persistence', async () => {
  const store = memoryStore();
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-cli-remote-approval-'));
  const configPath = writeApprovedConfig(directory);
  const calls = [];
  try {
    await assert.rejects(
      () => main(['repo', 'add', '--repo', 'octo/rejected', '--config', configPath], {
        store,
        github: {
          async getRepository(fullName) {
            calls.push(fullName);
            throw Object.assign(new Error('not canonical public active'), { code: 'GITHUB_REPOSITORY_INELIGIBLE' });
          },
        },
        stdout() {},
      }),
      error => error.code === 'GITHUB_REPOSITORY_INELIGIBLE',
    );
    assert.deepEqual(calls, ['octo/rejected']);
    assert.equal(store.listRepositories().length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
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
    store.registerRepository(approvedRepositoryInput({ fullName: 'octo/composed' }));
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

test('CLI run rejects a legacy repository before composing or invoking a workflow', async () => {
  const store = memoryStore();
  let workflowCalls = 0;
  try {
    store.registerRepository({ fullName: 'octo/legacy', configDigest: 'sha256:legacy', verificationArgv: ['node', '--test'] });
    await assert.rejects(
      () => main(['run', '--repo', 'octo/legacy'], {
        store,
        stdout() {},
        workflowFactory() {
          workflowCalls += 1;
          return { async run() { workflowCalls += 1; } };
        },
      }),
      error => error.code === 'REPOSITORY_REAPPROVAL_REQUIRED' && /repo add.*--config/i.test(error.message),
    );
    assert.equal(workflowCalls, 0);
  } finally {
    store.close();
  }
});

test('repo list --json prints all registered repositories as JSON', async () => {
  const store = memoryStore();
  const output = [];
  try {
    store.registerRepository(approvedRepositoryInput());
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
    const repository = store.registerRepository(approvedRepositoryInput());
    const claim = await main(['claim', '--repo', 'octo/example', '--issue', '7', '--worker', 'worker-a'], {
      store,
      stdout: value => output.push(value),
    });
    assert.equal(claim.issueNumber, 7);
    assert.equal(claim.approvalConfigDigest, repository.configDigest);
    assert.equal(JSON.parse(output.join('')).workerId, 'worker-a');
  } finally {
    store.close();
  }
});

test('claim rejects legacy, malformed, argv-mismatched, and tampered approvals without creating a claim', async () => {
  const approved = approvedRepositoryInput();
  const invalidRepositories = [
    { ...approved, fullName: 'octo/legacy', policy: {} },
    {
      ...approved,
      fullName: 'octo/malformed',
      policy: { approvedConfig: { ...approved.policy.approvedConfig, timeoutMinutes: 0 } },
    },
    { ...approved, fullName: 'octo/argv-mismatch', verificationArgv: ['node', '--version'] },
    { ...approved, fullName: 'octo/tampered', configDigest: 'sha256:tampered' },
  ];
  for (const repository of invalidRepositories) {
    const store = memoryStore();
    try {
      store.registerRepository(repository);
      await assert.rejects(
        () => main(['claim', '--repo', repository.fullName, '--issue', '7', '--worker', 'worker-a'], { store, stdout() {} }),
        error => error.code === 'REPOSITORY_REAPPROVAL_REQUIRED',
      );
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM claims').get().count, 0);
    } finally {
      store.close();
    }
  }
});

test('repo add rejects the private-registration path', async () => {
  const store = memoryStore();
  try {
    await assert.rejects(
      () => main(['repo', 'add', '--repo', 'octo/private', '--private'], { store, stdout() {} }),
      error => error.code === 'INVALID_ARGS',
    );
  } finally {
    store.close();
  }
});

test('claim rejects an inactive registered repository', async () => {
  const store = memoryStore();
  try {
    store.registerRepository(approvedRepositoryInput({ fullName: 'octo/inactive', active: false }));
    await assert.rejects(
      () => main(['claim', '--repo', 'octo/inactive', '--issue', '7', '--worker', 'worker-a'], { store, stdout() {} }),
      error => error.code === 'REPOSITORY_INACTIVE',
    );
  } finally {
    store.close();
  }
});
