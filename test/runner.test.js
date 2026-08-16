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

function controlledChild({ pid = 4321, onKill } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = signal => {
    onKill?.(signal, child);
    return true;
  };
  return child;
}

async function waitForCondition(condition, description, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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
  const runner = new CommandRunner({
    spawnFn: hangingSpawn(signals),
    terminationFn: async child => {
      child.kill('SIGTERM');
      return true;
    },
  });
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
  const runner = new CommandRunner({
    spawnFn: hangingSpawn(signals),
    terminationFn: async child => {
      child.kill('SIGTERM');
      return true;
    },
  });
  const controller = new AbortController();
  const running = runner.run('git', ['push'], { signal: controller.signal, timeoutMs: 60_000 });
  controller.abort(new Error('lease lost'));
  await assert.rejects(running, error => error.code === 'COMMAND_ABORTED');
  assert.deepEqual(signals, ['SIGTERM']);
});

test('does not report cancellation until the spawned child confirms close', async () => {
  let child;
  let settled = false;
  const runner = new CommandRunner({
    spawnFn: () => {
      child = controlledChild();
      return child;
    },
    terminationFn: async () => true,
    terminationConfirmationMs: 100,
  });
  const controller = new AbortController();
  const running = runner.run('git', ['push'], { signal: controller.signal }).finally(() => { settled = true; });

  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);

  child.emit('close', null, 'SIGTERM');
  await assert.rejects(running, error => error.code === 'COMMAND_ABORTED');
});

test('uses safe Windows taskkill argv and reports cancellation only after successful tree termination closes the child', async () => {
  const terminationCalls = [];
  const directSignals = [];
  const child = controlledChild({
    pid: 8765,
    onKill(signal, spawnedChild) {
      directSignals.push(signal);
      process.nextTick(() => spawnedChild.emit('close', null, signal));
    },
  });
  const terminationSpawnFn = (command, args, options) => {
    terminationCalls.push({ command, args, options });
    const taskkill = new EventEmitter();
    taskkill.kill = () => true;
    process.nextTick(() => {
      taskkill.emit('close', 0, null);
      child.emit('close', null, 'SIGTERM');
    });
    return taskkill;
  };
  const runner = new CommandRunner({
    spawnFn: () => child,
    terminationSpawnFn,
    platform: 'win32',
    terminationConfirmationMs: 1,
    unsafeTerminationWaitFn: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const running = runner.run('git', ['push'], { signal: controller.signal });
  controller.abort();

  await assert.rejects(running, error => error.code === 'COMMAND_ABORTED');
  assert.deepEqual(terminationCalls, [{
    command: 'taskkill.exe',
    args: ['/PID', '8765', '/T', '/F'],
    options: { shell: false, windowsHide: true, stdio: 'ignore' },
  }]);
  assert.deepEqual(directSignals, []);
});

test('taskkill failure remains pending even if the direct child later closes', async () => {
  const secret = 'caller-secret-value';
  const directSignals = [];
  let unsafeWaitStarted = false;
  const child = controlledChild({ onKill: signal => directSignals.push(signal) });
  const runner = new CommandRunner({
    spawnFn: () => child,
    terminationSpawnFn: () => {
      const taskkill = new EventEmitter();
      taskkill.kill = () => true;
      process.nextTick(() => taskkill.emit('error', new Error(`taskkill failed: ${secret}`)));
      return taskkill;
    },
    platform: 'win32',
    terminationConfirmationMs: 1,
    unsafeTerminationWaitFn: () => {
      unsafeWaitStarted = true;
      return new Promise(() => {});
    },
  });
  const controller = new AbortController();
  let settled = false;
  const running = runner.run('git', ['push'], { signal: controller.signal, sensitiveValues: [secret] });
  void running.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  child.emit('close', null, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 5));

  assert.equal(settled, false);
  assert.equal(unsafeWaitStarted, true);
  assert.deepEqual(directSignals, []);
});

test('bounds a hung taskkill and remains pending without direct-child fallback', async () => {
  let taskkillSignal;
  const directSignals = [];
  const child = controlledChild({
    onKill: signal => directSignals.push(signal),
  });
  const runner = new CommandRunner({
    spawnFn: () => child,
    terminationSpawnFn: () => {
      const taskkill = new EventEmitter();
      taskkill.kill = signal => {
        taskkillSignal = signal;
        process.nextTick(() => taskkill.emit('close', null, signal));
        return true;
      };
      return taskkill;
    },
    platform: 'win32',
    terminationCommandTimeoutMs: 1,
    terminationConfirmationMs: 1,
    unsafeTerminationWaitFn: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const running = runner.run('git', ['push'], { signal: controller.signal });
  let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(taskkillSignal, 'SIGKILL');
  assert.equal(settled, false);
  assert.deepEqual(directSignals, []);
});

test('does not treat a child close during failed Windows tree termination as safe', async () => {
  const directSignals = [];
  const child = controlledChild({ onKill: signal => directSignals.push(signal) });
  const runner = new CommandRunner({
    spawnFn: () => child,
    terminationSpawnFn: () => {
      const taskkill = new EventEmitter();
      taskkill.kill = () => true;
      process.nextTick(() => {
        child.emit('close', 0, null);
        taskkill.emit('close', 1, null);
      });
      return taskkill;
    },
    platform: 'win32',
    terminationConfirmationMs: 1,
    unsafeTerminationWaitFn: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const running = runner.run('git', ['push'], { signal: controller.signal });
  let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(directSignals, []);
});

test('POSIX commands default to a detached group and escalate TERM to group KILL before rejecting', async () => {
  const spawnCalls = [];
  const groupSignals = [];
  const child = controlledChild({ pid: 2468 });
  const runner = new CommandRunner({
    spawnFn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
    platform: 'linux',
    processKillFn: (pid, signal) => {
      groupSignals.push({ pid, signal });
      if (signal === 'SIGKILL') process.nextTick(() => child.emit('close', null, signal));
      if (signal === 0) {
        const error = new Error('process group does not exist');
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    },
    terminationConfirmationMs: 1,
  });
  const controller = new AbortController();
  const running = runner.run('git', ['push'], { signal: controller.signal });
  controller.abort();

  await assert.rejects(running, error => error.code === 'COMMAND_ABORTED');
  assert.equal(spawnCalls[0].options.detached, true);
  assert.deepEqual(groupSignals, [
    { pid: -2468, signal: 'SIGTERM' },
    { pid: -2468, signal: 'SIGKILL' },
    { pid: -2468, signal: 0 },
  ]);
});

test('POSIX kills and confirms the group after its leader closes during TERM grace', async () => {
  const groupSignals = [];
  const child = controlledChild({ pid: 3579 });
  const runner = new CommandRunner({
    spawnFn: () => child,
    platform: 'linux',
    processKillFn: (pid, signal) => {
      groupSignals.push({ pid, signal });
      if (signal === 'SIGTERM') process.nextTick(() => child.emit('close', null, signal));
      if (signal === 0) {
        const error = new Error('process group does not exist');
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    },
    terminationConfirmationMs: 1,
  });
  const controller = new AbortController();
  const running = runner.run('git', ['push'], { signal: controller.signal });
  controller.abort();

  await assert.rejects(running, error => error.code === 'COMMAND_ABORTED');
  assert.deepEqual(groupSignals, [
    { pid: -3579, signal: 'SIGTERM' },
    { pid: -3579, signal: 'SIGKILL' },
    { pid: -3579, signal: 0 },
  ]);
});

test('POSIX remains pending when the process group still exists after KILL', async () => {
  const groupSignals = [];
  let unsafeWaitStarted = false;
  const child = controlledChild({ pid: 4680 });
  const runner = new CommandRunner({
    spawnFn: () => child,
    platform: 'linux',
    processKillFn: (pid, signal) => {
      groupSignals.push({ pid, signal });
      if (signal === 'SIGTERM') process.nextTick(() => child.emit('close', null, signal));
      return true;
    },
    unsafeTerminationWaitFn: () => {
      unsafeWaitStarted = true;
      return new Promise(() => {});
    },
    terminationConfirmationMs: 1,
  });
  const controller = new AbortController();
  let settled = false;
  const running = runner.run('git', ['push'], { signal: controller.signal });
  void running.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  await waitForCondition(() => unsafeWaitStarted, 'unsafe process-group wait');

  assert.equal(settled, false);
  assert.equal(unsafeWaitStarted, true);
  assert.deepEqual(groupSignals.slice(0, 3), [
    { pid: -4680, signal: 'SIGTERM' },
    { pid: -4680, signal: 'SIGKILL' },
    { pid: -4680, signal: 0 },
  ]);
});

test('POSIX command spawning respects an explicit detached false option', async () => {
  const calls = [];
  const runner = new CommandRunner({ platform: 'linux', spawnFn: scriptedSpawn(calls, { code: 0 }) });
  await runner.run('git', ['status'], { detached: false });
  assert.equal(calls[0].options.detached, false);
});

test('does not terminate a child that already closed before cancellation', async () => {
  const directSignals = [];
  const terminationCalls = [];
  const child = controlledChild({ onKill: signal => directSignals.push(signal) });
  const runner = new CommandRunner({
    spawnFn: () => {
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    },
    terminationFn: async () => { terminationCalls.push('terminate'); },
  });
  const controller = new AbortController();

  const result = await runner.run('git', ['status'], { signal: controller.signal });
  controller.abort();

  assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
  assert.deepEqual(terminationCalls, []);
  assert.deepEqual(directSignals, []);
});

test('does not miss cancellation that occurs while the child is being spawned', async () => {
  const controller = new AbortController();
  const signals = [];
  const spawnFn = () => {
    controller.abort();
    return hangingSpawn(signals)();
  };
  const runner = new CommandRunner({
    spawnFn,
    terminationFn: async child => {
      child.kill('SIGTERM');
      return true;
    },
  });
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
