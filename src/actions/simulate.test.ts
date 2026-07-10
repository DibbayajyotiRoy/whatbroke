/**
 * T2.2 local simulation of the composite action's bash glue (roadmap 2.1 AC2).
 *
 * The scripts are EXTRACTED from action.yml at test time — not duplicated —
 * so this exercises the exact bash that runs in CI. GitHub `${{ ... }}`
 * expressions are substituted with test values (unknown expressions throw,
 * so any new interpolation must be stubbed here on purpose), the whatbroke
 * CLI is stubbed by a tiny node script that mimics `whatbroke run --ci`
 * (writes a fake bundle, prints the ::whatbroke line, exits 1), and every
 * script runs under `bash --noprofile --norc -e -o pipefail <file>` exactly
 * like the GitHub runner invokes composite `shell: bash` steps.
 */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionSrc = readFileSync(join(repoRoot, 'action.yml'), 'utf8');

// --- extraction of scripts from action.yml (mini YAML-subset reader) --------

/** Body of the step with the given id (from `- id: x` to the next `- id:`). */
function stepBody(id: string): string {
  const runsIdx = actionSrc.search(/^runs:/m);
  assert.notEqual(runsIdx, -1, 'action.yml has a runs: section');
  const runs = actionSrc.slice(runsIdx);
  const found = [...runs.matchAll(/-\s+id:\s*([\w-]+)/g)];
  const i = found.findIndex((m) => m[1] === id);
  assert.notEqual(i, -1, `action.yml has a step with id '${id}'`);
  const start = found[i]?.index ?? 0;
  const next = found[i + 1];
  return runs.slice(start, next ? next.index : runs.length);
}

/** Contents of a step's `run: |` block scalar, dedented. */
function scriptOf(body: string): string {
  const lines = body.split('\n');
  const runIdx = lines.findIndex((l) => /^\s*run:\s*\|/.test(l));
  assert.notEqual(runIdx, -1, 'step has a `run: |` block');
  const out: string[] = [];
  let indent = -1;
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (indent === -1) indent = width;
    if (width < indent) break;
    out.push(line.slice(indent));
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  assert.ok(out.length > 0, 'run block is non-empty');
  return `${out.join('\n')}\n`;
}

/** Replace `${{ expr }}` with stub values; unknown expressions fail the test. */
function substitute(script: string, values: Record<string, string>): string {
  return script.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_all, expr: string) => {
    const v = values[expr];
    if (v === undefined) throw new Error(`simulate: no stub value for expression '${expr}'`);
    return v;
  });
}

// --- simulated runner environment -------------------------------------------

interface Ctx {
  root: string;
  fixture: string; // stands in for `working-directory`
  outputFile: string; // $GITHUB_OUTPUT
  summaryFile: string; // $GITHUB_STEP_SUMMARY
  runnerTemp: string; // $RUNNER_TEMP
  stub: string; // fake whatbroke CLI
  n: number;
}

const STUB_CLI = `// Stub of \`whatbroke run --ci -- <cmd>\`: mimics only what the action's
// glue depends on. STUB_EXIT=0 -> green (journal written); otherwise crash
// (bundle .json + .md written, stable ::whatbroke line printed, exit code).
const fs = require('node:fs');
const path = require('node:path');
const code = Number(process.env.STUB_EXIT ?? '1');
const store = path.join(process.cwd(), '.whatbroke');
if (code === 0) {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'journal.json'), '{"version":1,"entries":[]}\\n');
} else {
  const dir = path.join(store, 'bundles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'whatbroke-sim42.json'), '{"id":"sim42"}\\n');
  fs.writeFileSync(
    path.join(dir, 'whatbroke-sim42.md'),
    '# whatbroke report sim42\\n\\nintentional simulated crash\\n',
  );
  process.stdout.write(
    '::whatbroke bundle=' + path.join(dir, 'whatbroke-sim42.json') + ' confidence=high suspect=boom.js\\n',
  );
}
process.exit(code);
`;

function makeCtx(): Ctx {
  const root = mkdtempSync(join(tmpdir(), 'whatbroke-action-sim-'));
  const fixture = join(root, 'fixture');
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(fixture, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const outputFile = join(root, 'github-output');
  const summaryFile = join(root, 'github-step-summary');
  writeFileSync(outputFile, ''); // the runner pre-creates both files
  writeFileSync(summaryFile, '');
  const stub = join(root, 'stub-whatbroke.cjs');
  writeFileSync(stub, STUB_CLI);
  return { root, fixture, outputFile, summaryFile, runnerTemp, stub, n: 0 };
}

function execStep(
  ctx: Ctx,
  script: string,
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const file = join(ctx.root, `step-${ctx.n++}.sh`);
  writeFileSync(file, script);
  return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', file], {
    cwd: ctx.fixture,
    env: {
      ...process.env,
      GITHUB_OUTPUT: ctx.outputFile,
      GITHUB_STEP_SUMMARY: ctx.summaryFile,
      RUNNER_TEMP: ctx.runnerTemp,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

/** Last `exit=<code>` written to $GITHUB_OUTPUT (GitHub's last-write-wins). */
function recordedExit(ctx: Ctx): string | undefined {
  const text = readFileSync(ctx.outputFile, 'utf8');
  const matches = [...text.matchAll(/^exit=(\S+)$/gm)];
  const last = matches[matches.length - 1];
  return last ? last[1] : undefined;
}

function baseValues(ctx: Ctx): Record<string, string> {
  return {
    'inputs.whatbroke-command': `node ${ctx.stub}`,
    'inputs.run': 'node boom.js',
    'inputs.artifact-name': 'whatbroke-bundle',
  };
}

const runScript = scriptOf(stepBody('run'));
const summaryScript = scriptOf(stepBody('summary'));
const gateScript = scriptOf(stepBody('gate'));

// --- tests -------------------------------------------------------------------

test('run step: crash exit code lands in GITHUB_OUTPUT without failing the step', () => {
  const ctx = makeCtx();
  try {
    const res = execStep(ctx, substitute(runScript, baseValues(ctx)));
    assert.equal(res.status, 0, `run step must not fail itself:\n${res.stdout}\n${res.stderr}`);
    assert.equal(recordedExit(ctx), '1', 'crash exit code recorded to GITHUB_OUTPUT');
    // stdout streamed through tee AND captured to the log for the summary step
    assert.match(res.stdout, /::whatbroke bundle=/);
    const log = readFileSync(join(ctx.runnerTemp, 'whatbroke-run.log'), 'utf8');
    assert.match(log, /^::whatbroke bundle=.* confidence=high suspect=boom\.js$/m);
    // the artifact path the upload step would zip exists and has both files
    assert.ok(existsSync(join(ctx.fixture, '.whatbroke', 'bundles', 'whatbroke-sim42.json')));
    assert.ok(existsSync(join(ctx.fixture, '.whatbroke', 'bundles', 'whatbroke-sim42.md')));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('summary step: newest bundle .md is appended to GITHUB_STEP_SUMMARY with the artifact note', () => {
  const ctx = makeCtx();
  try {
    const run = execStep(ctx, substitute(runScript, baseValues(ctx)));
    assert.equal(run.status, 0, run.stderr);

    // An OLDER stray bundle must lose to the fresh one (ls -t | head -1).
    const oldMd = join(ctx.fixture, '.whatbroke', 'bundles', 'whatbroke-old.md');
    writeFileSync(oldMd, '# OLD BUNDLE MUST NOT APPEAR\n');
    utimesSync(oldMd, new Date('2000-01-02'), new Date('2000-01-02'));

    const values = { ...baseValues(ctx), 'steps.run.outputs.exit': recordedExit(ctx) ?? '' };
    const res = execStep(ctx, substitute(summaryScript, values));
    assert.equal(res.status, 0, `summary step failed:\n${res.stdout}\n${res.stderr}`);

    const summary = readFileSync(ctx.summaryFile, 'utf8');
    assert.match(summary, /wrapped command failed \(exit 1\)/);
    assert.match(summary, /# whatbroke report sim42/, 'newest bundle md content is in the summary');
    assert.match(summary, /intentional simulated crash/);
    assert.doesNotMatch(summary, /OLD BUNDLE MUST NOT APPEAR/);
    assert.match(summary, /whatbroke-bundle/, 'summary names the uploaded artifact');
    // the optional re-echo of the stable machine line into the step log
    assert.match(res.stdout, /^::whatbroke bundle=/m);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('summary step: graceful message when the command failed before any bundle existed', () => {
  const ctx = makeCtx();
  try {
    const values = { ...baseValues(ctx), 'steps.run.outputs.exit': '7' };
    const res = execStep(ctx, substitute(summaryScript, values));
    assert.equal(res.status, 0, `summary step failed:\n${res.stdout}\n${res.stderr}`);
    const summary = readFileSync(ctx.summaryFile, 'utf8');
    assert.match(summary, /wrapped command failed \(exit 7\)/);
    assert.match(summary, /no whatbroke bundle was written/);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('run step: a whatbroke command that cannot even spawn still records its exit code', () => {
  const ctx = makeCtx();
  try {
    const values = { ...baseValues(ctx), 'inputs.whatbroke-command': 'definitely-not-a-real-command-a1b2c3' };
    const res = execStep(ctx, substitute(runScript, values));
    assert.equal(res.status, 0, `run step must not fail itself:\n${res.stdout}\n${res.stderr}`);
    assert.equal(recordedExit(ctx), '127', 'command-not-found code captured');
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('green path: exit=0 recorded and the journal exists for the cache-save step', () => {
  const ctx = makeCtx();
  try {
    const res = execStep(ctx, substitute(runScript, baseValues(ctx)), { STUB_EXIT: '0' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(recordedExit(ctx), '0');
    assert.ok(
      existsSync(join(ctx.fixture, '.whatbroke', 'journal.json')),
      'journal written on green — the path the save step caches',
    );
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('gate step: re-raises the recorded exit code (fails on 1, passes on 0)', () => {
  const ctx = makeCtx();
  try {
    const crash = execStep(ctx, substitute(gateScript, { ...baseValues(ctx), 'steps.run.outputs.exit': '1' }));
    assert.equal(crash.status, 1, 'gate must fail the job with the recorded code');
    assert.match(crash.stderr, /whatbroke: wrapped command exited with 1/);

    const green = execStep(ctx, substitute(gateScript, { ...baseValues(ctx), 'steps.run.outputs.exit': '0' }));
    assert.equal(green.status, 0, `gate must pass on green:\n${green.stderr}`);

    // a missing/empty recorded code fails safe (never silently green)
    const missing = execStep(ctx, substitute(gateScript, { ...baseValues(ctx), 'steps.run.outputs.exit': '' }));
    assert.equal(missing.status, 1, 'empty recorded code must fail the job');
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
