# Task 1 Report: Foundation and Safe Command Runner

## Files changed

- `package.json` — Node 24+ ESM package metadata, CLI bin mapping, and `node --test` script.
- `bin/patchpool.js` — thin executable entry point delegating to the later CLI composition root.
- `src/errors.js` — `PatchPoolError` with stable `name`, `code`, and optional `details`.
- `src/runner.js` — injected-spawn `CommandRunner` with argv-only execution, `shell: false`, bounded output capture, stdin closing/writing, timeout termination, and structured start/timeout errors.
- `test/runner.test.js` — five behavior tests covering the required interface and safety boundaries.

## RED evidence

Command:

```text
npm test -- test/runner.test.js
```

Observed failure before implementation:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\\src\\runner.js'
imported from ...\\test\\runner.test.js
✖ test\\runner.test.js
tests 1
pass 0
fail 1
exit_code=1
```

This was the expected missing-module failure for the new runner contract.

## GREEN evidence

Command:

```text
npm test
```

Observed result:

```text
✔ passes an argv array without a shell
✔ maps an expired process to COMMAND_TIMEOUT
✔ returns captured stdout and stderr and closes stdin
✔ limits captured output
✔ returns a non-zero exit code with output details
ℹ tests 5
ℹ pass 5
ℹ fail 0
exit_code=0
```

Also ran `git diff --check` successfully with no whitespace errors.

## Self-review

- Production subprocess creation is centralized in `CommandRunner` and receives an injectable `spawnFn`.
- Caller-provided command arguments are passed as the argv array; shell execution is always disabled and cannot be enabled through options.
- Captured stdout and stderr are bounded by bytes and retain UTF-8 decoding at the result boundary.
- Timeout rejection is deterministic (`COMMAND_TIMEOUT`) and attempts SIGTERM termination; a late close event cannot replace the timeout result.
- Non-zero process exit codes are returned as results so later adapters can interpret command-specific exit statuses; process-start failures remain `COMMAND_FAILED`.
- No credentials, shell cleanup commands, or business logic were added.

## Concerns

- `bin/patchpool.js` imports `src/cli.js`, which is intentionally created in Task 2; invoking the bin before that task is complete will fail by design.
- The runner does not add a forced SIGKILL grace path after SIGTERM; the timeout promise still settles immediately and later workflow code can decide whether additional process supervision is needed.

## Fix round 1

### Findings addressed

1. Timeout tests now record the signal sent to the child and assert `SIGTERM`. The fake child emits a delayed successful `close` event after termination; the test verifies the original `COMMAND_TIMEOUT` remains the observed error after that late event.
2. `CommandRunner` now has a central redaction boundary. Each run combines constructor- and call-supplied `sensitiveValues` with common GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, and `github_pat_`) and OpenAI (`sk-`, `sk-proj-`, `sk-admin-`, `sk-svcacct-`) token-shape redaction. Redaction is applied before stdout/stderr results and before all `PatchPoolError` details, including sanitized process-error cause fields.
3. Added a platform-gated integration test that runs the real Node executable on Windows with argv containing spaces and shell metacharacters, from a temporary cwd containing spaces. It verifies both the argument and cwd received by the child.

### RED evidence

Command after adding the new tests, before the redaction implementation:

```text
npm test -- test/runner.test.js
```

Observed result:

```text
✔ passes an argv array without a shell
✔ maps an expired process to COMMAND_TIMEOUT
✔ returns captured stdout and stderr and closes stdin
✔ limits captured output
✔ returns a non-zero exit code with output details
✖ redacts caller secrets and common GitHub/OpenAI tokens from output and errors
✔ executes argv safely in a Windows cwd containing spaces
ℹ tests 7
ℹ pass 6
ℹ fail 1
exit_code=1
```

The failure was the expected unredacted caller/token value assertion.

### GREEN evidence

Focused command:

```text
npm test -- test/runner.test.js
```

Observed result:

```text
✔ passes an argv array without a shell
✔ maps an expired process to COMMAND_TIMEOUT
✔ returns captured stdout and stderr and closes stdin
✔ limits captured output
✔ returns a non-zero exit code with output details
✔ redacts caller secrets and common GitHub/OpenAI tokens from output and errors
✔ executes argv safely in a Windows cwd containing spaces
ℹ tests 7
ℹ pass 7
ℹ fail 0
exit_code=0
```

Full suite command:

```text
npm test
```

Observed result: the same 7 tests passed, with 0 failures, 0 skips, and exit code 0. `git diff --check` also exited 0.

### Fix round 1 self-review and remaining concerns

- Timeout termination is now behaviorally covered: the test requires SIGTERM and exercises a late close event after timeout settlement.
- Secret values are never returned raw through the normal result or `PatchPoolError` paths. Process-error causes are reduced to redacted name/message/code fields rather than exposing the original Error object or stack.
- The Windows integration test executed on the current Windows host rather than being merely static; `shell: false` and argv preservation were exercised against a real child process and spaced cwd.
- Remaining concern: there is still no forced SIGKILL grace path after SIGTERM. The command promise settles deterministically on timeout, while later workflow code can choose whether it needs stronger process supervision.

### Additional red/green cycle for process-error metadata

The redaction test was strengthened to put a GitHub-shaped token in the process error name and assert directly on `error.details.cause.name`. Running `npm test -- test/runner.test.js` before the final one-line production change produced 6 passes and 1 failure at that assertion (`true !== false`, exit code 1). After redacting the sanitized cause name, the same command produced 7 passes and 0 failures (exit code 0); the subsequent full `npm test` run also produced 7 passes and 0 failures (exit code 0).
