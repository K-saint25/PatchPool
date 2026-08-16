import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexClient } from '../src/codex.js';
import { PatchPoolError } from '../src/errors.js';

function scriptedRunner(results) {
  const calls = [];
  return {
    calls,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result ?? { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

test('preflight checks ChatGPT authentication with codex login status', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' }]);
  const client = new CodexClient({ runner, platform: 'linux' });
  const result = await client.preflight();
  assert.equal(result.authenticated, true);
  assert.deepEqual(runner.calls[0].args, ['login', 'status']);
});

test('preflight rejects API-key authentication even when status says logged in', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: 'Logged in using API key', stderr: '' }]);
  const client = new CodexClient({ runner, platform: 'linux' });
  await assert.rejects(() => client.preflight(), error => error.code === 'CODEX_AUTH_REQUIRED');
});

test('implement puts global flags before exec and sends prompt on stdin', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: '{"type":"turn.started"}\n{"type":"turn.completed"}\n', stderr: '' }]);
  const client = new CodexClient({ runner, platform: 'linux', command: 'codex' });
  const result = await client.implement({ cwd: 'C:\\work tree', prompt: 'do work', timeoutMs: 1234 });
  assert.equal(result.terminal.type, 'turn.completed');
  assert.equal(runner.calls[0].command, 'codex');
  assert.deepEqual(runner.calls[0].args, ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', '--cd', 'C:\\work tree', 'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--color', 'never', '-']);
  assert.equal(runner.calls[0].options.stdin, 'do work');
  assert.equal(runner.calls[0].options.timeoutMs, 1234);
});

test('implement uses the Windows Node executable and installed codex.js without a shell shim', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '' }]);
  const client = new CodexClient({ runner, platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', codexPath: 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js' });
  await client.implement({ cwd: 'C:\\work', prompt: 'x' });
  assert.equal(runner.calls[0].command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(runner.calls[0].args, [
    'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    '-c',
    'windows.sandbox="elevated"',
    '--ask-for-approval',
    'never',
    '--sandbox',
    'workspace-write',
    '--cd',
    'C:\\work',
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--color',
    'never',
    '-',
  ]);
});

test('implement maps timeout, rate limit, nonzero, failed events, and missing terminal events', async () => {
  const timeout = new PatchPoolError('COMMAND_TIMEOUT', 'timed out');
  for (const [result, code] of [
    [timeout, 'CODEX_TIMEOUT'],
    [{ exitCode: 1, stdout: '', stderr: 'rate limit exceeded' }, 'CODEX_RATE_LIMIT'],
    [{ exitCode: 2, stdout: '', stderr: 'failed' }, 'CODEX_FAILED'],
    [{ exitCode: 0, stdout: '{"type":"turn.failed","error":{"message":"no"}}\n', stderr: '' }, 'CODEX_FAILED'],
    [{ exitCode: 0, stdout: '{"type":"item.completed"}\n', stderr: '' }, 'CODEX_PROTOCOL'],
  ]) {
    const runner = scriptedRunner([result]);
    const client = new CodexClient({ runner, platform: 'linux' });
    await assert.rejects(() => client.implement({ cwd: '.', prompt: 'x' }), error => error.code === code);
  }
});

test('implement forwards the sanitized environment when provided', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '' }]);
  const client = new CodexClient({ runner });
  await client.implement({ cwd: 'C:\\repo', prompt: 'prompt', env: { PATH: 'safe' } });
  assert.deepEqual(runner.calls[0].options.env, { PATH: 'safe' });
});
