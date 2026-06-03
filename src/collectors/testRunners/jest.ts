/**
 * Jest output parser.
 *
 * Jest prints `FAIL <file>` lines, `✕ <test name>` markers for failing tests, and a
 * summary line of the form `Tests: N failed, M passed, T total`. We detect jest by the
 * presence of that `Tests:` summary line (the runner-specific marker) combined with at
 * least one FAIL/✕ marker, and deliberately decline to claim vitest output (vitest uses
 * a `Test Files` summary and `⎯` separators instead).
 */
import type { TestFailure } from '../../types.js';

/** `Tests:       1 failed, 2 passed, 3 total` — jest's signature summary line. */
const JEST_SUMMARY = /^\s*Tests:\s+(.+)$/m;
/** `FAIL src/foo.test.ts` — capture the file path. */
const FAIL_LINE = /^\s*FAIL\s+(\S.*?)\s*$/gm;
/** `  ✕ adds numbers (3 ms)` — a failing test marker (✕ U+2715 or × U+00D7). */
const FAIL_TEST = /^\s*[✕×]\s+(.+?)\s*$/gm;

function parseCount(summary: string, label: string): number | undefined {
  const m = new RegExp(`(\\d+)\\s+${label}`).exec(summary);
  if (!m || m[1] === undefined) {
    return undefined;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Strip a trailing `(N ms)` timing suffix jest appends to test names. */
function stripTiming(name: string): string {
  return name.replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/, '').trim();
}

export function parseJest(text: string): TestFailure | null {
  const summaryMatch = JEST_SUMMARY.exec(text);
  if (!summaryMatch || summaryMatch[1] === undefined) {
    // No jest summary line → not confidently jest. Decline.
    return null;
  }
  // Guard against misclassifying vitest, which never emits a bare `Tests:` summary
  // but does emit a `Test Files` line.
  if (/^\s*Test Files\s+/m.test(text)) {
    return null;
  }

  const summary = summaryMatch[1];
  const failed = parseCount(summary, 'failed');
  const passed = parseCount(summary, 'passed');
  const total = parseCount(summary, 'total');

  // Collect the FAIL <file> paths, in order.
  const files: string[] = [];
  for (const m of text.matchAll(FAIL_LINE)) {
    if (m[1] !== undefined) {
      const file = m[1].trim();
      if (file.length > 0 && !files.includes(file)) {
        files.push(file);
      }
    }
  }

  const failingTests: TestFailure['failingTests'] = [];
  const fallbackFile = files.length === 1 ? files[0]! : null;
  for (const m of text.matchAll(FAIL_TEST)) {
    if (m[1] === undefined) {
      continue;
    }
    const id = stripTiming(m[1]);
    if (id.length > 0) {
      failingTests.push({ id, file: fallbackFile });
    }
  }

  // If we only learned about files (no per-test markers in the tail), surface those.
  if (failingTests.length === 0) {
    for (const file of files) {
      failingTests.push({ id: file, file });
    }
  }

  const result: TestFailure = { runner: 'jest', failingTests };
  if (total !== undefined) {
    result.total = total;
  }
  if (failed !== undefined) {
    result.failed = failed;
  }
  if (passed !== undefined) {
    result.passed = passed;
  }
  return result;
}
