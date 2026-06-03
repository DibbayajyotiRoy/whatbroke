/**
 * `whatbroke run [flags] -- <command> [args...]` — the primary command (07).
 *
 * Wraps the target command, and on a crash assembles → redacts → writes the
 * bundle and any requested sinks. On a passing run it is invisible and records a
 * green commit to the journal (which powers the moat, 05).
 */
import { relative } from 'node:path';
import type { CommandSpec, RedactedBundle, Sink, SinkResult } from '../types.js';
import { runCommand } from '../capture/runner.js';
import { collectAll } from '../collectors/index.js';
import { reconstruct } from '../repro/reconstruct.js';
import { redact } from '../redaction/redact.js';
import { renderMarkdown } from '../render/markdown.js';
import { createFileSink } from '../sinks/file.js';
import { createStdoutMarkdownSink } from '../sinks/stdout.js';
import { createGithubSink } from '../sinks/github.js';
import { openJournal, fingerprint } from '../journal/journal.js';
import {
  assembleBundle,
  enrichFrames,
  getGitRoot,
  gitHeadAndBranch,
} from '../assemble.js';
import { bundleId } from '../ids.js';
import { resolveStorePaths, ensureStore, ensureGitignore } from '../paths.js';
import { loadConfig, applyCliOverrides } from '../config.js';
import { makeLogger, type Verbosity } from '../util/log.js';

export interface RunArgs {
  targetArgv: string[];
  cwd: string;
  out?: string;
  noFile?: boolean;
  md?: boolean;
  github?: { repo?: string } | false;
  timeoutMs?: number;
  logLines?: number;
  explain?: boolean;
  verbosity: Verbosity;
}

export const USAGE_EXIT = 64;

export async function runCmd(args: RunArgs): Promise<number> {
  const log = makeLogger(args.verbosity);

  if (args.targetArgv.length === 0) {
    log.error('whatbroke run: no command given. Usage: whatbroke run -- <command> [args...]');
    return USAGE_EXIT;
  }

  const command: CommandSpec = { argv: args.targetArgv, cwd: args.cwd };
  const fileConfig = await loadConfig(args.cwd);
  const config = applyCliOverrides(fileConfig, {
    logLines: args.logLines,
    out: args.out,
    explain: args.explain,
  });

  const storePaths = resolveStorePaths(args.cwd, config.out);
  const journal = await openJournal(storePaths.journal);

  // ── Capture ────────────────────────────────────────────────────────────────
  let capture;
  try {
    const runOpts: { logLines: number; timeoutMs?: number } = {
      logLines: config.logLines,
    };
    if (args.timeoutMs !== undefined) runOpts.timeoutMs = args.timeoutMs;
    capture = await runCommand(command, runOpts);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      log.error(`whatbroke: command not found: ${args.targetArgv[0]}`);
      return USAGE_EXIT;
    }
    log.error(`whatbroke: failed to run command: ${String(err)}`);
    return USAGE_EXIT;
  }

  // ── Happy path: record green, stay invisible ─────────────────────────────────
  if (capture.crash === null) {
    const { head, branch } = await gitHeadAndBranch(args.cwd);
    if (head) {
      try {
        // Gitignore .whatbroke/ before the journal write so it never shows up as
        // an untracked file (hence a false "changed" suspect) in a later run.
        await ensureGitignore(args.cwd);
        await journal.recordGreen(fingerprint(command.argv, branch), head);
        log.line(log.style.dim(`${log.style.green('✓')} green recorded (${head.slice(0, 7)})`));
      } catch (err) {
        log.verbose(`whatbroke: could not record green: ${String(err)}`);
      }
    }
    return capture.exitCode ?? 0;
  }

  // ── Crash path: assemble → redact → sinks ────────────────────────────────────
  // Collect git context BEFORE whatbroke writes its own .gitignore entry, so our
  // setup edit never shows up as a "changed since green" file or a suspect.
  const gitRoot = await getGitRoot(args.cwd);
  const crash = capture.crash;
  if (crash.error) crash.error.stack = enrichFrames(crash.error.stack, gitRoot);

  const context = await collectAll({
    command,
    journal,
    frames: crash.error?.stack ?? [],
    logs: capture.logs,
  });
  for (const ce of context.collectorErrors) {
    log.verbose(`whatbroke: collector '${ce.collector}' degraded: ${ce.error}`);
  }

  const repro = reconstruct({ crash, context, command });

  const bundle = assembleBundle({
    id: bundleId(),
    createdAt: new Date().toISOString(),
    crash,
    context,
    logs: capture.logs,
    repro,
  });

  const redacted = redact(bundle, {
    allowEnv: config.redaction.allowEnv,
    denyPatterns: config.redaction.denyPatterns,
    entropy: config.redaction.entropy,
  });

  // Now safe to create the store + .gitignore entry (after git was read).
  const { createdGitignore } = await ensureStore(storePaths);
  if (createdGitignore) log.dim('whatbroke: created .gitignore (ignoring .whatbroke/)');

  // ── Sinks ────────────────────────────────────────────────────────────────────
  const sinks: Sink[] = [];
  if (!args.noFile) {
    sinks.push(createFileSink({ bundlesDir: storePaths.bundlesDir, render: renderMarkdown }));
  }
  if (args.md) {
    sinks.push(createStdoutMarkdownSink({ render: renderMarkdown }));
  }
  if (args.github) {
    const ghOpts: { repo?: string; cwd: string; render: typeof renderMarkdown } = {
      cwd: args.cwd,
      render: renderMarkdown,
    };
    if (args.github.repo) ghOpts.repo = args.github.repo;
    sinks.push(createGithubSink(ghOpts));
  }

  const results: SinkResult[] = [];
  for (const sink of sinks) {
    try {
      results.push(await sink(redacted));
    } catch (err) {
      results.push({ sink: 'unknown', ok: false, message: String(err) });
    }
  }

  printCrashSummary(redacted, results, log, args.cwd);
  return capture.exitCode ?? 1;
}

function confidenceLabel(c: string, s: ReturnType<typeof makeLogger>['style']): string {
  const up = c.toUpperCase();
  if (c === 'high') return s.green(up);
  if (c === 'medium') return s.yellow(up);
  return s.dim(up);
}

/**
 * Just enough to understand the crash, in ~4 lines: what failed, the most
 * likely file and why, where the full bundle is, and how to act on it.
 */
function printCrashSummary(
  bundle: RedactedBundle,
  results: SinkResult[],
  log: ReturnType<typeof makeLogger>,
  cwd: string,
): void {
  const s = log.style;
  const err = bundle.crash.error;
  const headline = err
    ? `${s.bold(err.name)}: ${err.message}`
    : `${s.bold(bundle.crash.kind)} (exit ${bundle.crash.exitCode ?? '—'}${
        bundle.crash.signal ? `, ${bundle.crash.signal}` : ''
      })`;

  log.line(''); // one blank line separates us from the child's own output
  log.line(`${s.red('✕ whatbroke')} · ${headline}`);

  // Confidence + the single top suspect with its reason — the actionable part.
  const top = bundle.repro.suspects[0];
  const conf = confidenceLabel(bundle.repro.confidence, s);
  if (top) {
    const why = top.reasons[0] ? s.dim(` — ${top.reasons[0]}`) : '';
    log.line(`  ${conf} · suspect ${s.cyan(top.path)} ${s.dim(`(score ${top.score})`)}${why}`);
  } else {
    log.line(`  ${conf} confidence`);
  }

  // Bundle path (relative) + scrub count, then the one next step.
  const rel = (p: string) => relative(cwd, p) || p;
  const file = results.find((r) => r.ok && r.paths?.length);
  const issue = results.find((r) => r.ok && r.url);
  const scrub =
    bundle.redaction.redactedCount > 0
      ? s.dim(` · ${bundle.redaction.redactedCount} scrubbed`)
      : '';
  if (file && file.paths) {
    const md = file.paths.find((p) => p.endsWith('.md')) ?? file.paths[0]!;
    log.line(`  ${s.cyan(rel(md))}${scrub}`);
  }
  if (issue?.url) log.line(`  ${s.cyan(issue.url)}`);
  log.line(s.dim('  → whatbroke show · or hand it to your agent over MCP (whatbroke mcp)'));

  for (const r of results) {
    if (!r.ok) log.warn(`  ! ${r.sink}: ${r.message}`);
  }
}
