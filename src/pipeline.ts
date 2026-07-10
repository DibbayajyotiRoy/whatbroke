/**
 * Shared pipeline orchestrator (ADR-0007).
 *
 * `run`, `verify`, `--ci`, and `watch` all execute the same staged pipeline:
 * capture → green fast-path → adapter selection → frame enrichment → collect →
 * reconstruct → assemble → redact → store → sinks. This module is the single
 * wiring of those stages; commands own only flag parsing and presentation.
 *
 * The redaction gate invariant is preserved here: the only `Bundle` that ever
 * leaves this function is the `RedactedBundle` produced by `redact()`.
 */
import type {
  CommandSpec,
  RedactedBundle,
  Sink,
  SinkResult,
} from './types.js';
import { runCommand } from './capture/runner.js';
import { collectAll } from './collectors/index.js';
import { reconstruct } from './repro/reconstruct.js';
import { redact } from './redaction/redact.js';
import { openJournal, fingerprint, type Journal } from './journal/journal.js';
import {
  assembleBundle,
  enrichFrames,
  getGitRoot,
  gitHeadAndBranch,
} from './assemble.js';
import { buildDetectionContext, selectAdapter } from './adapters/index.js';
import { bundleId } from './ids.js';
import { ensureStore, ensureGitignore, type StorePaths } from './paths.js';
import type { WhatbrokeConfig } from './config.js';
import { crashFingerprint } from './repro/fingerprint.js';
import { HistoryIndex, historyPath } from './history/history.js';

/** The command could not be spawned at all (ENOENT, EACCES, …). */
export class SpawnFailedError extends Error {
  constructor(
    readonly argv0: string,
    readonly code: string | undefined,
    cause: unknown,
  ) {
    super(
      code === 'ENOENT'
        ? `command not found: ${argv0}`
        : `failed to run command: ${String(cause)}`,
    );
    this.name = 'SpawnFailedError';
  }
}

export interface PipelineOptions {
  command: CommandSpec;
  config: WhatbrokeConfig;
  storePaths: StorePaths;
  /** Reused if provided (run.ts opens it to serve other flags); opened otherwise. */
  journal?: Journal;
  /** Output surfaces for the redacted bundle. Empty array = capture only. */
  sinks: Sink[];
  timeoutMs?: number;
  /** Stage-level diagnostics (collector degradation, green recording). */
  onVerbose?: (msg: string) => void;
  /** Called after a green run is recorded, with the head sha. */
  onGreen?: (head: string) => void;
}

export type PipelineResult =
  | { outcome: 'green'; exitCode: number }
  | {
      outcome: 'crash';
      exitCode: number;
      bundle: RedactedBundle;
      sinkResults: SinkResult[];
      /** True when the crash was our own timeout kill, not the child dying. */
      timedOut?: boolean;
    };

export async function executePipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { command, config, storePaths } = opts;
  const verbose = opts.onVerbose ?? (() => {});
  const journal = opts.journal ?? (await openJournal(storePaths.journal));

  // ── Capture ────────────────────────────────────────────────────────────────
  let capture;
  try {
    const runOpts: { logLines: number; timeoutMs?: number } = {
      logLines: config.logLines,
    };
    if (opts.timeoutMs !== undefined) runOpts.timeoutMs = opts.timeoutMs;
    capture = await runCommand(command, runOpts);
  } catch (err) {
    throw new SpawnFailedError(
      command.argv[0] ?? '',
      (err as { code?: string }).code,
      err,
    );
  }

  // ── Happy path: record green, stay invisible ─────────────────────────────────
  if (capture.crash === null) {
    const { head, branch } = await gitHeadAndBranch(command.cwd);
    if (head) {
      try {
        // Gitignore .whatbroke/ before the journal write so it never shows up as
        // an untracked file (hence a false "changed" suspect) in a later run.
        await ensureGitignore(command.cwd);
        await journal.recordGreen(fingerprint(command.argv, branch), head);
        opts.onGreen?.(head);
      } catch (err) {
        verbose(`whatbroke: could not record green: ${String(err)}`);
      }
    }
    return { outcome: 'green', exitCode: capture.exitCode ?? 0 };
  }

  // ── Crash path: detect stack → assemble → redact → sinks ─────────────────────
  // Pick the language adapter from the command + cwd + captured stderr, then
  // re-derive the crash through it (the Node-default classification from capture
  // is a fallback; for Python/Go this parses the real traceback/panic).
  const detectionCtx = await buildDetectionContext(command, capture.logs);
  const adapter = selectAdapter(detectionCtx);
  const stderrText = capture.logs.stderrTail;
  const adapterError = adapter.parseError(stderrText);
  const reclassified = adapter.classify({
    exitCode: capture.exitCode,
    signal: capture.signal,
    stderrText,
    error: adapterError,
  });
  const crash = reclassified ?? capture.crash;

  // Collect git context BEFORE whatbroke writes its own .gitignore entry, so our
  // setup edit never shows up as a "changed since green" file or a suspect.
  const gitRoot = await getGitRoot(command.cwd);
  if (crash.error) {
    crash.error.stack = enrichFrames(crash.error.stack, gitRoot, command.cwd);
  }

  const context = await collectAll({
    command,
    journal,
    frames: crash.error?.stack ?? [],
    logs: capture.logs,
    adapter,
  });
  for (const ce of context.collectorErrors) {
    verbose(`whatbroke: collector '${ce.collector}' degraded: ${ce.error}`);
  }

  const repro = reconstruct({ crash, context, command });

  const bundle = assembleBundle({
    id: bundleId(),
    createdAt: new Date().toISOString(),
    crash,
    context,
    logs: capture.logs,
    repro,
    language: adapter.id,
  });
  // Record the verbatim command so `verify` can re-run exactly this (ADR-0002).
  // Set pre-gate: argv elements pass through redaction like any other text.
  bundle.command = { argv: [...command.argv], cwd: command.cwd };

  // ── Crash history (3.1): match against prior fingerprints, record this one ──
  // Local + derived only; a history failure must never break capture.
  try {
    const fp = crashFingerprint(bundle.crash);
    const history = await HistoryIndex.open(historyPath(storePaths.dir));
    // Flaky signal only from an actually-recorded green run (journal), never
    // from weaker green-ref guesses like merge-base.
    const greenSha =
      bundle.git.greenRefSource === 'journal' ? bundle.git.greenRef : null;
    const match = history.match(fp, greenSha);
    if (match) bundle.history = match;
    history.recordCrash(fp, {
      bundleId: bundle.id,
      at: bundle.createdAt,
      head: bundle.git.head,
      suspects: repro.suspects.map((s) => s.path),
    });
    // Persisting creates .whatbroke/ — safe now, git context was already read.
    await history.persist();
  } catch (err) {
    verbose(`whatbroke: history index degraded: ${String(err)}`);
  }

  const redacted = redact(bundle, {
    allowEnv: config.redaction.allowEnv,
    denyPatterns: config.redaction.denyPatterns,
    entropy: config.redaction.entropy,
  });

  // Now safe to create the store + .gitignore entry (after git was read).
  const { createdGitignore } = await ensureStore(storePaths);
  if (createdGitignore) verbose('whatbroke: created .gitignore (ignoring .whatbroke/)');

  const sinkResults: SinkResult[] = [];
  for (const sink of opts.sinks) {
    try {
      sinkResults.push(await sink(redacted));
    } catch (err) {
      sinkResults.push({ sink: 'unknown', ok: false, message: String(err) });
    }
  }

  const crashResult: PipelineResult = {
    outcome: 'crash',
    exitCode: capture.exitCode ?? 1,
    bundle: redacted,
    sinkResults,
  };
  if (capture.timedOut) crashResult.timedOut = true;
  return crashResult;
}
