import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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

function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('doctor inspects an existing state database read-only without creating or migrating schema', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-doctor-existing-'));
  const dbPath = join(directory, 'state.sqlite');
  const database = new DatabaseSync(dbPath);
  database.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('unchanged')");
  database.close();
  const before = fileDigest(dbPath);
  const calls = [];
  const output = [];
  try {
    const result = await main(['doctor', '--json'], {
      dbPath,
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
    assert.deepEqual(result.checks.stateDatabase, {
      ok: true,
      path: dbPath,
      exists: true,
      writable: true,
      openable: true,
      integrity: 'ok',
    });
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
    assert.equal(fileDigest(dbPath), before);
    const inspected = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['sentinel']);
    inspected.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('doctor validates a missing state path through its parent without creating the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-doctor-missing-'));
  const dbPath = join(directory, 'state.sqlite');
  try {
    const result = await main(['doctor', '--json'], {
      dbPath,
      nodeVersion: '24.15.0',
      ...authenticatedDependencies(),
      stdout() {},
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.checks.stateDatabase, {
      ok: true,
      path: dbPath,
      exists: false,
      writable: true,
      openable: true,
      creatable: true,
    });
    assert.equal(existsSync(dbPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('doctor aggregates an invalid state parent instead of throwing or creating it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-doctor-parent-'));
  const missingParent = join(directory, 'missing-parent');
  const dbPath = join(missingParent, 'state.sqlite');
  const output = [];
  try {
    const result = await main(['doctor', '--json'], {
      dbPath,
      nodeVersion: '24.15.0',
      ...authenticatedDependencies(),
      stdout: value => output.push(value),
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.checks.stateDatabase.ok, false);
    assert.equal(result.checks.stateDatabase.code, 'STATE_DATABASE_PARENT_UNAVAILABLE');
    assert.deepEqual(JSON.parse(output.join('')), result);
    assert.equal(existsSync(missingParent), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('doctor reports all failed checks with a nonzero suggested exit code', async () => {
  const output = [];
  const result = await main(['doctor', '--json'], {
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
});

test('doctor CLI emits aggregated JSON and exits nonzero for an invalid state parent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-doctor-cli-'));
  const missingParent = join(directory, 'missing-parent');
  const dbPath = join(missingParent, 'state.sqlite');
  try {
    const result = spawnSync(process.execPath, ['bin/patchpool.js', 'doctor', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, PATCHPOOL_DB: dbPath },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.checks.stateDatabase.code, 'STATE_DATABASE_PARENT_UNAVAILABLE');
    assert.equal(existsSync(missingParent), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
        calls.push({ workerTimeout: input.approvedTimeoutMs });
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
