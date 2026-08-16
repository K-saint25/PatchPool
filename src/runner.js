import { spawn } from 'node:child_process';
import { PatchPoolError } from './errors.js';

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_COMMAND_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINATION_CONFIRMATION_MS = 2_000;
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

function positiveDuration(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function runBoundedTerminationCommand(spawnFn, command, args, timeoutMs) {
  return new Promise(resolve => {
    let helperProcess;
    let timer;
    let settled = false;
    const finish = succeeded => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(succeeded);
    };
    try {
      helperProcess = spawnFn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    } catch {
      finish(false);
      return;
    }
    helperProcess.once('error', () => finish(false));
    helperProcess.once('close', exitCode => finish(exitCode === 0));
    timer = setTimeout(() => {
      try { helperProcess.kill('SIGKILL'); } catch { /* the helper may already have exited */ }
      finish(false);
    }, timeoutMs);
  });
}

async function terminateProcessTree(child, {
  platform,
  spawnFn,
  commandTimeoutMs,
  detached,
  isClosed,
}) {
  if (isClosed()) return;
  if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    await runBoundedTerminationCommand(
      spawnFn,
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      commandTimeoutMs,
    );
    return;
  }
  if (platform !== 'win32' && detached === true && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // Fall back to the direct child when it is no longer a process-group leader.
    }
  }
  try { child.kill('SIGTERM'); } catch { /* the child may already have exited */ }
}

export class CommandRunner {
  constructor({
    spawnFn = spawn,
    terminationFn,
    terminationSpawnFn = spawn,
    platform = process.platform,
    terminationCommandTimeoutMs = DEFAULT_TERMINATION_COMMAND_TIMEOUT_MS,
    terminationConfirmationMs = DEFAULT_TERMINATION_CONFIRMATION_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    sensitiveValues = [],
  } = {}) {
    this.spawnFn = spawnFn;
    this.terminationFn = terminationFn;
    this.terminationSpawnFn = terminationSpawnFn;
    this.platform = platform;
    this.terminationCommandTimeoutMs = positiveDuration(terminationCommandTimeoutMs, DEFAULT_TERMINATION_COMMAND_TIMEOUT_MS);
    this.terminationConfirmationMs = positiveDuration(terminationConfirmationMs, DEFAULT_TERMINATION_CONFIRMATION_MS);
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
      let closed = false;
      let cancellation;
      let abortHandler;
      let resolveClosed;
      const closedPromise = new Promise(resolveClosedPromise => { resolveClosed = resolveClosedPromise; });

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

      const waitForClose = durationMs => {
        if (closed) return Promise.resolve(true);
        return new Promise(resolve => {
          let completed = false;
          const confirmationTimer = setTimeout(() => {
            if (completed) return;
            completed = true;
            resolve(false);
          }, durationMs);
          closedPromise.then(() => {
            if (completed) return;
            completed = true;
            clearTimeout(confirmationTimer);
            resolve(true);
          });
        });
      };

      const requestCancellation = (code, message, details = {}) => {
        if (settled || cancellation) return;
        cancellation = { code, message, details };
        if (timer) clearTimeout(timer);
        if (abortHandler && abortSignal) abortSignal.removeEventListener('abort', abortHandler);
        void (async () => {
          try {
            const terminate = this.terminationFn ?? ((target, context) => terminateProcessTree(target, context));
            await terminate(child, {
              platform: this.platform,
              spawnFn: this.terminationSpawnFn,
              commandTimeoutMs: this.terminationCommandTimeoutMs,
              detached: spawnOptions.detached,
              isClosed: () => closed,
            });
          } catch {
            // Termination errors can contain secrets and are never surfaced.
          }
          if (!closed) await waitForClose(this.terminationConfirmationMs);
          if (!closed) {
            try { child.kill('SIGKILL'); } catch { /* the child may already have exited */ }
            await waitForClose(this.terminationConfirmationMs);
          }
          if (!closed) await closedPromise;
          const captured = output();
          finish(reject, new PatchPoolError(code, message, { ...details, ...captured }));
        })();
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
        if (cancellation) return;
        const captured = output();
        finish(reject, new PatchPoolError('COMMAND_FAILED', `Failed to run command: ${redact(command)}`, {
          ...captured,
          cause: safeCause(cause, redact),
        }));
      });
      child.once('close', (exitCode, signal) => {
        if (closed) return;
        closed = true;
        resolveClosed();
        if (cancellation) return;
        const captured = output();
        finish(resolve, { exitCode, ...captured });
      });

      if (abortSignal) {
        abortHandler = () => {
          requestCancellation('COMMAND_ABORTED', `Command was aborted: ${redact(command)}`);
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });
        if (abortSignal.aborted) abortHandler();
      }

      if (options.stdin !== undefined && child.stdin) child.stdin.end(options.stdin);
      else if (child.stdin) child.stdin.end();

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          requestCancellation('COMMAND_TIMEOUT', `Command timed out: ${redact(command)}`, { timeoutMs });
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }
}
