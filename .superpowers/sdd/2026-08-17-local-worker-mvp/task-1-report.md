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
