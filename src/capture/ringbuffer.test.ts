import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from './ringbuffer.js';

test('keeps all lines under capacity', () => {
  const rb = new RingBuffer(5);
  rb.push('a\nb\nc\n');
  assert.deepEqual(rb.lines(), ['a', 'b', 'c']);
  assert.equal(rb.truncated, false);
  assert.equal(rb.lineCount, 3);
  assert.equal(rb.text(), 'a\nb\nc');
});

test('drops oldest lines past capacity and flags truncated', () => {
  const rb = new RingBuffer(3);
  rb.push('1\n2\n3\n4\n5\n');
  assert.deepEqual(rb.lines(), ['3', '4', '5']);
  assert.equal(rb.truncated, true);
  assert.equal(rb.lineCount, 3);
});

test('exact capacity is not truncated', () => {
  const rb = new RingBuffer(3);
  rb.push('1\n2\n3\n');
  assert.deepEqual(rb.lines(), ['1', '2', '3']);
  assert.equal(rb.truncated, false);
});

test('joins partial chunks into a single line', () => {
  const rb = new RingBuffer(10);
  rb.push('foo');
  rb.push('bar\n');
  assert.deepEqual(rb.lines(), ['foobar']);
});

test('exposes trailing partial line', () => {
  const rb = new RingBuffer(10);
  rb.push('done\nin progress');
  assert.deepEqual(rb.lines(), ['done', 'in progress']);
  assert.equal(rb.text(), 'done\nin progress');
});

test('multi-line chunk in one push', () => {
  const rb = new RingBuffer(10);
  rb.push('x\ny\nz');
  assert.deepEqual(rb.lines(), ['x', 'y', 'z']);
});

test('strips CR from CRLF input', () => {
  const rb = new RingBuffer(10);
  rb.push('a\r\nb\r\n');
  assert.deepEqual(rb.lines(), ['a', 'b']);
});

test('partial line over capacity drops oldest and truncates', () => {
  const rb = new RingBuffer(2);
  rb.push('1\n2\npartial');
  assert.deepEqual(rb.lines(), ['2', 'partial']);
  assert.equal(rb.truncated, true);
});

test('empty push is a no-op', () => {
  const rb = new RingBuffer(3);
  rb.push('');
  assert.deepEqual(rb.lines(), []);
  assert.equal(rb.lineCount, 0);
});

test('zero/negative maxLines clamps to 1', () => {
  const rb = new RingBuffer(0);
  rb.push('a\nb\nc\n');
  assert.deepEqual(rb.lines(), ['c']);
  assert.equal(rb.truncated, true);
});
