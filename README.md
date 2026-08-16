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
also checks Node.js 24+, the local Git author identity, read-only access to the
state database, and that Git signing is disabled for worker commits. It does
not claim an issue, mutate state, transmit credentials to PatchPool, or accept
an OpenAI API key for this workflow.

## Register a repository

Only a canonical `owner/name` public repository may be registered. The checked-
in [`.patchpool.json`](.patchpool.json) is the repository policy for this MVP:

```json
{"verifyCommand":["npm","test"],"requiredIssueLabel":"patchpool-ready","timeoutMinutes":30}
```

The 30-minute policy timeout bounds both the Codex implementation and the
registered verification command. Clone, push, and pull-request operations have
their own bounded adapter deadlines.

Register from the repository root with the checked-in config. The CLI loads and
validates this file, checks GitHub for the canonical repository's public and
non-archived status, and stores the approved policy snapshot:

```text
node bin/patchpool.js repo add --repo K-saint25/PatchPool --config .patchpool.json
node bin/patchpool.js repo list --json
```

If `--config` is omitted, the CLI automatically loads `.patchpool.json` from
the current working directory. Registration is immutable in the current store:
to change an approved policy, use `repo add --config .patchpool.json` again for
explicit reapproval (and re-register any legacy approved-config record), or use
a new local state database after review. `repo list` is read-only: a missing
state database returns `[]`, while legacy, future, malformed, or otherwise
incompatible state is rejected without creating or modifying it.

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

Codex chooses its normal default model unless you opt into a specific model
locally. Set `PATCHPOOL_CODEX_MODEL` to a model slug before starting the worker:

```powershell
$env:PATCHPOOL_CODEX_MODEL = 'gpt-5.6-luna'
node bin/patchpool.js run --repo K-saint25/PatchPool --issue <issue-number>
```

On macOS or Linux, prefix the command with
`PATCHPOOL_CODEX_MODEL=gpt-5.6-luna`. The choice is entirely user-controlled;
PatchPool does not automatically fall back to another model or retry a model
failure because the worktree may already contain partial edits.

Publishing commits with hooks disabled, verifies the remote, pushes a unique
`patchpool/issue-<number>-<claim-id>` branch, and creates and verifies a Draft
PR in the canonical repository. The PR body identifies the implementation as
AI-assisted and asks for human review.

## Self-dogfood

After registering this repository and creating an owner-controlled issue with
the `patchpool-ready` label, the intended self-dogfood command is the guarded
end-to-end path:

```text
node bin/patchpool.js e2e --repo K-saint25/PatchPool --publish
```

`e2e` accepts exactly `K-saint25/PatchPool` and requires `--publish`; it selects
the eligible owner-controlled issue and runs the full push-plus-Draft-PR flow.
Use a small documentation issue that is not already fixed. Inspect a normal
dry-run first; only then use the guarded command.

## State and workspace locations

- State database: `.patchpool.sqlite` in the current working directory, unless
  `PATCHPOOL_DB` names another path. SQLite may also create adjacent `-wal` and
  `-shm` files.
- Temporary worktrees: the operating system temporary directory, normally
  `%TEMP%` on Windows or `/tmp` on Unix-like systems. They are removed after a
  successful run unless `--keep-workspace` is used.
- Claim states: `claimed → running → verified → committed → pushed → pr_opened`.
  Pre-push failures are persisted as `failed` with an error code and timestamps.
  After a remote side effect may exist, the worker retains `pushed` or
  `pr_opened` so a retry can reconcile it safely.

Inspect the local claim history as JSON without changing claim or lease state:

```text
node bin/patchpool.js claim list --json
```

Rows are ordered by claim `id` ascending. The output includes repository and
workflow status fields, but omits execution lease tokens and arbitrary claim
metadata. If the state database does not exist, the command returns `[]`
without creating it. It never migrates a database; legacy, future, malformed,
or otherwise incompatible state is rejected without modification.

The SQLite claim and execution lease coordinate workers sharing one state DB on
one computer only. They are not a distributed lock or a service scheduler.

## Failure recovery

The worker persists each external side effect. Keep the same `PATCHPOOL_DB` and
the same worker identity (`PATCHPOOL_WORKER_ID`, when set) when retrying. A
dry-run that reached `verified`, or a normal crash before completion, can be
inspected before retrying:

```text
node bin/patchpool.js claim list --json
```

Use the matching claim's `state`, `workspace`, `branch`, `commitSha`, `prUrl`,
and `errorCode` to decide whether to inspect or retry it. Then rerun with the
same worker identity and an explicit matching issue number:

```text
node bin/patchpool.js run --repo K-saint25/PatchPool --issue <issue-number>
```

For an active `pushed` or `pr_opened` claim, this exact command does not need a
new `--publish` flag and does not re-evaluate issue eligibility. It only
reconciles the recorded branch with an existing or new Draft PR after the
approved repository, approval generation, worker identity, lease, branch, and
commit metadata have been revalidated. New claims still require the normal
issue eligibility checks and an explicit `--publish` before any remote write.

For the guarded self-dogfood path, rerun the same `e2e --repo
K-saint25/PatchPool --issue <issue-number> --publish` command. A verification or
Codex failure is safe to inspect and retry after fixing the cause. A dead owner
can be recovered after its execution lease expires, then the same command can
be rerun.

A dry-run intentionally leaves its `verified` claim active as a fail-safe. For
manual recovery:

1. Stop the worker and its entire process tree. If termination cannot be
   confirmed, wait until the process tree is confirmed stopped; do not start
   another worker. On Windows, `taskkill` is PID-based and has a small PID-reuse
   residual, so unconfirmed termination remains pending.
2. For a `pushed` or ambiguous result, inspect the GitHub branch and Draft PR
   first. Then rerun the same command so the workflow reconciles the recorded
   remote side effect instead of creating a duplicate.
3. For an expired owner lease, confirm the owner process is dead, keep the same
   `PATCHPOOL_DB` and worker identity, and rerun after lease expiry. Never
   overwrite a live lease.
4. For a legacy ownerless lease, stop every worker, resolve `PATCHPOOL_DB`, and
   back up the database plus adjacent `-wal`/`-shm` files. Only when you can
   prove the run was never published and has no remote side effect may you
   move that state database aside, choose a new state path, and re-register
   with `repo add --config .patchpool.json`. If there is any uncertainty or a
   branch/PR may exist, do not edit or delete the database; contact a
   maintainer for recovery.

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
