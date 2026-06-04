/**
 * Collector orchestration (04). Runs env/deps/git concurrently and parses the
 * test-runner output. Each collector is wrapped so a failure degrades gracefully
 * (recorded in `collectorErrors`) and never throws the whole pipeline.
 */
import type {
  CommandSpec,
  DepInfo,
  EnvInfo,
  GitInfo,
  LogBuffer,
  RawContext,
  StackFrame,
} from '../types.js';
import type { Journal } from '../journal/journal.js';
import type { LanguageAdapter } from '../adapters/types.js';
import { nodeAdapter } from '../adapters/node/index.js';
import { collectGit } from './git.js';
import { gitDiffProvider } from './gitDiffProvider.js';

export interface CollectInput {
  command: CommandSpec;
  journal: Journal;
  frames: StackFrame[];
  logs: LogBuffer;
  /** The selected language adapter. Defaults to the Node adapter. */
  adapter?: LanguageAdapter;
}

const NOT_A_REPO: GitInfo = {
  isRepo: false,
  branch: null,
  head: null,
  dirty: false,
  changedFiles: [],
  greenRef: null,
  greenRefSource: 'none',
  note: 'git collector failed',
};

function emptyEnv(cwd: string): EnvInfo {
  return {
    os: { platform: process.platform, release: '', arch: process.arch },
    runtime: { name: 'node', version: process.versions.node, node: process.versions.node },
    packageManager: { name: 'unknown', version: null },
    envKeys: [],
    envValues: {},
    cwd,
  };
}

const EMPTY_DEPS: DepInfo = {
  declared: {},
  relevantResolved: {},
  lockfile: 'none',
};

export async function collectAll(input: CollectInput): Promise<RawContext> {
  const { command, journal, frames, logs } = input;
  const adapter = input.adapter ?? nodeAdapter;
  const collectorErrors: RawContext['collectorErrors'] = [];

  const [envR, depsR, gitR] = await Promise.allSettled([
    adapter.collectEnv(command.cwd),
    adapter.collectDeps(command.cwd, frames),
    collectGit(command, journal, gitDiffProvider),
  ]);

  let env: EnvInfo;
  if (envR.status === 'fulfilled') {
    env = envR.value;
  } else {
    env = emptyEnv(command.cwd);
    collectorErrors.push({ collector: 'env', error: String(envR.reason) });
  }

  let deps: DepInfo;
  if (depsR.status === 'fulfilled') {
    deps = depsR.value;
  } else {
    deps = EMPTY_DEPS;
    collectorErrors.push({ collector: 'deps', error: String(depsR.reason) });
  }

  let git: GitInfo;
  if (gitR.status === 'fulfilled') {
    git = gitR.value;
  } else {
    git = NOT_A_REPO;
    collectorErrors.push({ collector: 'git', error: String(gitR.reason) });
  }

  let testFailure: RawContext['testFailure'];
  try {
    testFailure = adapter.parseTestFailure(logs) ?? undefined;
  } catch (err) {
    collectorErrors.push({ collector: 'test-runner', error: String(err) });
  }

  const context: RawContext = { env, deps, git, collectorErrors };
  if (testFailure) context.testFailure = testFailure;
  return context;
}
