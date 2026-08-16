# PatchPool

PatchPool is a local-worker MVP for turning an approved, public GitHub issue
into a verified, AI-assisted Draft pull request. The worker runs on your own
computer: GitHub and Codex credentials stay in your local tools, and the
coordinator is deliberately absent from this MVP.

## Prerequisites

- Node.js 24 or newer
- Git
- GitHub CLI (`gh`)
- The Codex CLI, signed in with the ChatGPT subscription flow (not an API key)

Authenticate before running the worker:

```text
gh auth login
gh auth status
codex login
codex login status
```

If GitHub SSH is required for cloning/pushing, select SSH during `gh auth
login` or run `gh config set git_protocol ssh`, then verify with
`ssh -T git@github.com`. Configure a Git author identity locally with
`git config --global user.name` and `git config --global user.email`; PatchPool
does not store that identity or any credential.

## Install and check the worker

From a checkout:

```text
npm install
node bin/patchpool.js doctor --json
```

`doctor` checks GitHub CLI authentication and Codex ChatGPT authentication. It
does not transmit credentials to PatchPool and it does not accept an OpenAI API
key for this workflow.

## Register a repository

Only a canonical `owner/name` public repository may be registered. The checked-
in [`.patchpool.json`](.patchpool.json) is the repository policy for this MVP:

```json
{"verifyCommand":["npm","test"],"requiredIssueLabel":"patchpool-ready","timeoutMinutes":30}
```

The current CLI accepts the policy values as explicit registration arguments;
it does not load `.patchpool.json` automatically. Compute its digest, then copy
the printed value into `--config-digest`:

```text
node -e "const fs=require('node:fs');const {createHash}=require('node:crypto');process.stdout.write('sha256:'+createHash('sha256').update(fs.readFileSync('.patchpool.json')).digest('hex'))"
node bin/patchpool.js repo add --repo K-saint25/PatchPool --config-digest <printed-digest> --verification-argv '["npm","test"]' --required-label patchpool-ready
node bin/patchpool.js repo list --json
```

The single-quoted JSON argument works in PowerShell and POSIX shells; use the
equivalent escaped quoting in `cmd.exe`. Registration is immutable in the
current store: to change an approved policy, use a new local state database or
perform an explicitly reviewed manual migration.

## Dry-run and publish

By default, `run` claims an eligible, open, unassigned issue, clones it into a
temporary worktree, asks the locally authenticated Codex CLI to edit only that
worktree, and runs the registered verification command. It does not commit,
push, or open a pull request:

```text
node bin/patchpool.js run --repo K-saint25/PatchPool --issue <issue-number> --keep-workspace
```

Omit `--issue` to select the first eligible issue. `--keep-workspace` preserves
the temporary directory for inspection. A remote write requires an explicit
`--publish`:

```text
node bin/patchpool.js run --repo K-saint25/PatchPool --issue <issue-number> --publish
```

Publishing commits with hooks disabled, verifies the remote, pushes a unique
`patchpool/issue-<number>-<claim-id>` branch, and creates and verifies a Draft
PR in the canonical repository. The PR body identifies the implementation as
AI-assisted and asks for human review.

## Self-dogfood

After registering this repository and creating an owner-controlled issue with
the `patchpool-ready` label, the intended self-dogfood command is:

```text
node bin/patchpool.js run --repo K-saint25/PatchPool --issue <owner-controlled-issue> --publish
```

Use a small documentation issue that is not already fixed. Inspect the dry-run
result first; only then use `--publish`.

## State and workspace locations

- State database: `.patchpool.sqlite` in the current working directory, unless
  `PATCHPOOL_DB` names another path. SQLite may also create adjacent `-wal` and
  `-shm` files.
- Temporary worktrees: the operating system temporary directory, normally
  `%TEMP%` on Windows or `/tmp` on Unix-like systems. They are removed after a
  successful run unless `--keep-workspace` is used.
- Claim states: `claimed → running → verified → committed → pushed → pr_opened`.
  Failures are persisted as `failed` with an error code and timestamps.

The SQLite claim and execution lease coordinate workers sharing one state DB on
one computer only. They are not a distributed lock or a service scheduler.

## Failure recovery

The worker persists each external side effect. Rerunning can reconcile a
`committed` or `pushed` claim instead of creating a second branch or PR. A
verification or Codex failure is safe to inspect and retry after fixing the
cause.

There is currently no public `claim release` command. A dry-run intentionally
leaves its `verified` claim active as a fail-safe. After confirming that no
worker is running and no remote side effect is pending, an operator may mark a
claim failed with the local store API (replace `<claim-id>`):

```text
node --input-type=module -e "import {PatchPoolStore} from './src/store.js';const s=PatchPoolStore.open();const id=Number(process.argv[1]);console.log(s.transitionClaim(id,'failed',{errorCode:'MANUAL_RECOVERY'}));s.close()" <claim-id>
```

Do not force recovery while process termination is unconfirmed. On Windows,
`taskkill` is PID-based and has a small PID-reuse residual; if termination or
its confirmation cannot be established, the run remains pending and must be
checked manually before another run. An expired legacy execution lease without
owner PID/session metadata also requires manual state recovery; it is not
automatically reclaimed.

## Security and AI disclosure

PatchPool never stores or sends GitHub/Codex credentials. Issue text is
untrusted input to the Codex prompt; the worker restricts the Codex sandbox to
workspace writes, rejects suspicious secret files, and uses argv-based
subprocesses without a shell. Only explicitly registered canonical public
repositories are eligible. Remote writes are limited to a unique branch and a
Draft PR, which a human maintainer must review.

Contributors must disclose material AI assistance in pull requests and include
test evidence. See [SECURITY.md](SECURITY.md) for private vulnerability
reporting and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## License

Licensed under the [Apache License 2.0](LICENSE).
