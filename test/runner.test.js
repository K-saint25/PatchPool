import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

function hangingSpawn() {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => child.emit('close', null, 'SIGTERM');
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
  const runner = new CommandRunner({ spawnFn: hangingSpawn() });
  await assert.rejects(
    () => runner.run('codex', ['exec'], { timeoutMs: 5 }),
    error => error.code === 'COMMAND_TIMEOUT',
  );
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
