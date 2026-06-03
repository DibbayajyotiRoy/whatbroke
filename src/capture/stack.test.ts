import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStack, parseErrorBlock } from './stack.js';

test('parses named frame with location', () => {
  const frames = parseStack('    at doThing (/abs/src/file.ts:12:34)');
  assert.equal(frames.length, 1);
  const f = frames[0]!;
  assert.equal(f.functionName, 'doThing');
  assert.equal(f.file, '/abs/src/file.ts');
  assert.equal(f.line, 12);
  assert.equal(f.column, 34);
  assert.equal(f.isUserCode, true);
  assert.equal(f.isInRepo, false);
  assert.equal(f.fileRelative, null);
  assert.equal(f.sourceMapped, false);
});

test('parses bare location frame (no function name)', () => {
  const frames = parseStack('    at /abs/file.ts:1:2');
  assert.equal(frames.length, 1);
  const f = frames[0]!;
  assert.equal(f.functionName, null);
  assert.equal(f.file, '/abs/file.ts');
  assert.equal(f.line, 1);
  assert.equal(f.column, 2);
  assert.equal(f.isUserCode, true);
});

test('parses async frame', () => {
  const frames = parseStack('    at async run (/abs/app.ts:5:7)');
  assert.equal(frames.length, 1);
  const f = frames[0]!;
  assert.equal(f.functionName, 'run');
  assert.equal(f.file, '/abs/app.ts');
  assert.equal(f.line, 5);
});

test('node:internal frame is not user code', () => {
  const frames = parseStack(
    '    at Module._compile (node:internal/modules/cjs/loader:1234:14)',
  );
  assert.equal(frames.length, 1);
  const f = frames[0]!;
  assert.equal(f.file, 'node:internal/modules/cjs/loader');
  assert.equal(f.line, 1234);
  assert.equal(f.column, 14);
  assert.equal(f.isUserCode, false);
});

test('node_modules frame is not user code', () => {
  const frames = parseStack(
    '    at handler (/proj/node_modules/express/lib/router.js:10:5)',
  );
  const f = frames[0]!;
  assert.equal(f.isUserCode, false);
  assert.equal(f.file, '/proj/node_modules/express/lib/router.js');
});

test('anonymous object frame', () => {
  const frames = parseStack('    at Object.<anonymous> (/abs/x.ts:1:1)');
  const f = frames[0]!;
  assert.equal(f.functionName, 'Object.<anonymous>');
  assert.equal(f.file, '/abs/x.ts');
});

test('bare <anonymous> frame has null location', () => {
  const frames = parseStack('    at <anonymous>');
  assert.equal(frames.length, 1);
  const f = frames[0]!;
  assert.equal(f.functionName, null);
  assert.equal(f.file, null);
  assert.equal(f.line, null);
  assert.equal(f.isUserCode, false);
});

test('eval frame extracts inner source location', () => {
  const frames = parseStack(
    '    at eval (eval at <anonymous> (/abs/file.ts:3:9), <anonymous>:1:1)',
  );
  assert.equal(frames.length, 1);
  const f = frames[0]!;
  assert.equal(f.file, '/abs/file.ts');
  assert.equal(f.line, 3);
  assert.equal(f.column, 9);
  assert.equal(f.isUserCode, true);
});

test('native frame yields null file', () => {
  const frames = parseStack('    at Array.map (native)');
  const f = frames[0]!;
  assert.equal(f.file, null);
  assert.equal(f.isUserCode, false);
});

test('ignores non-frame lines', () => {
  const frames = parseStack('Error: boom\n    at foo (/a.ts:1:1)\nrandom text');
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.functionName, 'foo');
});

test('parseErrorBlock parses a real-shaped stderr', () => {
  const stderr = [
    'some prior log line',
    'Error: boom happened',
    '    at doThing (/abs/src/file.ts:12:34)',
    '    at async main (/abs/src/main.ts:5:3)',
    '    at node:internal/process/task_queues:96:5',
    '',
    'Node.js v20.0.0',
  ].join('\n');

  const info = parseErrorBlock(stderr);
  assert.ok(info);
  assert.equal(info.name, 'Error');
  assert.equal(info.message, 'boom happened');
  assert.equal(info.stack.length, 3);
  assert.equal(info.stack[0]!.functionName, 'doThing');
  assert.equal(info.stack[0]!.isUserCode, true);
  assert.equal(info.stack[2]!.isUserCode, false);
  assert.ok(info.rawStack.includes('Error: boom happened'));
  assert.ok(info.rawStack.includes('at doThing'));
});

test('parseErrorBlock handles TypeError with frames', () => {
  const stderr = [
    "TypeError: Cannot read properties of undefined (reading 'x')",
    '    at /abs/app.ts:10:20',
  ].join('\n');
  const info = parseErrorBlock(stderr);
  assert.ok(info);
  assert.equal(info.name, 'TypeError');
  assert.equal(info.message, "Cannot read properties of undefined (reading 'x')");
  assert.equal(info.stack.length, 1);
});

test('parseErrorBlock returns null when no error block', () => {
  const stderr = 'just a warning: deprecation notice\nall good\n';
  assert.equal(parseErrorBlock(stderr), null);
});

test('parseErrorBlock ignores log lines that look like headers but have no frames', () => {
  const stderr = 'Config: loaded\nServer: started\n';
  assert.equal(parseErrorBlock(stderr), null);
});

test('parseErrorBlock captures multi-line message before frames', () => {
  const stderr = [
    'Error: line one',
    'line two of message',
    '    at foo (/a.ts:1:1)',
  ].join('\n');
  const info = parseErrorBlock(stderr);
  assert.ok(info);
  assert.equal(info.message, 'line one\nline two of message');
  assert.equal(info.stack.length, 1);
});
