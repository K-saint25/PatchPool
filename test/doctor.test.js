import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { formatDoctor, runDoctor } from '../src/doctor.js';
import { GitHubClient } from '../src/github.js';
import { CodexClient } from '../src/codex.js';

function authenticatedDependencies() {
  return {
    github: { async preflight() { return { authenticated: true }; } },
    codex: { async preflight() { return { authenticated: true, provider: 'ChatGPT' }; } },
    runner: {
      async run(_command, args) {
        return {
          exitCode: 0,
          stdout: args.at(-1) === 'user.name' ? 'Patch Pool Operator\n' : 'operator@example.test\n',
          stderr: '',
        };
      },
    },
  };
}

test('doctor reports an invalid state parent with its absolute path and actionable guidance without creating it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-doctor-guidance-'));
  const relativePath = join(directory, 'missing-parent', '..', 'missing-parent', 'state.sqlite');
  const missingParent = join(directory, 'missing-parent');
  try {
    const result = await runDoctor({
      dbPath: relativePath,
      nodeVersion: '24.15.0',
      ...authenticatedDependencies(),
    });

    assert.deepEqual(result.checks.stateDatabase, {
      ok: false,
      code: 'STATE_DATABASE_PARENT_UNAVAILABLE',
      path: resolve(relativePath),
      message: 'The state database parent directory is unavailable or not writable.',
      hint: 'Create the parent directory or choose a writable PATCHPOOL_DB path, then rerun PatchPool doctor.',
    });
    const human = formatDoctor(result);
    assert.match(human, new RegExp(resolve(relativePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(human, /Hint: Create the parent directory or choose a writable PATCHPOOL_DB path/);
    assert.equal(existsSync(missingParent), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('doctor gives fixed actionable diagnostics for every failing readiness check', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-doctor-all-failures-'));
  const dbPath = join(directory, 'missing-parent', 'state.sqlite');
  try {
    const result = await runDoctor({
      dbPath,
      nodeVersion: '23.9.0',
      github: { async preflight() { throw Object.assign(new Error('untrusted'), { code: 'GITHUB_COMMAND_FAILED' }); } },
      codex: { async preflight() { throw Object.assign(new Error('untrusted'), { code: 'CODEX_AUTH_REQUIRED' }); } },
      runner: { async run() { return { exitCode: 1, stdout: '', stderr: '' }; } },
    });

    assert.deepEqual(result.checks.node, {
      ok: false,
      code: 'NODE_VERSION_UNSUPPORTED',
      version: '23.9.0',
      minimumMajor: 24,
      message: 'Node.js 24 or newer is required.',
      hint: 'Install Node.js 24 or newer, then rerun PatchPool doctor.',
    });
    assert.deepEqual(result.checks.github, {
      ok: false,
      code: 'GITHUB_COMMAND_FAILED',
      message: 'The GitHub CLI is unavailable or not authenticated.',
      hint: 'Install or ensure the `gh` CLI is available, run `gh auth login`, then verify with `gh auth status`.',
    });
    assert.deepEqual(result.checks.codex, {
      ok: false,
      code: 'CODEX_AUTH_REQUIRED',
      message: 'The Codex CLI is unavailable or not authenticated with the ChatGPT subscription flow.',
      hint: 'Install or ensure the Codex CLI is available, run `codex login` with the ChatGPT subscription flow, then verify with `codex login status`.',
    });
    assert.deepEqual(result.checks.gitIdentity, {
      ok: false,
      code: 'GIT_IDENTITY_MISSING',
      message: 'Git author name and email are not configured.',
      hint: 'Set `git config --global user.name` and `git config --global user.email`, then rerun PatchPool doctor.',
    });
    assert.equal(result.checks.stateDatabase.ok, false);
    assert.equal(result.checks.commitSigning.mode, 'disabled-by-worker');
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('doctor never copies secret-bearing exception data into JSON or human diagnostics', async () => {
  const sentinel = 'PATCHPOOL_SECRET_SENTINEL_7f1d';
  const hostileError = () => Object.assign(new Error(`message-${sentinel}`), {
    code: `code-${sentinel}`,
    details: { stderr: `stderr-${sentinel}`, token: `token-${sentinel}`, path: `path-${sentinel}` },
    path: `exception-path-${sentinel}`,
  });
  const result = await runDoctor({
    dbPath: ':memory:',
    nodeVersion: '24.15.0',
    github: { async preflight() { throw hostileError(); } },
    codex: { async preflight() { throw hostileError(); } },
    runner: { async run() { throw hostileError(); } },
  });

  assert.equal(result.checks.github.code, 'GITHUB_AUTH_REQUIRED');
  assert.equal(result.checks.codex.code, 'CODEX_AUTH_REQUIRED');
  assert.equal(result.checks.gitIdentity.code, 'GIT_IDENTITY_MISSING');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  assert.doesNotMatch(formatDoctor(result), new RegExp(sentinel));
});

test('doctor tells operators to install missing GitHub and Codex CLIs before authentication', async () => {
  const sentinel = 'PATCHPOOL_MISSING_EXECUTABLE_SECRET_91c3';
  const missingExecutableRunner = {
    async run() {
      throw Object.assign(new Error(`spawn ENOENT ${sentinel}`), {
        code: 'COMMAND_FAILED',
        errno: 'ENOENT',
        details: { stderr: sentinel, token: sentinel, path: sentinel },
      });
    },
  };
  const result = await runDoctor({
    dbPath: ':memory:',
    nodeVersion: '24.15.0',
    github: new GitHubClient({ runner: missingExecutableRunner }),
    codex: new CodexClient({ runner: missingExecutableRunner, platform: 'linux' }),
    runner: missingExecutableRunner,
  });

  assert.equal(result.checks.github.code, 'GITHUB_AUTH_REQUIRED');
  assert.equal(
    result.checks.github.hint,
    'Install or ensure the `gh` CLI is available, run `gh auth login`, then verify with `gh auth status`.',
  );
  assert.equal(result.checks.codex.code, 'CODEX_AUTH_REQUIRED');
  assert.equal(
    result.checks.codex.hint,
    'Install or ensure the Codex CLI is available, run `codex login` with the ChatGPT subscription flow, then verify with `codex login status`.',
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  assert.doesNotMatch(formatDoctor(result), new RegExp(sentinel));
});

test('every observable doctor failure code has a non-empty fixed message and hint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-doctor-diagnostics-'));
  const stateDirectory = join(directory, 'state-directory.sqlite');
  const incompatiblePath = join(directory, 'incompatible.sqlite');
  const invalidPath = join(directory, 'invalid.sqlite');
  mkdirSync(stateDirectory);
  const incompatible = new DatabaseSync(incompatiblePath);
  incompatible.exec('CREATE TABLE unrelated (value TEXT NOT NULL)');
  incompatible.close();
  writeFileSync(invalidPath, 'not a sqlite database');

  const base = { dbPath: ':memory:', nodeVersion: '24.15.0', ...authenticatedDependencies() };
  try {
    const results = [
      await runDoctor({ ...base, nodeVersion: '23.9.0' }),
      await runDoctor({ ...base, github: { async preflight() { throw new Error('unknown'); } } }),
      await runDoctor({ ...base, github: { async preflight() { throw Object.assign(new Error('known'), { code: 'GITHUB_COMMAND_FAILED' }); } } }),
      await runDoctor({ ...base, codex: { async preflight() { throw new Error('unknown'); } } }),
      await runDoctor({ ...base, codex: { async preflight() { throw Object.assign(new Error('known'), { code: 'CODEX_NOT_FOUND' }); } } }),
      await runDoctor({ ...base, runner: { async run() { return { exitCode: 1, stdout: '', stderr: '' }; } } }),
      await runDoctor({ ...base, dbPath: join(directory, 'missing-parent', 'state.sqlite') }),
      await runDoctor({ ...base, dbPath: stateDirectory }),
      await runDoctor({ ...base, dbPath: incompatiblePath }),
      await runDoctor({ ...base, dbPath: invalidPath }),
    ];
    const expectedCodes = [
      'NODE_VERSION_UNSUPPORTED',
      'GITHUB_AUTH_REQUIRED',
      'GITHUB_COMMAND_FAILED',
      'CODEX_AUTH_REQUIRED',
      'CODEX_NOT_FOUND',
      'GIT_IDENTITY_MISSING',
      'STATE_DATABASE_PARENT_UNAVAILABLE',
      'STATE_DATABASE_NOT_WRITABLE',
      'STATE_DATABASE_SCHEMA_INCOMPATIBLE',
      'STATE_DATABASE_INVALID',
    ];

    for (const code of expectedCodes) {
      const check = results.flatMap(result => Object.values(result.checks)).find(candidate => candidate.code === code);
      assert.ok(check, `missing observable diagnostic for ${code}`);
      assert.match(check.message, /\S/, `${code} must have a message`);
      assert.match(check.hint, /\S/, `${code} must have a hint`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
