/**
 * Regression benchmark harness (ROADMAP 4.1, ADR-0006, TASKS T3.1).
 *
 * Replays each case under bench/cases/<name>/ through the FULL real pipeline
 * (`executePipeline`, ADR-0007): materialize the green fixture in a temp git
 * repo, commit it, run once (must be green — this records the journal's green
 * sha), overwrite files with the broken fixture as UNCOMMITTED changes, run
 * again (must crash), then score whether a known culprit ranks top-1 / top-3
 * in the bundle's suspect list.
 *
 *   npx tsx bench/run.ts [--filter substr] [--json out.json] [--gate]
 *
 * Standalone runs always exit 0 — the scoreboard is informational. With
 * --gate (the CI regression gate) the run exits 1 when measured top-3
 * accuracy drops below bench/baseline.json, or when any case errors.
 *
 * Cases labeled "expectedMiss": true are the known-miss improvement backlog
 * (AC4): scored separately, never in the headline numbers, never failing the
 * gate — when a new ranking signal (e.g. the import-graph hop) makes one hit
 * top-3, it is reported as "flipped".
 *
 * Structured as importable functions (loadCase / loadCases / runCase /
 * runBench) with a main() guard so src/bench.test.ts can drive the machinery
 * in-process.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { executePipeline } from '../src/pipeline.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { resolveStorePaths } from '../src/paths.js';
import { scoreCase, summarize } from './score.js';
import type { BenchSummary, ScoredCase } from './score.js';

// ─────────────────────────────────────────────────────────────────────────────
// Case format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * bench/cases/<name>/case.json. File contents are inline (`greenFiles` /
 * `brokenFiles`, keeping a case one reviewable file); large fixtures may
 * instead ship sibling directories of real files via `greenDir` / `brokenDir`
 * (both may be combined — inline files overlay the directory copy).
 * `brokenFiles`/`brokenDir` are applied AFTER the green commit, as uncommitted
 * working-tree changes.
 */
export interface BenchCaseSpec {
  name: string;
  language: string;
  /** Known-miss under the current ranking (AC4); excluded from headline totals. */
  expectedMiss?: boolean;
  /** Repo-relative path(s) of the file(s) actually responsible; any hit counts. */
  culprits: string[];
  /** Command replayed through the pipeline, e.g. ["node", "main.js"]. */
  argv: string[];
  greenFiles?: Record<string, string>;
  brokenFiles?: Record<string, string>;
  greenDir?: string;
  brokenDir?: string;
}

export interface LoadedCase {
  /** Absolute path of the case directory (dir-based fixtures resolve against it). */
  dir: string;
  spec: BenchCaseSpec;
}

export type CaseLoad =
  | { ok: true; case: LoadedCase }
  | { ok: false; name: string; dir: string; error: string };

export interface CaseResult extends ScoredCase {
  topSuspect: string | null;
  /** Ranked suspect paths from the bundle (up to 5). */
  suspects: string[];
  culprits: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Case loading + validation (malformed cases are reported, never thrown)
// ─────────────────────────────────────────────────────────────────────────────

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** A repo-relative fixture path: no absolute paths, no '..' escapes. */
function isSafeRelPath(p: string): boolean {
  if (p.length === 0 || path.isAbsolute(p)) {
    return false;
  }
  const segments = p.split(/[\\/]/);
  return segments.every((s) => s !== '..' && s.length > 0);
}

function asFileMap(v: unknown): Record<string, string> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== 'string' || !isSafeRelPath(key)) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

/** Load + validate one case dir. Any problem is an `ok: false` report. */
export async function loadCase(caseDir: string): Promise<CaseLoad> {
  const dir = path.resolve(caseDir);
  const fallbackName = path.basename(dir);
  const fail = (error: string): CaseLoad => ({
    ok: false,
    name: fallbackName,
    dir,
    error,
  });

  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, 'case.json'), 'utf8');
  } catch (err) {
    return fail(`cannot read case.json: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(`malformed case.json: ${String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('case.json must be a JSON object');
  }
  const c = parsed as Record<string, unknown>;

  const name =
    typeof c.name === 'string' && c.name.length > 0 ? c.name : fallbackName;
  if (typeof c.language !== 'string' || c.language.length === 0) {
    return fail('"language" must be a non-empty string');
  }
  if (!isStringArray(c.culprits) || c.culprits.length === 0) {
    return fail('"culprits" must be a non-empty string array');
  }
  if (!isStringArray(c.argv) || c.argv.length === 0) {
    return fail('"argv" must be a non-empty string array');
  }
  if (c.expectedMiss !== undefined && typeof c.expectedMiss !== 'boolean') {
    return fail('"expectedMiss" must be a boolean when present');
  }

  let greenFiles: Record<string, string> | undefined;
  if (c.greenFiles !== undefined) {
    const m = asFileMap(c.greenFiles);
    if (!m) return fail('"greenFiles" must map safe relative paths to string contents');
    greenFiles = m;
  }
  let brokenFiles: Record<string, string> | undefined;
  if (c.brokenFiles !== undefined) {
    const m = asFileMap(c.brokenFiles);
    if (!m) return fail('"brokenFiles" must map safe relative paths to string contents');
    brokenFiles = m;
  }

  const checkedDir = async (key: 'greenDir' | 'brokenDir'): Promise<string | null> => {
    const v = c[key];
    if (typeof v !== 'string' || !isSafeRelPath(v)) {
      return null;
    }
    try {
      const st = await fs.stat(path.join(dir, v));
      return st.isDirectory() ? v : null;
    } catch {
      return null;
    }
  };
  let greenDir: string | undefined;
  if (c.greenDir !== undefined) {
    const d = await checkedDir('greenDir');
    if (!d) return fail('"greenDir" must name an existing directory inside the case');
    greenDir = d;
  }
  let brokenDir: string | undefined;
  if (c.brokenDir !== undefined) {
    const d = await checkedDir('brokenDir');
    if (!d) return fail('"brokenDir" must name an existing directory inside the case');
    brokenDir = d;
  }

  if (!greenFiles && !greenDir) {
    return fail('case needs "greenFiles" and/or "greenDir"');
  }
  if (!brokenFiles && !brokenDir) {
    return fail('case needs "brokenFiles" and/or "brokenDir"');
  }

  const spec: BenchCaseSpec = {
    name,
    language: c.language,
    culprits: c.culprits,
    argv: c.argv,
    ...(c.expectedMiss === true ? { expectedMiss: true } : {}),
    ...(greenFiles ? { greenFiles } : {}),
    ...(brokenFiles ? { brokenFiles } : {}),
    ...(greenDir ? { greenDir } : {}),
    ...(brokenDir ? { brokenDir } : {}),
  };
  return { ok: true, case: { dir, spec } };
}

/** Enumerate case dirs (sorted for stable ordering) and load each. */
export async function loadCases(
  casesRoot: string,
  filter?: string,
): Promise<CaseLoad[]> {
  const entries = await fs.readdir(casesRoot, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const selected = filter ? dirs.filter((d) => d.includes(filter)) : dirs;
  const out: CaseLoad[] = [];
  for (const d of selected) {
    out.push(await loadCase(path.join(casesRoot, d)));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Case execution
// ─────────────────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function writeFileMap(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
}

/** Recursive copy (files + dirs only) — avoids fs.cp's experimental warning. */
async function copyTree(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyTree(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

/** Materialize a fixture layer: directory copy first, inline files overlay it. */
async function materialize(
  repoDir: string,
  caseDir: string,
  files: Record<string, string> | undefined,
  dirName: string | undefined,
): Promise<void> {
  if (dirName) {
    await copyTree(path.join(caseDir, dirName), repoDir);
  }
  if (files) {
    await writeFileMap(repoDir, files);
  }
}

type StdWrite = typeof process.stdout.write;

/**
 * The capture runner passes the child's stdout/stderr through to ours — 35
 * crashing fixtures would drown the scoreboard. Mute both streams around a
 * pipeline run (restored in finally; harness output uses the saved writers).
 */
async function withMutedStdio<T>(fn: () => Promise<T>): Promise<T> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const muted = function (this: unknown, ...args: unknown[]): boolean {
    const cb = args.find((a) => typeof a === 'function') as
      | ((err?: Error | null) => void)
      | undefined;
    cb?.();
    return true;
  } as unknown as StdWrite;
  process.stdout.write = muted;
  process.stderr.write = muted;
  try {
    return await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

export interface RunCaseOptions {
  /** Per-pipeline-run timeout; defends against a hanging fixture. Default 30s. */
  timeoutMs?: number;
}

/**
 * Replay one case through the full pipeline and score it.
 * Never throws: any failure to replay comes back as `result.error`.
 */
export async function runCase(
  loaded: LoadedCase,
  opts: RunCaseOptions = {},
): Promise<CaseResult> {
  const { spec, dir: caseDir } = loaded;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const failed = (error: string): CaseResult => ({
    name: spec.name,
    expectedMiss: spec.expectedMiss === true,
    top1: false,
    top3: false,
    topSuspect: null,
    suspects: [],
    culprits: spec.culprits,
    error,
  });

  let tmp: string | null = null;
  try {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-bench-'));
    // realpath so stack-frame paths and the git root agree (symlinked tmpdirs).
    const repo = await fs.realpath(tmp);

    await materialize(repo, caseDir, spec.greenFiles, spec.greenDir);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'bench@whatbroke.invalid');
    git(repo, 'config', 'user.name', 'whatbroke-bench');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'green', '--no-verify');

    // The fixture says "node"; run it with the node running this harness.
    const argv = spec.argv.map((a, i) =>
      i === 0 && a === 'node' ? process.execPath : a,
    );
    const command = { argv, cwd: repo };
    const storePaths = resolveStorePaths(repo);

    const green = await withMutedStdio(() =>
      executePipeline({ command, config: DEFAULT_CONFIG, storePaths, sinks: [], timeoutMs }),
    );
    if (green.outcome !== 'green') {
      return failed(
        `green run did not pass: outcome=${green.outcome} exit=${String(green.exitCode)}`,
      );
    }

    // Break it — uncommitted overwrites on top of the green commit.
    await materialize(repo, caseDir, spec.brokenFiles, spec.brokenDir);

    const crashed = await withMutedStdio(() =>
      executePipeline({ command, config: DEFAULT_CONFIG, storePaths, sinks: [], timeoutMs }),
    );
    if (crashed.outcome !== 'crash') {
      return failed(
        `broken run did not crash: outcome=${crashed.outcome} exit=${String(crashed.exitCode)}`,
      );
    }

    // Replace the throwaway repo path in reported suspects (ESM file: frames
    // currently leak it) so results.json is byte-stable across runs. Scoring
    // is unaffected: culprits are repo-relative and never contain the tmp dir.
    const scrub = (p: string): string => p.split(repo).join('<sandbox>');
    const suspects = crashed.bundle.repro.suspects.map((s) => scrub(s.path));
    const { top1, top3 } = scoreCase(suspects, spec.culprits);
    return {
      name: spec.name,
      expectedMiss: spec.expectedMiss === true,
      top1,
      top3,
      topSuspect: suspects[0] ?? null,
      suspects,
      culprits: spec.culprits,
    };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  } finally {
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite runner + scoreboard
// ─────────────────────────────────────────────────────────────────────────────

export interface RunBenchOptions {
  /** Defaults to bench/cases next to this file. */
  casesRoot?: string;
  /** Substring filter on case (dir) names. */
  filter?: string;
  /** Results JSON path; defaults to bench/results.json. */
  jsonOut?: string;
  /** CI regression gate: fail on top-3 < baseline or any case error. */
  gate?: boolean;
  /** Output sink for progress + scoreboard (default: stdout). */
  log?: (line: string) => void;
  /** Per-pipeline-run timeout forwarded to runCase. */
  timeoutMs?: number;
}

export interface BenchRun {
  results: CaseResult[];
  summary: BenchSummary;
  exitCode: number;
}

function benchDirname(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

const mark = (hit: boolean): string => (hit ? '✓' : '✗');

function padEnd(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function formatScoreboard(
  results: readonly CaseResult[],
  summary: BenchSummary,
): string {
  const headline = results.filter((r) => r.error === undefined && !r.expectedMiss);
  const knownMisses = results.filter((r) => r.error === undefined && r.expectedMiss);
  const errored = results.filter((r) => r.error !== undefined);

  const rows = [...headline, ...knownMisses];
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const suspectW = Math.max(
    11,
    ...rows.map((r) => clip(r.topSuspect ?? '—', 28).length),
  );

  const line = (r: CaseResult): string =>
    `${padEnd(r.name, nameW)}  ${mark(r.top1)}     ${mark(r.top3)}     ` +
    `${padEnd(clip(r.topSuspect ?? '—', 28), suspectW)}  ${clip(r.culprits.join(', '), 40)}`;

  const out: string[] = [];
  out.push('whatbroke bench — suspect-ranking accuracy (full pipeline replay)');
  out.push('');
  out.push(`${padEnd('case', nameW)}  top1  top3  ${padEnd('top suspect', suspectW)}  expected`);
  out.push(`${'-'.repeat(nameW)}  ----  ----  ${'-'.repeat(suspectW)}  ${'-'.repeat(20)}`);
  for (const r of headline) {
    out.push(line(r));
  }
  if (knownMisses.length > 0) {
    out.push('');
    out.push('known misses (labeled expectedMiss — improvement backlog, NOT in headline):');
    for (const r of knownMisses) {
      out.push(line(r));
    }
  }
  if (errored.length > 0) {
    out.push('');
    out.push('case errors (broken cases — fix the fixture):');
    for (const r of errored) {
      out.push(`  ${r.name}: ${r.error ?? 'unknown error'}`);
    }
  }
  out.push('');
  out.push(
    `totals: top1 ${summary.top1}/${summary.total} (${summary.top1Pct}%)  ` +
      `top3 ${summary.top3}/${summary.total} (${summary.top3Pct}%)`,
  );
  out.push(
    summary.flipped.length > 0
      ? `known-miss flips (now hitting top-3): ${summary.flipped.join(', ')}`
      : `known-miss flips (now hitting top-3): none of ${summary.knownMissTotal}`,
  );
  return out.join('\n');
}

interface BaselineFile {
  top1Pct?: number;
  top3Pct?: number;
  cases?: number;
}

async function evaluateGate(
  benchDir: string,
  summary: BenchSummary,
  log: (line: string) => void,
): Promise<number> {
  if (summary.errors.length > 0) {
    log(`GATE FAIL: ${summary.errors.length} case error(s): ${summary.errors.join(', ')}`);
    return 1;
  }
  const baselinePath = path.join(benchDir, 'baseline.json');
  let baseline: BaselineFile;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8')) as BaselineFile;
  } catch (err) {
    log(`GATE FAIL: cannot read ${baselinePath}: ${String(err)}`);
    return 1;
  }
  if (typeof baseline.top3Pct !== 'number') {
    log('GATE FAIL: baseline.json has no numeric "top3Pct"');
    return 1;
  }
  if (summary.top3Pct < baseline.top3Pct) {
    log(
      `GATE FAIL: top3 accuracy ${summary.top3Pct}% dropped below baseline ${baseline.top3Pct}%`,
    );
    return 1;
  }
  log(`gate ok: top3 ${summary.top3Pct}% >= baseline ${baseline.top3Pct}%`);
  return 0;
}

/** Run the whole suite; standalone exit code is 0 unless `gate` is set. */
export async function runBench(opts: RunBenchOptions = {}): Promise<BenchRun> {
  const log =
    opts.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const benchDir = benchDirname();
  const casesRoot = opts.casesRoot ?? path.join(benchDir, 'cases');

  const loads = await loadCases(casesRoot, opts.filter);
  if (loads.length === 0) {
    log(`no cases found under ${casesRoot}${opts.filter ? ` matching "${opts.filter}"` : ''}`);
  }

  const results: CaseResult[] = [];
  let i = 0;
  for (const load of loads) {
    i += 1;
    if (!load.ok) {
      log(`[${i}/${loads.length}] ${load.name}: CASE ERROR ${load.error}`);
      results.push({
        name: load.name,
        expectedMiss: false,
        top1: false,
        top3: false,
        topSuspect: null,
        suspects: [],
        culprits: [],
        error: load.error,
      });
      continue;
    }
    const result = await runCase(
      load.case,
      opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
    );
    const status = result.error
      ? `CASE ERROR ${result.error}`
      : `top1 ${mark(result.top1)} top3 ${mark(result.top3)}${result.expectedMiss ? ' (expectedMiss)' : ''}`;
    log(`[${i}/${loads.length}] ${result.name}: ${status}`);
    results.push(result);
  }

  const summary = summarize(results);
  log('');
  log(formatScoreboard(results, summary));

  const jsonPath = opts.jsonOut
    ? path.resolve(opts.jsonOut)
    : path.join(benchDir, 'results.json');
  const payload = {
    cases: results,
    top1: summary.top1,
    top3: summary.top3,
    top1Pct: summary.top1Pct,
    top3Pct: summary.top3Pct,
    knownMisses: { total: summary.knownMissTotal, flipped: summary.flipped },
    errors: summary.errors,
  };
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log(`results written to ${jsonPath}`);

  const exitCode = opts.gate ? await evaluateGate(benchDir, summary, log) : 0;
  return { results, summary, exitCode };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: npx tsx bench/run.ts [--filter <substr>] [--json <out.json>] [--gate]';

function parseCliArgs(
  argv: string[],
): { opts: RunBenchOptions; error?: string } {
  const opts: RunBenchOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inlineVal = eq === -1 ? undefined : arg.slice(eq + 1);
    const takeValue = (): string | undefined => {
      if (inlineVal !== undefined) return inlineVal;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return undefined;
      i += 1;
      return next;
    };
    switch (key) {
      case '--filter': {
        const v = takeValue();
        if (v === undefined) return { opts, error: '--filter needs a value' };
        opts.filter = v;
        break;
      }
      case '--json': {
        const v = takeValue();
        if (v === undefined) return { opts, error: '--json needs a path' };
        opts.jsonOut = v;
        break;
      }
      case '--gate':
        opts.gate = true;
        break;
      default:
        return { opts, error: `unknown flag: ${arg}` };
    }
  }
  return { opts };
}

async function main(): Promise<void> {
  const { opts, error } = parseCliArgs(process.argv.slice(2));
  if (error) {
    process.stderr.write(`${error}\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const started = Date.now();
  const { exitCode } = await runBench(opts);
  process.stdout.write(`bench completed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  process.exitCode = exitCode;
}

const invokedAsScript = ((): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
