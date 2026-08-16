import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = mkdtempSync(join(tmpdir(), 'patchpool-package-'));
const windowsNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCommand = process.platform === 'win32' && existsSync(windowsNpmCli) ? process.execPath : 'npm';
const npmPrefix = npmCommand === process.execPath ? [windowsNpmCli] : [];
const forbidden = /(?:^|\/)(?:test|tests|support|\.superpowers|plans|\.codex|workspaces|\.worktrees|node_modules)(?:\/|$)|(?:^|\/)(?:auth\.json|credentials?[^/]*|[^/]+\.(?:db|sqlite[^/]*)|\.env[^/]*)$/i;
const exactAllowed = new Set([
  '.editorconfig',
  '.gitattributes',
  '.patchpool.json',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'package.json',
]);

function isAllowed(path) {
  return exactAllowed.has(path)
    || /^bin\/[^/]+\.js$/.test(path)
    || /^src\/[^/]+\.js$/.test(path)
    || /^docs\/architecture\/[^/]+\.md$/.test(path);
}

try {
  const result = spawnSync(
    npmCommand,
    [...npmPrefix, 'pack', '--json', '--pack-destination', destination],
    { cwd: repositoryRoot, encoding: 'utf8', shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || 'npm pack failed').trim());

  const metadata = JSON.parse(result.stdout);
  const pack = Array.isArray(metadata) ? metadata[0] : metadata;
  const files = (pack?.files ?? []).map(file => String(file.path).replaceAll('\\', '/'));
  if (!pack?.filename || !existsSync(join(destination, basename(pack.filename)))) {
    throw new Error('npm pack did not produce the expected tarball');
  }

  const forbiddenPaths = files.filter(path => forbidden.test(path));
  const unexpectedPaths = files.filter(path => !isAllowed(path));
  if (forbiddenPaths.length > 0) throw new Error(`Forbidden package paths: ${forbiddenPaths.join(', ')}`);
  if (unexpectedPaths.length > 0) throw new Error(`Unexpected package paths: ${unexpectedPaths.join(', ')}`);
  console.log(`Package manifest validated (${files.length} files): ${pack.filename}`);
} catch (error) {
  console.error(`Package manifest validation failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(destination, { recursive: true, force: true });
}
