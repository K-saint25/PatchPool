import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRepositoryConfig } from '../src/config.js';

function withConfig(value, operation) {
  const directory = mkdtempSync(join(tmpdir(), 'patchpool-config-'));
  const path = join(directory, '.patchpool.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  try {
    return operation(path, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const APPROVED = {
  verifyCommand: ['npm', 'test'],
  requiredIssueLabel: 'patchpool-ready',
  timeoutMinutes: 30,
};

test('loads the exact config schema and computes a canonical digest internally', () => {
  withConfig('{\n  "timeoutMinutes": 30,\n  "requiredIssueLabel": "patchpool-ready",\n  "verifyCommand": ["npm", "test"]\n}', path => {
    const loaded = loadRepositoryConfig(path, { platform: 'linux', execPath: '/usr/bin/node' });
    assert.equal(loaded.configDigest, 'sha256:c397b0f2d7973a2a11e2ad711578d0c7a5ee9a0655e1cea7278c2031de21b002');
    assert.deepEqual(loaded.approvedConfig, APPROVED);
    assert.deepEqual(loaded.verificationArgv, ['npm', 'test']);
  });
});

test('rejects missing, extra, malformed, and out-of-bounds config values', () => {
  const invalid = [
    { verifyCommand: ['node', '--test'], requiredIssueLabel: 'ready' },
    { ...APPROVED, unexpected: true },
    { ...APPROVED, verifyCommand: [] },
    { ...APPROVED, verifyCommand: ['npm', ''] },
    { ...APPROVED, requiredIssueLabel: '' },
    { ...APPROVED, timeoutMinutes: 0 },
    { ...APPROVED, timeoutMinutes: 1_441 },
    { ...APPROVED, timeoutMinutes: 1.5 },
  ];
  for (const value of invalid) {
    withConfig(value, path => {
      assert.throws(() => loadRepositoryConfig(path), error => error.code === 'INVALID_REPOSITORY_CONFIG');
    });
  }
});

test('resolves npm to the Node runtime on Windows instead of spawning a command shim', () => {
  withConfig(APPROVED, path => {
    const loaded = loadRepositoryConfig(path, {
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      npmCliPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      isFile: candidate => candidate.endsWith('npm-cli.js'),
    });
    assert.deepEqual(loaded.verificationArgv, [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      'test',
    ]);
  });
});

test('rejects unsafe Windows script shims that have no approved runtime resolver', () => {
  withConfig({ ...APPROVED, verifyCommand: ['verify.cmd', '--all'] }, path => {
    assert.throws(
      () => loadRepositoryConfig(path, { platform: 'win32', execPath: 'C:\\node.exe' }),
      error => error.code === 'UNSAFE_VERIFY_COMMAND',
    );
  });
});

test('does not include unrelated config content in the approved snapshot', () => {
  withConfig({ ...APPROVED, token: 'secret-value' }, path => {
    assert.throws(() => loadRepositoryConfig(path), error => error.code === 'INVALID_REPOSITORY_CONFIG');
  });
});

test('rejects duplicate top-level JSON keys instead of accepting the last value', () => {
  withConfig('{"verifyCommand":["node","--test"],"requiredIssueLabel":"ready","timeoutMinutes":30,"timeoutMinutes":60}', path => {
    assert.throws(
      () => loadRepositoryConfig(path),
      error => error.code === 'INVALID_REPOSITORY_CONFIG',
    );
  });
});
