# Task 3 report: GitHub and Codex adapters

## RED evidence

Added `test/github.test.js`, `test/codex.test.js`, and `test/prompt.test.js` before the production modules. The initial targeted run failed with the expected `ERR_MODULE_NOT_FOUND` errors for `src/github.js`, `src/codex.js`, and `src/prompt.js`.

An additional failing test covered structured Draft PR responses; it failed until the implementation handled and verified that response shape.

## GREEN evidence

- `node --check src/github.js`
- `node --check src/codex.js`
- `node --check src/prompt.js`
- `npm test` — 36 passed, 0 failed

## Exact command decisions

All GitHub operations use `CommandRunner` with argv arrays and no shell commands:

- `gh auth status`
- `gh api repos/<owner/name>`
- `gh api repos/<owner/name>/issues/<number>`
- `gh api repos/<owner/name>/issues?state=open&per_page=100`
- `gh repo clone <owner/name> <directory>`
- `gh api user`
- `gh pr list --repo <owner/name> --head <branch> --state all`
- `gh pr create --repo <owner/name> --head <branch> --base <base> --title <title> --body <body> --draft`, followed by `gh pr view <url> --json number,url,isDraft,headRefName` and a required `isDraft: true` check.

Codex uses global flags before `exec`:

`codex --ask-for-approval never --sandbox workspace-write --cd <worktree> exec --json --ephemeral --ignore-user-config --ignore-rules --color never -`

The implementation prompt is sent on stdin. On Windows, when the npm installation is present, the invocation is `process.execPath <APPDATA>\\npm\\node_modules\\@openai\\codex\\bin\\codex.js ...`; explicit path/platform injection is supported by tests. No cmd/shell shim or dangerous bypass is used.

## Security and behavior self-review

- GitHub repository responses must match the requested canonical `owner/name`, be public, and not archived.
- GitHub JSON is parsed defensively; malformed shapes fail with stable `PatchPoolError` codes.
- Draft creation is verified after creation; a non-Draft response fails closed.
- Codex nonzero exits, failed/error events, missing terminal events, timeouts, and recognizable rate-limit responses map to stable errors. Errors do not claim an exact remaining quota.
- Prompt issue fields are delimited as untrusted data. Trusted instructions forbid network access, credentials/secrets, installs, commits, pushes, PR creation, and changes outside the worktree.
- No credentials are logged or persisted; all subprocesses remain behind the injected `CommandRunner`.

## Concerns

None for Task 3. The workflow layer still owns eligibility policy, claim ordering, verification, commit, push, and PR reconciliation.
