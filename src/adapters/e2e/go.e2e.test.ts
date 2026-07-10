/**
 * Go end-to-end golden tests (T4.1 / roadmap 5.1).
 *
 * Drives the REAL toolchain through the shared `executePipeline` orchestrator
 * in a throwaway git repo, twice per scenario: committed fixture GREEN (journal
 * records the green sha), then the bug applied as an UNCOMMITTED edit, then RED.
 *
 * Two scenarios, asserting exactly what the current pipeline delivers:
 *
 *  1. `go test ./...` — the test panics for real (nil-map write), but the go
 *     tool merges the test binary's stderr INTO ITS STDOUT, and the pipeline
 *     parses only stderr for stack traces. So the golden truth today is: a
 *     bundle with language 'go', kind 'nonzero-exit', NO parsed frames, the
 *     panic text preserved in the stdout log tail, and the culprit still
 *     ranked #1 via the changed-since-green journal signal.
 *
 *  2. `go run .` — the same broken file panics with the trace on REAL stderr
 *     (the go tool passes the child's stderr through), which is the
 *     stack-frame parity proof for the go grammar: parsed frames with
 *     file:line, crash kind upgrade, and the stack∩changed 'high' confidence.
 *
 * Skips cleanly when the go toolchain is not installed (CI installs it).
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

/** Toolchain probe: instant ENOENT when `go` is absent. */
function goUnavailable(): string | false {
  try {
    const probe = spawnSync('go', ['version'], { stdio: 'ignore', timeout: 15_000 });
    return probe.status === 0 ? false : 'go toolchain not available';
  } catch {
    return 'go toolchain not available';
  }
}

const SKIP = goUnavailable();

/** Copy the go fixture into a fresh temp dir and commit it (GREEN state). */
async function makeFixtureRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatbroke-e2e-go-'));
  await fs.cp(path.join(FIXTURES, 'go-proj'), dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'green fixture'], { cwd: dir });
  return dir;
}

async function breakTally(dir: string): Promise<void> {
  const broken = await fs.readFile(
    path.join(FIXTURES, 'go-proj.broken', 'app.go'),
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'app.go'), broken, 'utf8');
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
    timeoutMs: 300_000, // first go build in a cold cache can be slow in CI
  };
}

test(
  'go e2e: go test ./... — panic captured in logs, culprit ranked via changed-since-green',
  { skip: SKIP },
  async () => {
    const dir = await makeFixtureRepo();
    const storePaths = resolveStorePaths(dir);
    const argv = ['go', 'test', './...'];

    // ── 1. Green run ─────────────────────────────────────────────────────────
    const green = await executePipeline(pipelineOpts(dir, argv));
    assert.equal(green.outcome, 'green');
    const journal = await openJournal(storePaths.journal);
    assert.equal(journal.list().length, 1, 'green run must be journaled');

    // ── 2. Break app.go (uncommitted), 3. red run ────────────────────────────
    await breakTally(dir);
    const red = await executePipeline(pipelineOpts(dir, argv));
    assert.equal(red.outcome, 'crash');
    if (red.outcome !== 'crash') return;
    assert.equal(red.exitCode, 1);
    const bundle = red.bundle;

    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.language, 'go');
    assert.equal(bundle.environment.runtime.name, 'go');

    // `go test` merges the test binary's stderr into stdout, and the pipeline
    // parses only stderr — so no frames are parsed here (documented tier limit;
    // see docs/adding-a-language.md) and the kind stays 'nonzero-exit'.
    assert.equal(bundle.crash.kind, 'nonzero-exit');
    assert.equal(bundle.crash.exitCode, 1);
    assert.equal(bundle.crash.error, undefined);
    // The panic + failing test name ARE preserved in the stdout log tail.
    assert.match(bundle.logs.stdoutTail, /--- FAIL: TestTallyFirstView/);
    assert.match(bundle.logs.stdoutTail, /panic: assignment to entry in nil map/);
    // Grammar-tier adapter: no go-test report parser → no testFailure identity.
    assert.equal(bundle.crash.testFailure, undefined);

    // The moat still names the culprit: app.go changed since the journaled green.
    assert.equal(bundle.git.greenRefSource, 'journal');
    const suspect = bundle.repro.suspects[0];
    assert.ok(suspect, 'expected a ranked suspect');
    assert.equal(suspect.path, 'app.go');
    assert.ok(suspect.reasons.some((r) => r.includes('changed since green')));
    // No frames → no stack∩changed intersection → deterministically 'low'.
    assert.equal(bundle.repro.confidence, 'low');

    const files = await fs.readdir(storePaths.bundlesDir);
    assert.ok(files.some((f) => f.endsWith('.json')));
    await fs.rm(dir, { recursive: true, force: true });
  },
);

test(
  'go e2e: go run . — panic frames golden (grammar parity: file:line, kind, suspects)',
  { skip: SKIP },
  async () => {
    const dir = await makeFixtureRepo();
    const storePaths = resolveStorePaths(dir);
    const argv = ['go', 'run', '.'];

    // ── 1. Green run ─────────────────────────────────────────────────────────
    const green = await executePipeline(pipelineOpts(dir, argv));
    assert.equal(green.outcome, 'green');

    // ── 2. Break app.go (uncommitted), 3. red run ────────────────────────────
    await breakTally(dir);
    const red = await executePipeline(pipelineOpts(dir, argv));
    assert.equal(red.outcome, 'crash');
    if (red.outcome !== 'crash') return;
    assert.equal(red.exitCode, 1);
    const bundle = red.bundle;

    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.language, 'go');

    // A parsed panic upgrades the kind, with the trace from real stderr.
    assert.equal(bundle.crash.kind, 'uncaught-exception');
    const err = bundle.crash.error;
    assert.ok(err, 'expected a parsed panic from stderr');
    assert.equal(err.name, 'panic');
    assert.match(err.message, /assignment to entry in nil map/);
    assert.ok(err.stack.length >= 2, 'expected Tally + main frames');
    const top = err.stack[0];
    assert.ok(top, 'expected a top frame');
    assert.equal(top.fileRelative, 'app.go');
    assert.equal(top.line, 9); // `counts[key]++` in app.go
    assert.equal(top.functionName, 'main.Tally');
    assert.equal(top.isInRepo, true);
    assert.equal(top.isUserCode, true);
    const caller = err.stack[1];
    assert.ok(caller, 'expected the caller frame');
    assert.equal(caller.fileRelative, 'main.go');
    assert.equal(caller.functionName, 'main.main');

    // Suspects: app.go on the stack AND changed since green → #1, 'high'.
    assert.equal(bundle.git.greenRefSource, 'journal');
    const suspect = bundle.repro.suspects[0];
    assert.ok(suspect, 'expected a ranked suspect');
    assert.equal(suspect.path, 'app.go');
    assert.ok(suspect.reasons.some((r) => r.includes('on stack')));
    assert.ok(suspect.reasons.some((r) => r.includes('changed since green')));
    assert.equal(bundle.repro.confidence, 'high');

    // Bundle JSON round-trips from disk.
    const files = await fs.readdir(storePaths.bundlesDir);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    assert.ok(jsonFile, 'expected a bundle .json on disk');
    const roundTrip = JSON.parse(
      await fs.readFile(path.join(storePaths.bundlesDir, jsonFile), 'utf8'),
    ) as { schemaVersion: number; id: string; language: string };
    assert.equal(roundTrip.schemaVersion, 1);
    assert.equal(roundTrip.id, bundle.id);
    assert.equal(roundTrip.language, 'go');

    await fs.rm(dir, { recursive: true, force: true });
  },
);
