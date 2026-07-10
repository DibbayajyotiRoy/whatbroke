/**
 * Pure scoring helpers for the regression benchmark (ROADMAP 4.1, ADR-0006).
 *
 * No I/O in this module: `run.ts` feeds it suspect lists produced by the real
 * pipeline, and `src/bench.test.ts` unit-tests it directly.
 */

export interface CaseScore {
  top1: boolean;
  top3: boolean;
}

/** Minimal per-case shape the aggregator needs (run.ts's CaseResult satisfies it). */
export interface ScoredCase {
  name: string;
  /** Labeled known-miss (AC4): scored separately, never in the headline. */
  expectedMiss: boolean;
  top1: boolean;
  top3: boolean;
  /** Present when the case could not be replayed (green run crashed, bad case.json, ...). */
  error?: string;
}

export interface BenchSummary {
  /** Headline denominator: cases with no error and not expectedMiss. */
  total: number;
  top1: number;
  top3: number;
  top1Pct: number;
  top3Pct: number;
  /** Count of expectedMiss cases (excluded from the headline numbers). */
  knownMissTotal: number;
  /** expectedMiss cases that now HIT top-3 — a ranking-signal improvement flipped them. */
  flipped: string[];
  /** Names of cases that errored (never counted in any denominator). */
  errors: string[];
}

/** Normalize a repo-relative path for comparison: '\' → '/', strip leading './'. */
function normalize(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) {
    out = out.slice(2);
  }
  return out;
}

/** Percentage rounded to one decimal; 0 when the denominator is 0. */
export function pct(hits: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return Math.round((hits / total) * 1000) / 10;
}

/**
 * Score one case against the ranked suspect list the pipeline produced:
 * top1 = the first suspect is a culprit; top3 = any of the first three is.
 * Paths are normalized on both sides so 'lib\\a.js' and './lib/a.js' match.
 */
export function scoreCase(
  suspects: readonly string[],
  culprits: readonly string[],
): CaseScore {
  const culpritSet = new Set(culprits.map(normalize));
  const top = suspects.slice(0, 3).map(normalize);
  const first = top[0];
  return {
    top1: first !== undefined && culpritSet.has(first),
    top3: top.some((s) => culpritSet.has(s)),
  };
}

/** Aggregate per-case scores into the scoreboard totals (ADR-0006 semantics). */
export function summarize(cases: readonly ScoredCase[]): BenchSummary {
  const errors = cases.filter((c) => c.error !== undefined).map((c) => c.name);
  const scored = cases.filter((c) => c.error === undefined);
  const headline = scored.filter((c) => !c.expectedMiss);
  const knownMisses = scored.filter((c) => c.expectedMiss);
  const top1 = headline.filter((c) => c.top1).length;
  const top3 = headline.filter((c) => c.top3).length;
  return {
    total: headline.length,
    top1,
    top3,
    top1Pct: pct(top1, headline.length),
    top3Pct: pct(top3, headline.length),
    knownMissTotal: knownMisses.length,
    flipped: knownMisses.filter((c) => c.top3).map((c) => c.name),
    errors,
  };
}
