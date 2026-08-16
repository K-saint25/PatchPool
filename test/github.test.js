import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github.js';

function scriptedRunner(results) {
  const calls = [];
  return {
    calls,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result ?? { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

const repoJson = JSON.stringify({
  nameWithOwner: 'octo/example',
  isPrivate: false,
  isArchived: false,
  visibility: 'PUBLIC',
  defaultBranchRef: { name: 'main' },
});

test('preflight invokes gh auth status with an argv array', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: 'Logged in', stderr: '' }]);
  const client = new GitHubClient({ runner });
  await client.preflight();
  assert.deepEqual(runner.calls[0].args, ['auth', 'status']);
  assert.equal(runner.calls[0].options, undefined);
});

test('getRepository requests JSON and accepts only canonical public non-archived data', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: repoJson, stderr: '' }]);
  const client = new GitHubClient({ runner });
  const repository = await client.getRepository('octo/example');
  assert.equal(repository.fullName, 'octo/example');
  assert.equal(repository.public, true);
  assert.equal(repository.archived, false);
  assert.deepEqual(runner.calls[0].args, ['api', 'repos/octo/example']);
});

test('getRepository rejects malformed JSON and non-canonical/private/internal/archived repositories', async () => {
  for (const stdout of ['not-json', 'null', '[]', JSON.stringify({ nameWithOwner: 'octo/other', isPrivate: false, isArchived: false, visibility: 'PUBLIC' }), JSON.stringify({ nameWithOwner: 'octo/example', isPrivate: true, isArchived: false, visibility: 'PRIVATE' }), JSON.stringify({ nameWithOwner: 'octo/example', isPrivate: false, isArchived: true, visibility: 'PUBLIC' }), JSON.stringify({ nameWithOwner: 'octo/example', isPrivate: false, isArchived: false, visibility: 'INTERNAL' }), JSON.stringify({ nameWithOwner: 'octo/example', isPrivate: false, isArchived: false, visibility: 'INTERNAL', isPublic: true }), JSON.stringify({ nameWithOwner: 'octo/example', isPrivate: false, isArchived: false, visibility: 'PUBLIC', isPublic: false })]) {
    const runner = scriptedRunner([{ exitCode: 0, stdout, stderr: '' }]);
    const client = new GitHubClient({ runner });
    await assert.rejects(() => client.getRepository('octo/example'), error => error.code === 'GITHUB_INVALID_JSON' || error.code === 'GITHUB_REPOSITORY_INELIGIBLE');
  }
});

test('GitHub JSON object shape failures map to stable adapter errors', async () => {
  for (const action of [
    client => client.getIssue('octo/example', 4),
    client => client.getViewerLogin(),
    client => client.getPushRemote({ fullName: 'octo/example' }),
  ]) {
    const runner = scriptedRunner([{ exitCode: 0, stdout: 'null', stderr: '' }]);
    await assert.rejects(() => action(new GitHubClient({ runner })), error => error.code === 'GITHUB_INVALID_JSON');
  }
});

test('issue, list, clone, viewer, remote, and PR methods use safe gh argv', async () => {
  const runner = scriptedRunner([
    { exitCode: 0, stdout: JSON.stringify({ number: 4, title: 'Fix', state: 'OPEN' }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify([{ number: 4 }]), stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ login: 'octocat' }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ sshUrl: 'git@github.com:octo/example.git', viewerPermission: 'WRITE' }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify([{ number: 9, url: 'https://github.com/octo/example/pull/9', isDraft: true, headRefName: 'patch/4', headRepository: { nameWithOwner: 'octo/example' }, isCrossRepository: false }]), stderr: '' },
    { exitCode: 0, stdout: 'https://github.com/octo/example/pull/10\n', stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ number: 10, url: 'https://github.com/octo/example/pull/10', isDraft: true, headRefName: 'patch/4', baseRefName: 'main', headRepository: { nameWithOwner: 'octo/example' }, isCrossRepository: false, body: 'AI-assisted implementation. Closes #4' }), stderr: '' },
  ]);
  const client = new GitHubClient({ runner });
  await client.getIssue('octo/example', 4);
  await client.listIssues('octo/example');
  await client.clone('octo/example', 'C:\\tmp\\patch pool');
  await client.getViewerLogin();
  await client.getPushRemote({ fullName: 'octo/example' });
  await client.findPullRequest('octo/example', 'patch/4');
  const pr = await client.createDraftPullRequest({ repository: 'octo/example', branch: 'patch/4', title: 'Fix', body: 'Body', base: 'main' });
  assert.equal(pr.isDraft, true);
  assert.deepEqual(runner.calls[0].args, ['api', 'repos/octo/example/issues/4']);
  assert.deepEqual(runner.calls[1].args, ['api', 'repos/octo/example/issues?state=open&per_page=100']);
  assert.deepEqual(runner.calls[2].args, ['repo', 'clone', 'octo/example', 'C:\\tmp\\patch pool']);
  assert.deepEqual(runner.calls[3].args, ['api', 'user']);
  assert.deepEqual(runner.calls[4].args, ['api', 'repos/octo/example']);
  assert.deepEqual(runner.calls[5].args, ['pr', 'list', '--repo', 'octo/example', '--head', 'patch/4', '--state', 'all', '--json', 'number,url,isDraft,headRefName,baseRefName,headRepository,isCrossRepository,body']);
  assert.deepEqual(runner.calls[6].args, ['pr', 'create', '--repo', 'octo/example', '--head', 'patch/4', '--base', 'main', '--title', 'Fix', '--body', 'Body', '--draft']);
  assert.deepEqual(runner.calls[7].args, ['pr', 'view', 'https://github.com/octo/example/pull/10', '--json', 'number,url,isDraft,headRefName,baseRefName,headRepository,isCrossRepository,body']);
});

test('pull request commands receive cancellation and bounded timeout options', async () => {
  const runner = scriptedRunner([
    { exitCode: 0, stdout: '[]', stderr: '' },
    { exitCode: 0, stdout: 'https://github.com/octo/example/pull/10\n', stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ number: 10, url: 'https://github.com/octo/example/pull/10', isDraft: true, headRefName: 'patch/4', baseRefName: 'main', headRepository: { nameWithOwner: 'octo/example' }, isCrossRepository: false, body: 'AI-assisted implementation. Closes #4' }), stderr: '' },
  ]);
  const client = new GitHubClient({ runner });
  const controller = new AbortController();
  const options = { signal: controller.signal, timeoutMs: 12_345 };
  await client.findPullRequest('octo/example', 'patch/4', options);
  await client.createDraftPullRequest({ repository: 'octo/example', branch: 'patch/4', title: 'Fix', body: 'Body', base: 'main' }, options);
  assert.equal(runner.calls.length, 3);
  for (const call of runner.calls) {
    assert.equal(call.options.signal, controller.signal);
    assert.equal(call.options.timeoutMs, 12_345);
  }
});

test('repo-scoped PR commands request supported fields and normalize the canonical base repository', async () => {
  const foundPayload = {
    number: 9,
    url: 'https://github.com/octo/example/pull/9',
    isDraft: true,
    headRefName: 'patch/4',
    baseRefName: 'main',
    headRepository: { nameWithOwner: 'octo/example' },
    isCrossRepository: false,
    body: 'AI-assisted implementation. Closes #4',
  };
  const createdPayload = { ...foundPayload, number: 10, url: 'https://github.com/octo/example/pull/10' };
  const runner = scriptedRunner([
    { exitCode: 0, stdout: JSON.stringify([foundPayload]), stderr: '' },
    { exitCode: 0, stdout: `${createdPayload.url}\n`, stderr: '' },
    { exitCode: 0, stdout: JSON.stringify(createdPayload), stderr: '' },
  ]);
  const client = new GitHubClient({ runner });

  const found = await client.findPullRequest('octo/example', 'patch/4');
  const created = await client.createDraftPullRequest({ repository: 'octo/example', branch: 'patch/4', title: 'Fix', body: foundPayload.body, base: 'main' });

  assert.deepEqual(found.baseRepository, { fullName: 'octo/example' });
  assert.deepEqual(created.baseRepository, { fullName: 'octo/example' });
  for (const call of [runner.calls[0], runner.calls[2]]) {
    const fields = call.args[call.args.indexOf('--json') + 1].split(',');
    assert.equal(fields.includes('baseRepository'), false);
    assert.equal(fields.includes('isCrossRepository'), true);
  }
});

test('PR lookup ignores fork and incomplete head repository results', async () => {
  const runner = scriptedRunner([
    { exitCode: 0, stdout: JSON.stringify([
      { headRefName: 'patch/4', headRepository: { nameWithOwner: 'fork/example' }, isCrossRepository: true },
      { headRefName: 'patch/4', headRepository: { nameWithOwner: 'octo/example' } },
    ]), stderr: '' },
  ]);
  const client = new GitHubClient({ runner });
  assert.equal(await client.findPullRequest('octo/example', 'patch/4'), null);
});

test('clone forwards cancellation and bounded timeout options to the command runner', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: '', stderr: '' }]);
  const client = new GitHubClient({ runner });
  const controller = new AbortController();
  const options = { signal: controller.signal, timeoutMs: 12_345 };
  await client.clone('octo/example', 'C:\\tmp\\patch pool', options);
  assert.deepEqual(runner.calls[0].args, ['repo', 'clone', 'octo/example', 'C:\\tmp\\patch pool']);
  assert.equal(runner.calls[0].options.signal, controller.signal);
  assert.equal(runner.calls[0].options.timeoutMs, 12_345);
});

test('createDraftPullRequest rejects a response that is not verified as Draft', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: 'https://github.com/octo/example/pull/1\n', stderr: '' }, { exitCode: 0, stdout: JSON.stringify({ number: 1, url: 'https://github.com/octo/example/pull/1', isDraft: false }), stderr: '' }]);
  const client = new GitHubClient({ runner });
  await assert.rejects(() => client.createDraftPullRequest({ repository: 'octo/example', branch: 'patch/4', title: 'Fix', body: 'Body' }), error => error.code === 'GITHUB_PR_NOT_DRAFT');
});

test('createDraftPullRequest always verifies a structured Draft response remotely', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: JSON.stringify({ number: 2, url: 'https://github.com/octo/example/pull/2', isDraft: true }), stderr: '' }, { exitCode: 0, stdout: JSON.stringify({ number: 2, url: 'https://github.com/octo/example/pull/2', isDraft: true, headRefName: 'patch/4', baseRefName: 'main', headRepository: { nameWithOwner: 'octo/example' }, isCrossRepository: false, body: 'AI-assisted implementation. Closes #2' }), stderr: '' }]);
  const client = new GitHubClient({ runner });
  const pr = await client.createDraftPullRequest({ repository: 'octo/example', branch: 'patch/4', title: 'Fix', body: 'Body' });
  assert.equal(pr.isDraft, true);
  assert.deepEqual(runner.calls[1].args, ['pr', 'view', 'https://github.com/octo/example/pull/2', '--json', 'number,url,isDraft,headRefName,baseRefName,headRepository,isCrossRepository,body']);
});

test('createDraftPullRequest rejects a URL for a different repository before reconciliation', async () => {
  const runner = scriptedRunner([{ exitCode: 0, stdout: 'https://github.com/other/repo/pull/2\n', stderr: '' }]);
  const client = new GitHubClient({ runner });
  await assert.rejects(() => client.createDraftPullRequest({ repository: 'octo/example', branch: 'patch/4', title: 'Fix', body: 'Body' }), error => error.code === 'GITHUB_INVALID_PR_URL');
  assert.equal(runner.calls.length, 1);
});

test('createDraftPullRequest rejects credentials, explicit ports, queries, and hashes in PR URLs', async () => {
  for (const url of [
    'https://user:pass@github.com/octo/example/pull/2',
    'https://github.com:443/octo/example/pull/2',
    'https://github.com:444/octo/example/pull/2',
    'https://github.com/octo/example/pull/2?x=1',
    'https://github.com/octo/example/pull/2#fragment',
  ]) {
    const runner = scriptedRunner([{ exitCode: 0, stdout: `${url}\n`, stderr: '' }]);
    const client = new GitHubClient({ runner });
    await assert.rejects(() => client.createDraftPullRequest({ repository: 'octo/example', branch: 'patch/4', title: 'Fix', body: 'Body' }), error => error.code === 'GITHUB_INVALID_PR_URL');
    assert.equal(runner.calls.length, 1);
  }
});
