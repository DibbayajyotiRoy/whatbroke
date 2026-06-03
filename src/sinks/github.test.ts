import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildIssueTitle,
  buildIssueUrl,
  createGithubSink,
  inferRepo,
} from './github.js';
import type { RedactedBundle } from '../types.js';

test('inferRepo parses https remotes', () => {
  assert.equal(
    inferRepo('https://github.com/owner/repo.git'),
    'owner/repo',
  );
  assert.equal(inferRepo('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(inferRepo('https://github.com/owner/repo/'), 'owner/repo');
  assert.equal(
    inferRepo('https://user@github.com/owner/repo.git\n'),
    'owner/repo',
  );
});

test('inferRepo parses ssh remotes', () => {
  assert.equal(inferRepo('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(inferRepo('git@github.com:owner/repo'), 'owner/repo');
  assert.equal(
    inferRepo('ssh://git@github.com/owner/repo.git'),
    'owner/repo',
  );
});

test('inferRepo returns null for unparseable input', () => {
  assert.equal(inferRepo(''), null);
  assert.equal(inferRepo('   '), null);
  assert.equal(inferRepo('not-a-url'), null);
});

test('buildIssueTitle uses error name + truncated first-line message', () => {
  const b = {
    crash: {
      kind: 'uncaught-exception',
      error: { name: 'TypeError', message: 'cannot read x\nsecond line' },
    },
  } as unknown as RedactedBundle;
  assert.equal(buildIssueTitle(b), '[bug] TypeError: cannot read x');
});

test('buildIssueTitle truncates long messages to ~80 chars', () => {
  const longMsg = 'a'.repeat(200);
  const b = {
    crash: { kind: 'uncaught-exception', error: { name: 'Error', message: longMsg } },
  } as unknown as RedactedBundle;
  const title = buildIssueTitle(b);
  // prefix "[bug] Error: " + 80-char (last replaced by ellipsis) message
  assert.ok(title.startsWith('[bug] Error: '));
  assert.ok(title.endsWith('…'));
  const msgPart = title.slice('[bug] Error: '.length);
  assert.equal(msgPart.length, 80);
});

test('buildIssueTitle falls back to crash kind when no error', () => {
  const b = {
    crash: { kind: 'signal' },
  } as unknown as RedactedBundle;
  assert.equal(buildIssueTitle(b), '[bug] signal');
});

test('buildIssueUrl returns a full URL for small bodies', () => {
  const { url, truncated } = buildIssueUrl('o/r', 'title', 'small body');
  assert.equal(truncated, false);
  assert.ok(url.startsWith('https://github.com/o/r/issues/new?title='));
  assert.ok(url.includes('body='));
});

test('buildIssueUrl truncates huge bodies and stays under the limit', () => {
  const huge = 'x'.repeat(50_000);
  const { url, truncated } = buildIssueUrl('o/r', 'title', huge);
  assert.equal(truncated, true);
  assert.ok(url.length <= 6000);
  // The truncation note must be present in the decoded body.
  const bodyEnc = url.slice(url.indexOf('&body=') + '&body='.length);
  const decoded = decodeURIComponent(bodyEnc);
  assert.ok(decoded.includes('full whatbroke bundle is saved locally'));
});

test('github sink returns ok:false with helpful message when no repo inferable', async () => {
  // cwd that is not a git repo and no explicit repo -> git remote fails.
  const sink = createGithubSink({
    cwd: '/nonexistent-path-whatbroke-test',
    render: () => '# md',
  });
  const b = {
    id: 'z9',
    crash: { kind: 'nonzero-exit' },
  } as unknown as RedactedBundle;
  const result = await sink(b);
  assert.equal(result.sink, 'github');
  assert.equal(result.ok, false);
  assert.ok(/repo/i.test(result.message));
});
