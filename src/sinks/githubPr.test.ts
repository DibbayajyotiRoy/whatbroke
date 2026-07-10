/**
 * Tests for the sticky PR-comment sink (roadmap 2.2). Transport is always a
 * mock — no network, no `gh`. The fixture RedactedBundle is produced by the
 * real redact() gate (the only legitimate brand producer); the brand is never
 * hand-cast here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createGithubPrSink,
  renderPrComment,
  STICKY_MARKER,
} from './githubPr.js';
import type { PrTransport } from './githubPr.js';
import { redact } from '../redaction/redact.js';
import type { Bundle, RedactedBundle } from '../types.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

function baseBundle(): Bundle {
  return {
    schemaVersion: 1,
    id: 'k7m2p9',
    createdAt: '2026-07-01T00:00:00.000Z',
    tool: { name: 'whatbroke', version: '0.2.0' },
    language: 'node',
    crash: {
      kind: 'uncaught-exception',
      exitCode: 1,
      signal: null,
      error: {
        name: 'TypeError',
        message: "cannot read properties of undefined (reading 'profile')",
        stack: [],
        rawStack:
          "TypeError: cannot read properties of undefined (reading 'profile')",
      },
    },
    environment: {
      os: { platform: 'linux', release: '6.0', arch: 'x64' },
      runtime: { name: 'node', version: 'v20.11.0' },
      packageManager: { name: 'npm', version: '10.0.0' },
      envKeys: [],
      envValues: {},
      cwd: '/repo',
    },
    dependencies: { declared: {}, relevantResolved: {}, lockfile: 'none' },
    git: {
      isRepo: true,
      branch: 'main',
      head: 'aaaa111bbbb222ccc',
      dirty: true,
      changedFiles: [{ path: 'src/user.ts', status: 'M' }],
      greenRef: 'e5f6a7b',
      greenRefSource: 'journal',
      diffVsGreen: {
        base: 'e5f6a7b',
        truncated: false,
        patch: 'diff --git a/src/user.ts b/src/user.ts',
      },
    },
    logs: { stdoutTail: '', stderrTail: '', truncated: false, bufferLines: 0 },
    repro: {
      steps: [],
      suspects: [
        {
          path: 'src/user.ts',
          score: 7,
          reasons: ['appears in the stack trace', 'changed since green'],
        },
        { path: 'src/db.ts', score: 5, reasons: ['changed since green'] },
        {
          path: 'src/routes/profile.ts',
          score: 3,
          reasons: ['imports changed file src/user.ts'],
        },
        { path: 'src/unrelated.ts', score: 1, reasons: ['recently modified'] },
      ],
      confidence: 'high',
    },
    redaction: { redactedCount: 0, rules: [] },
    collectorErrors: [],
  };
}

/** The ONLY way this suite obtains the brand: through the real gate. */
function fixture(mutate?: (b: Bundle) => void): RedactedBundle {
  const b = baseBundle();
  if (mutate) mutate(b);
  return redact(b, { env: {} });
}

interface TransportLog {
  listCalls: number;
  created: string[];
  updated: Array<{ id: number; body: string }>;
}

function mockTransport(
  comments: Array<{ id: number; body: string }>,
): { transport: PrTransport; log: TransportLog } {
  const log: TransportLog = { listCalls: 0, created: [], updated: [] };
  const transport: PrTransport = {
    async listComments() {
      log.listCalls += 1;
      return comments;
    },
    async createComment(body: string) {
      log.created.push(body);
      return { url: 'https://github.com/o/r/pull/5#issuecomment-900' };
    },
    async updateComment(id: number, body: string) {
      log.updated.push({ id, body });
      return { url: `https://github.com/o/r/pull/5#issuecomment-${id}` };
    },
  };
  return { transport, log };
}

// ── marker stability ─────────────────────────────────────────────────────────

test('STICKY_MARKER is exported and stable', () => {
  assert.equal(STICKY_MARKER, '<!-- whatbroke-sticky -->');
});

// ── comment body ─────────────────────────────────────────────────────────────

test('renderPrComment: marker first, headline, top-3 suspects with first reasons, show line', () => {
  const bundle = fixture();
  const body = renderPrComment(bundle);

  // Starts with the hidden sticky marker.
  assert.ok(body.startsWith(STICKY_MARKER), 'body must start with the marker');

  // H3 headline carries error name + message.
  assert.ok(body.includes('### TypeError:'), 'missing H3 error headline');
  assert.ok(
    body.includes("cannot read properties of undefined (reading 'profile')"),
    'missing error message',
  );

  // Exactly the top 3 suspects (ranked order), never the 4th.
  assert.ok(body.includes('src/user.ts'), 'missing suspect 1');
  assert.ok(body.includes('src/db.ts'), 'missing suspect 2');
  assert.ok(body.includes('src/routes/profile.ts'), 'missing suspect 3');
  assert.ok(!body.includes('src/unrelated.ts'), 'suspect 4 must be omitted');

  // Each shown suspect carries its score and FIRST reason.
  assert.ok(body.includes('(score 7) — appears in the stack trace'));
  assert.ok(body.includes('(score 5) — changed since green'));
  assert.ok(body.includes('(score 3) — imports changed file src/user.ts'));

  // Diff-vs-green line names the base sha.
  assert.ok(/Diff vs green:.*`e5f6a7b`/.test(body), 'missing diff base sha');

  // Fenced copy-paste show line.
  assert.ok(
    body.includes('```\nnpx whatbroke show k7m2p9\n```'),
    'missing fenced `npx whatbroke show <id>` line',
  );
});

test('renderPrComment: crash-kind headline and baseline note when error/diff absent', () => {
  const bundle = fixture((b) => {
    b.crash = { kind: 'nonzero-exit', exitCode: 1, signal: null };
    b.git = {
      isRepo: true,
      branch: 'main',
      head: 'aaaa111',
      dirty: false,
      changedFiles: [],
      greenRef: null,
    };
  });
  const body = renderPrComment(bundle);
  assert.ok(body.startsWith(STICKY_MARKER));
  assert.ok(body.includes('### nonzero-exit: exited with code 1'));
  assert.ok(
    body.includes('no green baseline recorded yet'),
    'missing absent-baseline note',
  );
});

// ── sticky update-vs-create ──────────────────────────────────────────────────

test('updates the FIRST existing marker comment, never creates a second', async () => {
  const { transport, log } = mockTransport([
    { id: 4, body: 'lgtm, nice work' },
    { id: 7, body: `${STICKY_MARKER}\n\n### old whatbroke report` },
    { id: 9, body: `${STICKY_MARKER}\n\nstray duplicate` },
  ]);
  const sink = createGithubPrSink({ cwd: '/repo', transport });
  const result = await sink(fixture());

  assert.equal(result.sink, 'github-pr');
  assert.equal(result.ok, true);
  assert.equal(log.created.length, 0, 'createComment must not be called');
  assert.equal(log.updated.length, 1, 'exactly one update expected');
  assert.equal(log.updated[0]?.id, 7, 'must update the FIRST marker comment');
  assert.ok(log.updated[0]?.body.startsWith(STICKY_MARKER));
  assert.equal(result.url, 'https://github.com/o/r/pull/5#issuecomment-7');
});

test('creates exactly one comment when no marker comment exists', async () => {
  const { transport, log } = mockTransport([
    { id: 1, body: 'unrelated review comment' },
    { id: 2, body: '<!-- some-other-bot -->' },
  ]);
  const sink = createGithubPrSink({ cwd: '/repo', transport });
  const result = await sink(fixture());

  assert.equal(result.ok, true);
  assert.equal(log.updated.length, 0, 'updateComment must not be called');
  assert.equal(log.created.length, 1, 'exactly one create expected');
  assert.ok(log.created[0]?.startsWith(STICKY_MARKER));
  assert.equal(result.url, 'https://github.com/o/r/pull/5#issuecomment-900');
});

// ── failure paths: always resolve, never throw ───────────────────────────────

test('transport failure resolves ok:false (never throws)', async () => {
  const transport: PrTransport = {
    async listComments(): Promise<Array<{ id: number; body: string }>> {
      throw new Error('boom: 502 from api');
    },
    async createComment() {
      return {};
    },
    async updateComment() {
      return {};
    },
  };
  const sink = createGithubPrSink({ cwd: '/repo', transport });
  const result = await sink(fixture()); // must not reject
  assert.equal(result.sink, 'github-pr');
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('boom: 502 from api'));
});

test('missing PR context resolves ok:false with a helpful message', async () => {
  const keys = [
    'GITHUB_REPOSITORY',
    'GITHUB_REF',
    'GITHUB_EVENT_PATH',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ] as const;
  const saved = new Map<string, string | undefined>(
    keys.map((k) => [k, process.env[k]]),
  );
  for (const k of keys) delete process.env[k];
  try {
    // No transport, no prNumber, no env → context resolution fails BEFORE any
    // subprocess or network is touched.
    const sink = createGithubPrSink({ cwd: '/repo' });
    const result = await sink(fixture());
    assert.equal(result.sink, 'github-pr');
    assert.equal(result.ok, false);
    assert.match(result.message, /PR/i, 'message should mention the PR context');
    assert.match(
      result.message,
      /GITHUB_REPOSITORY|owner\/repo/,
      'message should say how to supply the repo',
    );
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
