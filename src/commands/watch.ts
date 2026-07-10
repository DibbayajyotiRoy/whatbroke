/**
 * `whatbroke watch -- <cmd>` (roadmap 6.2): re-run on file change, recording
 * greens and capturing crashes continuously, so the journal populates during
 * normal dev without the user thinking about it.
 *
 * Dedup (AC2): rapid crash successions are debounced, and a session persists
 * at most one bundle per distinct failure — distinctness via the 1.2 crash
 * fingerprint. A recurring identical crash updates nothing; a changed crash
 * gets its own bundle.
 *
 * The session core is watcher-agnostic (tests drive `trigger()` directly);
 * `watchCmd` wires it to fs.watch.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import type { CommandSpec, Sink } from '../types.js';
import type { WhatbrokeConfig } from '../config.js';
import type { StorePaths } from '../paths.js';
import { executePipeline, type PipelineResult } from '../pipeline.js';
import { crashFingerprint } from '../repro/fingerprint.js';
import { createFileSink } from '../sinks/file.js';
import { renderMarkdown } from '../render/markdown.js';
import { loadConfig, applyCliOverrides } from '../config.js';
import { resolveStorePaths } from '../paths.js';
import { openJournal } from '../journal/journal.js';
import { makeLogger, type Verbosity } from '../util/log.js';

export interface WatchEvent {
  kind: 'run-start' | 'green' | 'new-crash' | 'same-crash' | 'run-error';
  fingerprint?: string;
  bundleId?: string;
  detail?: string;
}

export interface WatchSessionOptions {
  command: CommandSpec;
  config: WhatbrokeConfig;
  storePaths: StorePaths;
  debounceMs?: number;
  timeoutMs?: number;
  onEvent?: (ev: WatchEvent) => void;
  /** Injectable for tests; defaults to the real pipeline with no sinks. */
  runPipeline?: (command: CommandSpec, sinks: Sink[]) => Promise<PipelineResult>;
}

export const WATCH_DEBOUNCE_MS = 300;

export interface WatchSession {
  /** Signal a file change; debounced, coalesced while a run is in flight. */
  trigger(): void;
  /** Run immediately (initial run). Serialized with triggered runs. */
  runNow(): Promise<void>;
  /** Resolves when no run is active or queued (test synchronization). */
  idle(): Promise<void>;
  /** Fingerprints that produced a bundle this session. */
  capturedFingerprints(): readonly string[];
  dispose(): void;
}

export function createWatchSession(opts: WatchSessionOptions): WatchSession {
  const debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS;
  const emit = opts.onEvent ?? (() => {});
  const seen = new Set<string>(); // fingerprints already persisted this session
  let lastFingerprint: string | null = null;

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let queued = false;
  let disposed = false;
  let idleResolvers: Array<() => void> = [];

  const fileSink = createFileSink({
    bundlesDir: opts.storePaths.bundlesDir,
    render: renderMarkdown,
  });

  const runPipeline =
    opts.runPipeline ??
    ((command: CommandSpec, sinks: Sink[]) => {
      const pOpts: Parameters<typeof executePipeline>[0] = {
        command,
        config: opts.config,
        storePaths: opts.storePaths,
        sinks,
      };
      if (opts.timeoutMs !== undefined) pOpts.timeoutMs = opts.timeoutMs;
      return executePipeline(pOpts);
    });

  const settleIdle = (): void => {
    if (!running && !queued && timer === null) {
      for (const r of idleResolvers) r();
      idleResolvers = [];
    }
  };

  const runOnce = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      queued = true; // coalesce: one pending re-run regardless of change count
      return;
    }
    running = true;
    emit({ kind: 'run-start' });
    try {
      // Capture with NO sinks; persist only genuinely new failures (AC2).
      const result = await runPipeline(opts.command, []);
      if (result.outcome === 'green') {
        lastFingerprint = null;
        emit({ kind: 'green' });
      } else {
        const fp = crashFingerprint(result.bundle.crash);
        if (!seen.has(fp)) {
          seen.add(fp);
          await fileSink(result.bundle);
          emit({ kind: 'new-crash', fingerprint: fp, bundleId: result.bundle.id });
        } else {
          emit({
            kind: 'same-crash',
            fingerprint: fp,
            detail: fp === lastFingerprint ? 'unchanged since last run' : 'seen earlier this session',
          });
        }
        lastFingerprint = fp;
      }
    } catch (err) {
      emit({ kind: 'run-error', detail: String(err) });
    } finally {
      running = false;
      if (queued && !disposed) {
        queued = false;
        void runOnce();
      } else {
        settleIdle();
      }
    }
  };

  return {
    trigger(): void {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void runOnce();
      }, debounceMs);
      timer.unref?.();
    },
    runNow(): Promise<void> {
      return runOnce();
    },
    idle(): Promise<void> {
      return new Promise((resolve) => {
        idleResolvers.push(resolve);
        settleIdle();
      });
    },
    capturedFingerprints(): readonly string[] {
      return [...seen];
    },
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Directories never worth re-running for. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.whatbroke', 'dist', 'build']);

export function shouldIgnorePath(rel: string): boolean {
  if (rel === '') return false;
  const parts = rel.split(path.sep);
  return parts.some((p) => IGNORED_DIRS.has(p) || (p.startsWith('.') && p !== '.'));
}

export interface WatchArgs {
  targetArgv: string[];
  cwd: string;
  out?: string;
  timeoutMs?: number;
  logLines?: number;
  verbosity: Verbosity;
}

export async function watchCmd(args: WatchArgs): Promise<number> {
  const log = makeLogger(args.verbosity);
  if (args.targetArgv.length === 0) {
    log.error('whatbroke watch: no command given. Usage: whatbroke watch -- <command> [args...]');
    return 64;
  }

  const fileConfig = await loadConfig(args.cwd);
  const config = applyCliOverrides(fileConfig, {
    logLines: args.logLines,
    out: args.out,
  });
  const storePaths = resolveStorePaths(args.cwd, config.out);
  // Open once so the journal file exists; the pipeline reopens per run.
  await openJournal(storePaths.journal);

  const s = log.style;
  const sessionOpts: WatchSessionOptions = {
    command: { argv: args.targetArgv, cwd: args.cwd },
    config,
    storePaths,
    onEvent: (ev) => {
      if (ev.kind === 'run-start') log.dim(`↻ ${args.targetArgv.join(' ')}`);
      if (ev.kind === 'green') log.line(`${s.green('✓')} green`);
      if (ev.kind === 'new-crash')
        log.line(`${s.red('✕ crash')} · bundle ${s.cyan(ev.bundleId ?? '')} · whatbroke show ${ev.bundleId ?? ''}`);
      if (ev.kind === 'same-crash') log.dim(`✕ same failure (${ev.detail ?? ''})`);
      if (ev.kind === 'run-error') log.warn(`watch: run failed: ${ev.detail ?? ''}`);
    },
  };
  if (args.timeoutMs !== undefined) sessionOpts.timeoutMs = args.timeoutMs;
  const session = createWatchSession(sessionOpts);

  let watcher: FSWatcher;
  try {
    watcher = fsWatch(args.cwd, { recursive: true }, (_event, filename) => {
      if (filename && shouldIgnorePath(String(filename))) return;
      session.trigger();
    });
  } catch (err) {
    log.error(`whatbroke watch: cannot watch ${args.cwd}: ${String(err)}`);
    return 74;
  }

  log.line(s.dim(`watching ${args.cwd} — Ctrl-C to stop`));
  await session.runNow();

  return new Promise<number>((resolve) => {
    const shutdown = (): void => {
      watcher.close();
      session.dispose();
      log.line('');
      log.line(s.dim('watch stopped'));
      resolve(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
