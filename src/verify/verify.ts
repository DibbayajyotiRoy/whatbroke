/**
 * `verify` core (roadmap 1.1): re-run a bundle's captured command and report
 * pass/fail *against that bundle*. This is the agent's ground-truth oracle for
 * "did my fix work?" — the same deterministic wrapper pointed backward.
 *
 * Security invariant (ADR-0002, AC5): the ONLY thing verify ever executes is
 * `bundle.command.argv` exactly as recorded, via array-argv spawn (no shell).
 * Nothing here accepts a caller-supplied command, and the MCP `verify_fix`
 * tool exposes no argv input.
 */
import { promises as fs } from 'node:fs';
import type { RedactedBundle } from '../types.js';
import { BundleStore } from '../mcp/store.js';
import { executePipeline, SpawnFailedError } from '../pipeline.js';
import { compareCrashes, type CrashComparison } from '../repro/fingerprint.js';
import { createFileSink } from '../sinks/file.js';
import { renderMarkdown } from '../render/markdown.js';
import { loadConfig } from '../config.js';
import { resolveStorePaths, bundleJsonPath } from '../paths.js';
import { run } from '../util/exec.js';
import { crashFingerprint } from '../repro/fingerprint.js';
import { HistoryIndex, historyPath } from '../history/history.js';

export type VerifyStatus = 'fixed' | 'same-failure' | 'different-failure';

export interface VerifyOutcome {
  status: VerifyStatus;
  /** The bundle that was verified. */
  bundleId: string;
  /** Child exit code from the re-run (0 when fixed). */
  exitCode: number;
  /** Crash comparison, present whenever the command still fails. */
  delta?: CrashComparison;
  /** New bundle captured for a different failure, so agents can iterate. */
  newBundleId?: string;
  /** HEAD sha recorded as the resolving commit when fixed. */
  resolvedCommit?: string;
}

export type VerifyErrorKind =
  | 'bundle-not-found'
  | 'no-command'
  | 'argv-redacted'
  | 'cwd-missing'
  | 'command-missing'
  | 'timeout';

/** Typed, never-hanging failure modes (1.1 AC4). */
export class VerifyError extends Error {
  constructor(
    readonly kind: VerifyErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'VerifyError';
  }
}

export interface VerifyOptions {
  /** Project root whose .whatbroke store holds the bundle. */
  projectCwd: string;
  /** Bundle id; latest bundle when omitted. */
  id?: string;
  /** Custom bundles dir (mirrors `--out`). */
  out?: string;
  /** Re-run kill timeout. Default 10 minutes — verify never hangs (AC4). */
  timeoutMs?: number;
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

export async function verifyBundle(opts: VerifyOptions): Promise<VerifyOutcome> {
  const config = await loadConfig(opts.projectCwd);
  const storePaths = resolveStorePaths(opts.projectCwd, opts.out ?? config.out);
  const store = new BundleStore(storePaths.bundlesDir);

  const bundle = await store.get(opts.id);
  if (!bundle) {
    throw new VerifyError(
      'bundle-not-found',
      opts.id
        ? `no bundle with id '${opts.id}' in ${storePaths.bundlesDir}`
        : `no bundles in ${storePaths.bundlesDir} — nothing to verify`,
    );
  }

  const command = bundle.command;
  if (!command || command.argv.length === 0) {
    throw new VerifyError(
      'no-command',
      `bundle ${bundle.id} predates verify support (no captured command); re-capture with 'whatbroke run'`,
    );
  }

  // Fail closed: never execute an argv the redaction gate altered — a
  // placeholder is not the recorded command (AC5).
  if (command.argv.some((a) => a.includes('‹redacted:'))) {
    throw new VerifyError(
      'argv-redacted',
      `bundle ${bundle.id}'s captured argv contained a secret and was redacted; ` +
        're-run the original command manually with whatbroke run',
    );
  }

  try {
    const st = await fs.stat(command.cwd);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new VerifyError(
      'cwd-missing',
      `captured cwd no longer exists: ${command.cwd}`,
    );
  }

  // Re-run the exact captured argv from the captured cwd. Empty sinks: a
  // same-failure re-run must not spam the store with duplicate bundles.
  let result;
  try {
    result = await executePipeline({
      command: { argv: [...command.argv], cwd: command.cwd },
      config,
      storePaths,
      sinks: [],
      timeoutMs: opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof SpawnFailedError && err.code === 'ENOENT') {
      throw new VerifyError(
        'command-missing',
        `captured command no longer exists: ${command.argv[0]}`,
      );
    }
    throw err;
  }

  if (result.outcome === 'green') {
    // Fixed: stamp the bundle resolved with the resolving commit (AC3). The
    // green run itself was already recorded in the journal by the pipeline.
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: command.cwd });
    const commit = head.code === 0 ? head.stdout.trim() : '';
    const resolvedAt = new Date().toISOString();
    await stampResolved(storePaths.bundlesDir, bundle.id, resolvedAt, commit);
    await recordResolution(storePaths.dir, bundle, commit, resolvedAt, command.cwd);

    const outcome: VerifyOutcome = {
      status: 'fixed',
      bundleId: bundle.id,
      exitCode: 0,
    };
    if (commit) outcome.resolvedCommit = commit;
    return outcome;
  }

  if (result.timedOut) {
    throw new VerifyError(
      'timeout',
      `re-run exceeded ${opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS}ms and was killed`,
    );
  }

  const delta = compareCrashes(bundle.crash, result.bundle.crash);
  if (delta.verdict === 'same') {
    return {
      status: 'same-failure',
      bundleId: bundle.id,
      exitCode: result.exitCode,
      delta,
    };
  }

  // Different (or related-but-not-same) failure: persist the new crash as its
  // own bundle so the agent can iterate on it without leaving MCP (AC2).
  const fileSink = createFileSink({
    bundlesDir: storePaths.bundlesDir,
    render: renderMarkdown,
  });
  await fileSink(result.bundle);

  return {
    status: 'different-failure',
    bundleId: bundle.id,
    exitCode: result.exitCode,
    delta,
    newBundleId: result.bundle.id,
  };
}

/**
 * Record the resolution into the history index (3.1 AC1) with which files the
 * fix touched and whether the ranking named them (3.2 ledger). Uncommitted
 * fixes count their dirty files; committed fixes count the commit's files.
 * Best-effort: a history failure never changes the verify verdict.
 */
async function recordResolution(
  storeDir: string,
  bundle: RedactedBundle,
  commit: string,
  at: string,
  cwd: string,
): Promise<void> {
  try {
    let filesTouched: string[] = [];
    const dirty = await run('git', ['status', '--porcelain'], { cwd });
    if (dirty.code === 0 && dirty.stdout.trim() !== '') {
      filesTouched = dirty.stdout
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter((f) => f !== '' && !f.startsWith('.whatbroke'));
    } else if (commit) {
      const show = await run(
        'git',
        ['show', '--name-only', '--pretty=format:', commit],
        { cwd },
      );
      if (show.code === 0) {
        filesTouched = show.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      }
    }
    const history = await HistoryIndex.open(historyPath(storeDir));
    history.recordResolution(crashFingerprint(bundle.crash), {
      bundleId: bundle.id,
      commit,
      at,
      filesTouched,
      suspects: bundle.repro.suspects,
    });
    await history.persist();
  } catch {
    // verify's verdict stands regardless
  }
}

/** Rewrite the stored bundle JSON with a resolution stamp. Best-effort. */
async function stampResolved(
  bundlesDir: string,
  id: string,
  at: string,
  commit: string,
): Promise<void> {
  const path = bundleJsonPath(bundlesDir, id);
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as RedactedBundle;
    parsed.resolution = { status: 'resolved', at, commit };
    await fs.writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  } catch {
    // The verify verdict stands even if the stamp fails (read-only store, etc.).
  }
}
