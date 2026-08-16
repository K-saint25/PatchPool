import { PatchPoolError } from './errors.js';

const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function requireFullName(fullName) {
  if (typeof fullName !== 'string' || !FULL_NAME.test(fullName)) {
    throw new PatchPoolError('GITHUB_INVALID_REPOSITORY', 'Repository must use canonical owner/name form');
  }
  return fullName;
}

function json(stdout, context) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new PatchPoolError('GITHUB_INVALID_JSON', `GitHub returned malformed JSON for ${context}`);
  }
}

function jsonObject(stdout, context) {
  const value = json(stdout, context);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PatchPoolError('GITHUB_INVALID_JSON', `GitHub returned an invalid object for ${context}`);
  }
  return value;
}

function jsonArray(stdout, context) {
  const value = json(stdout, context);
  if (!Array.isArray(value)) throw new PatchPoolError('GITHUB_INVALID_JSON', `GitHub returned an invalid array for ${context}`);
  return value;
}

function assertSuccess(result, operation) {
  if (!result || result.exitCode !== 0) {
    const details = { exitCode: result?.exitCode, stderr: result?.stderr };
    throw new PatchPoolError('GITHUB_COMMAND_FAILED', `GitHub command failed during ${operation}`, details);
  }
}

function repositoryName(repository) {
  return requireFullName(typeof repository === 'string' ? repository : repository?.fullName ?? repository?.nameWithOwner);
}

function requirePullRequestUrl(value, canonical, code = 'GITHUB_INVALID_PR_URL') {
  if (typeof value !== 'string' || value.length === 0) throw new PatchPoolError(code, 'GitHub pull request URL is required');
  let parsed;
  try { parsed = new URL(value); } catch { throw new PatchPoolError(code, 'GitHub pull request URL is invalid'); }
  const prefix = `/${canonical}/pull/`;
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.href !== value || !parsed.pathname.startsWith(prefix) || !/^\d+$/.test(parsed.pathname.slice(prefix.length))) {
    throw new PatchPoolError(code, 'GitHub pull request URL does not match the requested repository');
  }
  return parsed.href;
}

function outputUrl(stdout) {
  const trimmed = String(stdout ?? '').trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed.url ?? parsed.html_url;
  } catch {
    // gh pr create prints the URL as plain text.
  }
  return trimmed.split(/\s+/).find(value => /^https:\/\/github\.com\//.test(value));
}

const PR_JSON_FIELDS = 'number,url,isDraft,headRefName,baseRefName,headRepository,isCrossRepository,body';

function prRepository(value) {
  return value?.fullName ?? value?.nameWithOwner ?? value?.full_name;
}

function normalizeRepoScopedPullRequest(value, canonical) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.isCrossRepository !== false || prRepository(value.headRepository) !== canonical) return null;
  return { ...value, baseRepository: { fullName: canonical } };
}

export class GitHubClient {
  constructor({ runner, command = 'gh' } = {}) {
    if (!runner || typeof runner.run !== 'function') throw new TypeError('GitHubClient requires a CommandRunner');
    this.runner = runner;
    this.command = command;
  }

  async run(args, operation, options) {
    const result = await this.runner.run(this.command, args, options);
    assertSuccess(result, operation);
    return result;
  }

  async preflight() {
    await this.run(['auth', 'status'], 'authentication preflight');
    return { authenticated: true };
  }

  async getRepository(fullName) {
    const canonical = requireFullName(fullName);
    const result = await this.run(['api', `repos/${canonical}`], 'repository lookup');
    const value = jsonObject(result.stdout, 'repository lookup');
    const returnedName = value.nameWithOwner ?? value.full_name;
    const isPrivate = value.isPrivate ?? value.private;
    const isArchived = value.isArchived ?? value.archived;
    const visibility = String(value.visibility ?? '').toLowerCase();
    const isPublic = visibility === 'public' && (value.isPublic === undefined || value.isPublic === true) && (value.public === undefined || value.public === true);
    if (returnedName !== canonical || isPrivate !== false || isArchived !== false || !isPublic) {
      throw new PatchPoolError('GITHUB_REPOSITORY_INELIGIBLE', `Repository is not canonical, public, and active: ${canonical}`);
    }
    if (typeof returnedName !== 'string' || isPrivate === undefined || isArchived === undefined) {
      throw new PatchPoolError('GITHUB_INVALID_JSON', 'GitHub repository response omitted required fields');
    }
    return {
      ...value,
      fullName: canonical,
      public: !isPrivate,
      archived: Boolean(isArchived),
      defaultBranch: value.defaultBranch ?? value.default_branch ?? value.defaultBranchRef?.name,
    };
  }

  async getIssue(fullName, number) {
    const canonical = requireFullName(fullName);
    if (!Number.isInteger(number) || number < 1) throw new PatchPoolError('GITHUB_INVALID_ISSUE', 'Issue number must be a positive integer');
    const result = await this.run(['api', `repos/${canonical}/issues/${number}`], 'issue lookup');
    return jsonObject(result.stdout, 'issue lookup');
  }

  async listIssues(fullName) {
    const canonical = requireFullName(fullName);
    const result = await this.run(['api', `repos/${canonical}/issues?state=open&per_page=100`], 'issue listing');
    return jsonArray(result.stdout, 'issue listing');
  }

  async clone(fullName, directory, options) {
    const canonical = requireFullName(fullName);
    if (typeof directory !== 'string' || directory.length === 0) throw new PatchPoolError('GITHUB_INVALID_DIRECTORY', 'Clone directory is required');
    await this.run(['repo', 'clone', canonical, directory], 'repository clone', options);
    return directory;
  }

  async getViewerLogin() {
    const result = await this.run(['api', 'user'], 'viewer lookup');
    const value = jsonObject(result.stdout, 'viewer lookup');
    if (typeof value?.login !== 'string' || value.login.length === 0) throw new PatchPoolError('GITHUB_INVALID_JSON', 'GitHub viewer response omitted login');
    return value.login;
  }

  async getPushRemote(repository) {
    const canonical = repositoryName(repository);
    const result = await this.run(['api', `repos/${canonical}`], 'push permission lookup');
    const value = jsonObject(result.stdout, 'push permission lookup');
    const canPush = value.permissions?.push ?? (value.viewerPermission === 'WRITE' || value.viewerPermission === 'ADMIN');
    if (!canPush) throw new PatchPoolError('GITHUB_PUSH_FORBIDDEN', `No push permission for ${canonical}`);
    return {
      ...value,
      fullName: canonical,
      canPush: true,
      remoteName: 'origin',
      remote: value.sshUrl ?? value.ssh_url ?? value.pushUrl ?? value.clone_url ?? value.url,
    };
  }

  async findPullRequest(fullName, branch, options) {
    const canonical = requireFullName(fullName);
    if (typeof branch !== 'string' || branch.length === 0 || /[\r\n]/.test(branch)) throw new PatchPoolError('GITHUB_INVALID_BRANCH', 'Branch is required');
    const result = await this.run(['pr', 'list', '--repo', canonical, '--head', branch, '--state', 'all', '--json', PR_JSON_FIELDS], 'pull request lookup', options);
    const value = jsonArray(result.stdout, 'pull request lookup');
    for (const pullRequest of value) {
      if (pullRequest?.headRefName !== branch) continue;
      const normalized = normalizeRepoScopedPullRequest(pullRequest, canonical);
      if (normalized) return normalized;
    }
    return null;
  }

  async createDraftPullRequest(input, options) {
    const canonical = repositoryName(input?.repository ?? input?.fullName);
    const branch = input?.branch;
    if (typeof branch !== 'string' || branch.length === 0 || /[\r\n]/.test(branch)) throw new PatchPoolError('GITHUB_INVALID_BRANCH', 'Branch is required');
    const title = String(input?.title ?? '').trim();
    if (!title) throw new PatchPoolError('GITHUB_INVALID_PR', 'Pull request title is required');
    const base = String(input?.base ?? input?.defaultBranch ?? 'main');
    const create = await this.run(['pr', 'create', '--repo', canonical, '--head', branch, '--base', base, '--title', title, '--body', String(input?.body ?? ''), '--draft'], 'pull request creation', options);
    let structured;
    try { structured = JSON.parse(String(create.stdout ?? '').trim()); } catch { structured = undefined; }
    const createdUrl = structured && typeof structured === 'object' && !Array.isArray(structured) ? structured.url ?? structured.html_url : outputUrl(create.stdout);
    const url = requirePullRequestUrl(createdUrl, canonical);
    if (!url) throw new PatchPoolError('GITHUB_INVALID_JSON', 'GitHub pull request creation returned no URL');
    const verifyResult = await this.run(['pr', 'view', url, '--json', PR_JSON_FIELDS], 'pull request verification', options);
    const verified = normalizeRepoScopedPullRequest(jsonObject(verifyResult.stdout, 'pull request verification'), canonical);
    if (!verified || verified.isDraft !== true || verified.headRefName !== branch || verified.baseRefName !== base || prRepository(verified.baseRepository) !== canonical || prRepository(verified.headRepository) !== canonical || typeof verified.body !== 'string') {
      throw new PatchPoolError('GITHUB_PR_NOT_DRAFT', 'Created pull request was not verified as Draft');
    }
    const verifiedUrl = verified.url === undefined ? url : requirePullRequestUrl(verified.url, canonical);
    if (verifiedUrl !== url) throw new PatchPoolError('GITHUB_PR_MISMATCH', 'Verified pull request did not match the created pull request');
    return { ...verified, url: verifiedUrl, isDraft: true, body: verified.body };
  }
}
