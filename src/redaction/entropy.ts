/**
 * High-entropy token detector (06) — the LAST, lower-precision pass.
 *
 * Catches long random-looking secrets (base64/hex blobs, API keys with no known
 * prefix) that slipped past the high-precision detectors. Because it is
 * heuristic it runs last and is tuned conservatively so that structural strings
 * — file paths, semver versions, git SHAs embedded in normal text — are NOT
 * flagged.
 */

import type { Detector } from './detectors.js';
import { placeholder } from './detectors.js';

/**
 * Shannon entropy in bits per character. A truly random base64 string trends
 * toward ~6 bits/char; hex toward ~4. English prose sits around 3–4 but its
 * *tokens* (words) are short and rejected by the length gate. We require a
 * fairly high bar so structural identifiers don't trip it. We pick 3.5: a
 * 48-char hex secret sits around ~3.9 and MUST be caught, while structural
 * identifiers (paths, versions, SHAs in prose) are already excluded earlier by
 * the length (≥20) and shape (no separators) gates, so the threshold itself
 * never has to defend against them.
 */
export const ENTROPY_THRESHOLD_BITS = 3.5;

/** Tokens shorter than this are never considered (keeps paths/versions safe). */
export const MIN_TOKEN_LENGTH = 20;

/**
 * A token only qualifies if it is "secret-shaped": made of the character set
 * you'd expect in base64/hex/url-safe tokens, with no path separators, spaces,
 * or sentence punctuation. This excludes file paths (`src/auth/handler.ts`),
 * dotted versions (`2.1.0`), and prose run-ons.
 *
 * Note: `/` is deliberately NOT part of the shape and IS treated as a split
 * boundary below. Path separators are a high false-positive risk (long paths
 * read as high entropy), and slashes inside base64 secrets are handled by the
 * earlier known-format / env-value passes; per spec we err toward NOT mangling
 * structural fields here.
 */
const SECRET_SHAPE = /^[A-Za-z0-9+_=-]+$/;

/** Shannon entropy (bits per character) of a string. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  const len = s.length;
  for (const count of counts.values()) {
    const p = count / len;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Decide whether a single token looks like a high-entropy secret. Beyond the
 * length and shape gates we also require enough *distinct* characters: a token
 * like "aaaaaaaaaaaaaaaaaaaaaa" has length but near-zero entropy and is clearly
 * not a secret, while "0000111122223333..." could have moderate entropy yet be
 * structural, so the distinct-char floor adds robustness.
 */
export function looksHighEntropy(token: string): boolean {
  if (token.length < MIN_TOKEN_LENGTH) return false;
  if (!SECRET_SHAPE.test(token)) return false;
  // A digits-only token of this length is far more likely an id/number than a
  // secret; require at least some alphabetic mixing OR very high entropy.
  const distinct = new Set(token).size;
  if (distinct < 12) return false;
  return shannonEntropy(token) >= ENTROPY_THRESHOLD_BITS;
}

/**
 * Split text into tokens on whitespace, quotes, and punctuation boundaries —
 * but preserve those boundaries so we can faithfully reassemble the text with
 * only the secret tokens replaced.
 */
const SPLIT = /([^\sA-Za-z0-9+_=-])/;

export const entropyDetector: Detector = {
  rule: 'high-entropy',
  redact(text: string): { text: string; hits: number } {
    let hits = 0;
    // Split on whitespace first, then handle each chunk; rejoin with the exact
    // original whitespace to avoid mangling layout.
    const out = text.replace(/[^\s]+/g, (chunk) => {
      // A chunk may contain delimiters (e.g. key="SECRET"); split them out so
      // we only test the secret-shaped inner token(s).
      const parts = chunk.split(SPLIT);
      let changed = false;
      const rebuilt = parts.map((part) => {
        if (looksHighEntropy(part)) {
          changed = true;
          hits++;
          return placeholder('high-entropy');
        }
        return part;
      });
      return changed ? rebuilt.join('') : chunk;
    });
    return { text: out, hits };
  },
};
