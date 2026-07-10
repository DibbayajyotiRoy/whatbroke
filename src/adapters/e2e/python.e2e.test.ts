/**
 * Python end-to-end golden test (T4.1 / roadmap 5.1).
 *
 * Drives the REAL toolchain (`python3 -m pytest`) through the shared
 * `executePipeline` orchestrator in a throwaway git repo:
 *
 *   1. run the committed fixture GREEN → journal records the green sha,
 *   2. apply the bug as an UNCOMMITTED edit (the changed-since-green signal),
 *   3. run RED → golden assertions on the redacted bundle.
 *
 * Fixture design note: the pipeline parses the child's *stderr* for a stack
 * trace, while pytest prints its failure report to *stdout*. The fixture's bug
 * therefore crashes a worker thread — CPython's default threading.excepthook
 * prints a bona-fide `Traceback (most recent call last):` block to real stderr
 * (pytest capture is off via the fixture's pyproject.toml). The pytest report
 * (with the failing test id) still lands in the bundle's stdout log tail; it is
 * NOT parsed into crash.testFailure — the python adapter is grammar-tier and
 * has no pytest report parser (see docs/adding-a-language.md, no overclaiming).
 *
 * Skips cleanly when python3+pytest are not installed (CI installs them).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { executePipeline } from '../../pipeline.js';
import { DEFAULT_CONFIG } from '../../config.js';
import { resolveStorePaths } from '../../paths.js';
import { openJournal } from '../../journal/journal.js';
import { createFileSink } from '../../sinks/file.js';
import { renderMarkdown } from '../../render/markdown.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PYTEST_ARGV = ['python3', '-m', 'pytest', '-x', '-q'];

/**
 * Toolchain probe. Must be cheap when the toolchain is absent: a missing
 * `python3` fails the spawn instantly (ENOENT), and `python3 -m pytest` without
 * pytest exits ≠0 in well under a second. Returns a skip message or false.
 */
function pytestUnavailable(): string | false {
  try {
    const probe = spawnSync('python3', ['-m', 'pytest', '--version'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    return probe.status === 0 ? false : 'python3+pytest not available';
  } catch {
    return 'python3+pytest not available';
  }
}

const SKIP = pytestUnavailable();

/** Copy a fixture project into a fresh temp dir and commit it (GREEN state). */
async function makeFixtureRepo(fixture: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-e2e-py-'));
  await fs.cp(path.join(FIXTURES, fixture), dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'green fixture'], { cwd: dir });
  return dir;
}

function pipelineOpts(dir: string, argv: string[]) {
  const storePaths = resolveStorePaths(dir);
  const sink = createFileSink({
    bundlesDir: storePaths.bundlesDir,
    render: renderMarkdown,
  });
  return {
    command: { argv, cwd: dir },
    config: DEFAULT_CONFIG,
    storePaths,
    sinks: [sink],
    timeoutMs: 120_000,
  };
}

test(
  'python e2e: pytest run — green journal, then golden bundle (frames, kind, suspects)',
  { skip: SKIP },
  async () => {
    const dir = await makeFixtureRepo('py-proj');
    const storePaths = resolveStorePaths(dir);

    // ── 1. Green run: passes, records the journal, writes no bundle ─────────
    const green = await executePipeline(pipelineOpts(dir, PYTEST_ARGV));
    assert.equal(green.outcome, 'green');
    assert.equal(green.exitCode, 0);
    const journal = await openJournal(storePaths.journal);
    assert.equal(journal.list().length, 1, 'green run must be journaled');

    // ── 2. Break: overwrite app.py with the buggy version (uncommitted) ─────
    const broken = await fs.readFile(
      path.join(FIXTURES, 'py-proj.broken', 'app.py'),
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'app.py'), broken, 'utf8');

    // ── 3. Red run: crash bundle through the full pipeline + file sink ──────
    const red = await executePipeline(pipelineOpts(dir, PYTEST_ARGV));
    assert.equal(red.outcome, 'crash');
    if (red.outcome !== 'crash') return;
    assert.equal(red.exitCode, 1);
    const bundle = red.bundle;

    // Language routing + schema.
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.language, 'python');
    assert.equal(bundle.environment.runtime.name, 'python');

    // Crash kind: a parsed traceback upgrades nonzero-exit → uncaught-exception.
    assert.equal(bundle.crash.kind, 'uncaught-exception');
    assert.equal(bundle.crash.exitCode, 1);
    assert.equal(bundle.crash.signal, null);

    // Parsed error: the worker thread's KeyError, most-recent frame first.
    const err = bundle.crash.error;
    assert.ok(err, 'expected a parsed ErrorInfo from stderr');
    assert.equal(err.name, 'KeyError');
    assert.match(err.message, /timeout/);
    assert.ok(err.stack.length >= 3, 'app frame + threading frames expected');
    const top = err.stack[0];
    assert.ok(top, 'expected a top frame');
    assert.equal(top.fileRelative, 'app.py');
    assert.equal(top.line, 10); // `results[key] = overrides[key]` in app.py
    assert.equal(top.functionName, 'load_settings');
    assert.equal(top.isInRepo, true);
    assert.equal(top.isUserCode, true);
    // stdlib threading frames are vendor code outside the repo.
    const vendor = err.stack.find((f) => f.file?.includes('threading.py'));
    assert.ok(vendor, 'expected stdlib threading frames');
    assert.equal(vendor.isUserCode, false);
    assert.equal(vendor.isInRepo, false);

    // Test identity: the python adapter is grammar-tier — it has NO pytest
    // report parser, so crash.testFailure is absent by design. The failing
    // test id is still visible verbatim in the captured stdout tail.
    assert.equal(bundle.crash.testFailure, undefined);
    assert.match(bundle.logs.stdoutTail, /FAILED test_app\.py::test_refresh_uses_defaults/);

    // Suspects: app.py is on the stack AND changed since green → top suspect,
    // and that intersection makes confidence deterministically 'high'.
    assert.equal(bundle.git.greenRefSource, 'journal');
    const suspect = bundle.repro.suspects[0];
    assert.ok(suspect, 'expected a ranked suspect');
    assert.equal(suspect.path, 'app.py');
    assert.ok(suspect.reasons.some((r) => r.includes('on stack')));
    assert.ok(suspect.reasons.some((r) => r.includes('changed since green')));
    assert.equal(bundle.repro.confidence, 'high');
    // The diff vs green captures the uncommitted breaking edit.
    assert.match(bundle.git.diffVsGreen?.patch ?? '', /app\.py/);

    // Sink wrote the pair; the JSON bundle round-trips from disk.
    assert.equal(red.sinkResults.length, 1);
    assert.equal(red.sinkResults[0]?.ok, true);
    const files = await fs.readdir(storePaths.bundlesDir);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    assert.ok(jsonFile, 'expected a bundle .json on disk');
    assert.ok(files.some((f) => f.endsWith('.md')), 'expected a bundle .md on disk');
    const roundTrip = JSON.parse(
      await fs.readFile(path.join(storePaths.bundlesDir, jsonFile), 'utf8'),
    ) as { schemaVersion: number; id: string; language: string };
    assert.equal(roundTrip.schemaVersion, 1);
    assert.equal(roundTrip.id, bundle.id);
    assert.equal(roundTrip.language, 'python');

    await fs.rm(dir, { recursive: true, force: true });
  },
);
