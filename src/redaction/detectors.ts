/**
 * Detectors for the redaction gate (06).
 *
 * A detector takes free text and returns a copy with every sensitive hit
 * replaced by `‹redacted:RULE›`, plus a count of how many hits it replaced.
 * Detectors NEVER return the original sensitive value (not even in the rule
 * name) and NEVER throw on benign input.
 *
 * Ordering matters: high-precision known-format detectors run first, then the
 * env-value detector, then the config denylist, then (in entropy.ts) the
 * lower-precision entropy pass. Each pass operates on the output of the prior.
 */

/** A single redaction pass. */
export interface Detector {
  /** Stable rule name; used as the placeholder tag and the report key. */
  rule: string;
  /** Replace every hit in `text` with `‹redacted:rule›`; report the count. */
  redact(text: string): { text: string; hits: number };
}

/** The placeholder a hit is replaced with. The reader sees something *was* here. */
export function placeholder(rule: string): string {
  return `‹redacted:${rule}›`;
}

/**
 * Build a regex-backed detector. `re` MUST be global (`g`) so replaceAll-style
 * counting works. We count via the replace callback to stay accurate even with
 * overlapping-ish alternations.
 */
function regexDetector(rule: string, re: RegExp): Detector {
  return {
    rule,
    redact(text: string): { text: string; hits: number } {
      let hits = 0;
      // Clone the regex per call so lastIndex state never leaks between calls.
      const local = new RegExp(re.source, re.flags);
      const out = text.replace(local, () => {
        hits++;
        return placeholder(rule);
      });
      return { text: out, hits };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Known-format secrets — high precision, run FIRST.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Order within this array matters: broad container patterns (private key
 * blocks, connection strings, auth headers) should run before the narrow
 * token patterns so a token embedded in a larger structure is consumed by the
 * structural rule first. It is harmless either way (both redact), but it keeps
 * the report attribution sane.
 */
export const KNOWN_FORMAT_DETECTORS: Detector[] = [
  // Private key PEM blocks (multiline). Non-greedy body, DOTALL via [\s\S].
  regexDetector(
    'private-key',
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  ),
  // JWTs: header.payload.signature, header/payload start with eyJ.
  regexDetector('jwt', /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g),
  // Connection strings with embedded credentials: scheme://user:pass@host
  // Redact the whole userinfo@host portion; keep nothing of the secret.
  regexDetector(
    'connection-string',
    /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@[^\s/]+/g,
  ),
  // Bearer / Authorization header values. Capture the keyword, redact value.
  regexDetector(
    'auth-header',
    /\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*(?:Bearer|Basic|Token|Digest)?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
  ),
  regexDetector(
    'bearer-token',
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  ),
  // GitHub tokens: classic + fine-grained PATs + oauth/app/server tokens.
  regexDetector(
    'github-token',
    /\b(?:ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  ),
  // AWS access key id.
  regexDetector('aws-access-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g),
  // AWS secret access key, typically introduced by a labelled assignment.
  regexDetector(
    'aws-secret-key',
    /\baws_secret_access_key\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi,
  ),
  // Google API keys.
  regexDetector('google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g),
  // Slack tokens (bot/app/refresh/session) and legacy.
  regexDetector('slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g),
];

// ─────────────────────────────────────────────────────────────────────────────
// Env-value detector — cheap, high-yield. Redact verbatim env VALUES.
// ─────────────────────────────────────────────────────────────────────────────

/** Escape a literal string for safe embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A value is "trivial" (and therefore NOT worth matching verbatim) if it is
 * short, a plain number, a boolean-ish word, or a single common dictionary
 * word. Matching such values verbatim would mangle ordinary log text.
 */
const COMMON_WORDS = new Set<string>([
  'true', 'false', 'yes', 'no', 'on', 'off', 'none', 'null', 'undefined',
  'development', 'production', 'staging', 'test', 'testing', 'local',
  'default', 'enabled', 'disabled', 'debug', 'info', 'warn', 'error',
  'utf-8', 'en_us', 'en-us', 'utc', 'localhost',
]);

function isTrivialValue(value: string): boolean {
  if (value.length < 8) return true;
  // Pure number (incl. decimals / version-ish dotted numbers).
  if (/^[0-9]+(?:\.[0-9]+)*$/.test(value)) return true;
  // Single common word (case-insensitive), no internal separators.
  if (/^[A-Za-z][A-Za-z-]*$/.test(value) && COMMON_WORDS.has(value.toLowerCase())) {
    return true;
  }
  return false;
}

/**
 * Build a detector that redacts verbatim occurrences of every NON-allowlisted,
 * non-trivial env value. This catches secrets that match no known format but
 * are clearly sensitive because they live in the environment.
 *
 * @param env       The env snapshot to draw values from.
 * @param allowKeys Keys whose values are safe and must NOT be redacted.
 */
export function makeEnvValueDetector(
  env: Record<string, string | undefined>,
  allowKeys: Set<string>,
): Detector {
  // Collect candidate values, longest-first so a value that is a substring of
  // another doesn't pre-empt the longer (more specific) match.
  const values: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(env)) {
    if (allowKeys.has(key)) continue;
    const value = env[key];
    if (value === undefined) continue;
    if (isTrivialValue(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  values.sort((a, b) => b.length - a.length);

  const combined =
    values.length > 0
      ? new RegExp(values.map(escapeRegExp).join('|'), 'g')
      : null;

  return {
    rule: 'env-value',
    redact(text: string): { text: string; hits: number } {
      if (combined === null) return { text, hits: 0 };
      let hits = 0;
      const local = new RegExp(combined.source, combined.flags);
      const out = text.replace(local, () => {
        hits++;
        return placeholder('env-value');
      });
      return { text: out, hits };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Denylist detector — config-supplied regexes. Config can only ADD redaction.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compile each config-supplied pattern and redact matches. Invalid patterns are
 * skipped (a bad config regex must never weaken the gate or throw the pipeline).
 */
export function makeDenylistDetector(patterns: string[]): Detector {
  const compiled: RegExp[] = [];
  for (const src of patterns) {
    try {
      // Force global so every occurrence is replaced.
      const existing = src;
      compiled.push(new RegExp(existing, 'g'));
    } catch {
      // Skip uncompilable patterns; do not throw, do not weaken other rules.
    }
  }

  return {
    rule: 'denylist',
    redact(text: string): { text: string; hits: number } {
      let hits = 0;
      let out = text;
      for (const re of compiled) {
        const local = new RegExp(re.source, re.flags);
        out = out.replace(local, () => {
          hits++;
          return placeholder('denylist');
        });
      }
      return { text: out, hits };
    },
  };
}
