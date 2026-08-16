import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PatchPoolError } from './errors.js';
import { evaluateIssueEligibility } from './policy.js';
import { buildImplementationPrompt } from './prompt.js';

const SECRET_FILE = /(?:^|[\\/])(?:\.env(?:\.|$)|\.ssh(?:[\\/]|$)|\.aws(?:[\\/]|$)|\.git-credentials(?:\.|$)|.*\.(?:pem|key|p12|pfx)|.*id_(?:rsa|ecdsa|ed25519)(?:\.|$)|.*private[_-]?key.*|.*credentials?(?:\.|$)|.*secrets?(?:\.|$)|.*token.*)|(?:^|[\\/])\.\.(?:[\\/]|$)/i;

function asError(error, fallback = 'WORKFLOW_FAILED') {
  if (error instanceof PatchPoolError) return error;
  return new PatchPoolError(fallback, error?.message ?? String(error));
}

function repositoryName(value) {
  const name = typeof value === 'string' ? value : value?.fullName ?? value?.nameWithOwner;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) {
    throw new PatchPoolError('WORKFLOW_INVALID_REPOSITORY', 'Workflow repository must use canonical owner/name form');
  }
  return name;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPullRequest(issue) {
  return Boolean(issue?.pull_request ?? issue?.pullRequest ?? issue?.isPullRequest) ||
    String(issue?.type ?? '').toLowerCase() === 'pullrequest';
}

function issueNumber(issue, requested) {
  const number = Number(issue?.number ?? requested);
  if (!Number.isInteger(number) || number < 1) throw new PatchPoolError('WORKFLOW_INVALID_ISSUE', 'Issue number must be a positive integer');
  return number;
}

function outputLines(stdout) {
  return String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function changedPaths(stdout) {
  return outputLines(stdout).map(line => line.length > 3 && /^[ MADRCU?!]{2}\s/.test(line) ? line.slice(3) : line);
}

function untrackedPaths(stdout) {
  return outputLines(stdout).filter(line => /^\?\?\s/.test(line)).map(line => line.slice(3));
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function defaultTempDirectoryFactory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function defaultCleanup(directory) {
  return rm(directory, { recursive: true, force: true });
}

function pullRequestRepository(pr, side) {
  const value = side === 'base' ? (pr?.baseRepository ?? pr?.baseRepo ?? pr?.base?.repository ?? pr?.base?.repo) : (pr?.headRepository ?? pr?.headRepo ?? pr?.head?.repository ?? pr?.head?.repo);
  return value?.fullName ?? value?.nameWithOwner ?? value?.full_name;
}

function validatePullRequest(pr, repository, base, branch, issueNumberValue) {
  if (!pr || typeof pr !== 'object') throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Reconciled pull request response is invalid');
  if (pr.isDraft !== true) throw new PatchPoolError('WORKFLOW_PR_NOT_DRAFT', 'Pull request is not Draft');
  if (pr.headRefName !== undefined && pr.headRefName !== branch) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request head does not match the worker branch');
  const baseRef = pr.baseRefName ?? pr.baseBranch ?? pr.base?.ref;
  if (baseRef !== undefined && baseRef !== base) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request base does not match the repository default branch');
  const baseRepository = pullRequestRepository(pr, 'base');
  if (baseRepository !== undefined && baseRepository !== repository) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request base repository does not match the requested repository');
  const headRepository = pullRequestRepository(pr, 'head');
  if (headRepository !== undefined && headRepository !== repository) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request head repository does not match the requested repository');
  if (typeof pr.url !== 'string' || !new RegExp(`^https://github\\.com/${escapeRegex(repository)}/pull/\\d+$`).test(pr.url)) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request URL is invalid or belongs to another repository');
  if (typeof pr.body === 'string' && (!/AI-assisted implementation/i.test(pr.body) || !new RegExp(`/issues/${issueNumberValue}\\b`).test(pr.body))) throw new PatchPoolError('WORKFLOW_PR_DISCLOSURE_MISSING', 'Pull request body must contain the AI disclosure and Issue link');
  return pr;
}

export class IssueWorkflow {
  constructor({
    store,
    github,
    codex,
    runner,
    tempDirectoryFactory = defaultTempDirectoryFactory,
    cleanup = defaultCleanup,
    workerId,
    clock = () => new Date().toISOString(),
    randomId = randomUUID,
    promptBuilder = buildImplementationPrompt,
    codexTimeoutMs,
  } = {}) {
    if (!store || typeof store.getRepository !== 'function' || typeof store.claimIssue !== 'function' || typeof store.transitionClaim !== 'function') throw new TypeError('IssueWorkflow requires a PatchPoolStore');
    if (!github) throw new TypeError('IssueWorkflow requires a GitHubClient');
    if (!codex) throw new TypeError('IssueWorkflow requires a CodexClient');
    if (!runner || typeof runner.run !== 'function') throw new TypeError('IssueWorkflow requires a CommandRunner');
    this.store = store;
    this.github = github;
    this.codex = codex;
    this.runner = runner;
    this.tempDirectoryFactory = tempDirectoryFactory;
    this.cleanup = cleanup;
    this.workerId = workerId ?? `worker-${randomId()}`;
    this.clock = clock;
    this.randomId = randomId;
    this.promptBuilder = promptBuilder;
    this.codexTimeoutMs = codexTimeoutMs;
  }

  async command(args, cwd, code, operation) {
    let result;
    try {
      result = await this.runner.run('git', args, cwd ? { cwd } : undefined);
    } catch (error) {
      throw asError(error, code);
    }
    if (!result || result.exitCode !== 0) throw new PatchPoolError(code, operation, { exitCode: result?.exitCode, stderr: result?.stderr });
    return result;
  }

  async invoke(command, args, options, code, operation) {
    let result;
    try {
      result = await this.runner.run(command, args, options);
    } catch (error) {
      throw asError(error, code);
    }
    if (!result || result.exitCode !== 0) throw new PatchPoolError(code, operation, { exitCode: result?.exitCode, stderr: result?.stderr });
    return result;
  }

  async status(directory) {
    const result = await this.command(['status', '--porcelain'], directory, 'WORKFLOW_GIT_FAILED', 'Unable to inspect worktree status');
    return { all: changedPaths(result.stdout), untracked: untrackedPaths(result.stdout) };
  }

  async assertEligible(repository, issue) {
    if (isPullRequest(issue)) throw new PatchPoolError('WORKFLOW_PULL_REQUEST', 'Pull request responses cannot be processed as issues');
    const decision = evaluateIssueEligibility(repository, issue);
    if (!decision.eligible) throw new PatchPoolError('WORKFLOW_ISSUE_INELIGIBLE', `Issue is not eligible: ${decision.reason}`, { reason: decision.reason });
    return issue;
  }

  async refresh(repositoryNameValue, number, expectedRepository) {
    const repository = await this.github.getRepository(repositoryNameValue);
    if (repository?.fullName !== repositoryNameValue || repository?.public === false || repository?.isPrivate === true || repository?.archived === true || repository?.isArchived === true || ['private', 'internal'].includes(String(repository?.visibility ?? '').toLowerCase())) {
      throw new PatchPoolError('WORKFLOW_REPOSITORY_INELIGIBLE', 'Repository changed eligibility during the workflow');
    }
    const issue = await this.github.getIssue(repositoryNameValue, number);
    await this.assertEligible({ ...expectedRepository, ...repository, fullName: repositoryNameValue }, issue);
    return { repository, issue };
  }

  async transition(claim, state, fields = {}) {
    return this.store.transitionClaim(claim.id, state, { ...fields, updatedAt: this.clock() });
  }

  async fail(claim, error) {
    if (!claim) return;
    const current = this.store.getClaim?.(claim.id);
    if (!current || ['failed', 'released', 'completed', 'pr_opened'].includes(current.state)) return;
    try {
      this.store.transitionClaim(claim.id, 'failed', { errorCode: error.code ?? 'WORKFLOW_FAILED', error: error.message, failedAt: this.clock() });
    } catch {
      // Preserve the original workflow error if the store itself is unavailable.
    }
  }

  async run({ repo, issueNumber: requestedIssueNumber, publish = false, keepWorkspace = false } = {}) {
    const fullName = repositoryName(repo);
    const approved = this.store.getRepository(fullName);
    if (!approved) throw new PatchPoolError('REPOSITORY_NOT_FOUND', `Repository is not registered: ${fullName}`);
    if (!approved.active) throw new PatchPoolError('REPOSITORY_INACTIVE', `Repository is inactive: ${fullName}`);
    if (!approved.public) throw new PatchPoolError('REPOSITORY_NOT_PUBLIC', `Repository is not public: ${fullName}`);

    let claim;
    let workspace;
    let commitSha;
    let pr;
    let branch;
    try {
      const canonical = await this.github.getRepository(fullName);
      if (canonical?.fullName !== fullName || canonical?.public === false || canonical?.isPrivate === true || canonical?.archived === true || canonical?.isArchived === true || ['private', 'internal'].includes(String(canonical?.visibility ?? '').toLowerCase())) throw new PatchPoolError('WORKFLOW_REPOSITORY_INELIGIBLE', `Repository is not eligible: ${fullName}`);

      let issue;
      if (requestedIssueNumber !== undefined) {
        issue = await this.github.getIssue(fullName, Number(requestedIssueNumber));
        await this.assertEligible({ ...approved, ...canonical, fullName }, issue);
      } else {
        const issues = await this.github.listIssues(fullName);
        issue = issues.find(candidate => !isPullRequest(candidate) && evaluateIssueEligibility({ ...approved, ...canonical }, candidate).eligible);
        if (!issue) throw new PatchPoolError('WORKFLOW_NO_ELIGIBLE_ISSUE', 'No eligible issue is available');
      }
      const number = issueNumber(issue, requestedIssueNumber);
      claim = this.store.claimIssue({ repoId: approved.id, issueNumber: number, workerId: this.workerId, fields: { title: issue.title, claimedAt: this.clock() } });

      const refreshed = await this.refresh(fullName, number, { ...approved, ...canonical });
      const runId = String(claim.id ?? this.randomId());
      branch = `patchpool/issue-${number}-${runId}`;
      workspace = await this.tempDirectoryFactory(`patchpool-${number}-${runId}-`);
      await this.github.clone(fullName, workspace);
      claim = await this.transition(claim, 'running', { branch, workspace, startedAt: this.clock() });
      await this.command(['switch', '-c', branch], workspace, 'WORKFLOW_BRANCH_FAILED', 'Unable to create the worker branch');

      const prompt = this.promptBuilder({ repository: { ...approved, ...refreshed.repository, fullName }, issue: refreshed.issue, verificationArgv: [...approved.verificationArgv] });
      await this.codex.implement({ cwd: workspace, prompt, timeoutMs: this.codexTimeoutMs });
      claim = await this.transition(claim, 'verifying', { codexCompletedAt: this.clock() });
      const afterCodex = await this.status(workspace);
      const paths = [...afterCodex.all, ...afterCodex.untracked];
      if (paths.length === 0) throw new PatchPoolError('WORKFLOW_NO_CHANGES', 'Codex produced no worktree changes');
      if (paths.some(path => SECRET_FILE.test(path))) throw new PatchPoolError('WORKFLOW_SUSPICIOUS_FILE', 'Codex produced a suspicious secret-like filename');
      await this.invoke('git', ['diff', '--check'], { cwd: workspace }, 'WORKFLOW_DIFF_CHECK_FAILED', 'Git diff check failed');

      const verification = [...approved.verificationArgv];
      if (!verification.length || verification.some(argument => typeof argument !== 'string' || !argument)) throw new PatchPoolError('WORKFLOW_INVALID_VERIFICATION', 'Repository verification argv is invalid');
      await this.invoke(verification[0], verification.slice(1), { cwd: workspace }, 'WORKFLOW_VERIFICATION_FAILED', 'Approved verification command failed');
      const afterVerification = await this.status(workspace);
      const beforeVerificationPaths = new Set(afterCodex.all);
      const verificationAdded = afterVerification.all.filter(path => !beforeVerificationPaths.has(path));
      if (verificationAdded.length > 0 || !sameSet(new Set(afterCodex.untracked), new Set(afterVerification.untracked))) throw new PatchPoolError('WORKFLOW_VERIFICATION_ADDED_FILES', 'Verification added files to the worktree');
      claim = await this.transition(claim, 'verified', { verifiedAt: this.clock() });

      if (!publish) return { state: claim.state, claimId: claim.id, issueNumber: number, branch, workspace: keepWorkspace ? workspace : undefined };

      await this.command(['add', '-A'], workspace, 'WORKFLOW_COMMIT_FAILED', 'Unable to stage the worktree changes');
      await this.invoke('git', ['-c', 'core.hooksPath=NUL', 'commit', '--no-verify', '-m', `PatchPool: resolve issue #${number}`], { cwd: workspace }, 'WORKFLOW_COMMIT_FAILED', 'Unable to commit the worktree changes');
      commitSha = (await this.command(['rev-parse', 'HEAD'], workspace, 'WORKFLOW_COMMIT_FAILED', 'Unable to resolve the commit SHA')).stdout.trim();
      claim = await this.transition(claim, 'committed', { commitSha, committedAt: this.clock() });

      const beforePush = await this.refresh(fullName, number, { ...approved, ...canonical });
      const pushPermission = await this.github.getPushRemote({ fullName });
      if (pushPermission?.canPush === false) throw new PatchPoolError('WORKFLOW_PUSH_FORBIDDEN', `No push permission for ${fullName}`);
      await this.invoke('git', ['push', '--set-upstream', 'origin', branch], { cwd: workspace }, 'WORKFLOW_PUSH_FAILED', 'Unable to push the worker branch');
      claim = await this.transition(claim, 'pushed', { pushedAt: this.clock() });

      const base = beforePush.repository.defaultBranch ?? canonical.defaultBranch ?? 'main';
      let found = await this.github.findPullRequest(fullName, branch);
      if (found) {
        pr = validatePullRequest(found, fullName, base, branch, number);
      } else {
        const body = `## PatchPool\n\nAI-assisted implementation generated by the local PatchPool worker. A human maintainer must review the changes.\n\nCloses https://github.com/${fullName}/issues/${number}`;
        try {
          pr = await this.github.createDraftPullRequest({ repository: fullName, branch, base, title: beforePush.issue.title ?? issue.title ?? `Resolve issue #${number}`, body });
        } catch (createError) {
          const reconciled = await this.github.findPullRequest(fullName, branch).catch(() => null);
          if (!reconciled) throw createError;
          pr = validatePullRequest(reconciled, fullName, base, branch, number);
        }
        pr = validatePullRequest(pr, fullName, base, branch, number);
      }
      claim = await this.transition(claim, 'pr_opened', { prUrl: pr.url, pullRequestUrl: pr.url, openedAt: this.clock() });
      return { state: claim.state, claimId: claim.id, issueNumber: number, branch, commitSha, prUrl: pr.url, workspace: keepWorkspace ? workspace : undefined };
    } catch (cause) {
      const error = asError(cause);
      await this.fail(claim, error);
      throw error;
    } finally {
      if (workspace && !keepWorkspace) {
        try { await this.cleanup(workspace); } catch { /* cleanup must not hide the workflow result */ }
      }
    }
  }
}

export { isPullRequest, validatePullRequest };
