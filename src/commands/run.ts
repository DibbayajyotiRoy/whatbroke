/**
 * `whatbroke run [flags] -- <command> [args...]` — the primary command (07).
 *
 * Flag parsing + presentation only; the staged pipeline itself lives in
 * `src/pipeline.ts` (ADR-0007) and is shared with `verify`, `--ci`, and watch.
 */
import { relative } from 'node:path';
import type { CommandSpec, RedactedBundle, Sink, SinkResult } from '../types.js';
import { renderMarkdown } from '../render/markdown.js';
import { createFileSink } from '../sinks/file.js';
import { createStdoutMarkdownSink } from '../sinks/stdout.js';
import { createGithubSink } from '../sinks/github.js';
import { createGithubPrSink } from '../sinks/githubPr.js';
import { openJournal } from '../journal/journal.js';
import { resolveStorePaths } from '../paths.js';
import { loadConfig, applyCliOverrides } from '../config.js';
import { makeLogger, type Verbosity } from '../util/log.js';
import { executePipeline, SpawnFailedError } from '../pipeline.js';

export interface RunArgs {
  targetArgv: string[];
  cwd: string;
  out?: string;
  noFile?: boolean;
  md?: boolean;
  github?: { repo?: string } | false;
  githubPr?: boolean;
  /** CI mode (2.1): tri-state — true/false from flags, undefined = auto from $CI. */
  ci?: boolean;
  timeoutMs?: number;
  logLines?: number;
  explain?: boolean;
  verbosity: Verbosity;
}

export const USAGE_EXIT = 64;

/** True when running under CI: explicit flag wins, else the CI env convention. */
export function ciModeEnabled(flag: boolean | undefined, env = process.env): boolean {
  if (flag !== undefined) return flag;
  const v = env['CI'];
  return v !== undefined && v !== '' && v !== 'false' && v !== '0';
}

export async function runCmd(args: RunArgs): Promise<number> {
  const ci = ciModeEnabled(args.ci);
  const log = ci ? makeLogger(args.verbosity, { color: false }) : makeLogger(args.verbosity);

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

  const sinks: Sink[] = [];
  // CI mode always writes the bundle file — it is the artifact teammates see.
  if (!args.noFile || ci) {
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
  // Sticky PR comment (2.2). Explicit flag, or on by default under CI when a
  // PR context is detectable — the sink itself no-ops (warns) without one and
  // never fails the build.
  if (args.githubPr || (ci && process.env['GITHUB_ACTIONS'] === 'true')) {
    sinks.push(createGithubPrSink({ cwd: args.cwd }));
  }

  let result;
  try {
    const pipelineOpts: Parameters<typeof executePipeline>[0] = {
      command,
      config,
      storePaths,
      journal,
      sinks,
      onVerbose: (msg) => log.verbose(msg),
      onGreen: (head) =>
        log.line(log.style.dim(`${log.style.green('✓')} green recorded (${head.slice(0, 7)})`)),
    };
    if (args.timeoutMs !== undefined) pipelineOpts.timeoutMs = args.timeoutMs;
    result = await executePipeline(pipelineOpts);
  } catch (err) {
    if (err instanceof SpawnFailedError && err.code === 'ENOENT') {
      log.error(`whatbroke: command not found: ${args.targetArgv[0]}`);
      return USAGE_EXIT;
    }
    log.error(`whatbroke: failed to run command: ${String(err instanceof SpawnFailedError ? err.cause ?? err : err)}`);
    return USAGE_EXIT;
  }

  if (result.outcome === 'green') return result.exitCode;

  if (ci) printCiMachineLine(result.bundle, result.sinkResults);
  printCrashSummary(result.bundle, result.sinkResults, log, args.cwd);
  return result.exitCode;
}

/**
 * The one stable machine-readable line CI tooling greps for (2.1 AC1). Goes to
 * stdout (whatbroke's human chatter stays on stderr). Format is a contract:
 * `::whatbroke bundle=<abs json path> confidence=<level> suspect=<relpath|->`.
 */
function printCiMachineLine(bundle: RedactedBundle, results: SinkResult[]): void {
  const file = results.find((r) => r.ok && r.paths?.length);
  const json = file?.paths?.find((p) => p.endsWith('.json')) ?? '-';
  const suspect = bundle.repro.suspects[0]?.path ?? '-';
  process.stdout.write(
    `::whatbroke bundle=${json} confidence=${bundle.repro.confidence} suspect=${suspect}\n`,
  );
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
