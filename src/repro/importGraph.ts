import { readFileSync, statSync } from 'node:fs';
import { normalizePath } from './changed.js';

/**
 * Static, bounded import-graph extraction for the one-hop suspect signal
 * (roadmap 4.2 / T3.2). NO execution of user code, no AST dependency, no
 * tsconfig path mapping in v1: a string-aware comment-stripping pass plus a
 * handful of regexes over the source text. Deterministic by construction —
 * candidate files are processed in sorted order and every emitted set is
 * sorted.
 *
 * Known, accepted parsing limitations (this is a heuristic signal, +2):
 *   - The comment stripper tracks '...', "..." and `...` so a specifier-like
 *     string containing `//` (e.g. 'https://…') never starts a comment, and
 *     commented-out imports are reliably dropped. It does NOT understand
 *     regex literals: `//` or `/*` inside a regex literal is treated as a
 *     comment and may over-strip the rest of that line/block. `${}` nesting
 *     inside template literals is not tracked (a backtick inside an
 *     interpolation ends the template early). Both can only LOSE edges,
 *     never invent them.
 *   - Only single/double-quoted literal specifiers are extracted; template
 *     literals and computed expressions (`import(x)`, `require(a + b)`) are
 *     ignored on purpose.
 *   - Whitespace is required after the `import`/`export` keyword, so fully
 *     minified `import{x}from'y'` is not matched — repo source files are the
 *     target, not bundles.
 */

// ── Comment stripping ────────────────────────────────────────────────────────

type StripMode = 'code' | 'single' | 'double' | 'template';

/** Remove line and block comments while preserving string contents verbatim. */
function stripComments(source: string): string {
  const n = source.length;
  let out = '';
  let i = 0;
  let mode: StripMode = 'code';
  while (i < n) {
    const ch = source.charAt(i);
    const nx = source.charAt(i + 1);
    if (mode === 'code') {
      if (ch === '/' && nx === '/') {
        i += 2;
        while (i < n && source.charAt(i) !== '\n') {
          i++;
        }
        out += ' '; // the newline itself is emitted by the code branch
        continue;
      }
      if (ch === '/' && nx === '*') {
        i += 2;
        while (i < n && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) {
          if (source.charAt(i) === '\n') {
            out += '\n'; // keep line structure roughly intact
          }
          i++;
        }
        i += 2; // past the closing */ (or end of input)
        out += ' ';
        continue;
      }
      if (ch === "'") {
        mode = 'single';
      } else if (ch === '"') {
        mode = 'double';
      } else if (ch === '`') {
        mode = 'template';
      }
      out += ch;
      i++;
      continue;
    }
    // Inside a string literal: copy verbatim, honoring escapes.
    if (ch === '\\') {
      out += ch + nx;
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && (ch === "'" || ch === '\n')) || // \n: unterminated literal
      (mode === 'double' && (ch === '"' || ch === '\n')) ||
      (mode === 'template' && ch === '`')
    ) {
      mode = 'code';
    }
    out += ch;
    i++;
  }
  return out;
}

// ── Specifier extraction ─────────────────────────────────────────────────────

// `import <clause> from '<spec>'` — clause may span lines but never crosses a
// quote or `;`, which fences the match inside one statement.
const IMPORT_FROM_RE = /\bimport\s+([^'";]+?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g;
// `export <clause> from '<spec>'` (re-exports).
const EXPORT_FROM_RE = /\bexport\s+([^'";]+?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g;
// Side-effect `import '<spec>'` — quote must follow the keyword directly.
const SIDE_EFFECT_RE = /\bimport\s*(['"])([^'"\n]+)\1/g;
// Dynamic `import('<spec>')` with a literal string; allows import attributes.
const DYNAMIC_RE = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*[,)]/g;
// CommonJS `require('<spec>')` with a literal string (also catches the TS
// `import x = require('…')` form via the require call itself).
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

/**
 * Is an import/export clause type-only (`import type { T } …`)?
 * Pathological-but-legal value forms are kept:
 *   - `import type from 'x'`      → default VALUE binding named `type`
 *   - `import type, { A } from`   → ditto, plus named bindings
 */
function isTypeOnlyClause(clause: string): boolean {
  const c = clause.trim();
  if (c === 'type') {
    return false;
  }
  if (/^type\s*,/.test(c)) {
    return false;
  }
  return /^type\b/.test(c);
}

/**
 * Statically extract module specifiers from ESM imports/re-exports,
 * side-effect imports, literal dynamic `import()`, and literal `require()`.
 * Type-only imports and non-literal specifiers are ignored. Returns
 * specifiers in source order, deduplicated (first occurrence wins).
 */
export function parseImports(source: string): string[] {
  const code = stripComments(source);
  const found: { index: number; spec: string }[] = [];

  const collect = (re: RegExp, specGroup: number, clauseGroup?: number): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const spec = m[specGroup];
      if (!spec) {
        continue;
      }
      if (clauseGroup !== undefined && isTypeOnlyClause(m[clauseGroup] ?? '')) {
        continue;
      }
      found.push({ index: m.index, spec });
    }
  };

  collect(IMPORT_FROM_RE, 3, 1);
  collect(EXPORT_FROM_RE, 3, 1);
  collect(SIDE_EFFECT_RE, 2);
  collect(DYNAMIC_RE, 2);
  collect(REQUIRE_RE, 2);

  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of found) {
    if (!seen.has(f.spec)) {
      seen.add(f.spec);
      out.push(f.spec);
    }
  }
  return out;
}

// ── Resolution ───────────────────────────────────────────────────────────────

// Probe suffixes, in deterministic order (after `exact` and the .js→.ts remap).
const EXTENSION_PROBES = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs'] as const;
const INDEX_PROBES = ['/index.ts', '/index.tsx', '/index.js'] as const;

/** Join a directory and a specifier, collapsing `.`/`..`; null if it escapes the root. */
function joinAndNormalize(dir: string, spec: string): string | null {
  const parts: string[] = dir === '' ? [] : dir.split('/');
  for (const seg of normalizePath(spec).split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (parts.length === 0) {
        return null; // climbed above the repo root — not repo-relative anymore
      }
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length === 0 ? null : parts.join('/');
}

/**
 * Resolve a RELATIVE specifier (`./x`, `../y`) from a repo-relative importer
 * to a repo-relative file path. Bare specifiers (packages, `node:*`) and
 * absolute paths return null — the graph only tracks in-repo edges.
 *
 * Probe order (deterministic): exact; then, for a specifier ending in `.js`,
 * the TS-ESM remap (`./x.js` → `x.ts`); then appended extensions
 * .ts/.tsx/.mts/.js/.mjs/.cjs; then /index.ts, /index.tsx, /index.js.
 * The first existing candidate wins. `fileExists` is called with paths in the
 * same repo-relative form as `fromFile`.
 */
export function resolveSpecifier(
  fromFile: string,
  spec: string,
  fileExists: (p: string) => boolean,
): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    return null;
  }
  const from = normalizePath(fromFile);
  const slash = from.lastIndexOf('/');
  const dir = slash === -1 ? '' : from.slice(0, slash);
  const base = joinAndNormalize(dir, spec);
  if (base === null) {
    return null;
  }
  const candidates: string[] = [base];
  if (base.endsWith('.js')) {
    candidates.push(`${base.slice(0, -3)}.ts`);
  }
  for (const ext of EXTENSION_PROBES) {
    candidates.push(base + ext);
  }
  for (const idx of INDEX_PROBES) {
    candidates.push(base + idx);
  }
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ── One-hop edge building ────────────────────────────────────────────────────

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_BYTES = 512 * 1024;

// Only JS/TS-family sources are parsed (Node/TS only in v1); other candidates
// (.py, .md, package.json, …) are skipped WITHOUT being read and do not
// consume maxFiles budget.
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'] as const;

export interface BuildOneHopEdgesOptions {
  /** Absolute repo root; candidate paths are joined under it for fs access. */
  repoRoot: string;
  /** Repo-relative candidate files (union of stack files + changed files). */
  files: string[];
  /** Reader — receives repoRoot-joined paths; null means unreadable/absent. */
  readFile: (p: string) => string | null;
  /** Existence probe — receives repoRoot-joined paths; must be false for directories. */
  fileExists: (p: string) => boolean;
  /** Max candidate files parsed (default 200), applied after sorting. */
  maxFiles?: number;
  /** Max file size in bytes (default 512 KiB); larger files are skipped. */
  maxBytes?: number;
}

/**
 * Parse ONLY the given candidate files (≤1 hop — no crawling) and return the
 * adjacency importer → Set of imported repo-relative paths. Importers with no
 * resolved in-repo edges (and self-imports) are omitted. Deterministic:
 * candidates are deduped and sorted before the maxFiles cap, and each edge
 * set is sorted.
 */
export function buildOneHopEdges(opts: BuildOneHopEdgesOptions): Map<string, Set<string>> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const root = opts.repoRoot.replace(/[\\/]+$/, '');
  const joined = (rel: string): string => (root === '' ? rel : `${root}/${rel}`);

  const candidates = [...new Set(opts.files.map((f) => normalizePath(f)))]
    .filter((f) => SOURCE_EXTENSIONS.some((ext) => f.endsWith(ext)))
    .sort()
    .slice(0, maxFiles);

  const edges = new Map<string, Set<string>>();
  for (const rel of candidates) {
    const content = opts.readFile(joined(rel));
    if (content === null || Buffer.byteLength(content, 'utf8') > maxBytes) {
      continue;
    }
    const targets = new Set<string>();
    for (const spec of parseImports(content)) {
      const resolved = resolveSpecifier(rel, spec, (p) => opts.fileExists(joined(p)));
      if (resolved !== null && resolved !== rel) {
        targets.add(resolved);
      }
    }
    if (targets.size > 0) {
      edges.set(rel, new Set([...targets].sort()));
    }
  }
  return edges;
}

// ── Default fs implementations (production) ─────────────────────────────────

/** Synchronous utf8 read; null on any error (missing, unreadable, directory). */
export function defaultReadFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** True only for existing regular files (directories must NOT resolve). */
export function defaultFileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
