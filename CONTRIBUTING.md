# Contributing to PatchPool

PatchPool is a local-worker MVP. Contributions should preserve the local-only
credential boundary and the fail-safe workflow described in
[the architecture note](docs/architecture/local-worker-mvp.md).

## Development loop

1. Use Node.js 24 or newer and install the checkout with `npm install`.
2. Keep changes focused on one issue and run `npm test`.
3. Run `npm pack --dry-run` when changing package or ignore rules. Local SQLite
   files, `.env` files, and worker workspaces must not appear in the package.
4. Update operator documentation when CLI behavior or recovery changes.

Pull requests should link the relevant issue, describe the security impact,
and include exact test or verification commands. CI covers Node 24 on Windows
and Ubuntu.

## Safety requirements

- Never commit API keys, access tokens, Codex credentials, repository secrets,
  local state databases, workspaces, or personal data.
- Do not broaden the worker from canonical public repositories or add a remote
  write without an explicit `--publish` guard and tests.
- Preserve argv-based subprocess execution, Codex workspace-write sandboxing,
  secret-file checks, and Draft-PR verification.
- Treat uncertain process termination and stale/legacy leases as pending manual
  recovery, not as permission to start a second worker.
- Disclose material AI assistance in the pull request description and identify
  what a human reviewer must verify.

Please report security vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not through a public issue or pull request.

By contributing, you agree that your contribution is licensed under the Apache
License 2.0.
