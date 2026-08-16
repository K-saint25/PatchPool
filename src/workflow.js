import { mkdtemp, rm } from 'node:fs/promises';
import * as defaultFilesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { PatchPoolError } from './errors.js';
import { evaluateIssueEligibility } from './policy.js';
import { buildImplementationPrompt } from './prompt.js';
import { resolveWorkerId } from './worker.js';

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

function parseStatus(stdout) {
  const value = String(stdout ?? '');
  const tokens = value.includes('\0') ? value.split('\0') : value.split(/\r?\n/);
  const paths = [];
  const untracked = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (!record || record.length < 3 || !/^[ MADRCU?!]{2} /.test(record)) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;
    paths.push(path);
    if (status === '??') untracked.push(path);
    if (status[0] === 'R' || status[0] === 'C') {
      const original = tokens[index + 1];
      if (original !== undefined && original !== '') {
        paths.push(original);
        index += 1;
      }
    }
  }
  return { paths: [...new Set(paths)], untracked: [...new Set(untracked)] };
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function sanitizeEnvironment(source = process.env, { push = false } = {}) {
  const allow = /^(?:PATH|PATHEXT|SystemRoot|SYSTEMROOT|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|CODEX_HOME|ComSpec|COMSPEC|windir|USER|USERNAME|LANG|LC_[A-Z_]+|NODE_PATH)$/i;
  const pushAllow = /^(?:SSH_AUTH_SOCK|GIT_ASKPASS|SSH_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_TERMINAL_PROMPT)$/i;
  const secret = /(?:GH|GITHUB|OPENAI|AWS|AZURE|GOOGLE|CLOUD|TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
  const result = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    if ((allow.test(name) || (push && pushAllow.test(name))) && !secret.test(name) && value !== undefined) result[name] = String(value);
  }
  return result;
}

function defaultTempDirectoryFactory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function defaultCleanup(directory, options = {}) {
  return rm(directory, { recursive: true, force: true, maxRetries: options.maxRetries ?? 3, retryDelay: options.retryDelay ?? 25 });
}

function pullRequestRepository(pr, side) {
  const value = side === 'base' ? (pr?.baseRepository ?? pr?.baseRepo ?? pr?.base?.repository ?? pr?.base?.repo) : (pr?.headRepository ?? pr?.headRepo ?? pr?.head?.repository ?? pr?.head?.repo);
  return value?.fullName ?? value?.nameWithOwner ?? value?.full_name;
}

function remoteMatches(value, repository) {
  const text = String(value ?? '').trim();
  const ssh = text.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  const https = text.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  return (ssh?.[1] ?? https?.[1]) === repository;
}

function remoteUrls(stdout) {
  return String(stdout ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function validatePullRequest(pr, repository, base, branch, issueNumberValue) {
  if (!pr || typeof pr !== 'object') throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Reconciled pull request response is invalid');
  if (pr.isDraft !== true) throw new PatchPoolError('WORKFLOW_PR_NOT_DRAFT', 'Pull request is not Draft');
  if (pr.headRefName !== branch) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request head does not match the worker branch');
  const baseRef = pr.baseRefName ?? pr.baseBranch ?? pr.base?.ref;
  if (baseRef !== base) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request base does not match the repository default branch');
  const baseRepository = pullRequestRepository(pr, 'base');
  if (baseRepository !== repository) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request base repository does not match the requested repository');
  const headRepository = pullRequestRepository(pr, 'head');
  if (headRepository !== repository) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request head repository does not match the requested repository');
  if (typeof pr.url !== 'string' || !new RegExp(`^https://github\\.com/${escapeRegex(repository)}/pull/\\d+$`).test(pr.url)) throw new PatchPoolError('WORKFLOW_PR_MISMATCH', 'Pull request URL is invalid or belongs to another repository');
  if (typeof pr.body !== 'string' || !/AI-assisted implementation/i.test(pr.body) || !new RegExp(`Closes #${issueNumberValue}\\b`).test(pr.body)) throw new PatchPoolError('WORKFLOW_PR_DISCLOSURE_MISSING', 'Pull request body must contain the AI disclosure and Issue link');
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
    filesystem = defaultFilesystem,
    environment = process.env,
    hooksDirectoryFactory = defaultTempDirectoryFactory,
    cleanupMaxRetries = 3,
    cleanupRetryDelay = 25,
    leaseTtlMs = 300_000,
    leaseHeartbeatMs = Math.max(1_000, Math.floor(leaseTtlMs / 3)),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
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
    this.workerId = workerId ?? resolveWorkerId();
    this.clock = clock;
    this.randomId = randomId;
    this.promptBuilder = promptBuilder;
    this.codexTimeoutMs = codexTimeoutMs;
    this.filesystem = filesystem;
    this.environment = environment;
    this.hooksDirectoryFactory = hooksDirectoryFactory;
    this.cleanupMaxRetries = cleanupMaxRetries;
    this.cleanupRetryDelay = cleanupRetryDelay;
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0 || !Number.isFinite(leaseHeartbeatMs) || leaseHeartbeatMs <= 0 || leaseHeartbeatMs >= leaseTtlMs) {
      throw new TypeError('IssueWorkflow requires a positive lease heartbeat interval shorter than its TTL');
    }
    this.leaseTtlMs = leaseTtlMs;
    this.leaseHeartbeatMs = leaseHeartbeatMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
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
    const result = await this.command(['status', '--porcelain=v1', '-z', '--untracked-files=all'], directory, 'WORKFLOW_GIT_FAILED', 'Unable to inspect worktree status');
    return parseStatus(result.stdout);
  }

  async fingerprint(directory, status) {
    const root = resolve(directory);
    const rootReal = await this.filesystem.realpath(root).catch(() => root);
    const result = new Map();
    for (const path of status.paths) {
      if (SECRET_FILE.test(path)) throw new PatchPoolError('WORKFLOW_SUSPICIOUS_FILE', 'Codex produced a suspicious secret-like filename');
      const absolute = resolve(root, path);
      const relativePath = relative(root, absolute);
      if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || !relativePath || relativePath.startsWith('..') || relativePath.includes('..' + '\\') || relativePath.includes('../') || absolute === root) throw new PatchPoolError('WORKFLOW_PATH_ESCAPE', 'Changed path escapes the isolated worktree');
      let stat;
      try { stat = await this.filesystem.lstat(absolute); } catch (error) {
        if (error?.code === 'ENOENT') { result.set(path, 'missing'); continue; }
        throw new PatchPoolError('WORKFLOW_FILE_INSPECTION_FAILED', 'Unable to inspect a changed path');
      }
      if (stat.isSymbolicLink()) throw new PatchPoolError('WORKFLOW_SYMLINK', 'Changed symlinks are not allowed');
      const parts = relative(root, absolute).split(/[\\/]/).filter(Boolean);
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        try {
          if ((await this.filesystem.lstat(parent)).isSymbolicLink()) throw new PatchPoolError('WORKFLOW_SYMLINK', 'Changed paths through symlinked directories are not allowed');
        } catch (error) {
          if (error instanceof PatchPoolError) throw error;
          break;
        }
      }
      const resolved = await this.filesystem.realpath(absolute).catch(() => absolute);
      const resolvedRelative = relative(rootReal, resolved);
      if (resolvedRelative.startsWith('..') || resolvedRelative.includes('..' + '\\') || resolvedRelative.includes('../')) throw new PatchPoolError('WORKFLOW_PATH_ESCAPE', 'Changed path resolves outside the isolated worktree');
      let content;
      try { content = await this.filesystem.readFile(absolute); } catch (error) {
        if (error?.code === 'EISDIR') content = Buffer.from('<directory>');
        else throw new PatchPoolError('WORKFLOW_FILE_INSPECTION_FAILED', 'Unable to fingerprint a changed path');
      }
      const digest = createHash('sha256').update(content).digest('hex');
      result.set(path, `${stat.mode & 0o7777}:${digest}`);
    }
    return result;
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

  assertLease(controller) {
    if (!controller?.lease) throw new PatchPoolError('LEASE_LOST', 'Execution lease is unavailable');
    if (controller.error) throw controller.error;
    return this.store.assertExecutionLease(controller.lease.claimId, controller.lease.workerId, controller.lease.token);
  }

  async withLease(controller, operation) {
    this.assertLease(controller);
    try {
      const result = await operation();
      this.assertLease(controller);
      return result;
    } catch (error) {
      this.assertLease(controller);
      throw error;
    }
  }

  startLeaseHeartbeat(lease) {
    const controller = { lease, error: null, timer: null };
    controller.timer = this.setIntervalFn(() => {
      if (controller.error) return;
      try {
        controller.lease = this.store.renewExecutionLease(
          controller.lease.claimId,
          controller.lease.workerId,
          controller.lease.token,
          { ttlMs: this.leaseTtlMs },
        );
      } catch (cause) {
        controller.error = asError(cause, 'LEASE_LOST');
      }
    }, this.leaseHeartbeatMs);
    controller.timer?.unref?.();
    return controller;
  }

  stopLeaseHeartbeat(controller) {
    if (controller?.timer) this.clearIntervalFn(controller.timer);
  }

  async transition(claim, state, fields = {}, controller) {
    this.assertLease(controller);
    const result = this.store.transitionClaimWithLease(claim.id, state, { ...fields, updatedAt: this.clock() }, controller.lease);
    this.assertLease(controller);
    return result;
  }

  async restart(claim, fields, controller) {
    this.assertLease(controller);
    const result = this.store.restartClaimWithLease(claim.id, fields, controller.lease);
    this.assertLease(controller);
    return result;
  }

  async fail(claim, error, controller) {
    if (!claim) return;
    const current = this.store.getClaim?.(claim.id);
    if (!current || current.state === 'pr_opened') return;
    try {
      await this.transition(current, 'failed', { errorCode: error.code ?? 'WORKFLOW_FAILED', failedAt: this.clock() }, controller);
    } catch {
      // Preserve the original workflow error if the store itself is unavailable.
    }
  }

  async openPullRequest({ fullName, base, branch, number, title, publish }) {
    let found = await this.github.findPullRequest(fullName, branch);
    if (found) return validatePullRequest(found, fullName, base, branch, number);
    if (!publish) throw new PatchPoolError('WORKFLOW_PR_NOT_FOUND', 'Published Draft pull request was not found');
    const body = `## PatchPool\n\nAI-assisted implementation generated by the local PatchPool worker. A human maintainer must review the changes.\n\nCloses #${number} (https://github.com/${fullName}/issues/${number})`;
    let created;
    try {
      created = await this.github.createDraftPullRequest({ repository: fullName, branch, base, title: title ?? `Resolve issue #${number}`, body });
    } catch (createError) {
      const reconciled = await this.github.findPullRequest(fullName, branch).catch(() => null);
      if (!reconciled) throw createError;
      return validatePullRequest(reconciled, fullName, base, branch, number);
    }
    return validatePullRequest(created, fullName, base, branch, number);
  }

  async verifyRemote(directory, remoteName, repository) {
    const options = { cwd: directory, env: sanitizeEnvironment(this.environment) };
    const fetchResult = await this.invoke('git', ['remote', 'get-url', '--all', remoteName], options, 'WORKFLOW_REMOTE_MISMATCH', 'Unable to resolve the local Git fetch remote');
    const pushResult = await this.invoke('git', ['remote', 'get-url', '--push', '--all', remoteName], options, 'WORKFLOW_REMOTE_MISMATCH', 'Unable to resolve the local Git push remote');
    const fetchUrls = remoteUrls(fetchResult.stdout);
    const pushUrls = remoteUrls(pushResult.stdout);
    if (fetchUrls.length === 0 || pushUrls.length === 0 || !fetchUrls.every(url => remoteMatches(url, repository)) || !pushUrls.every(url => remoteMatches(url, repository))) {
      throw new PatchPoolError('WORKFLOW_REMOTE_MISMATCH', 'Every local Git fetch and push URL must match the approved repository');
    }
  }

  async reusableCommittedWorkspace(directory, commitSha) {
    if (!directory || !commitSha) return false;
    try {
      const stat = await this.filesystem.lstat(directory);
      if (!stat.isDirectory()) return false;
      const head = (await this.command(['rev-parse', 'HEAD'], directory, 'WORKFLOW_RESUME_UNAVAILABLE', 'Unable to inspect the committed workspace')).stdout.trim();
      return head === commitSha;
    } catch {
      return false;
    }
  }

  async ensureEmptyWorkspace(directory) {
    try {
      const entries = await this.filesystem.readdir(directory);
      if (entries.length > 0) throw new PatchPoolError('WORKFLOW_WORKSPACE_NOT_EMPTY', 'Temporary workspace is not empty');
    } catch (error) {
      if (error instanceof PatchPoolError) throw error;
      if (error?.code !== 'ENOENT') throw new PatchPoolError('WORKFLOW_WORKSPACE_FAILED', 'Unable to inspect the temporary workspace');
    }
  }

  async cleanupPath(path, code = 'WORKFLOW_CLEANUP_FAILED') {
    try { await this.cleanup(path, { maxRetries: this.cleanupMaxRetries, retryDelay: this.cleanupRetryDelay }); } catch { throw new PatchPoolError(code, 'Unable to clean up the temporary workflow directory'); }
  }

  async persistCleanupFailure(claim, controller) {
    if (!claim) return;
    try {
      await this.transition(claim, 'failed', { errorCode: 'WORKFLOW_CLEANUP_FAILED', failedAt: this.clock() }, controller);
    } catch {
      // The cleanup error remains the observed result even if persistence is unavailable.
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
    let hooksDirectory;
    let commitSha;
    let pr;
    let branch;
    let leaseController;
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
      claim = this.store.claimIssue({ repoId: approved.id, issueNumber: number, workerId: this.workerId });
      if (typeof this.store.acquireExecutionLease === 'function') {
        const lease = this.store.acquireExecutionLease(claim.id, this.workerId, { ttlMs: this.leaseTtlMs });
        leaseController = this.startLeaseHeartbeat(lease);
        this.assertLease(leaseController);
      }

      const refreshed = await this.refresh(fullName, number, { ...approved, ...canonical });
      branch = claim.branch ?? `patchpool/issue-${number}-${String(claim.id ?? this.randomId())}`;
      const base = refreshed.repository.defaultBranch ?? canonical.defaultBranch ?? 'main';
      if (claim.state === 'pr_opened') return { state: claim.state, claimId: claim.id, issueNumber: number, branch, commitSha: claim.commitSha, prUrl: claim.prUrl, workspace: keepWorkspace ? claim.workspace : undefined };
      if (claim.state === 'pushed') {
        pr = await this.withLease(leaseController, () => this.openPullRequest({ fullName, base, branch, number, title: refreshed.issue.title, publish }));
        claim = await this.transition(claim, 'pr_opened', { prUrl: pr.url, openedAt: this.clock() }, leaseController);
        return { state: claim.state, claimId: claim.id, issueNumber: number, branch, commitSha: claim.commitSha, prUrl: pr.url };
      }
      let reuseCommitted = false;
      if (claim.state === 'committed' && claim.workspace) {
        reuseCommitted = await this.reusableCommittedWorkspace(claim.workspace, claim.commitSha);
        if (reuseCommitted) workspace = claim.workspace;
        else claim = await this.restart(claim, { restartAt: this.clock() }, leaseController);
      }
      if (!workspace) workspace = await this.withLease(leaseController, () => this.tempDirectoryFactory(`patchpool-${number}-${String(claim.id ?? this.randomId())}-`));
      if (!reuseCommitted) {
        await this.ensureEmptyWorkspace(workspace);
        await this.withLease(leaseController, () => this.github.clone(fullName, workspace));
        await this.withLease(leaseController, () => this.command(['switch', '-c', branch], workspace, 'WORKFLOW_BRANCH_FAILED', 'Unable to create the worker branch'));
        if (claim.state === 'claimed' || claim.state === 'running') claim = await this.transition(claim, 'running', { branch, workspace, startedAt: this.clock() }, leaseController);
      }

      if (claim.state !== 'committed') {
        const prompt = this.promptBuilder({ repository: { ...approved, ...refreshed.repository, fullName }, issue: refreshed.issue, verificationArgv: [...approved.verificationArgv] });
        await this.withLease(leaseController, () => this.codex.implement({ cwd: workspace, prompt, timeoutMs: this.codexTimeoutMs, env: sanitizeEnvironment(this.environment) }));
        const afterCodex = await this.status(workspace);
        if (afterCodex.paths.length === 0) throw new PatchPoolError('WORKFLOW_NO_CHANGES', 'Codex produced no worktree changes');
        const beforeVerification = await this.fingerprint(workspace, afterCodex);
        await this.invoke('git', ['diff', '--check'], { cwd: workspace, env: sanitizeEnvironment(this.environment) }, 'WORKFLOW_DIFF_CHECK_FAILED', 'Git diff check failed');
        const verification = [...approved.verificationArgv];
        if (!verification.length || verification.some(argument => typeof argument !== 'string' || !argument)) throw new PatchPoolError('WORKFLOW_INVALID_VERIFICATION', 'Repository verification argv is invalid');
        await this.withLease(leaseController, () => this.invoke(verification[0], verification.slice(1), { cwd: workspace, env: sanitizeEnvironment(this.environment) }, 'WORKFLOW_VERIFICATION_FAILED', 'Approved verification command failed'));
        const afterVerification = await this.status(workspace);
        const afterFingerprint = await this.fingerprint(workspace, afterVerification);
        if (!sameSet(new Set(beforeVerification.keys()), new Set(afterFingerprint.keys())) || [...beforeVerification].some(([path, digest]) => afterFingerprint.get(path) !== digest)) throw new PatchPoolError('WORKFLOW_VERIFICATION_MUTATED', 'Verification changed the worktree');
        claim = await this.transition(claim, 'verified', { verifiedAt: this.clock() }, leaseController);
      }

      if (!publish) return { state: claim.state, claimId: claim.id, issueNumber: number, branch, workspace: keepWorkspace ? workspace : undefined };
      hooksDirectory = await this.withLease(leaseController, () => this.hooksDirectoryFactory('patchpool-hooks-'));
      await this.withLease(leaseController, () => this.command(['add', '-A'], workspace, 'WORKFLOW_COMMIT_FAILED', 'Unable to stage the worktree changes'));
      await this.invoke('git', ['-c', `core.hooksPath=${hooksDirectory}`, '-c', 'commit.gpgSign=false', 'diff', '--cached', '--check'], { cwd: workspace, env: sanitizeEnvironment(this.environment) }, 'WORKFLOW_DIFF_CHECK_FAILED', 'Staged diff check failed');
      if (claim.state === 'verified') {
        await this.withLease(leaseController, () => this.invoke('git', ['-c', `core.hooksPath=${hooksDirectory}`, '-c', 'commit.gpgSign=false', 'commit', '--no-verify', '-m', `PatchPool: resolve issue #${number}`], { cwd: workspace, env: sanitizeEnvironment(this.environment) }, 'WORKFLOW_COMMIT_FAILED', 'Unable to commit the worktree changes'));
        commitSha = (await this.command(['rev-parse', 'HEAD'], workspace, 'WORKFLOW_COMMIT_FAILED', 'Unable to resolve the commit SHA')).stdout.trim();
        claim = await this.transition(claim, 'committed', { commitSha, workspace, committedAt: this.clock() }, leaseController);
      } else commitSha = claim.commitSha;
      const beforePush = await this.refresh(fullName, number, { ...approved, ...canonical });
      const pushPermission = await this.github.getPushRemote({ fullName });
      if (!pushPermission || pushPermission.canPush !== true) throw new PatchPoolError('WORKFLOW_PUSH_PERMISSION', `Push permission could not be verified for ${fullName}`);
      const remoteName = pushPermission.remoteName;
      if (typeof remoteName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(remoteName)) throw new PatchPoolError('WORKFLOW_PUSH_PERMISSION', 'Push remote name is invalid');
      await this.verifyRemote(workspace, remoteName, fullName);
      await this.withLease(leaseController, () => this.invoke('git', ['-c', `core.hooksPath=${hooksDirectory}`, 'push', '--set-upstream', remoteName, branch], { cwd: workspace, env: sanitizeEnvironment(this.environment, { push: true }) }, 'WORKFLOW_PUSH_FAILED', 'Unable to push the worker branch'));
      claim = await this.transition(claim, 'pushed', { pushedAt: this.clock() }, leaseController);
      if (!publish) return { state: claim.state, claimId: claim.id, issueNumber: number, branch, commitSha, workspace: keepWorkspace ? workspace : undefined };
      pr = await this.withLease(leaseController, () => this.openPullRequest({ fullName, base: beforePush.repository.defaultBranch ?? base, branch, number, title: beforePush.issue.title ?? issue.title, publish }));
      claim = await this.transition(claim, 'pr_opened', { prUrl: pr.url, openedAt: this.clock() }, leaseController);
      return { state: claim.state, claimId: claim.id, issueNumber: number, branch, commitSha, prUrl: pr.url, workspace: keepWorkspace ? workspace : undefined };
    } catch (cause) {
      let error = asError(cause);
      if (leaseController) {
        try { this.assertLease(leaseController); } catch (lost) { error = asError(lost, 'LEASE_LOST'); }
      }
      if (leaseController && error.code !== 'LEASE_LOST') await this.fail(claim, error, leaseController);
      throw error;
    } finally {
      let cleanupFailure;
      let cleanupLeaseError;
      let ownsLease = false;
      if (leaseController) {
        try { this.assertLease(leaseController); ownsLease = true; } catch { /* stale holders must not mutate shared state or paths */ }
      }
      if (ownsLease && hooksDirectory) {
        try { await this.withLease(leaseController, () => this.cleanup(hooksDirectory, { maxRetries: this.cleanupMaxRetries, retryDelay: this.cleanupRetryDelay })); } catch (error) {
          if (error?.code === 'LEASE_LOST') cleanupLeaseError = error;
          else cleanupFailure = true;
        }
      }
      if (ownsLease && workspace && !keepWorkspace) {
        try { await this.withLease(leaseController, () => this.cleanup(workspace, { maxRetries: this.cleanupMaxRetries, retryDelay: this.cleanupRetryDelay })); } catch (error) {
          if (error?.code === 'LEASE_LOST') cleanupLeaseError = error;
          else cleanupFailure = true;
        }
      }
      if (cleanupFailure && ownsLease) {
        await this.persistCleanupFailure(claim, leaseController);
      }
      this.stopLeaseHeartbeat(leaseController);
      if (leaseController?.lease && typeof this.store.releaseExecutionLease === 'function') {
        try { this.store.releaseExecutionLease(leaseController.lease.claimId, leaseController.lease.workerId, leaseController.lease.token); } catch { /* lease expiry remains the recovery path */ }
      }
      if (cleanupLeaseError) throw cleanupLeaseError;
      if (cleanupFailure) throw new PatchPoolError('WORKFLOW_CLEANUP_FAILED', 'Unable to clean up the temporary workflow directory');
    }
  }
}

export { isPullRequest, validatePullRequest, sanitizeEnvironment, parseStatus };
