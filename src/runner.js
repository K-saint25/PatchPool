import { spawn } from 'node:child_process';
import { PatchPoolError } from './errors.js';

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const REDACTED = '[REDACTED]';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createRedactor(sensitiveValues = []) {
  const exactValues = sensitiveValues
    .filter(value => value !== undefined && value !== null && String(value).length > 0)
    .map(value => String(value));
  const tokenPattern = /(?:github_pat_[A-Za-z0-9_-]{4,}|gh[pousr]_[A-Za-z0-9_-]{4,}|sk-(?:proj-|admin-|svcacct-)?[A-Za-z0-9_-]{4,})/g;

  return value => {
    let text = String(value ?? '');
    for (const sensitiveValue of exactValues) {
      text = text.replace(new RegExp(escapeRegExp(sensitiveValue), 'g'), REDACTED);
    }
    return text.replace(tokenPattern, REDACTED);
  };
}

function safeCause(cause, redact) {
  if (cause && typeof cause === 'object') {
    const safe = {
      name: redact(cause.name),
      message: redact(cause.message ?? String(cause)),
    };
    if (cause.code !== undefined) safe.code = redact(cause.code);
    return safe;
  }
  return redact(cause);
}

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
  constructor({ spawnFn = spawn, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, sensitiveValues = [] } = {}) {
    this.spawnFn = spawnFn;
    this.maxOutputBytes = maxOutputBytes;
    this.sensitiveValues = sensitiveValues;
  }

  run(command, args = [], options = {}) {
    const timeoutMs = options.timeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? options.maxCaptureBytes ?? this.maxOutputBytes;
    const spawnOptions = spawnOptionsFrom(options);
    const redact = createRedactor([...this.sensitiveValues, ...(options.sensitiveValues ?? [])]);
    const abortSignal = options.signal;

    return new Promise((resolve, reject) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      const stdoutState = { bytes: 0 };
      const stderrState = { bytes: 0 };
      let child;
      let timer;
      let settled = false;
      let timedOut = false;
      let abortHandler;

      const output = () => ({
        stdout: redact(Buffer.concat(stdoutChunks).toString('utf8')),
        stderr: redact(Buffer.concat(stderrChunks).toString('utf8')),
      });

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortHandler && abortSignal) abortSignal.removeEventListener('abort', abortHandler);
        fn(value);
      };

      if (abortSignal?.aborted) {
        finish(reject, new PatchPoolError('COMMAND_ABORTED', `Command was aborted: ${redact(command)}`));
        return;
      }

      try {
        child = this.spawnFn(command, args, spawnOptions);
      } catch (cause) {
        finish(reject, new PatchPoolError('COMMAND_FAILED', `Failed to start command: ${redact(command)}`, {
          cause: safeCause(cause, redact),
        }));
        return;
      }

      child.stdout?.on('data', chunk => appendLimited(stdoutChunks, stdoutState, chunk, maxOutputBytes));
      child.stderr?.on('data', chunk => appendLimited(stderrChunks, stderrState, chunk, maxOutputBytes));
      child.once('error', cause => {
        const captured = output();
        finish(reject, new PatchPoolError('COMMAND_FAILED', `Failed to run command: ${redact(command)}`, {
          ...captured,
          cause: safeCause(cause, redact),
        }));
      });
      child.once('close', (exitCode, signal) => {
        const captured = output();
        if (timedOut) return;
        finish(resolve, { exitCode, ...captured });
      });

      if (abortSignal) {
        abortHandler = () => {
          const captured = output();
          try { child.kill('SIGTERM'); } catch { /* the child may already have exited */ }
          finish(reject, new PatchPoolError('COMMAND_ABORTED', `Command was aborted: ${redact(command)}`, captured));
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });
        if (abortSignal.aborted) abortHandler();
      }

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
          finish(reject, new PatchPoolError('COMMAND_TIMEOUT', `Command timed out: ${redact(command)}`, {
            timeoutMs,
            ...captured,
          }));
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }
}
