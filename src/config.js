import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { PatchPoolError } from './errors.js';

const CONFIG_KEYS = ['requiredIssueLabel', 'timeoutMinutes', 'verifyCommand'];
const MAX_CONFIG_BYTES = 64 * 1024;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 24 * 60;

function invalid(message) {
  throw new PatchPoolError('INVALID_REPOSITORY_CONFIG', message);
}

function regularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function skipWhitespace(source, index) {
  while (index < source.length && /[\t\n\r ]/.test(source[index])) index += 1;
  return index;
}

function stringEnd(source, start) {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (!escaped && character === '"') return index + 1;
    if (!escaped && character === '\\') escaped = true;
    else escaped = false;
  }
  return source.length;
}

function rejectDuplicateTopLevelKeys(source) {
  let index = skipWhitespace(source, 0);
  if (source[index] !== '{') return;
  index += 1;
  const keys = new Set();
  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (source[index] === '}') return;
    if (source[index] !== '"') return;
    const end = stringEnd(source, index);
    let key;
    try { key = JSON.parse(source.slice(index, end)); } catch { return; }
    if (keys.has(key)) invalid('.patchpool.json contains a duplicate top-level key');
    keys.add(key);
    index = skipWhitespace(source, end);
    if (source[index] !== ':') return;
    index += 1;
    let nested = 0;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index = stringEnd(source, index);
        continue;
      }
      if (character === '{' || character === '[') nested += 1;
      else if (character === '}' || character === ']') {
        if (character === '}' && nested === 0) return;
        nested -= 1;
      } else if (character === ',' && nested === 0) {
        index += 1;
        break;
      }
      index += 1;
    }
  }
}

function parseConfig(path) {
  let source;
  try {
    const size = statSync(path).size;
    if (size > MAX_CONFIG_BYTES) invalid('.patchpool.json exceeds the 64 KiB size limit');
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'INVALID_REPOSITORY_CONFIG') throw error;
    throw new PatchPoolError('REPOSITORY_CONFIG_UNREADABLE', `Unable to read repository config: ${path}`);
  }
  let value;
  try {
    rejectDuplicateTopLevelKeys(source);
    value = JSON.parse(source);
  } catch (error) {
    if (error?.code === 'INVALID_REPOSITORY_CONFIG') throw error;
    invalid('.patchpool.json must contain valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('.patchpool.json must contain a JSON object');
  const keys = Object.keys(value).sort();
  if (keys.length !== CONFIG_KEYS.length || keys.some((key, index) => key !== CONFIG_KEYS[index])) {
    invalid(`.patchpool.json must contain exactly: ${CONFIG_KEYS.join(', ')}`);
  }
  if (!Array.isArray(value.verifyCommand) || value.verifyCommand.length === 0 || value.verifyCommand.length > 128 ||
      value.verifyCommand.some(argument => typeof argument !== 'string' || argument.length === 0 || argument.length > 4096 || argument.includes('\0'))) {
    invalid('verifyCommand must be a non-empty argv string array');
  }
  if (typeof value.requiredIssueLabel !== 'string' || value.requiredIssueLabel.trim() !== value.requiredIssueLabel ||
      value.requiredIssueLabel.length === 0 || value.requiredIssueLabel.length > 100 || /[\r\n\0]/.test(value.requiredIssueLabel)) {
    invalid('requiredIssueLabel must be a non-empty single-line string of at most 100 characters');
  }
  if (!Number.isInteger(value.timeoutMinutes) || value.timeoutMinutes < MIN_TIMEOUT_MINUTES || value.timeoutMinutes > MAX_TIMEOUT_MINUTES) {
    invalid(`timeoutMinutes must be an integer from ${MIN_TIMEOUT_MINUTES} through ${MAX_TIMEOUT_MINUTES}`);
  }
  return {
    verifyCommand: [...value.verifyCommand],
    requiredIssueLabel: value.requiredIssueLabel,
    timeoutMinutes: value.timeoutMinutes,
  };
}

function resolveVerificationArgv(verifyCommand, {
  platform = process.platform,
  execPath = process.execPath,
  npmCliPath,
  isFile = regularFile,
} = {}) {
  if (platform !== 'win32') return [...verifyCommand];
  const commandName = basename(verifyCommand[0]).toLowerCase();
  if (commandName === 'npm' || commandName === 'npm.cmd' || commandName === 'npm.ps1') {
    const candidate = resolve(npmCliPath ?? join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    if (extname(candidate).toLowerCase() !== '.js' || !isFile(candidate)) {
      throw new PatchPoolError('UNSAFE_VERIFY_COMMAND', 'Could not resolve npm to a safe JavaScript runtime entry point on Windows');
    }
    return [execPath, candidate, ...verifyCommand.slice(1)];
  }
  if (['.bat', '.cmd', '.ps1'].includes(extname(commandName))) {
    throw new PatchPoolError('UNSAFE_VERIFY_COMMAND', 'Windows verification commands cannot invoke script shims with shell:false');
  }
  return [...verifyCommand];
}

export function loadRepositoryConfig(path, options = {}) {
  const approvedConfig = parseConfig(path);
  const canonical = JSON.stringify({
    verifyCommand: approvedConfig.verifyCommand,
    requiredIssueLabel: approvedConfig.requiredIssueLabel,
    timeoutMinutes: approvedConfig.timeoutMinutes,
  });
  return {
    approvedConfig,
    configDigest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    verificationArgv: resolveVerificationArgv(approvedConfig.verifyCommand, options),
  };
}

export { MAX_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES };
