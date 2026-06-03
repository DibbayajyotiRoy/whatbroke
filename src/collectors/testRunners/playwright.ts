/**
 * Playwright output parser.
 *
 * The Playwright `list` reporter prints failing lines and a summary:
 *
 *   ✘  1 [chromium] › tests/login.spec.ts:12:3 › login flow › shows error (2s)
 *   1) [chromium] › tests/login.spec.ts:12:3 › login flow › shows error ──────────
 *
 *   1 failed
 *     [chromium] › tests/login.spec.ts:12:3 › login flow › shows error
 *   2 passed (5s)
 *
 * We detect it by the `[project] › file:line › title` shape (the `›` U+203A separators
 * with a `file:line` segment), which is unique to Playwright among these runners.
 */
import type { TestFailure } from '../../types.js';

/**
 * Matches both the `✘  N [project] › file:line:col › title` lines and the numbered
 * `N) [project] › file:line:col › title` failure headers. The leading marker (✘/✗/✕
 * and/or an index) is optional so we also catch the indented entries under `N failed`.
 */
const FAIL_ENTRY =
  /^\s*(?:[✘✗✕]\s*)?(?:\d+\)?\s+)?\[([^\]]+)\]\s+›\s+(.+?):(\d+)(?::\d+)?\s+›\s+(.+?)\s*$/gm;

/** `1 failed` / `2 passed (5s)` summary tokens. */
const FAILED_LINE = /(\d+)\s+failed\b/;
const PASSED_LINE = /(\d+)\s+passed\b/;
const FLAKY_LINE = /(\d+)\s+flaky\b/;

function toInt(s: string | undefined): number | undefined {
  if (s === undefined) {
    return undefined;
  }
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

function stripTrailing(title: string): string {
  // Drop trailing box-drawing padding (`──────`) and timing (`(2s)`).
  return title
    .replace(/[\s─-]+$/u, '')
    .replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/, '')
    .trim();
}

export function parsePlaywright(text: string): TestFailure | null {
  const seen = new Set<string>();
  const failingTests: TestFailure['failingTests'] = [];

  for (const m of text.matchAll(FAIL_ENTRY)) {
    const project = m[1];
    const file = m[2];
    const line = m[3];
    const rawTitle = m[4];
    if (project === undefined || file === undefined || rawTitle === undefined) {
      continue;
    }
    const title = stripTrailing(rawTitle);
    const id = `[${project}] › ${title}`;
    const key = `${id}::${file}:${line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    failingTests.push({ id, file: `${file}:${line}` });
  }

  if (failingTests.length === 0) {
    // No Playwright-shaped entry → decline.
    return null;
  }

  const failed = toInt(FAILED_LINE.exec(text)?.[1]);
  const passed = toInt(PASSED_LINE.exec(text)?.[1]);
  const flaky = toInt(FLAKY_LINE.exec(text)?.[1]);

  const result: TestFailure = { runner: 'playwright', failingTests };
  if (failed !== undefined) {
    result.failed = failed;
  }
  if (passed !== undefined) {
    result.passed = passed;
  }
  if (failed !== undefined || passed !== undefined) {
    result.total = (failed ?? 0) + (passed ?? 0) + (flaky ?? 0);
  }
  return result;
}
