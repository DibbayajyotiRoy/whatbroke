/**
 * Adapter registry + selection seam. Mirrors the existing PARSERS/Sink patterns:
 * a flat list, registration order as the tie-break, and a guaranteed fallback.
 */
import type { DetectionContext, LanguageAdapter } from './types.js';

const ADAPTERS: LanguageAdapter[] = [];

/** Minimum confidence before a non-fallback adapter is chosen. */
export const DETECT_THRESHOLD = 0.3;

/** The adapter id used when nothing else scores high enough. */
export const FALLBACK_ID = 'node';

export function registerAdapter(adapter: LanguageAdapter): void {
  // Idempotent re-register (replace by id) keeps test isolation simple.
  const existing = ADAPTERS.findIndex((a) => a.id === adapter.id);
  if (existing !== -1) ADAPTERS.splice(existing, 1, adapter);
  else ADAPTERS.push(adapter);
}

export function listAdapters(): readonly LanguageAdapter[] {
  return ADAPTERS;
}

export function getAdapter(id: string): LanguageAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

/**
 * Pick the adapter for a run: highest `detect()` score above the threshold,
 * ties broken by registration order. Falls back to the `node` adapter (or the
 * first registered adapter) when nothing clears the bar.
 */
export function selectAdapter(ctx: DetectionContext): LanguageAdapter {
  let best: LanguageAdapter | null = null;
  let bestScore = 0;
  for (const a of ADAPTERS) {
    let s = 0;
    try {
      s = a.detect(ctx);
    } catch {
      s = 0;
    }
    if (s > bestScore) {
      best = a;
      bestScore = s;
    }
  }
  if (best && bestScore >= DETECT_THRESHOLD) return best;
  return getAdapter(FALLBACK_ID) ?? ADAPTERS[0] ?? best ?? throwNoAdapters();
}

function throwNoAdapters(): never {
  throw new Error('no language adapters registered');
}
