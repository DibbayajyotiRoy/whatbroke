/**
 * T2.2 schema-level guard for the composite GitHub Action (roadmap 2.1
 * AC2/AC3, ADR-0005). Composite actions cannot execute locally, so this test
 * pins `action.yml`'s structure: the inputs contract, step ids and ORDER, the
 * gating condition on each step, and the exit-code plumbing.
 *
 * Deliberately a tiny hand-rolled YAML-subset reader (indentation + regex) —
 * no yaml dependency. Regexes tolerate whitespace via `\s*` so harmless
 * reformatting does not break the suite; semantic changes do.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(repoRoot, 'action.yml'), 'utf8');

/** GitHub expression `${{ inner }}` as a whitespace-tolerant regex fragment. */
function ghExpr(inner: string): string {
  const escaped = inner.replace(/[.$*+?()[\]{}|^\\/-]/g, (c) => `\\${c}`);
  return String.raw`\$\{\{\s*${escaped}\s*\}\}`;
}

/** Text between a top-level `key:` line and the next top-level key. */
function topSection(name: string): string {
  const m = new RegExp(`^${name}:.*$`, 'm').exec(src);
  assert.ok(m, `action.yml has a top-level '${name}:' section`);
  const rest = src.slice(m.index + m[0].length);
  const next = /^[A-Za-z][\w-]*:/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Block of one input under `inputs:` (from its name line to the next input). */
function inputBlock(name: string): string {
  const inputs = topSection('inputs');
  const m = new RegExp(`^ {2}${name}:\\s*$`, 'm').exec(inputs);
  assert.ok(m, `inputs.${name} is declared`);
  const rest = inputs.slice(m.index + m[0].length);
  const next = /^ {2}[A-Za-z][\w-]*:/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

interface Step {
  id: string;
  body: string;
}

function steps(): Step[] {
  const runs = topSection('runs');
  const found = [...runs.matchAll(/-\s+id:\s*([\w-]+)/g)];
  assert.ok(found.length > 0, 'runs.steps declares `- id:` steps');
  return found.map((m, i) => {
    const start = m.index ?? 0;
    const nextMatch = found[i + 1];
    const end = nextMatch ? (nextMatch.index ?? runs.length) : runs.length;
    return { id: m[1] ?? '', body: runs.slice(start, end) };
  });
}

function step(id: string): Step {
  const s = steps().find((s) => s.id === id);
  assert.ok(s, `action.yml has a step with id '${id}'`);
  return s;
}

function ifLine(s: Step): string {
  const m = /^\s*if:\s*(.+)$/m.exec(s.body);
  assert.ok(m, `step '${s.id}' has an if: condition`);
  return m[1] ?? '';
}

test('action metadata: name whatbroke, description, composite runner', () => {
  assert.match(src, /^name:\s*'?whatbroke'?\s*$/m);
  const desc = /^description:\s*>?-?\s*\n?([\s\S]{0,400})/m.exec(src);
  assert.ok(desc, 'has a description');
  assert.match(src, /runs:\s*\n\s*using:\s*'?composite'?/);
});

test('inputs contract: run required; defaults for the optional inputs', () => {
  assert.match(inputBlock('run'), /required:\s*true/);
  assert.match(inputBlock('run'), /word-split/i); // the documented quoting contract
  assert.match(inputBlock('working-directory'), /default:\s*'\.'/);
  assert.match(inputBlock('journal-cache'), /default:\s*'true'/);
  assert.match(inputBlock('artifact-name'), /default:\s*'whatbroke-bundle'/);
  assert.match(inputBlock('node-version'), /default:\s*'20'/);
  assert.match(inputBlock('whatbroke-command'), /default:\s*'npx -y @whatbroke\/whatbroke'/);
});

test('outputs: exit is exposed and wired to the run step output', () => {
  const outputs = topSection('outputs');
  assert.match(outputs, /^ {2}exit:\s*$/m);
  assert.match(outputs, new RegExp(`value:\\s*${ghExpr('steps.run.outputs.exit')}`));
});

test('steps appear in the required order: restore, run, summary, artifact, save, gate', () => {
  const required = ['restore', 'run', 'summary', 'artifact', 'save', 'gate'];
  const ids = steps().map((s) => s.id);
  assert.deepEqual(
    ids.filter((id) => required.includes(id)),
    required,
    `step order wrong: ${ids.join(' -> ')}`,
  );
  // The gate must be the LAST step overall: everything (summary, artifact,
  // cache save) must already have run before the job is failed.
  assert.equal(ids[ids.length - 1], 'gate');
});

test('restore step: cache/restore@v4 of the journal, branch key + default-branch fallback', () => {
  const s = step('restore');
  assert.match(s.body, /uses:\s*actions\/cache\/restore@v4/);
  assert.match(s.body, new RegExp(`path:\\s*${ghExpr('inputs.working-directory')}/\\.whatbroke/journal\\.json`));
  assert.match(s.body, new RegExp(`key:\\s*whatbroke-journal-${ghExpr('runner.os')}-${ghExpr('github.ref_name')}`));
  assert.match(
    s.body,
    new RegExp(
      `restore-keys:\\s*\\|?\\s*\\n\\s*whatbroke-journal-${ghExpr('runner.os')}-${ghExpr('github.event.repository.default_branch')}`,
    ),
    'restore-keys falls back to the default-branch journal (ADR-0005: PR runs diff vs green main)',
  );
  assert.match(ifLine(s), /inputs\.journal-cache\s*==\s*'true'/);
});

test('run step: bash in working-directory, wraps command with `run --ci --`, records exit without failing', () => {
  const s = step('run');
  assert.match(s.body, /shell:\s*bash/);
  assert.match(s.body, new RegExp(`working-directory:\\s*${ghExpr('inputs.working-directory')}`));
  assert.match(
    s.body,
    new RegExp(`${ghExpr('inputs.whatbroke-command')}\\s+run\\s+--ci\\s+--\\s+${ghExpr('inputs.run')}`),
    'invokes `<whatbroke-command> run --ci -- <run>`',
  );
  assert.match(s.body, /\|\|\s*code=\$\?/, 'captures the exit code instead of failing the step');
  assert.match(s.body, /echo\s+"exit=\$code"\s*>>\s*"\$GITHUB_OUTPUT"/, 'exports exit to GITHUB_OUTPUT');
});

test('summary step: gated on crash, appends newest bundle .md to the job summary', () => {
  const s = step('summary');
  assert.match(ifLine(s), /steps\.run\.outputs\.exit\s*!=\s*'0'/);
  assert.match(s.body, /ls\s+-t\s+\.whatbroke\/bundles\/\*\.md/, 'globs the bundles dir (not the ::whatbroke line)');
  assert.match(s.body, /head\s+-n\s*1/, 'picks the newest bundle');
  assert.match(s.body, /\$GITHUB_STEP_SUMMARY/, 'appends to the job summary');
});

test('artifact step: upload-artifact@v4 of the bundles dir, gated on crash, named from input', () => {
  const s = step('artifact');
  assert.match(s.body, /uses:\s*actions\/upload-artifact@v4/);
  assert.match(ifLine(s), /steps\.run\.outputs\.exit\s*!=\s*'0'/);
  assert.match(s.body, new RegExp(`name:\\s*${ghExpr('inputs.artifact-name')}`));
  assert.match(s.body, new RegExp(`path:\\s*${ghExpr('inputs.working-directory')}/\\.whatbroke/bundles/`));
});

test('save step: cache/save@v4 gated on green + default branch + journal-cache enabled', () => {
  const s = step('save');
  assert.match(s.body, /uses:\s*actions\/cache\/save@v4/);
  const cond = ifLine(s);
  assert.match(cond, /steps\.run\.outputs\.exit\s*==\s*'0'/, 'only saves on green');
  assert.match(cond, /inputs\.journal-cache\s*==\s*'true'/, 'respects the journal-cache switch');
  assert.match(
    cond,
    /github\.ref_name\s*==\s*github\.event\.repository\.default_branch/,
    'only default-branch runs record the green baseline (ADR-0005)',
  );
  assert.match(s.body, new RegExp(`path:\\s*${ghExpr('inputs.working-directory')}/\\.whatbroke/journal\\.json`));
  // Immutable-cache workaround: default-branch key + run_id uniquifier so
  // every green main run records a fresh baseline; restore prefix-matches.
  assert.match(
    s.body,
    new RegExp(
      `key:\\s*whatbroke-journal-${ghExpr('runner.os')}-${ghExpr('github.event.repository.default_branch')}-${ghExpr('github.run_id')}`,
    ),
  );
});

test('gate step: re-raises the recorded exit code last', () => {
  const s = step('gate');
  assert.match(s.body, new RegExp(`code='${ghExpr('steps.run.outputs.exit')}'`));
  assert.match(s.body, /exit\s+"\$\{code:-1\}"/, 'exits with the recorded code (missing output fails safe)');
});

test('every uses: is pinned to @v4', () => {
  for (const s of steps()) {
    const m = /uses:\s*(\S+)/.exec(s.body);
    if (!m) continue;
    assert.ok((m[1] ?? '').endsWith('@v4'), `step '${s.id}' uses '${m[1]}', expected an @v4 pin`);
  }
});
