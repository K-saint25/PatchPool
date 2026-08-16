import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PatchPoolStore } from '../src/store.js';
import { main } from '../src/cli.js';

function memoryStore() {
  return PatchPoolStore.open(':memory:');
}

function authenticatedDependencies(calls = []) {
  return {
    github: {
      async preflight() {
        calls.push('github.preflight');
        return { authenticated: true };
      },
    },
    codex: {
      async preflight() {
        calls.push('codex.preflight');
        return { authenticated: true, provider: 'ChatGPT' };
      },
    },
    runner: {
      async run(command, args) {
        calls.push([command, ...args]);
        if (command === 'git' && args.join(' ') === 'config --get user.name') {
          return { exitCode: 0, stdout: 'Patch Pool Operator\n', stderr: '' };
        }
        if (command === 'git' && args.join(' ') === 'config --get user.email') {
          return { exitCode: 0, stdout: 'operator@example.test\n', stderr: '' };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    },
  };
}

test('doctor --json reports Node, auth, Git identity, state DB, and intentionally disabled signing', async () => {
  const store = memoryStore();
  const calls = [];
  const output = [];
  try {
    const result = await main(['doctor', '--json'], {
      store,
      nodeVersion: '24.15.0',
      ...authenticatedDependencies(calls),
      stdout: value => output.push(value),
      workflow: { async run() { throw new Error('doctor must not run a workflow'); } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.checks.node, { ok: true, version: '24.15.0', minimumMajor: 24 });
    assert.deepEqual(result.checks.github, { ok: true, authenticated: true });
    assert.deepEqual(result.checks.codex, { ok: true, authenticated: true, provider: 'ChatGPT' });
    assert.deepEqual(result.checks.gitIdentity, {
      ok: true,
      name: 'Patch Pool Operator',
      email: 'operator@example.test',
    });
    assert.deepEqual(result.checks.stateDatabase, { ok: true, path: ':memory:', writable: true, openable: true });
    assert.deepEqual(result.checks.commitSigning, {
      ok: true,
      enabled: false,
      mode: 'disabled-by-worker',
    });
    assert.deepEqual(JSON.parse(output.join('')), result);
    assert.deepEqual(calls, [
      'github.preflight',
      'codex.preflight',
      ['git', 'config', '--get', 'user.name'],
      ['git', 'config', '--get', 'user.email'],
    ]);
    assert.equal(store.listRepositories().length, 0);
  } finally {
    store.close();
  }
});

test('doctor reports all failed checks with a nonzero suggested exit code', async () => {
  const store = memoryStore();
  const output = [];
  try {
    const result = await main(['doctor', '--json'], {
      store,
      dbPath: ':memory:',
      nodeVersion: '23.9.0',
      github: { async preflight() { throw Object.assign(new Error('no gh auth'), { code: 'GITHUB_COMMAND_FAILED' }); } },
      codex: { async preflight() { throw Object.assign(new Error('API key is not eligible'), { code: 'CODEX_AUTH_REQUIRED' }); } },
      runner: { async run() { return { exitCode: 1, stdout: '', stderr: '' }; } },
      stdout: value => output.push(value),
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.checks.node.ok, false);
    assert.equal(result.checks.github.code, 'GITHUB_COMMAND_FAILED');
    assert.equal(result.checks.codex.code, 'CODEX_AUTH_REQUIRED');
    assert.equal(result.checks.gitIdentity.ok, false);
    assert.equal(result.checks.stateDatabase.ok, true);
    assert.equal(JSON.parse(output.join('')).ok, false);
  } finally {
    store.close();
  }
});

test('--help prints usage without opening the state database', async () => {
  const output = [];
  const impossiblePath = join(tmpdir(), 'patchpool-help-must-not-open', 'state.sqlite');
  const result = await main(['--help'], { dbPath: impossiblePath, stdout: value => output.push(value) });
  assert.equal(result.command, 'help');
  assert.match(output.join(''), /patchpool doctor \[--json\]/);
  assert.match(output.join(''), /patchpool repo add/);
  assert.match(output.join(''), /patchpool e2e --repo K-saint25\/PatchPool .*--publish/);
});

test('manual e2e rejects every repository except the exact owner-controlled target', async () => {
  const store = memoryStore();
  let workflowCalls = 0;
  try {
    await assert.rejects(
      () => main(['e2e', '--repo', 'k-saint25/patchpool', '--publish'], {
        store,
        stdout() {},
        workflow: { async run() { workflowCalls += 1; } },
      }),
      error => error.code === 'E2E_REPOSITORY_GUARD',
    );
    assert.equal(workflowCalls, 0);
  } finally {
    store.close();
  }
});

test('manual e2e requires explicit --publish before workflow dispatch', async () => {
  const store = memoryStore();
  let workflowCalls = 0;
  try {
    await assert.rejects(
      () => main(['e2e', '--repo', 'K-saint25/PatchPool'], {
        store,
        stdout() {},
        workflow: { async run() { workflowCalls += 1; } },
      }),
      error => error.code === 'E2E_PUBLISH_REQUIRED',
    );
    assert.equal(workflowCalls, 0);
  } finally {
    store.close();
  }
});

test('manual e2e dispatches the exact target in publish mode and applies its approved timeout', async () => {
  const store = memoryStore();
  const calls = [];
  try {
    store.registerRepository({
      fullName: 'K-saint25/PatchPool',
      configDigest: 'sha256:approved',
      verificationArgv: [process.execPath, '--test'],
      policy: { approvedConfig: { verifyCommand: ['npm', 'test'], requiredIssueLabel: 'patchpool-ready', timeoutMinutes: 30 } },
    });
    const result = await main(['e2e', '--repo', 'K-saint25/PatchPool', '--issue', '7', '--publish'], {
      store,
      stdout() {},
      ...authenticatedDependencies(),
      workflowFactory(input) {
        calls.push({ workerTimeout: input.codexTimeoutMs });
        return {
          async run(runInput) {
            calls.push(runInput);
            return { state: 'pr_opened', prUrl: 'https://github.com/K-saint25/PatchPool/pull/1' };
          },
        };
      },
    });
    assert.equal(result.state, 'pr_opened');
    assert.deepEqual(calls, [
      { workerTimeout: 30 * 60 * 1_000 },
      { repo: 'K-saint25/PatchPool', issueNumber: 7, publish: true, keepWorkspace: false },
    ]);
  } finally {
    store.close();
  }
});

test('ordinary run still supports any approved public repository', async () => {
  const store = memoryStore();
  const calls = [];
  try {
    store.registerRepository({ fullName: 'octo/other-public', configDigest: 'sha256:approved', verificationArgv: [process.execPath, '--test'] });
    await main(['run', '--repo', 'octo/other-public'], {
      store,
      stdout() {},
      ...authenticatedDependencies(),
      workflow: { async run(input) { calls.push(input); return { state: 'verified' }; } },
    });
    assert.deepEqual(calls, [{ repo: 'octo/other-public', issueNumber: undefined, publish: false, keepWorkspace: false }]);
  } finally {
    store.close();
  }
});
