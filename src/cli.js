import { PatchPoolError } from './errors.js';
import { join } from 'node:path';
import { PatchPoolStore, requireCanonicalFullName } from './store.js';
import { CommandRunner } from './runner.js';
import { GitHubClient } from './github.js';
import { CodexClient } from './codex.js';
import { IssueWorkflow } from './workflow.js';
import { resolveWorkerId } from './worker.js';
import { assertRepositoryApproval, loadRepositoryConfig } from './config.js';
import { formatDoctor, runDoctor } from './doctor.js';

const HELP = `Usage:
  patchpool doctor [--json]
  patchpool repo add --repo <owner/name> [--config <path>]
  patchpool repo list [--json]
  patchpool claim list --json
  patchpool run --repo <owner/name> [--issue N] [--publish] [--keep-workspace]
  patchpool e2e --repo K-saint25/PatchPool [--issue N] --publish
`;

const CODEX_MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function resolveCodexModel(environment = {}) {
  const model = environment.PATCHPOOL_CODEX_MODEL;
  if (model === undefined || model === '') return undefined;
  if (typeof model !== 'string' || !CODEX_MODEL_SLUG.test(model)) {
    throw new PatchPoolError('INVALID_CODEX_MODEL', 'PATCHPOOL_CODEX_MODEL must be a valid Codex model slug');
  }
  return model;
}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const key = argument.slice(2).replaceAll('-', '_');
    if (key === 'private') {
      throw new PatchPoolError('INVALID_ARGS', 'Private repositories are not eligible for PatchPool claims');
    }
    if (key === 'json' || key === 'public' || key === 'inactive' || key === 'publish' || key === 'keep_workspace') {
      options[key] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new PatchPoolError('INVALID_ARGS', `Option --${key.replaceAll('_', '-')} requires a value`);
    }
    if (key === 'blocking_label' || key === 'blocking_labels') {
      options.blocking_labels ??= [];
      options.blocking_labels.push(...value.split(',').map(item => item.trim()).filter(Boolean));
    } else {
      options[key] = value;
    }
  }
  return { positional, options };
}

function required(options, key, label = key) {
  const value = options[key];
  if (value === undefined || value === '') throw new PatchPoolError('INVALID_ARGS', `Missing required option: ${label}`);
  return value;
}

function emit(stdout, value, json = true) {
  stdout(`${json ? JSON.stringify(value) : String(value)}\n`);
}

function assertClaimListArguments(argv) {
  let parsed;
  try {
    parsed = parseArguments(argv.slice(2));
  } catch {
    throw new PatchPoolError('INVALID_ARGS', 'claim list requires --json and accepts no other arguments');
  }
  const { positional, options } = parsed;
  const unsupported = positional.length > 0 || !options.json || Object.keys(options).some(key => key !== 'json');
  if (unsupported) throw new PatchPoolError('INVALID_ARGS', 'claim list requires --json and accepts no other arguments');
}

function assertSupportedOptions(options, allowed, label) {
  const unsupported = Object.keys(options).find(key => !allowed.has(key));
  if (unsupported) {
    throw new PatchPoolError('INVALID_ARGS', `${label} does not accept --${unsupported.replaceAll('_', '-')}`);
  }
}

function assertNoPositionals(positional, label) {
  if (positional.length > 0) throw new PatchPoolError('INVALID_ARGS', `${label} does not accept positional arguments`);
}

function assertInvocation(argv) {
  const [command, maybeSubcommand, ...remaining] = argv;
  if (!command) throw new PatchPoolError('INVALID_ARGS', 'A command is required');

  if (command === 'doctor') {
    const { positional, options } = parseArguments(argv.slice(1));
    assertNoPositionals(positional, 'doctor');
    assertSupportedOptions(options, new Set(['json']), 'doctor');
    return command;
  }

  if (command === 'repo') {
    const subcommand = maybeSubcommand;
    if (subcommand !== 'add' && subcommand !== 'list') {
      throw new PatchPoolError('INVALID_ARGS', `Unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`);
    }
    const { positional, options } = parseArguments(remaining);
    if (subcommand === 'list') {
      assertNoPositionals(positional, 'repo list');
      assertSupportedOptions(options, new Set(['json']), 'repo list');
      return command;
    }
    if (positional.length > 1 || (positional.length === 1 && options.repo !== undefined)) {
      throw new PatchPoolError('INVALID_ARGS', 'repo add accepts one repository owner/name');
    }
    assertSupportedOptions(options, new Set([
      'repo', 'config', 'inactive', 'public', 'blocking_label', 'blocking_labels',
      'config_digest', 'verification_argv', 'verify_argv',
    ]), 'repo add');
    if (options.config_digest !== undefined || options.verification_argv !== undefined || options.verify_argv !== undefined) {
      throw new PatchPoolError('INVALID_ARGS', 'Repository approval must come from .patchpool.json; caller-provided digest and verification argv are not accepted');
    }
    const fullName = required({ fullName: options.repo ?? positional[0] }, 'fullName', 'repository owner/name');
    requireCanonicalFullName(fullName);
    return command;
  }

  if (command === 'claim' && maybeSubcommand === 'list') {
    assertClaimListArguments(argv);
    return command;
  }

  if (command === 'claim') {
    const { positional, options } = parseArguments(argv.slice(1));
    assertNoPositionals(positional, 'claim');
    assertSupportedOptions(options, new Set(['repo', 'issue', 'worker']), 'claim');
    requireCanonicalFullName(required(options, 'repo', '--repo'));
    const issueText = required(options, 'issue', '--issue');
    required(options, 'worker', '--worker');
    const issueNumber = Number(issueText);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      throw new PatchPoolError('INVALID_ARGS', '--issue must be a positive integer');
    }
    return command;
  }

  if (command === 'run' || command === 'e2e') {
    const { positional, options } = parseArguments(argv.slice(1));
    assertNoPositionals(positional, command);
    assertSupportedOptions(options, new Set(['repo', 'issue', 'publish', 'keep_workspace']), command);
    const fullName = requireCanonicalFullName(required(options, 'repo', '--repo'));
    if (options.issue !== undefined) {
      const issueNumber = Number(options.issue);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        throw new PatchPoolError('INVALID_ARGS', '--issue must be a positive integer');
      }
    }
    if (command === 'e2e' && fullName !== 'K-saint25/PatchPool') {
      throw new PatchPoolError('E2E_REPOSITORY_GUARD', 'Manual E2E is restricted to K-saint25/PatchPool');
    }
    if (command === 'e2e' && options.publish !== true) {
      throw new PatchPoolError('E2E_PUBLISH_REQUIRED', 'Manual E2E requires explicit --publish');
    }
    return command;
  }

  throw new PatchPoolError('INVALID_ARGS', `Unknown command: ${[command, maybeSubcommand].filter(Boolean).join(' ')}`);
}

async function dispatch(argv, { store, stdout, workflow, workflowFactory, github, codex, runner, environment = process.env, codexModel, cwd = process.cwd(), dbPath, nodeVersion }) {
  const [command, maybeSubcommand, ...remaining] = argv;
  const subcommand = command === 'repo' ? maybeSubcommand : undefined;
  const rest = command === 'repo' ? remaining : [maybeSubcommand, ...remaining].filter(item => item !== undefined);
  if (!command) throw new PatchPoolError('INVALID_ARGS', 'A command is required');
  const { positional, options } = parseArguments(rest);

  if (command === 'repo' && subcommand === 'add') {
    const fullName = options.repo ?? positional[0];
    required({ fullName }, 'fullName', 'repository owner/name');
    if (options.config_digest !== undefined || options.verification_argv !== undefined || options.verify_argv !== undefined) {
      throw new PatchPoolError('INVALID_ARGS', 'Repository approval must come from .patchpool.json; caller-provided digest and verification argv are not accepted');
    }
    const approved = loadRepositoryConfig(options.config ?? join(cwd, '.patchpool.json'));
    const commandRunner = runner ?? new CommandRunner();
    const gh = github ?? new GitHubClient({ runner: commandRunner });
    await gh.getRepository(fullName);
    const registration = {
      fullName,
      configDigest: approved.configDigest,
      verificationArgv: approved.verificationArgv,
      requiredLabel: approved.approvedConfig.requiredIssueLabel,
      blockingLabels: options.blocking_labels ?? [],
      policy: { approvedConfig: approved.approvedConfig },
      active: !options.inactive,
      public: true,
    };
    const repository = store.getRepository(fullName)
      ? store.reapproveRepository(registration)
      : store.registerRepository(registration);
    emit(stdout, repository);
    return repository;
  }

  if (command === 'repo' && subcommand === 'list') {
    const repositories = store.listRepositories();
    emit(stdout, repositories, options.json !== false);
    return repositories;
  }

  if (command === 'claim') {
    const fullName = required(options, 'repo', '--repo');
    const issueText = required(options, 'issue', '--issue');
    const workerId = options.worker ?? options.worker_id;
    required(options, 'worker', '--worker');
    const issueNumber = Number(issueText);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      throw new PatchPoolError('INVALID_ARGS', '--issue must be a positive integer');
    }
    const repository = store.getRepository(fullName);
    if (!repository) throw new PatchPoolError('REPOSITORY_NOT_FOUND', `Repository is not registered: ${fullName}`);
    const timeoutMinutes = repository.policy?.approvedConfig?.timeoutMinutes;
    const approvedTimeoutMs = Number.isInteger(timeoutMinutes) ? timeoutMinutes * 60 * 1_000 : undefined;
    const approval = assertRepositoryApproval(repository, { approvedTimeoutMs });
    const claim = store.claimIssue({ repoId: repository.id, issueNumber, workerId, expectedConfigDigest: approval.configDigest });
    emit(stdout, claim);
    return claim;
  }

  if (command === 'doctor') {
    const commandRunner = runner ?? new CommandRunner();
    const gh = github ?? new GitHubClient({ runner: commandRunner });
    const cx = codex ?? new CodexClient({ runner: commandRunner });
    const result = await runDoctor({ dbPath, runner: commandRunner, github: gh, codex: cx, nodeVersion });
    if (options.json) emit(stdout, result);
    else stdout(formatDoctor(result));
    return result;
  }

  if (command === 'run' || command === 'e2e') {
    const fullName = required(options, 'repo', '--repo');
    if (command === 'e2e' && fullName !== 'K-saint25/PatchPool') {
      throw new PatchPoolError('E2E_REPOSITORY_GUARD', 'Manual E2E is restricted to K-saint25/PatchPool');
    }
    if (command === 'e2e' && options.publish !== true) {
      throw new PatchPoolError('E2E_PUBLISH_REQUIRED', 'Manual E2E requires explicit --publish');
    }
    let issueNumber;
    if (options.issue !== undefined) {
      issueNumber = Number(options.issue);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new PatchPoolError('INVALID_ARGS', '--issue must be a positive integer');
    }
    const commandRunner = runner ?? new CommandRunner();
    const gh = github ?? new GitHubClient({ runner: commandRunner });
    const cx = codex ?? new CodexClient({ runner: commandRunner, model: codexModel });
    const approved = store.getRepository(fullName);
    const timeoutMinutes = approved?.policy?.approvedConfig?.timeoutMinutes;
    const approvedTimeoutMs = Number.isInteger(timeoutMinutes) ? timeoutMinutes * 60 * 1_000 : undefined;
    assertRepositoryApproval(approved, { approvedTimeoutMs });
    const worker = workflow ?? (workflowFactory
      ? workflowFactory({ store, github: gh, codex: cx, runner: commandRunner, workerId: resolveWorkerId(environment), approvedTimeoutMs })
      : new IssueWorkflow({ store, github: gh, codex: cx, runner: commandRunner, workerId: resolveWorkerId(environment), approvedTimeoutMs }));
    const result = await worker.run({ repo: fullName, issueNumber, publish: command === 'e2e' || options.publish === true, keepWorkspace: options.keep_workspace === true });
    emit(stdout, result, options.json !== false);
    return result;
  }

  throw new PatchPoolError('INVALID_ARGS', `Unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? (value => process.stdout.write(value));
  if (argv[0] === 'help' || argv.includes('--help')) {
    stdout(HELP);
    return { command: 'help', exitCode: 0 };
  }
  const command = assertInvocation(argv);
  const requestedDbPath = options.dbPath ?? process.env.PATCHPOOL_DB;
  const dbPath = requestedDbPath ?? '.patchpool.sqlite';
  if (command === 'claim' && argv[1] === 'list') {
    const claims = options.store ? options.store.listClaims() : PatchPoolStore.listClaimsReadOnly(dbPath);
    emit(stdout, claims);
    return claims;
  }
  if (command === 'repo' && argv[1] === 'list') {
    const repositories = options.store ? options.store.listRepositories() : PatchPoolStore.listRepositoriesReadOnly(dbPath);
    emit(stdout, repositories);
    return repositories;
  }
  const environment = options.environment ?? process.env;
  const codexModel = command === 'run' || command === 'e2e' ? resolveCodexModel(environment) : undefined;
  const common = {
    stdout,
    workflow: options.workflow,
    workflowFactory: options.workflowFactory,
    github: options.github,
    codex: options.codex,
    runner: options.runner,
    environment,
    codexModel,
    cwd: options.cwd ?? process.cwd(),
    dbPath,
    nodeVersion: options.nodeVersion ?? process.versions.node,
  };
  if (argv[0] === 'doctor') return dispatch(argv, { ...common, store: undefined });
  const ownsStore = !options.store;
  const store = options.store ?? PatchPoolStore.open(dbPath);
  const openedDbPath = requestedDbPath ?? store.path ?? '.patchpool.sqlite';
  try {
    return await dispatch(argv, { ...common, store, dbPath: openedDbPath });
  } finally {
    if (ownsStore) store.close();
  }
}

export { HELP, parseArguments, resolveCodexModel, resolveWorkerId };
