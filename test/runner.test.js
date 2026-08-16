import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRunner } from '../src/runner.js';

function scriptedSpawn(calls, result = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    process.nextTick(() => {
      if (result.stdout) child.stdout.emit('data', result.stdout);
      if (result.stderr) child.stderr.emit('data', result.stderr);
      child.emit('close', result.code ?? 0, result.signal ?? null);
    });
    return child;
  };
}

function hangingSpawn(signals) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = signal => {
      signals.push(signal);
      process.nextTick(() => child.emit('close', 0, null));
    };
    return child;
  };
}

test('passes an argv array without a shell', async () => {
  const calls = [];
  const runner = new CommandRunner({ spawnFn: scriptedSpawn(calls, { code: 0 }) });
  await runner.run('gh', ['auth', 'status'], { cwd: 'C:\\repo path' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args, ['auth', 'status']);
  assert.equal(calls[0].options.cwd, 'C:\\repo path');
  assert.equal(calls[0].options.shell, false);
});

test('maps an expired process to COMMAND_TIMEOUT', async () => {
  const signals = [];
  const runner = new CommandRunner({ spawnFn: hangingSpawn(signals) });
  let timeoutError;
  try {
    await runner.run('codex', ['exec'], { timeoutMs: 5 });
  } catch (error) {
    timeoutError = error;
  }
  assert.equal(timeoutError?.code, 'COMMAND_TIMEOUT');
  assert.deepEqual(signals, ['SIGTERM']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timeoutError?.code, 'COMMAND_TIMEOUT');
});

test('aborting a running command terminates the child and reports COMMAND_ABORTED', async () => {
  const signals = [];
  const runner = new CommandRunner({ spawnFn: hangingSpawn(signals) });
  const controller = new AbortController();
  const running = runner.run('git', ['push'], { signal: controller.signal, timeoutMs: 60_000 });
  controller.abort(new Error('lease lost'));
  await assert.rejects(running, error => error.code === 'COMMAND_ABORTED');
  assert.deepEqual(signals, ['SIGTERM']);
});

test('does not miss cancellation that occurs while the child is being spawned', async () => {
  const controller = new AbortController();
  const signals = [];
  const spawnFn = () => {
    controller.abort();
    return hangingSpawn(signals)();
  };
  const runner = new CommandRunner({ spawnFn });
  await assert.rejects(
    runner.run('git', ['push'], { signal: controller.signal, timeoutMs: 10 }),
    error => error.code === 'COMMAND_ABORTED',
  );
  assert.deepEqual(signals, ['SIGTERM']);
});

test('returns captured stdout and stderr and closes stdin', async () => {
  let input;
  const spawnFn = (command, args, options) => {
    const child = scriptedSpawn([], { code: 3, stdout: 'output', stderr: 'warning' })(command, args, options);
    child.stdin = { end(value) { input = value; } };
    return child;
  };
  const runner = new CommandRunner({ spawnFn });
  const result = await runner.run('tool', [], { stdin: 'request' });
  assert.deepEqual(result, { exitCode: 3, stdout: 'output', stderr: 'warning' });
  assert.equal(input, 'request');
});

test('limits captured output', async () => {
  const runner = new CommandRunner({
    spawnFn: scriptedSpawn([], { code: 0, stdout: 'abcdef', stderr: 'uvwxyz' }),
  });
  const result = await runner.run('tool', [], { maxOutputBytes: 3 });
  assert.equal(result.stdout, 'abc');
  assert.equal(result.stderr, 'uvw');
});

test('returns a non-zero exit code with output details', async () => {
  const runner = new CommandRunner({
    spawnFn: scriptedSpawn([], { code: 7, stderr: 'bad command' }),
  });
  const result = await runner.run('tool', []);
  assert.deepEqual(result, { exitCode: 7, stdout: '', stderr: 'bad command' });
});

test('redacts caller secrets and common GitHub/OpenAI tokens from output and errors', async () => {
  const callerSecret = 'caller-secret-value';
  const githubToken = 'ghp_test-token-value';
  const openAiToken = 'sk-test-token-value';
  const runner = new CommandRunner({
    spawnFn: scriptedSpawn([], {
      code: 0,
      stdout: `stdout ${callerSecret} ${githubToken}`,
      stderr: `stderr ${openAiToken}`,
    }),
  });
  const result = await runner.run('tool', [], { sensitiveValues: [callerSecret] });
  const resultText = JSON.stringify(result);
  assert.equal(resultText.includes(callerSecret), false);
  assert.equal(resultText.includes(githubToken), false);
  assert.equal(resultText.includes(openAiToken), false);

  const errorRunner = new CommandRunner({
    spawnFn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      process.nextTick(() => {
        child.stderr.emit('data', `${callerSecret} ${githubToken} ${openAiToken}`);
        const processError = new Error(`failed with ${callerSecret} ${githubToken} ${openAiToken}`);
        processError.name = `Error-${githubToken}`;
        child.emit('error', processError);
      });
      return child;
    },
  });
  await assert.rejects(
    () => errorRunner.run('tool', [], { sensitiveValues: [callerSecret] }),
    error => {
      const errorText = JSON.stringify(error);
      assert.equal(errorText.includes(callerSecret), false);
      assert.equal(errorText.includes(githubToken), false);
      assert.equal(errorText.includes(openAiToken), false);
      assert.equal(error.details.cause.name.includes(githubToken), false);
      return true;
    },
  );
});

test('executes argv safely in a Windows cwd containing spaces', { skip: process.platform !== 'win32' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'patchpool runner '));
  try {
    const runner = new CommandRunner();
    const script = 'process.stdout.write(JSON.stringify({ argv: process.argv[1], cwd: process.cwd() }))';
    const result = await runner.run(process.execPath, ['-e', script, 'value with spaces & symbols'], { cwd });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.argv, 'value with spaces & symbols');
    assert.equal(parsed.cwd, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
