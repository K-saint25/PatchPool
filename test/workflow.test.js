import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchPoolStore } from '../src/store.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    async getPushRemote() { calls.push(['permission']); return { canPush: true, remoteName: 'origin' }; },
    async findPullRequest() { calls.push(['find-pr']); return null; },
    async createDraftPullRequest(input) { calls.push(['create-pr']); return { url: 'https://github.com/octo/example/pull/1', isDraft: true, headRefName: input.branch, baseRefName: input.base, baseRepository: { fullName: 'octo/example' }, headRepository: { fullName: 'octo/example' }, body: input.body }; },
  };
  const runner = {
    async run(command, args, options) {
      calls.push(['run', command, args]);
      if (command === 'git' && args[0] === 'status') return { exitCode: 0, stdout: ' M src/app.js\n', stderr: '' };
      if (command === 'git' && args[0] === 'remote') return { exitCode: 0, stdout: 'https://github.com/octo/example.git\n', stderr: '' };
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
  const failed = setupState.store.db.prepare('SELECT fields_json FROM claims ORDER BY id DESC LIMIT 1').get();
  assert.equal(JSON.parse(failed.fields_json).error, undefined);
  assert.equal(JSON.parse(failed.fields_json).errorCode, 'WORKFLOW_VERIFICATION_FAILED');
  setupState.store.close();
});

test('publish disables hooks, refreshes issue before push, and creates one Draft PR with disclosure', async () => {
  const setupState = setup();
  let created;
  setupState.github.createDraftPullRequest = async input => {
    created = input;
    setupState.calls.push(['create-pr']);
    return { url: 'https://github.com/octo/example/pull/1', isDraft: true, headRefName: input.branch, baseRefName: input.base, baseRepository: { fullName: 'octo/example' }, headRepository: { fullName: 'octo/example' }, body: input.body };
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
    return lookups === 1 ? null : { url: 'https://github.com/octo/example/pull/9', isDraft: true, headRefName: 'patchpool/issue-1-1', baseRefName: 'main', baseRepository: { fullName: 'octo/example' }, headRepository: { fullName: 'octo/example' }, body: 'AI-assisted implementation. Closes #1' };
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

test('rejects verification that mutates the same changed path', async () => {
  const setupState = setup();
  const directory = await mkdtemp(join(tmpdir(), 'patchpool-fingerprint-'));
  setupState.runner.run = async (command, args, options) => {
    setupState.calls.push(['run', command, args]);
    if (command === 'git' && args[0] === 'status') return { exitCode: 0, stdout: ' M src/app.js\0', stderr: '' };
    if (command === 'git' && args[0] === 'diff') return { exitCode: 0, stdout: '', stderr: '' };
    if (command === 'npm') {
      await mkdir(join(directory, 'src'), { recursive: true });
      await writeFile(join(directory, 'src', 'app.js'), 'mutated');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  setupState.codex.implement = async () => { await mkdir(join(directory, 'src'), { recursive: true }); await writeFile(join(directory, 'src', 'app.js'), 'before'); };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => directory, cleanup: async () => {} });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: false }), error => error.code === 'WORKFLOW_VERIFICATION_MUTATED');
  await rm(directory, { recursive: true, force: true });
  setupState.store.close();
});

test('rejects a changed symlink before verification', async () => {
  if (process.platform === 'win32') return;
  const setupState = setup();
  const directory = await mkdtemp(join(tmpdir(), 'patchpool-symlink-'));
  setupState.runner.run = async (command, args) => {
    setupState.calls.push(['run', command, args]);
    if (command === 'git' && args[0] === 'status') return { exitCode: 0, stdout: '?? docs/link\0', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  setupState.codex.implement = async () => { await mkdir(join(directory, 'docs'), { recursive: true }); await symlink('outside', join(directory, 'docs', 'link')); };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => directory, cleanup: async () => {} });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: false }), error => error.code === 'WORKFLOW_SYMLINK');
  await rm(directory, { recursive: true, force: true });
  setupState.store.close();
});

test('rejects a rename record whose destination is a secret path', async () => {
  const setupState = setup();
  setupState.runner.run = async (command, args) => {
    setupState.calls.push(['run', command, args]);
    if (command === 'git' && args[0] === 'status') return { exitCode: 0, stdout: 'R  safe.txt\0.env\0', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: false }), error => error.code === 'WORKFLOW_SUSPICIOUS_FILE');
  setupState.store.close();
});

test('resumes a pushed claim by reconciling its PR without running Codex or pushing again', async () => {
  const setupState = setup();
  const claim = setupState.store.claimIssue({ repoId: setupState.repository.id, issueNumber: 1, workerId: 'worker-a' });
  setupState.store.transitionClaim(claim.id, 'running', { branch: 'patchpool/issue-1-1' });
  setupState.store.transitionClaim(claim.id, 'verified');
  setupState.store.transitionClaim(claim.id, 'committed', { commitSha: 'abc' });
  setupState.store.transitionClaim(claim.id, 'pushed');
  setupState.github.findPullRequest = async () => ({ url: 'https://github.com/octo/example/pull/2', isDraft: true, headRefName: 'patchpool/issue-1-1', baseRefName: 'main', baseRepository: { fullName: 'octo/example' }, headRepository: { fullName: 'octo/example' }, body: 'AI-assisted implementation. Closes #1' });
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, workerId: 'worker-a', tempDirectoryFactory: async () => 'unused', cleanup: async () => {} });
  const result = await workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true });
  assert.equal(result.state, 'pr_opened');
  assert.equal(setupState.calls.some(call => call[0] === 'codex'), false);
  assert.equal(setupState.calls.some(call => call[0] === 'run' && call[2]?.[0] === 'push'), false);
  setupState.store.close();
});

test('rejects malformed push permission and missing PR reconciliation fields', async () => {
  const setupState = setup();
  setupState.github.getPushRemote = async () => ({ canPush: true });
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true }), error => error.code === 'WORKFLOW_PUSH_PERMISSION');
  setupState.store.close();
});

test('strips credential environment variables while preserving Codex operational paths', async () => {
  const setupState = setup();
  let codexEnvironment;
  let verifierEnvironment;
  let pushEnvironment;
  setupState.codex.implement = async options => { codexEnvironment = options.env; };
  const originalRun = setupState.runner.run;
  setupState.runner.run = async (command, args, options) => {
    if (command === 'npm') verifierEnvironment = options.env;
    if (command === 'git' && args[0] === '-c' && args.includes('push')) pushEnvironment = options.env;
    return originalRun(command, args, options);
  };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, environment: { PATH: 'safe', CODEX_HOME: 'codex-home', APPDATA: 'appdata', SSH_AUTH_SOCK: 'ssh-agent', GIT_ASKPASS: 'askpass', GITHUB_TOKEN: 'github-secret', OPENAI_API_KEY: 'openai-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret', RANDOM_VALUE: 'drop' }, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  await workflow.run({ repo: 'octo/example', issueNumber: 1, publish: false });
  assert.deepEqual(codexEnvironment, { PATH: 'safe', CODEX_HOME: 'codex-home', APPDATA: 'appdata' });
  assert.deepEqual(verifierEnvironment, codexEnvironment);
  assert.equal(pushEnvironment, undefined);
  setupState.store.close();
});

test('push environment retains approved SSH helpers but not raw credentials', async () => {
  const setupState = setup();
  let pushEnvironment;
  const originalRun = setupState.runner.run;
  setupState.runner.run = async (command, args, options) => {
    if (command === 'git' && args[0] === '-c' && args.includes('push')) pushEnvironment = options.env;
    if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
    return originalRun(command, args, options);
  };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, environment: { PATH: 'safe', SSH_AUTH_SOCK: 'ssh-agent', GIT_ASKPASS: 'askpass', SSH_ASKPASS: 'ssh-askpass', GITHUB_TOKEN: 'github-secret', OPENAI_API_KEY: 'openai-secret' }, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  await workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true });
  assert.equal(pushEnvironment.SSH_AUTH_SOCK, 'ssh-agent');
  assert.equal(pushEnvironment.GIT_ASKPASS, 'askpass');
  assert.equal(pushEnvironment.SSH_ASKPASS, 'ssh-askpass');
  assert.equal(pushEnvironment.GITHUB_TOKEN, undefined);
  assert.equal(pushEnvironment.OPENAI_API_KEY, undefined);
  setupState.store.close();
});

test('surfaces cleanup failure as a stable workflow error', async () => {
  const setupState = setup();
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => { throw new Error('cleanup failed'); } });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: false }), error => error.code === 'WORKFLOW_CLEANUP_FAILED');
  const failed = setupState.store.db.prepare('SELECT state, fields_json FROM claims ORDER BY id DESC LIMIT 1').get();
  assert.equal(failed.state, 'failed');
  assert.equal(JSON.parse(failed.fields_json).errorCode, 'WORKFLOW_CLEANUP_FAILED');
  setupState.store.close();
});

test('committed resume reuses a matching workspace without cloning', async () => {
  const setupState = setup();
  const claim = setupState.store.claimIssue({ repoId: setupState.repository.id, issueNumber: 1, workerId: 'worker-a' });
  setupState.store.transitionClaim(claim.id, 'running', { branch: 'patchpool/issue-1-1', workspace: 'worktree' });
  setupState.store.transitionClaim(claim.id, 'verified');
  setupState.store.transitionClaim(claim.id, 'committed', { commitSha: 'abc123', workspace: 'worktree' });
  setupState.runner.run = async (command, args, options) => {
    setupState.calls.push(['run', command, args]);
    if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
    if (command === 'git' && args[0] === 'remote') return { exitCode: 0, stdout: 'https://github.com/octo/example.git\n', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  setupState.github.findPullRequest = async () => ({ url: 'https://github.com/octo/example/pull/2', isDraft: true, headRefName: 'patchpool/issue-1-1', baseRefName: 'main', baseRepository: { fullName: 'octo/example' }, headRepository: { fullName: 'octo/example' }, body: 'AI-assisted implementation. Closes #1' });
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, workerId: 'worker-a', filesystem: { lstat: async () => ({ isDirectory: () => true }), realpath: async path => path, readdir: async () => [], readFile: async () => Buffer.from('') }, tempDirectoryFactory: async () => 'new-worktree', cleanup: async () => {} });
  const result = await workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true });
  assert.equal(result.state, 'pr_opened');
  assert.equal(setupState.calls.some(call => call[0] === 'clone'), false);
  setupState.store.close();
});

test('committed resume with an unusable workspace restarts from running in a fresh directory', async () => {
  const setupState = setup();
  const claim = setupState.store.claimIssue({ repoId: setupState.repository.id, issueNumber: 1, workerId: 'worker-a' });
  setupState.store.transitionClaim(claim.id, 'running', { branch: 'patchpool/issue-1-1', workspace: 'missing-worktree' });
  setupState.store.transitionClaim(claim.id, 'verified');
  setupState.store.transitionClaim(claim.id, 'committed', { commitSha: 'abc123', workspace: 'missing-worktree' });
  let cloned;
  setupState.github.clone = async (name, directory) => { cloned = directory; setupState.calls.push(['clone', directory]); };
  setupState.runner.run = async (command, args) => {
    setupState.calls.push(['run', command, args]);
    if (command === 'git' && args[0] === 'remote') return { exitCode: 0, stdout: 'https://github.com/octo/example.git\n', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: command === 'npm' ? '' : ' M src/app.js\n', stderr: '' };
  };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, workerId: 'worker-a', tempDirectoryFactory: async () => 'fresh-worktree', cleanup: async () => {} });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true }), error => error.code === 'WORKFLOW_VERIFICATION_FAILED' || error.code === 'WORKFLOW_COMMIT_FAILED');
  assert.equal(cloned, 'fresh-worktree');
  setupState.store.close();
});

test('does not synthesize a missing remote PR body from the local request', async () => {
  const setupState = setup();
  setupState.github.createDraftPullRequest = async input => ({ url: 'https://github.com/octo/example/pull/4', isDraft: true, headRefName: input.branch, baseRefName: input.base, baseRepository: { fullName: 'octo/example' }, headRepository: { fullName: 'octo/example' } });
  const originalRun = setupState.runner.run;
  setupState.runner.run = async (command, args, options) => {
    if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
    if (command === 'git' && args[0] === 'remote') return { exitCode: 0, stdout: 'https://github.com/octo/example.git\n', stderr: '' };
    return originalRun(command, args, options);
  };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true }), error => error.code === 'WORKFLOW_PR_DISCLOSURE_MISSING');
  setupState.store.close();
});

test('rejects a local origin remote that resolves to another repository', async () => {
  const setupState = setup();
  const originalRun = setupState.runner.run;
  setupState.runner.run = async (command, args, options) => {
    if (command === 'git' && args[0] === 'remote') return { exitCode: 0, stdout: 'https://github.com/other/repo.git\n', stderr: '' };
    return originalRun(command, args, options);
  };
  const { IssueWorkflow } = await import('../src/workflow.js');
  const workflow = new IssueWorkflow({ ...setupState, tempDirectoryFactory: async () => 'worktree', cleanup: async () => {} });
  await assert.rejects(() => workflow.run({ repo: 'octo/example', issueNumber: 1, publish: true }), error => error.code === 'WORKFLOW_REMOTE_MISMATCH');
  setupState.store.close();
});
