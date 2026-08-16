import { spawn } from 'node:child_process';
import { PatchPoolError } from './errors.js';

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function appendLimited(chunks, state, value, maxBytes) {
  if (state.bytes >= maxBytes) return;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const remaining = maxBytes - state.bytes;
  const chunk = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
  chunks.push(chunk);
  state.bytes += chunk.length;
}

function spawnOptionsFrom(options) {
  const spawnOptions = { shell: false };
  for (const key of ['cwd', 'env', 'uid', 'gid', 'windowsHide', 'detached']) {
    if (options[key] !== undefined) spawnOptions[key] = options[key];
  }
  return spawnOptions;
}

export class CommandRunner {
  constructor({ spawnFn = spawn, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
    this.spawnFn = spawnFn;
    this.maxOutputBytes = maxOutputBytes;
  }

  run(command, args = [], options = {}) {
    const timeoutMs = options.timeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? options.maxCaptureBytes ?? this.maxOutputBytes;
    const spawnOptions = spawnOptionsFrom(options);

    return new Promise((resolve, reject) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      const stdoutState = { bytes: 0 };
      const stderrState = { bytes: 0 };
      let child;
      let timer;
      let settled = false;
      let timedOut = false;

      const output = () => ({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };

      try {
        child = this.spawnFn(command, args, spawnOptions);
      } catch (cause) {
        finish(reject, new PatchPoolError('COMMAND_FAILED', `Failed to start command: ${command}`, { cause }));
        return;
      }

      child.stdout?.on('data', chunk => appendLimited(stdoutChunks, stdoutState, chunk, maxOutputBytes));
      child.stderr?.on('data', chunk => appendLimited(stderrChunks, stderrState, chunk, maxOutputBytes));
      child.once('error', cause => {
        const captured = output();
        finish(reject, new PatchPoolError('COMMAND_FAILED', `Failed to run command: ${command}`, {
          ...captured,
          cause,
        }));
      });
      child.once('close', (exitCode, signal) => {
        const captured = output();
        if (timedOut) return;
        finish(resolve, { exitCode, ...captured });
      });

      if (options.stdin !== undefined && child.stdin) child.stdin.end(options.stdin);
      else if (child.stdin) child.stdin.end();

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          const captured = output();
          try {
            child.kill('SIGTERM');
          } catch {
            // The process may have exited between the timeout and kill attempt.
          }
          finish(reject, new PatchPoolError('COMMAND_TIMEOUT', `Command timed out: ${command}`, {
            timeoutMs,
            ...captured,
          }));
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }
}
