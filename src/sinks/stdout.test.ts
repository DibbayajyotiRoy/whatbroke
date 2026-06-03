import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStdoutMarkdownSink } from './stdout.js';
import type { RedactedBundle } from '../types.js';

const fixture = { id: 'x1' } as unknown as RedactedBundle;

test('stdout sink writes rendered markdown via injected write spy', async () => {
  const captured: string[] = [];
  const sink = createStdoutMarkdownSink({
    render: () => '# rendered md\nbody',
    write: (s) => captured.push(s),
  });

  const result = await sink(fixture);

  assert.equal(result.sink, 'stdout');
  assert.equal(result.ok, true);
  assert.equal(result.message, 'rendered to stdout');
  assert.deepEqual(captured, ['# rendered md\nbody']);
});

test('stdout sink passes the bundle to the renderer', async () => {
  let seen: RedactedBundle | null = null;
  const sink = createStdoutMarkdownSink({
    render: (b) => {
      seen = b;
      return 'ok';
    },
    write: () => {},
  });
  await sink(fixture);
  assert.equal(seen, fixture);
});
