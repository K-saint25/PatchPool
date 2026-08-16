import { PatchPoolError } from './errors.js';
import { PatchPoolStore } from './store.js';
import { CommandRunner } from './runner.js';
import { GitHubClient } from './github.js';
import { CodexClient } from './codex.js';
import { IssueWorkflow } from './workflow.js';
import { resolveWorkerId } from './worker.js';

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

function parseVerificationArgv(options) {
  const value = options.verification_argv ?? options.verify_argv;
  if (value === undefined) return [process.execPath, '--test'];
  let parsed;
  try { parsed = JSON.parse(value); } catch {
    throw new PatchPoolError('INVALID_ARGS', '--verification-argv must be a JSON string array');
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new PatchPoolError('INVALID_ARGS', '--verification-argv must be a JSON string array');
  }
  return parsed;
}

function emit(stdout, value, json = true) {
  stdout(`${json ? JSON.stringify(value) : String(value)}\n`);
}

async function dispatch(argv, { store, stdout, workflow, workflowFactory, github, codex, runner, environment = process.env }) {
  const [command, maybeSubcommand, ...remaining] = argv;
  const subcommand = command === 'repo' ? maybeSubcommand : undefined;
  const rest = command === 'repo' ? remaining : [maybeSubcommand, ...remaining].filter(item => item !== undefined);
  if (!command) throw new PatchPoolError('INVALID_ARGS', 'A command is required');
  const { positional, options } = parseArguments(rest);

  if (command === 'repo' && subcommand === 'add') {
    const fullName = options.repo ?? positional[0];
    required({ fullName }, 'fullName', 'repository owner/name');
    const repository = store.registerRepository({
      fullName,
      configDigest: required(options, 'config_digest', '--config-digest'),
      verificationArgv: parseVerificationArgv(options),
      requiredLabel: options.required_label,
      blockingLabels: options.blocking_labels ?? [],
      active: !options.inactive,
      public: true,
    });
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
    const claim = store.claimIssue({ repoId: repository.id, issueNumber, workerId });
    emit(stdout, claim);
    return claim;
  }

  if (command === 'doctor') {
    const commandRunner = runner ?? new CommandRunner();
    const gh = github ?? new GitHubClient({ runner: commandRunner });
    const cx = codex ?? new CodexClient({ runner: commandRunner });
    const result = { github: await gh.preflight(), codex: await cx.preflight() };
    emit(stdout, result, options.json !== false);
    return result;
  }

  if (command === 'run') {
    const fullName = required(options, 'repo', '--repo');
    let issueNumber;
    if (options.issue !== undefined) {
      issueNumber = Number(options.issue);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new PatchPoolError('INVALID_ARGS', '--issue must be a positive integer');
    }
    const commandRunner = runner ?? new CommandRunner();
    const gh = github ?? new GitHubClient({ runner: commandRunner });
    const cx = codex ?? new CodexClient({ runner: commandRunner });
    const worker = workflow ?? (workflowFactory
      ? workflowFactory({ store, github: gh, codex: cx, runner: commandRunner, workerId: resolveWorkerId(environment) })
      : new IssueWorkflow({ store, github: gh, codex: cx, runner: commandRunner, workerId: resolveWorkerId(environment) }));
    const result = await worker.run({ repo: fullName, issueNumber, publish: options.publish === true, keepWorkspace: options.keep_workspace === true });
    emit(stdout, result, options.json !== false);
    return result;
  }

  throw new PatchPoolError('INVALID_ARGS', `Unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const ownsStore = !options.store;
  const store = options.store ?? PatchPoolStore.open(options.dbPath ?? process.env.PATCHPOOL_DB ?? '.patchpool.sqlite');
  const stdout = options.stdout ?? (value => process.stdout.write(value));
  try {
    return await dispatch(argv, { store, stdout, workflow: options.workflow, workflowFactory: options.workflowFactory, github: options.github, codex: options.codex, runner: options.runner, environment: options.environment ?? process.env });
  } finally {
    if (ownsStore) store.close();
  }
}

export { parseArguments, resolveWorkerId };
