/**
 * Vitest output parser.
 *
 * Vitest prints `FAIL <file> > <test name>` lines, `×`/`✕` test markers, `⎯` (U+23AF)
 * separators around failure details, and a two-line summary:
 *
 *   Test Files  1 failed (1)
 *        Tests  1 failed | 2 passed (3)
 *
 * We detect vitest by the `Test Files` summary line or the `⎯` separator — markers jest
 * never emits — to avoid stealing jest output.
 */
import type { TestFailure } from '../../types.js';

/** `Test Files  1 failed | 1 passed (2)` — vitest's signature line. */
const TEST_FILES_LINE = /^\s*Test Files\s+(.+)$/m;
/** Vitest's heavy-horizontal `⎯` separator (U+23AF), repeated. */
const VITEST_SEPARATOR = /⎯{3,}/;
/** `Tests  1 failed | 2 passed (3)` — pipe-delimited counts. */
const TESTS_LINE = /^\s*Tests\s+(.+)$/m;
/** `FAIL  src/foo.test.ts > suite > adds (3ms)` — file then ` > ` test path. */
const FAIL_LINE = /^\s*FAIL\s+(\S+?)(?:\s+>\s+(.+?))?\s*$/gm;

function parseCount(summary: string, label: string): number | undefined {
  const m = new RegExp(`(\\d+)\\s+${label}`).exec(summary);
  if (!m || m[1] === undefined) {
    return undefined;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Vitest reports total in parentheses, e.g. `1 failed | 2 passed (3)`. */
function parseTotal(summary: string): number | undefined {
  const m = /\((\d+)\)\s*$/.exec(summary.trim());
  if (!m || m[1] === undefined) {
    return undefined;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? undefined : n;
}

function stripTiming(name: string): string {
  return name.replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/, '').trim();
}

export function parseVitest(text: string): TestFailure | null {
  const testFilesMatch = TEST_FILES_LINE.exec(text);
  const hasSeparator = VITEST_SEPARATOR.test(text);
  if (!testFilesMatch && !hasSeparator) {
    // No vitest-specific marker → decline (likely jest or unrelated).
    return null;
  }

  const failingTests: TestFailure['failingTests'] = [];
  const files: string[] = [];
  for (const m of text.matchAll(FAIL_LINE)) {
    if (m[1] === undefined) {
      continue;
    }
    const file = m[1].trim();
    if (file.length > 0 && !files.includes(file)) {
      files.push(file);
    }
    const testPath = m[2];
    if (testPath !== undefined) {
      const id = stripTiming(testPath);
      if (id.length > 0) {
        failingTests.push({ id, file });
      }
    }
  }

  // If FAIL lines only named files (no ` > test`), surface the files themselves.
  if (failingTests.length === 0) {
    for (const file of files) {
      failingTests.push({ id: file, file });
    }
  }

  const testsMatch = TESTS_LINE.exec(text);
  let failed: number | undefined;
  let passed: number | undefined;
  let total: number | undefined;
  if (testsMatch && testsMatch[1] !== undefined) {
    const s = testsMatch[1];
    failed = parseCount(s, 'failed');
    passed = parseCount(s, 'passed');
    total = parseTotal(s);
  }

  const result: TestFailure = { runner: 'vitest', failingTests };
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
