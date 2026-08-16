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

function assertSuccess(result, operation) {
  if (!result || result.exitCode !== 0) {
    const details = { exitCode: result?.exitCode, stderr: result?.stderr };
    throw new PatchPoolError('GITHUB_COMMAND_FAILED', `GitHub command failed during ${operation}`, details);
  }
}

function repositoryName(repository) {
  return requireFullName(typeof repository === 'string' ? repository : repository?.fullName ?? repository?.nameWithOwner);
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

export class GitHubClient {
  constructor({ runner, command = 'gh' } = {}) {
    if (!runner || typeof runner.run !== 'function') throw new TypeError('GitHubClient requires a CommandRunner');
    this.runner = runner;
    this.command = command;
  }

  async run(args, operation) {
    const result = await this.runner.run(this.command, args);
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
    const value = json(result.stdout, 'repository lookup');
    const returnedName = value.nameWithOwner ?? value.full_name;
    const isPrivate = value.isPrivate ?? value.private;
    const isArchived = value.isArchived ?? value.archived;
    const visibility = String(value.visibility ?? '').toLowerCase();
    if (returnedName !== canonical || isPrivate === true || isArchived === true || visibility === 'private') {
      throw new PatchPoolError('GITHUB_REPOSITORY_INELIGIBLE', `Repository is not canonical, public, and active: ${canonical}`);
    }
    if (returnedName === undefined || isPrivate === undefined || isArchived === undefined) {
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
    return json(result.stdout, 'issue lookup');
  }

  async listIssues(fullName) {
    const canonical = requireFullName(fullName);
    const result = await this.run(['api', `repos/${canonical}/issues?state=open&per_page=100`], 'issue listing');
    const value = json(result.stdout, 'issue listing');
    if (!Array.isArray(value)) throw new PatchPoolError('GITHUB_INVALID_JSON', 'GitHub issue listing was not an array');
    return value;
  }

  async clone(fullName, directory) {
    const canonical = requireFullName(fullName);
    if (typeof directory !== 'string' || directory.length === 0) throw new PatchPoolError('GITHUB_INVALID_DIRECTORY', 'Clone directory is required');
    await this.run(['repo', 'clone', canonical, directory], 'repository clone');
    return directory;
  }

  async getViewerLogin() {
    const result = await this.run(['api', 'user'], 'viewer lookup');
    const value = json(result.stdout, 'viewer lookup');
    if (typeof value?.login !== 'string' || value.login.length === 0) throw new PatchPoolError('GITHUB_INVALID_JSON', 'GitHub viewer response omitted login');
    return value.login;
  }

  async getPushRemote(repository) {
    const canonical = repositoryName(repository);
    const result = await this.run(['api', `repos/${canonical}`], 'push permission lookup');
    const value = json(result.stdout, 'push permission lookup');
    const canPush = value.permissions?.push ?? (value.viewerPermission === 'WRITE' || value.viewerPermission === 'ADMIN');
    if (!canPush) throw new PatchPoolError('GITHUB_PUSH_FORBIDDEN', `No push permission for ${canonical}`);
    return {
      ...value,
      fullName: canonical,
      canPush: true,
      remote: value.sshUrl ?? value.ssh_url ?? value.pushUrl ?? value.clone_url ?? value.url,
    };
  }

  async findPullRequest(fullName, branch) {
    const canonical = requireFullName(fullName);
    if (typeof branch !== 'string' || branch.length === 0 || /[\r\n]/.test(branch)) throw new PatchPoolError('GITHUB_INVALID_BRANCH', 'Branch is required');
    const result = await this.run(['pr', 'list', '--repo', canonical, '--head', branch, '--state', 'all'], 'pull request lookup');
    const value = json(result.stdout, 'pull request lookup');
    if (!Array.isArray(value)) throw new PatchPoolError('GITHUB_INVALID_JSON', 'GitHub pull request listing was not an array');
    return value.find(pr => pr?.headRefName === branch) ?? null;
  }

  async createDraftPullRequest(input) {
    const canonical = repositoryName(input?.repository ?? input?.fullName);
    const branch = input?.branch;
    if (typeof branch !== 'string' || branch.length === 0 || /[\r\n]/.test(branch)) throw new PatchPoolError('GITHUB_INVALID_BRANCH', 'Branch is required');
    const title = String(input?.title ?? '').trim();
    if (!title) throw new PatchPoolError('GITHUB_INVALID_PR', 'Pull request title is required');
    const base = String(input?.base ?? input?.defaultBranch ?? 'main');
    const create = await this.run(['pr', 'create', '--repo', canonical, '--head', branch, '--base', base, '--title', title, '--body', String(input?.body ?? ''), '--draft'], 'pull request creation');
    try {
      const structured = JSON.parse(String(create.stdout ?? '').trim());
      if (structured && typeof structured === 'object' && typeof structured.isDraft === 'boolean') {
        if (structured.isDraft !== true || (structured.headRefName !== undefined && structured.headRefName !== branch)) {
          throw new PatchPoolError('GITHUB_PR_NOT_DRAFT', 'Created pull request was not verified as Draft');
        }
        return { ...structured, isDraft: true };
      }
    } catch (error) {
      if (error instanceof PatchPoolError) throw error;
      // gh pr create normally prints a URL, so continue with URL verification.
    }
    const url = outputUrl(create.stdout);
    if (!url) throw new PatchPoolError('GITHUB_INVALID_JSON', 'GitHub pull request creation returned no URL');
    const verifyResult = await this.run(['pr', 'view', url, '--json', 'number,url,isDraft,headRefName'], 'pull request verification');
    const verified = json(verifyResult.stdout, 'pull request verification');
    if (verified.isDraft !== true || (verified.headRefName !== undefined && verified.headRefName !== branch)) {
      throw new PatchPoolError('GITHUB_PR_NOT_DRAFT', 'Created pull request was not verified as Draft');
    }
    return { ...verified, url: verified.url ?? url, isDraft: true };
  }
}
