/**
 * Failure-delta classification (roadmap 1.2, task T1.1): "same bug or new bug?"
 *
 * Three pure, deterministic building blocks — NO LLM, no I/O, no clock:
 *
 *   - `normalizeMessage()` replaces volatile substrings (timestamps, hex
 *     addresses, tmp paths, ports, durations, pids, uuids, generated ids) with
 *     stable tokens so two renderings of the same failure compare equal.
 *   - `crashFingerprint()` derives a stable 16-hex identity for a crash.
 *     Line/column numbers are deliberately excluded so moving code around a
 *     file does not change the crash's identity.
 *   - `compareCrashes()` classifies two crashes as same/related/different via
 *     fixed rules, with human-readable reasons.
 *
 * Consumers: `verify` (delta reports), the crash-history index (recurrence
 * detection), and watch-mode dedup.
 */
import { createHash } from 'node:crypto';

import type { CrashInfo, StackFrame, TestFailure } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Message normalization
// ─────────────────────────────────────────────────────────────────────────────

export type NormalizeRuleName =
  | 'timestamp'
  | 'uuid'
  | 'tmp-path'
  | 'hex-address'
  | 'port'
  | 'duration'
  | 'pid'
  | 'long-id'
  | 'whitespace';

/** One volatile-substring class. Exposed so tests can exercise it in isolation. */
export interface NormalizeRule {
  readonly name: NormalizeRuleName;
  /** The stable token this rule substitutes for volatile text. */
  readonly token: string;
  readonly apply: (input: string) => string;
}

const CLOCK = String.raw`\d{1,2}:\d{2}:\d{2}(?:\.\d+)?`;
const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';

/**
 * ISO-8601 dates/datetimes (`2024-01-15T10:30:22.123Z`, `2024-01-15 10:30:22`),
 * JS `Date#toString()` (`Mon Jan 15 2024 10:30:00 GMT+0200 (…)`), RFC-1123
 * (`Mon, 15 Jan 2024 10:30:00 GMT`), and bare wall-clock times (`10:30:22.5`).
 */
const TIMESTAMP_RE = new RegExp(
  [
    String.raw`\b${DAY},?\s+(?:${MONTH}\s+\d{1,2}|\d{1,2}\s+${MONTH})\s+\d{4}(?:\s+${CLOCK}(?:\s+(?:GMT|UTC)(?:[+-]\d{4})?)?(?:\s+\([^)]+\))?)?`,
    String.raw`\b\d{4}-\d{2}-\d{2}(?:[T ]${CLOCK}(?:Z|[+-]\d{2}:?\d{2})?)?\b`,
    String.raw`\b${CLOCK}\b`,
  ].join('|'),
  'g',
);

const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

/**
 * OS-tmpdir-like paths: `/tmp/…`, `/private/tmp/…`, macOS `/var/folders/…`,
 * Windows `…\Temp\…` and `%TEMP%\…`. The tail stops at whitespace, quotes,
 * and common punctuation so surrounding prose survives.
 */
const TMP_PATH_RE =
  /(?:(?:\/private)?\/tmp\/|(?:\/private)?\/var\/folders\/|[A-Za-z]:\\(?:[^\\\s'"]+\\)*temp\\|%te?mp%\\?)[^\s'"`()[\]{},;:]*/gi;

const HEX_ADDR_RE = /\b0x[0-9a-fA-F]+\b/g;

// Port numbers, three contexts: `host:3000` (localhost / IPv4 / hostname /
// `[::1]:`), Node's bare `:3000` / `:::3000`, and the word form `port 3000`.
const HOST_PORT_RE =
  /((?:\blocalhost|\b\d{1,3}(?:\.\d{1,3}){3}|\b[A-Za-z][A-Za-z0-9.-]*|\]):)(\d{1,5})\b/g;
const BARE_COLON_PORT_RE = /(^|\s)(:{1,3})(\d{1,5})\b/g;
const PORT_WORD_RE = /\b(ports?\s*[:=]?\s*)(\d{1,5})\b/gi;

const DURATION_RE =
  /\b\d+(?:\.\d+)?\s?(?:ns|us|µs|ms|sec(?:ond)?s?|min(?:ute)?s?|h(?:ou)?rs?|[smh])\b/g;

const PID_RE = /\b((?:pid|process)\s*[:=#]?\s*)(\d{1,8})\b/gi;

// Candidate tokens for the generated-id heuristic: alnum runs, optionally
// hyphen/underscore-segmented (`lq8x3k-7f9a2c`, `deadbeefcafe1234`).
const ID_CANDIDATE_RE = /\b[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*\b/g;
const MIN_ID_LENGTH = 8;
const MIN_ID_DIGITS = 2;

export const RULE_TIMESTAMP: NormalizeRule = {
  name: 'timestamp',
  token: '‹ts›',
  apply: (input) => input.replace(TIMESTAMP_RE, '‹ts›'),
};

export const RULE_UUID: NormalizeRule = {
  name: 'uuid',
  token: '‹uuid›',
  apply: (input) => input.replace(UUID_RE, '‹uuid›'),
};

export const RULE_TMP_PATH: NormalizeRule = {
  name: 'tmp-path',
  token: '‹tmp›',
  apply: (input) => input.replace(TMP_PATH_RE, '‹tmp›'),
};

export const RULE_HEX_ADDRESS: NormalizeRule = {
  name: 'hex-address',
  token: '‹hex›',
  apply: (input) => input.replace(HEX_ADDR_RE, '‹hex›'),
};

export const RULE_PORT: NormalizeRule = {
  name: 'port',
  token: '‹port›',
  apply: (input) =>
    input
      .replace(HOST_PORT_RE, '$1‹port›')
      .replace(BARE_COLON_PORT_RE, '$1$2‹port›')
      .replace(PORT_WORD_RE, '$1‹port›'),
};

export const RULE_DURATION: NormalizeRule = {
  name: 'duration',
  token: '‹dur›',
  apply: (input) => input.replace(DURATION_RE, '‹dur›'),
};

export const RULE_PID: NormalizeRule = {
  name: 'pid',
  token: '‹pid›',
  apply: (input) => input.replace(PID_RE, '$1‹pid›'),
};

export const RULE_LONG_ID: NormalizeRule = {
  name: 'long-id',
  token: '‹id›',
  apply: (input) =>
    input.replace(ID_CANDIDATE_RE, (token) => {
      const alnum = token.replace(/[-_]/g, '');
      if (alnum.length < MIN_ID_LENGTH) return token;
      // Pure numbers are counts/sizes, not ids.
      if (!/[A-Za-z]/.test(alnum)) return token;
      // Words with a single stray digit (utf8…, HTTP2…) are identifiers, keep.
      const digits = alnum.replace(/\D/g, '').length;
      if (digits < MIN_ID_DIGITS) return token;
      // Mixed-case tokens are almost always code identifiers, not generated ids.
      if (token !== token.toLowerCase() && token !== token.toUpperCase()) {
        return token;
      }
      return '‹id›';
    }),
};

export const RULE_WHITESPACE: NormalizeRule = {
  name: 'whitespace',
  token: ' ',
  apply: (input) => input.replace(/\s+/g, ' ').trim(),
};

/**
 * All rules, applied in order by `normalizeMessage`. Ordering matters — the
 * more specific rules run first:
 *   - `uuid` before `long-id` (a UUID's segments look like long hex ids);
 *   - `tmp-path` before `hex-address`/`long-id` (paths often embed ids);
 *   - `hex-address` before `long-id` (`0xdeadbeef` is also a base36-ish token);
 *   - `whitespace` last, to collapse whatever the replacements left behind.
 */
export const RULES: readonly NormalizeRule[] = [
  RULE_TIMESTAMP,
  RULE_UUID,
  RULE_TMP_PATH,
  RULE_HEX_ADDRESS,
  RULE_PORT,
  RULE_DURATION,
  RULE_PID,
  RULE_LONG_ID,
  RULE_WHITESPACE,
];

/**
 * Replace volatile substrings in an error message with stable tokens
 * (`‹ts›`, `‹hex›`, `‹tmp›`, `‹port›`, `‹dur›`, `‹pid›`, `‹uuid›`, `‹id›`)
 * and collapse whitespace. Pure and deterministic.
 */
export function normalizeMessage(msg: string): string {
  let out = msg;
  for (const rule of RULES) {
    out = rule.apply(out);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Crash fingerprint
// ─────────────────────────────────────────────────────────────────────────────

interface FrameIdentity {
  file: string;
  fn: string;
}

function topInRepoFrame(crash: CrashInfo): StackFrame | null {
  for (const frame of crash.error?.stack ?? []) {
    if (frame.isInRepo) {
      return frame;
    }
  }
  return null;
}

/**
 * Identity of the top in-repo frame: file (repo-relative when known) and
 * function name. Line/column are deliberately excluded — moving code within a
 * file must not change the crash's identity. Missing pieces are ''.
 */
function frameIdentity(crash: CrashInfo): FrameIdentity {
  const frame = topInRepoFrame(crash);
  if (!frame) {
    return { file: '', fn: '' };
  }
  return {
    file: frame.fileRelative ?? frame.file ?? '',
    fn: frame.functionName ?? '',
  };
}

/** Failing-test identity: runner + full test names, '' when absent. */
function testIdentity(crash: CrashInfo): string {
  const tf = crash.testFailure;
  if (!tf) {
    return '';
  }
  return `${tf.runner}:${tf.failingTests.map((t) => t.id).join(',')}`;
}

/**
 * Stable short fingerprint of a crash: sha256 (16 hex chars) over
 * kind + error name + normalized message + top in-repo frame (file +
 * function, never line/column) + failing-test identity. Missing pieces are
 * empty strings. Pure and deterministic — key order and extra properties on
 * the input object cannot affect the result.
 */
export function crashFingerprint(crash: CrashInfo): string {
  const frame = frameIdentity(crash);
  const parts = [
    crash.kind,
    crash.error?.name ?? '',
    normalizeMessage(crash.error?.message ?? ''),
    frame.file,
    frame.fn,
    testIdentity(crash),
  ];
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// Crash comparison
// ─────────────────────────────────────────────────────────────────────────────

export type CompareVerdict = 'same' | 'related' | 'different';

export interface CrashComparison {
  verdict: CompareVerdict;
  /** Human-readable full sentences; deterministic for a given input pair. */
  reasons: string[];
}

function describeFrame(f: FrameIdentity): string {
  if (f.file === '') {
    return 'no in-repo frame';
  }
  return f.fn === '' ? `"${f.file}"` : `"${f.file}" in ${f.fn}`;
}

function describeTest(tf: TestFailure): string {
  const ids = tf.failingTests.map((t) => t.id).join('", "');
  return `${tf.runner} test "${ids}"`;
}

/**
 * Deterministic same/related/different classification of two crashes.
 * Fixed rules, evaluated in order:
 *   1. identical fingerprint → 'same';
 *   2. same error name at the same top in-repo file → 'related';
 *   3. same failing-test identity → 'related';
 *   4. same normalized message at different frames → 'related';
 *   5. otherwise 'different', with reasons stating exactly what differs.
 */
export function compareCrashes(a: CrashInfo, b: CrashInfo): CrashComparison {
  const nameA = a.error?.name ?? '';
  const nameB = b.error?.name ?? '';
  const msgA = normalizeMessage(a.error?.message ?? '');
  const msgB = normalizeMessage(b.error?.message ?? '');
  const frameA = frameIdentity(a);
  const frameB = frameIdentity(b);
  const testA = testIdentity(a);
  const testB = testIdentity(b);
  const framesEqual = frameA.file === frameB.file && frameA.fn === frameB.fn;

  // Rule 1: identical fingerprint.
  if (crashFingerprint(a) === crashFingerprint(b)) {
    const reasons: string[] = [];
    if (a.error !== undefined && b.error !== undefined) {
      reasons.push(
        `Same error name "${nameA}" with the same normalized message "${msgA}".`,
      );
    } else if (a.error === undefined && b.error === undefined) {
      reasons.push(`Both crashes are kind "${a.kind}" with no error object.`);
    } else {
      reasons.push(`Crash kind "${a.kind}" matches.`);
    }
    if (frameA.file !== '') {
      reasons.push(`Same top in-repo frame: ${describeFrame(frameA)}.`);
    } else {
      reasons.push('Neither crash has an in-repo stack frame.');
    }
    if (a.testFailure !== undefined && b.testFailure !== undefined) {
      reasons.push(`Same failing test: ${describeTest(a.testFailure)}.`);
    }
    return { verdict: 'same', reasons };
  }

  // What differs — appended to 'related' verdicts and the sole content of
  // 'different' verdicts.
  const diffs: string[] = [];
  if (a.kind !== b.kind) {
    diffs.push(`Crash kinds differ: "${a.kind}" vs "${b.kind}".`);
  }
  if (a.error !== undefined && b.error === undefined) {
    diffs.push(
      `The first crash has error "${nameA}" while the second has no error object.`,
    );
  } else if (a.error === undefined && b.error !== undefined) {
    diffs.push(
      `The second crash has error "${nameB}" while the first has no error object.`,
    );
  } else if (nameA !== nameB) {
    diffs.push(`Error names differ: "${nameA}" vs "${nameB}".`);
  }
  if (a.error !== undefined && b.error !== undefined && msgA !== msgB) {
    diffs.push(`Normalized messages differ: "${msgA}" vs "${msgB}".`);
  }
  if (!framesEqual) {
    if (frameA.file === frameB.file && frameA.file !== '') {
      diffs.push(
        `Same file "${frameA.file}" but different functions: "${frameA.fn}" vs "${frameB.fn}".`,
      );
    } else {
      diffs.push(
        `Top in-repo frames differ: ${describeFrame(frameA)} vs ${describeFrame(frameB)}.`,
      );
    }
  }
  if (testA !== testB) {
    if (a.testFailure !== undefined && b.testFailure !== undefined) {
      diffs.push(
        `Failing tests differ: ${describeTest(a.testFailure)} vs ${describeTest(b.testFailure)}.`,
      );
    } else {
      diffs.push('Only one of the crashes has a failing-test identity.');
    }
  }

  // Rule 2: same error type at the same top in-repo file.
  if (
    a.error !== undefined &&
    b.error !== undefined &&
    nameA === nameB &&
    frameA.file !== '' &&
    frameA.file === frameB.file
  ) {
    return {
      verdict: 'related',
      reasons: [
        `Same error type at same file: "${nameA}" at "${frameA.file}" in both crashes.`,
        ...diffs,
      ],
    };
  }

  // Rule 3: same failing test, different error.
  if (a.testFailure !== undefined && b.testFailure !== undefined && testA === testB) {
    return {
      verdict: 'related',
      reasons: [
        `Same failing test, different error: ${describeTest(a.testFailure)} fails in both crashes.`,
        ...diffs,
      ],
    };
  }

  // Rule 4: same normalized message, different location.
  if (a.error !== undefined && b.error !== undefined && msgA === msgB && !framesEqual) {
    return {
      verdict: 'related',
      reasons: [
        `Same message, different location: normalized message "${msgA}" appears at ${describeFrame(frameA)} and at ${describeFrame(frameB)}.`,
        ...diffs,
      ],
    };
  }

  return { verdict: 'different', reasons: diffs };
}
