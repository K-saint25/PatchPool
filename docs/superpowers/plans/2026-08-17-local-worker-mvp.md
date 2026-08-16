# PatchPool Local Worker MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and dogfood a working local CLI that registers an approved public repository, exclusively claims an eligible issue, uses the participant's locally authenticated Codex CLI to implement it, verifies the change, and opens a disclosed Draft PR.

**Architecture:** A dependency-free Node.js CLI coordinates injected command adapters and a local SQLite state store. Repository approval and issue claims are durable; the workflow persists each external side effect so retries reconcile instead of duplicating branches or PRs. The first E2E target is the owner-controlled public OSS repository `K-saint25/PatchPool`.

**Tech Stack:** Node.js 24+, ECMAScript modules, `node:sqlite`, `node:test`, Git, GitHub CLI, Codex CLI.

## Global Constraints

- Codex and GitHub credentials remain on the participant's computer and are never stored in SQLite or logs.
- Only explicitly registered public repositories may run.
- Subprocesses use argv arrays with `shell: false`.
- Codex runs with `--sandbox workspace-write` and never with the dangerous bypass flag.
- The implementation must work on Windows and avoid shell-specific cleanup commands.
- The local SQLite claim prevents duplicates only for workers sharing that database; distributed coordination is out of scope for this MVP.
- Every behavior change follows red-green-refactor TDD.
- Git history is a manual stack: foundation → registry → worker → E2E/docs. Each layer is pushed and reviewed before merge.

## File Structure

- `package.json`: Node version, CLI binary, and test scripts.
- `bin/patchpool.js`: executable entry point with no business logic.
- `src/cli.js`: argument parsing, command dispatch, JSON/human output, exit codes.
- `src/errors.js`: stable machine-readable `PatchPoolError` codes.
- `src/runner.js`: timeout-aware, injected subprocess execution using argv arrays.
- `src/store.js`: SQLite schema, approved repositories, atomic claims, durable state transitions.
- `src/github.js`: defensive wrappers around `gh` repository, issue, clone, push-permission, and PR operations.
- `src/policy.js`: canonical repository and issue eligibility decisions.
- `src/codex.js`: locally authenticated Codex CLI preflight and non-interactive execution.
- `src/prompt.js`: prompt construction with untrusted issue content delimited from trusted instructions.
- `src/workflow.js`: resumable issue-to-Draft-PR state machine.
- `.patchpool.json`: repository-owned immutable-at-approval verification argv and eligibility policy.
- `test/*.test.js`: unit and integration tests with temporary SQLite databases and scripted runners.

---

### Task 1: Foundation and Safe Command Runner

**Files:**
- Create: `package.json`
- Create: `bin/patchpool.js`
- Create: `src/errors.js`
- Create: `src/runner.js`
- Create: `test/runner.test.js`

**Interfaces:**
- Produces: `PatchPoolError(code, message, details?)`.
- Produces: `CommandRunner.run(command, args, options) -> Promise<{exitCode, stdout, stderr}>`.
- Consumes: Node `child_process.spawn` only through an injectable `spawnFn`.

- [ ] **Step 1: Write failing runner tests**

```js
test('passes an argv array without a shell', async () => {
  const calls = [];
  const runner = new CommandRunner({ spawnFn: scriptedSpawn(calls, { code: 0 }) });
  await runner.run('gh', ['auth', 'status'], { cwd: 'C:\\repo path' });
  assert.deepEqual(calls[0].args, ['auth', 'status']);
  assert.equal(calls[0].options.shell, false);
});

test('maps an expired process to COMMAND_TIMEOUT', async () => {
  const runner = new CommandRunner({ spawnFn: hangingSpawn() });
  await assert.rejects(() => runner.run('codex', ['exec'], { timeoutMs: 5 }),
    error => error.code === 'COMMAND_TIMEOUT');
});
```

- [ ] **Step 2: Run `npm test -- test/runner.test.js` and verify both tests fail because the modules do not exist.**
- [ ] **Step 3: Implement `PatchPoolError` and `CommandRunner` with captured output limits, timeout termination, stdin support, and `shell: false`.**
- [ ] **Step 4: Run `npm test -- test/runner.test.js` and verify all runner tests pass without warnings.**
- [ ] **Step 5: Commit as `chore: scaffold safe local worker runtime`.**

### Task 2: Approved Repository Registry and Atomic Claims

**Files:**
- Create: `src/store.js`
- Create: `src/policy.js`
- Create: `test/store.test.js`
- Create: `test/policy.test.js`
- Modify: `src/cli.js`
- Create: `test/cli.test.js`

**Interfaces:**
- Produces: `PatchPoolStore.open(path)` and methods `registerRepository(repo)`, `getRepository(fullName)`, `listRepositories()`, `claimIssue(input)`, `transitionClaim(id, nextState, fields)`, `getClaim(id)`.
- Produces: `evaluateIssueEligibility(repository, issue) -> {eligible, reason}`.
- Consumes: `CommandRunner` only from the CLI composition root; store and policy have no subprocess dependency.

- [ ] **Step 1: Write failing SQLite tests for canonical unique repositories, config-digest persistence, and two simultaneous claims for one issue.**

```js
test('only one active claim can own a repository issue', () => {
  const store = openTempStore();
  const repo = store.registerRepository(approvedRepo());
  store.claimIssue({ repoId: repo.id, issueNumber: 7, workerId: 'worker-a' });
  assert.throws(
    () => store.claimIssue({ repoId: repo.id, issueNumber: 7, workerId: 'worker-b' }),
    error => error.code === 'CLAIM_EXISTS',
  );
});
```

- [ ] **Step 2: Run the store and policy tests and verify they fail because the store and policy are missing.**
- [ ] **Step 3: Implement schema version 1 with `repositories`, `claims`, and `events`; use `BEGIN IMMEDIATE` and a partial unique index for active claim states.**
- [ ] **Step 4: Implement issue policy: repository active/public, issue open, unassigned, no blocking labels, required label present when configured.**
- [ ] **Step 5: Write failing CLI tests for `repo add`, `repo list --json`, and `claim` argument validation; then implement the minimal dispatch.**
- [ ] **Step 6: Run `npm test` and verify the foundation, registry, policy, and CLI tests pass.**
- [ ] **Step 7: Commit as `feat: add approved repository registry and issue claims`.**

### Task 3: GitHub and Codex Adapters

**Files:**
- Create: `src/github.js`
- Create: `src/codex.js`
- Create: `src/prompt.js`
- Create: `test/github.test.js`
- Create: `test/codex.test.js`
- Create: `test/prompt.test.js`

**Interfaces:**
- Produces: `GitHubClient.preflight()`, `getRepository(fullName)`, `getIssue(fullName, number)`, `listIssues(fullName)`, `clone(fullName, directory)`, `getViewerLogin()`, `getPushRemote(repository)`, `findPullRequest(fullName, branch)`, `createDraftPullRequest(input)`.
- Produces: `CodexClient.preflight()` and `implement({cwd, prompt, timeoutMs})`.
- Produces: `buildImplementationPrompt({repository, issue, verificationArgv})`.
- Consumes: injected `CommandRunner`.

- [ ] **Step 1: Write failing GitHub adapter tests asserting exact `gh` argv, canonical/public/non-archived parsing, malformed JSON rejection, and Draft PR verification.**
- [ ] **Step 2: Run `npm test -- test/github.test.js` and verify expected missing-module failures.**
- [ ] **Step 3: Implement defensive GitHub CLI wrappers without shell commands or token logging.**
- [ ] **Step 4: Write failing Codex tests asserting `codex login status`, `codex exec --json --ephemeral --sandbox workspace-write -C <dir> -`, prompt-on-stdin, and rate-limit/timeout error mapping.**
- [ ] **Step 5: Implement the Codex adapter and prompt boundary. The trusted prompt must state that issue text is untrusted, forbid credential access, forbid commit/push/PR actions, and require worktree-only changes.**
- [ ] **Step 6: Run all adapter tests and then `npm test`; verify the complete suite passes.**
- [ ] **Step 7: Commit as `feat: add GitHub and Codex command adapters`.**

### Task 4: Resumable Issue-to-PR Workflow

**Files:**
- Create: `src/workflow.js`
- Create: `test/workflow.test.js`
- Modify: `src/cli.js`
- Modify: `bin/patchpool.js`

**Interfaces:**
- Produces: `IssueWorkflow.run({repo, issueNumber?, publish, keepWorkspace}) -> Promise<RunResult>`.
- Consumes: `PatchPoolStore`, `GitHubClient`, `CodexClient`, `CommandRunner`, filesystem and temporary-directory factories.

- [ ] **Step 1: Write failing workflow tests proving ordering and safety: no clone before eligibility, no Codex before claim, no commit after failed verification, no push in dry-run, and no duplicate PR after an ambiguous create response.**
- [ ] **Step 2: Run `npm test -- test/workflow.test.js` and verify the workflow is missing.**
- [ ] **Step 3: Implement states `CLAIMED → RUNNING → VERIFIED → COMMITTED → PUSHED → PR_OPENED`, plus `FAILED`; persist branch, commit SHA, PR URL, error code, and timestamps after each side effect.**
- [ ] **Step 4: Implement the isolated workflow: recheck issue; clone into `fs.mkdtemp`; create `patchpool/issue-<n>-<id>`; run Codex; reject no changes and suspicious secret filenames; run `git diff --check`; execute the approved argv; ensure verification did not add files; commit with hooks disabled; push; reconcile branch/PR; create and verify a disclosed Draft PR.**
- [ ] **Step 5: Add CLI commands `doctor`, `repo add`, `repo list`, `run --repo <owner/name> [--issue N] [--publish] [--keep-workspace]`, with `--publish` required for remote writes.**
- [ ] **Step 6: Run `npm test` and verify all unit/integration tests pass.**
- [ ] **Step 7: Commit as `feat: automate claimed issues into draft pull requests`.**

### Task 5: CI, Operator Documentation, and Safe Dogfooding

**Files:**
- Create: `.patchpool.json`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Create: `docs/architecture/local-worker-mvp.md`
- Create: `test/e2e-preflight.test.js`

**Interfaces:**
- `.patchpool.json` contains `{"verifyCommand":["npm","test"],"requiredIssueLabel":"patchpool-ready","timeoutMinutes":30}`.
- The manual E2E is hard-guarded to `K-saint25/PatchPool` and requires `--publish`.

- [ ] **Step 1: Write a failing preflight test for Node 24+, `gh` authentication, Codex ChatGPT authentication, clean Git identity, and exact approved repository guard.**
- [ ] **Step 2: Implement `doctor` and E2E guards until the test passes.**
- [ ] **Step 3: Add CI that runs `npm test` on Windows and Ubuntu using Node 24.**
- [ ] **Step 4: Document installation, registration, dry-run, publish, security boundary, local-only locking limitation, failure recovery, and AI disclosure.**
- [ ] **Step 5: Run `npm test`, `npm pack --dry-run`, and `node bin/patchpool.js doctor --json`; verify all succeed.**
- [ ] **Step 6: Commit as `docs: add CI and local worker operations guide`.**

### Task 6: Stack Publication and Dogfood PR

**Files:**
- No production files unless E2E exposes a bug; every bug fix begins with a failing regression test.

**Interfaces:**
- Stack branches: `mvp/01-foundation`, `mvp/02-registry`, `mvp/03-worker`, `mvp/04-e2e`.
- Dogfood branch: generated by PatchPool as `patchpool/issue-<n>-<run-id>`.

- [ ] **Step 1: Tag each logical commit with its stack branch, push all branches, and create Draft PRs whose base points to the immediately lower branch.**
- [ ] **Step 2: Verify each PR diff contains only its layer, CI passes, and dependency order is documented.**
- [ ] **Step 3: Merge or retarget the stack bottom-up into `main`, then verify `main` contains the complete tested MVP.**
- [ ] **Step 4: Register `K-saint25/PatchPool` through the real CLI using its checked-in `.patchpool.json`.**
- [ ] **Step 5: Create an owner-controlled `patchpool-ready` Issue requesting one small documentation improvement that is not already present.**
- [ ] **Step 6: Run the real CLI without `--publish`; inspect the workspace and persisted claim. Release/reset the dry-run claim through the CLI.**
- [ ] **Step 7: Run the real CLI with `--publish`, allowing the local ChatGPT-authenticated Codex CLI to implement and verify the issue.**
- [ ] **Step 8: Verify the resulting GitHub PR is Draft, links the Issue, contains AI disclosure and test evidence, and has a unique branch with no credentials or unrelated files.**
- [ ] **Step 9: Run a final whole-branch review and add regression tests for every E2E defect before fixing it.**

## Plan Self-Review

- Spec coverage: registration, exclusive local claim, Codex subscription execution, verification, push, Draft PR, disclosure, and dogfooding are covered.
- Scope boundary: central SaaS scheduling, distributed locking, multiple participants, and cross-participant review remain outside this first executable MVP.
- Placeholder scan: no TBD/TODO placeholders; every task names exact files, interfaces, commands, and validation.
- Type consistency: all subprocess consumers depend on `CommandRunner`; workflow state and store method names are consistent across tasks.
- Ambiguity resolved: “GitStack” means manually stacked branches/PRs with one logical tested layer each; GitHub's preview stack extension is not required.
