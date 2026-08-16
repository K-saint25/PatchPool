import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { PatchPoolStore } from '../src/store.js';
import { HELP, main, resolveWorkerId } from '../src/cli.js';
import { digestApprovedRepositoryConfig } from '../src/config.js';

function memoryStore() {
  return PatchPoolStore.open(':memory:');
}

function fileSnapshot(path) {
  return {
    bytes: readFileSync(path),
    mtimeNs: statSync(path, { bigint: true }).mtimeNs,
  };
}

function schemaVersion(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare('SELECT version FROM schema_meta WHERE id = 1').get()?.version;
  } finally {
    database.close();
  }
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

test('CLI run passes a valid model from the injected environment to Codex', async () => {
  const store = memoryStore();
  let selectedModel;
  try {
    store.registerRepository(approvedRepositoryInput({ fullName: 'octo/modelled' }));
    await main(['run', '--repo', 'octo/modelled'], {
      store,
      environment: {
        PATCHPOOL_CODEX_MODEL: 'gpt-5.6-luna',
        PATCHPOOL_WORKER_ID: 'worker-model-test',
      },
      stdout() {},
      workflowFactory(input) {
        selectedModel = input.codex.options.model;
        return { run: async () => ({ state: 'verified' }) };
      },
    });
    assert.equal(selectedModel, 'gpt-5.6-luna');
  } finally {
    store.close();
  }
});

test('CLI run rejects an invalid injected model before creating a workflow', async () => {
  for (const model of ['gpt/model', '.hidden', 'a'.repeat(101)]) {
    const store = memoryStore();
    let workflowCalls = 0;
    try {
      store.registerRepository(approvedRepositoryInput({ fullName: 'octo/invalid-model' }));
      await assert.rejects(
        () => main(['run', '--repo', 'octo/invalid-model'], {
          store,
          environment: { PATCHPOOL_CODEX_MODEL: model, PATCHPOOL_WORKER_ID: 'worker-model-test' },
          stdout() {},
          workflowFactory() {
            workflowCalls += 1;
            return { run: async () => ({ state: 'verified' }) };
          },
        }),
        error => error.code === 'INVALID_CODEX_MODEL',
      );
      assert.equal(workflowCalls, 0);
    } finally {
      store.close();
    }
  }
});

test('CLI rejects an invalid model before creating the state database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-cli-invalid-model-db-'));
  const dbPath = join(directory, 'state.sqlite');
  try {
    assert.equal(existsSync(dbPath), false);
    await assert.rejects(
      () => main(['run', '--repo', 'octo/no-state'], {
        dbPath,
        environment: { PATCHPOOL_CODEX_MODEL: 'gpt/unsafe' },
        stdout() {},
      }),
      error => error.code === 'INVALID_CODEX_MODEL',
    );
    assert.equal(existsSync(dbPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
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

test('claim list --json emits the read-only sanitized claim view', async () => {
  const store = memoryStore();
  const output = [];
  try {
    const repository = store.registerRepository(approvedRepositoryInput());
    const claim = store.claimIssue({ repoId: repository.id, issueNumber: 7, workerId: 'worker-a', expectedConfigDigest: repository.configDigest });
    store.transitionClaim(claim.id, 'running', { branch: 'patchpool/issue-7-1', workspace: 'C:\\work', secret: 'hidden' });
    const before = store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count;

    const result = await main(['claim', 'list', '--json'], { store, stdout: value => output.push(value) });

    assert.deepEqual(result, store.listClaims());
    assert.deepEqual(JSON.parse(output.join('')), result);
    assert.deepEqual(Object.keys(result[0]), [
      'id', 'repoId', 'repositoryFullName', 'issueNumber', 'workerId', 'state', 'branch',
      'workspace', 'commitSha', 'prUrl', 'errorCode', 'claimedAt', 'updatedAt',
    ]);
    assert.equal(JSON.stringify(result).includes('hidden'), false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, before);
  } finally {
    store.close();
  }
});

test('claim list requires JSON and rejects unsupported arguments', async () => {
  for (const argv of [
    ['claim', 'list'],
    ['claim', 'list', '--repo', 'octo/example'],
    ['claim', 'list', '--unknown', 'value'],
    ['claim', 'list', '--private'],
    ['claim', 'list', 'unexpected', '--json'],
  ]) {
    const store = memoryStore();
    try {
      await assert.rejects(
        () => main(argv, { store, stdout() {} }),
        error => error.code === 'INVALID_ARGS' && /claim list/i.test(error.message),
      );
    } finally {
      store.close();
    }
  }
});

test('claim list returns an empty array for missing state without creating it or validating a model', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-claim-list-missing-'));
  const dbPath = join(directory, 'state.sqlite');
  const output = [];
  try {
    const result = await main(['claim', 'list', '--json'], {
      dbPath,
      environment: { PATCHPOOL_CODEX_MODEL: 'invalid/model' },
      stdout: value => output.push(value),
    });
    assert.deepEqual(result, []);
    assert.deepEqual(JSON.parse(output.join('')), []);
    assert.equal(existsSync(dbPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('claim list reads a current state database without changing bytes, mtime, or schema metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-claim-list-current-'));
  const dbPath = join(directory, 'state.sqlite');
  const state = PatchPoolStore.open(dbPath);
  const repository = state.registerRepository(approvedRepositoryInput());
  state.claimIssue({ repoId: repository.id, issueNumber: 12, workerId: 'worker-read-only', expectedConfigDigest: repository.configDigest });
  state.close();
  const before = fileSnapshot(dbPath);
  try {
    const result = await main(['claim', 'list', '--json'], {
      dbPath,
      environment: { PATCHPOOL_CODEX_MODEL: 'invalid/model' },
      stdout() {},
    });
    assert.equal(result[0].issueNumber, 12);
    assert.equal(schemaVersion(dbPath), 1);
    assert.deepEqual(fileSnapshot(dbPath), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('claim list rejects legacy state without migrating or changing it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-claim-list-legacy-'));
  const dbPath = join(directory, 'state.sqlite');
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (1, 1);
    CREATE TABLE repositories (
      id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, active INTEGER NOT NULL,
      is_public INTEGER NOT NULL, config_digest TEXT NOT NULL, verification_argv TEXT NOT NULL,
      required_label TEXT, blocking_labels TEXT NOT NULL, policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO repositories VALUES (1, 'octo/legacy', 1, 1, 'sha256:legacy', '[]', NULL, '[]', '{}', 'before', 'before');
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, issue_number INTEGER NOT NULL,
      worker_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('claimed','working','verifying','completed','failed','released')),
      fields_json TEXT NOT NULL, claimed_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO claims VALUES (1, 1, 3, 'worker-legacy', 'working', '{}', 'before', 'before');
    CREATE TABLE events (id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE execution_leases (claim_id INTEGER PRIMARY KEY, worker_id TEXT NOT NULL, token TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  `);
  database.close();
  const before = fileSnapshot(dbPath);
  try {
    await assert.rejects(
      () => main(['claim', 'list', '--json'], { dbPath, stdout() {} }),
      error => error.code === 'STATE_DATABASE_INCOMPATIBLE',
    );
    assert.equal(schemaVersion(dbPath), 1);
    assert.deepEqual(fileSnapshot(dbPath), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('claim list rejects future, arbitrary, and malformed databases without changing them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-claim-list-invalid-'));
  const futurePath = join(directory, 'future.sqlite');
  const future = PatchPoolStore.open(futurePath);
  future.close();
  const futureWriter = new DatabaseSync(futurePath);
  futureWriter.prepare('UPDATE schema_meta SET version = 99 WHERE id = 1').run();
  futureWriter.close();
  const arbitraryPath = join(directory, 'arbitrary.sqlite');
  const arbitrary = new DatabaseSync(arbitraryPath);
  arbitrary.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
  arbitrary.close();
  const malformedPath = join(directory, 'malformed.sqlite');
  writeFileSync(malformedPath, 'not a SQLite database');
  try {
    for (const dbPath of [futurePath, arbitraryPath, malformedPath]) {
      const before = fileSnapshot(dbPath);
      await assert.rejects(
        () => main(['claim', 'list', '--json'], { dbPath, stdout() {} }),
        error => error.code === 'STATE_DATABASE_INCOMPATIBLE',
      );
      assert.deepEqual(fileSnapshot(dbPath), before);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('help documents the JSON claim list command', () => {
  assert.match(HELP, /patchpool claim list --json/);
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
