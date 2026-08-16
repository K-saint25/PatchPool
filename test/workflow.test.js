import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchPoolStore } from '../src/store.js';

test('workflow module is present', async () => {
  const module = await import('../src/workflow.js');
  assert.equal(typeof module.IssueWorkflow, 'function');
});

function setup({ verificationExitCode = 0 } = {}) {
  const store = PatchPoolStore.open(':memory:');
  const repository = store.registerRepository({ fullName: 'octo/example', configDigest: 'sha256:one', verificationArgv: ['npm', 'test'] });
  const calls = [];
  const github = {
    async getRepository(name) { calls.push(['repo', name]); return { fullName: name, public: true, archived: false, defaultBranch: 'main' }; },
    async getIssue(name, number) { calls.push(['issue', number]); return { number, title: 'Fix', body: 'body', state: 'OPEN', assignees: [], labels: [] }; },
    async listIssues() { return []; },
    async clone(name, directory) { calls.push(['clone', directory]); },
    async getPushRemote() { calls.push(['permission']); return { canPush: true }; },
    async findPullRequest() { calls.push(['find-pr']); return null; },
    async createDraftPullRequest() { calls.push(['create-pr']); return { url: 'https://github.com/octo/example/pull/1', isDraft: true, headRefName: 'patchpool/issue-1-1' }; },
  };
  const runner = {
    async run(command, args, options) {
      calls.push(['run', command, args]);
      if (command === 'git' && args[0] === 'status') return { exitCode: 0, stdout: ' M src/app.js\n', stderr: '' };
      if (command === 'git' && args[0] === 'diff') return { exitCode: 0, stdout: '', stderr: '' };
      if (command === 'npm') return { exitCode: verificationExitCode, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const codex = { async implement() { calls.push(['codex']); } };
  return { store, repository, calls, github, runner, codex };
}

test('dry-run claims only after eligibility, runs Codex, and never commits, pushes, or creates a PR', async () => {
  const setupState = setup();
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  const result = await workflow.run({ repo: 'octo/example', issueNumber: 1, publish: false, keepWorkspace: true });
  assert.equal(result.state, 'verified');
  assert.equal(result.workspace, 'worktree');
  const names = setupState.calls.map(call => call[0]);
  assert.ok(names.indexOf('clone') > names.indexOf('issue'));
  assert.ok(names.indexOf('codex') > names.indexOf('clone'));
  assert.equal(names.includes('permission'), false);
  assert.equal(names.includes('create-pr'), false);
  assert.equal(setupState.store.getClaim(result.claimId).state, 'verified');
  setupState.store.close();
});

test('failed approved verification does not commit', async () => {
  const setupState = setup({ verificationExitCode: 1 });
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true }), error => error.code === 'WORKFLOW_VERIFICATION_FAILED');
  assert.equal(setupState.calls.some(call => call[0] === 'run' && call[2]?.[0] === 'commit'), false);
  setupState.store.close();
});

test('publish disables hooks, refreshes issue before push, and creates one Draft PR with disclosure', async () => {
  const setupState = setup();
  let created;
  setupState.github.createDraftPullRequest = async input => {
    created = input;
    setupState.calls.push(['create-pr']);
    return { url: 'https://github.com/octo/example/pull/1', isDraft: true, headRefName: input.branch };
  };
  const originalRun = setupState.runner.run;
  setupState.runner.run = async (command, args, options) => {
    if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
    return originalRun(command, args, options);
  };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  const result = await workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true });
  assert.equal(result.state, 'pr_opened');
  assert.equal(result.commitSha, 'abc123');
  assert.match(created.body, /AI-assisted implementation/);
  assert.match(created.body, /issues\/1/);
  const commitCall = setupState.calls.find(call => call[0] === 'run' && call[2]?.includes('commit'));
  assert.ok(commitCall);
  assert.ok(commitCall[2].includes('--no-verify'));
  assert.equal(setupState.store.getClaim(result.claimId).prUrl, result.prUrl);
  setupState.store.close();
});

test('ambiguous PR creation reconciles the existing matching Draft PR without retrying create', async () => {
  const setupState = setup();
  let lookups = 0;
  let creates = 0;
  setupState.github.findPullRequest = async () => {
    lookups += 1;
    return lookups === 1 ? null : { url: 'https://github.com/octo/example/pull/9', isDraft: true, headRefName: 'patchpool/issue-1-1' };
  };
  setupState.github.createDraftPullRequest = async () => {
    creates += 1;
    throw new Error('connection lost after create');
  };
  const originalRun = setupState.runner.run;
  setupState.runner.run = async (command, args, options) => {
    if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
    return originalRun(command, args, options);
  };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  const result = await workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true });
  assert.equal(result.prUrl, 'https://github.com/octo/example/pull/9');
  assert.equal(creates, 1);
  assert.equal(lookups, 2);
  setupState.store.close();
});

test('rejects a pull-request-shaped issue before cloning or claiming', async () => {
  const setupState = setup();
  setupState.github.getIssue = async () => ({ number: 1, title: 'PR', state: 'OPEN', assignees: [], labels: [], pull_request: { url: 'https://github.com/octo/example/pull/1' } });
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: false }), error => error.code === 'WORKFLOW_PULL_REQUEST');
  assert.equal(setupState.store.listRepositories().length, 1);
  assert.equal(setupState.calls.some(call => call[0] === 'clone'), false);
  setupState.store.close();
});
