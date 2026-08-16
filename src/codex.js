import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PatchPoolError } from './errors.js';

function rateLimited(value) {
  return /(?:rate[ -]?limit|rate_limit|too many requests|quota exceeded|429)/i.test(String(value ?? ''));
}

function invocation({ platform, command, execPath, codexPath, appData }) {
  if (platform !== 'win32') return { command, prefix: [] };
  const candidate = codexPath ?? (appData ? join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : undefined);
  if (candidate && (codexPath || existsSync(candidate))) return { command: execPath, prefix: [candidate] };
  if (command !== 'codex') return { command, prefix: [] };
  throw new PatchPoolError('CODEX_NOT_FOUND', 'Could not safely locate the Windows Codex installation');
}

function parseEvents(stdout) {
  const events = [];
  for (const line of String(stdout ?? '').split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object') throw new Error('not object');
      events.push(event);
    } catch {
      throw new PatchPoolError('CODEX_PROTOCOL', 'Codex returned a non-JSON event');
    }
  }
  return events;
}

export class CodexClient {
  constructor({ runner, command = 'codex', platform = process.platform, execPath = process.execPath, codexPath, appData = process.env.APPDATA } = {}) {
    if (!runner || typeof runner.run !== 'function') throw new TypeError('CodexClient requires a CommandRunner');
    this.runner = runner;
    this.options = { command, platform, execPath, codexPath, appData };
  }

  async preflight() {
    const { command, prefix } = invocation(this.options);
    let result;
    try {
      result = await this.runner.run(command, [...prefix, 'login', 'status']);
    } catch (error) {
      throw new PatchPoolError('CODEX_AUTH_REQUIRED', 'Codex authentication preflight failed', { cause: error.code });
    }
    const status = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || /api[ -_]?key/i.test(status) || !/chatgpt/i.test(status)) {
      throw new PatchPoolError('CODEX_AUTH_REQUIRED', 'Codex is not authenticated with ChatGPT');
    }
    return { authenticated: true, provider: 'ChatGPT' };
  }

  async implement({ cwd, prompt, timeoutMs } = {}) {
    if (typeof cwd !== 'string' || cwd.length === 0) throw new PatchPoolError('CODEX_INVALID_WORKTREE', 'Codex worktree directory is required');
    if (typeof prompt !== 'string') throw new PatchPoolError('CODEX_INVALID_PROMPT', 'Codex prompt is required');
    const { command, prefix } = invocation(this.options);
    const args = [...prefix, '--ask-for-approval', 'never', '--sandbox', 'workspace-write', '--cd', cwd, 'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--color', 'never', '-'];
    let result;
    try {
      result = await this.runner.run(command, args, { cwd, stdin: prompt, timeoutMs });
    } catch (error) {
      if (error.code === 'COMMAND_TIMEOUT') throw new PatchPoolError('CODEX_TIMEOUT', 'Codex implementation timed out', { timeoutMs });
      const detail = `${error.message}\n${JSON.stringify(error.details ?? '')}`;
      if (rateLimited(detail)) throw new PatchPoolError('CODEX_RATE_LIMIT', 'Codex request was rate limited');
      throw new PatchPoolError('CODEX_FAILED', 'Codex implementation failed');
    }
    if (rateLimited(`${result.stdout}\n${result.stderr}`)) throw new PatchPoolError('CODEX_RATE_LIMIT', 'Codex request was rate limited');
    if (result.exitCode !== 0) throw new PatchPoolError('CODEX_FAILED', 'Codex implementation exited unsuccessfully', { exitCode: result.exitCode });
    let events;
    try {
      events = parseEvents(result.stdout);
    } catch (error) {
      if (error.code === 'CODEX_PROTOCOL') throw error;
      throw new PatchPoolError('CODEX_PROTOCOL', 'Codex returned an invalid event stream');
    }
    const failed = events.find(event => event.type === 'turn.failed' || event.type === 'error');
    if (failed) {
      if (rateLimited(JSON.stringify(failed))) throw new PatchPoolError('CODEX_RATE_LIMIT', 'Codex request was rate limited');
      throw new PatchPoolError('CODEX_FAILED', 'Codex reported a failed turn');
    }
    const terminal = events.find(event => event.type === 'turn.completed');
    if (!terminal) throw new PatchPoolError('CODEX_PROTOCOL', 'Codex did not return a terminal completion event');
    return { events, terminal, stdout: result.stdout, stderr: result.stderr };
  }
}

export { invocation as resolveCodexInvocation };
