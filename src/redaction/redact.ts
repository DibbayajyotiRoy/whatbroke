/**
 * The redaction gate (06) — the SINGLE producer of `RedactedBundle`.
 *
 * Pipeline position: `Bundle → redact() → RedactedBundle → sinks`. There is no
 * other path to the brand. The brand (`__redacted`) is a phantom type-only
 * symbol; we mint a `RedactedBundle` solely by casting the fully-scrubbed clone
 * at the very end of this function. No other file may perform that cast.
 *
 * Safety posture: fail CLOSED. Every per-field redaction is wrapped in
 * try/catch; on any error the field's content is DROPPED (replaced with
 * `‹redacted:error›`) and recorded in the report — we never emit raw text when
 * redaction fails.
 */

import type {
  Bundle,
  RedactedBundle,
  RedactOptions,
  RedactionReport,
} from '../types.js';
import type { Detector } from './detectors.js';
import {
  KNOWN_FORMAT_DETECTORS,
  makeDenylistDetector,
  makeEnvValueDetector,
  placeholder,
} from './detectors.js';
import { entropyDetector } from './entropy.js';
import { debugError } from '../util/debug.js';

/**
 * Env keys whose VALUES are safe to surface verbatim in `environment.envValues`
 * and are excluded from the env-value detector. These are non-secret by nature.
 */
export const DEFAULT_ALLOW_ENV: readonly string[] = [
  'NODE_ENV',
  'CI',
  'TZ',
  'LANG',
  'LC_ALL',
  'PATH',
  'HOME',
  'SHELL',
  'TERM',
  'PWD',
];

/** Accumulates per-rule hit counts without ever storing redacted values. */
class ReportBuilder {
  private readonly hitsByRule = new Map<string, number>();
  private total = 0;

  add(rule: string, hits: number): void {
    if (hits <= 0) return;
    this.hitsByRule.set(rule, (this.hitsByRule.get(rule) ?? 0) + hits);
    this.total += hits;
  }

  build(): RedactionReport {
    const rules = [...this.hitsByRule.entries()].map(([rule, hits]) => ({
      rule,
      hits,
    }));
    return { redactedCount: this.total, rules };
  }
}

/**
 * Run the full detector chain over one field's text, accumulating hits into the
 * report. Fails CLOSED: any thrown error drops the field entirely.
 */
function scrubField(
  text: string,
  chain: Detector[],
  report: ReportBuilder,
): string {
  try {
    let current = text;
    for (const detector of chain) {
      const { text: next, hits } = detector.redact(current);
      report.add(detector.rule, hits);
      current = next;
    }
    return current;
  } catch (err) {
    debugError('redaction: field failed, dropped (fail-closed)', err);
    report.add('error', 1);
    return placeholder('error');
  }
}

/**
 * Redact a Bundle. The returned object is the same shape with all free-text /
 * value-bearing fields scrubbed, a populated `redaction` report, and the
 * `environment.envValues` map repopulated with ONLY allowlisted values.
 */
export function redact(bundle: Bundle, opts: RedactOptions = {}): RedactedBundle {
  // Deep clone so we never mutate the caller's pre-gate bundle.
  const cloned: Bundle = structuredClone(bundle);

  const env = opts.env ?? process.env;
  const allowKeys = new Set<string>(opts.allowEnv ?? DEFAULT_ALLOW_ENV);
  const denyPatterns = opts.denyPatterns ?? [];
  const entropyEnabled = opts.entropy !== false;

  // Build the chain: known formats → env values → denylist → entropy (last).
  const chain: Detector[] = [
    ...KNOWN_FORMAT_DETECTORS,
    makeEnvValueDetector(env, allowKeys),
    makeDenylistDetector(denyPatterns),
  ];
  if (entropyEnabled) chain.push(entropyDetector);

  const report = new ReportBuilder();
  const scrub = (text: string): string => scrubField(text, chain, report);

  // ── logs ──────────────────────────────────────────────────────────────────
  cloned.logs.stdoutTail = scrub(cloned.logs.stdoutTail);
  cloned.logs.stderrTail = scrub(cloned.logs.stderrTail);
  if (cloned.logs.combinedTail !== undefined) {
    cloned.logs.combinedTail = scrub(cloned.logs.combinedTail);
  }

  // ── crash error ─────────────────────────────────────────────────────────--
  if (cloned.crash.error !== undefined) {
    cloned.crash.error.message = scrub(cloned.crash.error.message);
    cloned.crash.error.rawStack = scrub(cloned.crash.error.rawStack);
  }

  // ── crash test-failure messages ────────────────────────────────────────────
  if (cloned.crash.testFailure !== undefined) {
    for (const t of cloned.crash.testFailure.failingTests) {
      if (t.message !== undefined) t.message = scrub(t.message);
    }
  }

  // ── git diff patch ──────────────────────────────────────────────────────--
  if (cloned.git.diffVsGreen !== undefined) {
    cloned.git.diffVsGreen.patch = scrub(cloned.git.diffVsGreen.patch);
  }

  // ── repro narration + steps ────────────────────────────────────────────────
  if (cloned.repro.narration !== undefined) {
    cloned.repro.narration = scrub(cloned.repro.narration);
  }
  for (const step of cloned.repro.steps) {
    step.text = scrub(step.text);
  }

  // ── raw error block, if the internal field leaked onto the bundle ──────────
  // (Not part of the persisted Bundle schema, but scrub it defensively if present.)
  const maybeRaw = cloned.crash as { rawErrorBlock?: string };
  if (typeof maybeRaw.rawErrorBlock === 'string') {
    maybeRaw.rawErrorBlock = scrub(maybeRaw.rawErrorBlock);
  }

  // ── collector error strings (may echo paths / env values) ──────────────────
  for (const ce of cloned.collectorErrors) {
    ce.error = scrub(ce.error);
  }

  // ── environment.envValues: start empty, repopulate ONLY allowlisted keys ──--
  // Allowlisted values are non-secret by definition; do NOT scrub them.
  const allowedValues: Record<string, string> = {};
  for (const key of allowKeys) {
    const value = env[key];
    if (typeof value === 'string') allowedValues[key] = value;
  }
  cloned.environment.envValues = allowedValues;

  // ── finalize report ────────────────────────────────────────────────────────
  cloned.redaction = report.build();

  // The brand is phantom (type-only). This cast is the gate's sole privilege.
  return cloned as RedactedBundle;
}
