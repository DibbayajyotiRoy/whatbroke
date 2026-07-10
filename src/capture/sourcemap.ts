/**
 * Source-map resolution (roadmap 5.2, T4.2).
 *
 * Rewrites stack frames that point into build output (`dist/`, `build/`, …)
 * back to the original source (`.ts`) via standard source-map v3 files, so
 * suspect ranking names the file the developer actually edits.
 *
 * Design constraints:
 *   - Offline + best-effort: any read/parse failure leaves the frame untouched
 *     and NEVER throws. `resolveFrames` reports how many frames had a
 *     discoverable map that could not be resolved (`unresolvedCount`).
 *   - No runtime dependencies: the base64-VLQ decoder below is self-contained.
 *   - Sync: frame enrichment (`enrichFrames` in assemble.ts) is sync.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StackFrame } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// IO seam — injectable for hermetic tests
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceMapIO {
  /** Read a file as UTF-8, or null if unreadable/missing. Must not throw. */
  readFile(p: string): string | null;
  /** Whether a file exists on disk. Must not throw. */
  fileExists(p: string): boolean;
}

const DEFAULT_IO: SourceMapIO = {
  readFile(p: string): string | null {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  fileExists(p: string): boolean {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Base64-VLQ decoder (source-map v3 `mappings`)
// ─────────────────────────────────────────────────────────────────────────────

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = new Map<string, number>();
for (let i = 0; i < BASE64_ALPHABET.length; i++) {
  B64_VALUE.set(BASE64_ALPHABET[i]!, i);
}

/**
 * Decode one comma-delimited segment chunk into its relative VLQ fields.
 * Each base64 char carries 5 payload bits; bit 6 (0x20) is the continuation
 * flag; bit 0 of the assembled value is the sign. Throws on malformed input
 * (invalid char or a sequence that ends mid-value).
 */
function decodeVlqChunk(chunk: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < chunk.length; i++) {
    const digit = B64_VALUE.get(chunk[i]!);
    if (digit === undefined) {
      throw new Error(`invalid base64-VLQ character '${chunk[i]!}'`);
    }
    // Multiply instead of << so values past 31 bits do not silently wrap.
    value += (digit & 0x1f) * 2 ** shift;
    if ((digit & 0x20) !== 0) {
      shift += 5;
      continue;
    }
    const negative = value % 2 === 1;
    const abs = (value - (negative ? 1 : 0)) / 2;
    out.push(negative ? -abs : abs);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) {
    throw new Error('unterminated base64-VLQ sequence');
  }
  return out;
}

/**
 * Decode a source-map v3 `mappings` string.
 *
 * Returns one array per generated line (`;`-separated); each line holds its
 * segments (`,`-separated) as ABSOLUTE values:
 *
 *   [generatedColumn, sourceIndex, originalLine, originalColumn]
 *
 * (all 0-based; the optional 5th names index is decoded but dropped).
 * Segments without source info are kept as 1-tuples `[generatedColumn]`.
 * Per spec, generatedColumn resets at each line while sourceIndex /
 * originalLine / originalColumn carry across lines and segments.
 *
 * Throws on malformed VLQ input — callers that must not throw (resolveFrame)
 * catch it. Exported for direct testing.
 */
export function decodeVlqMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let sourceIndex = 0;
  let origLine = 0;
  let origCol = 0;

  for (const lineStr of mappings.split(';')) {
    const segments: number[][] = [];
    let genCol = 0;
    if (lineStr.length > 0) {
      for (const chunk of lineStr.split(',')) {
        if (chunk.length === 0) continue;
        const fields = decodeVlqChunk(chunk);
        if (fields.length === 0) continue;
        genCol += fields[0]!;
        if (fields.length >= 4) {
          sourceIndex += fields[1]!;
          origLine += fields[2]!;
          origCol += fields[3]!;
          segments.push([genCol, sourceIndex, origLine, origCol]);
        } else {
          // 1-field segment (no source info). 2/3-field segments are invalid
          // per spec; be lenient and treat them the same without applying
          // their partial deltas.
          segments.push([genCol]);
        }
      }
    }
    lines.push(segments);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// sourceMappingURL discovery + map parsing
// ─────────────────────────────────────────────────────────────────────────────

/** Last `//# sourceMappingURL=` (or legacy `//@`) in the file, if any. */
function findSourceMappingUrl(content: string): string | null {
  const re = /\/\/[#@][ \t]*sourceMappingURL=(\S+)/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    last = m[1] ?? null;
  }
  return last;
}

/** Decode an inline `data:application/json[;charset=…];base64,…` map. */
function decodeDataUri(uri: string): string | null {
  const m = /^data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]*)$/.exec(
    uri,
  );
  if (!m) return null;
  try {
    return Buffer.from(m[1] ?? '', 'base64').toString('utf8');
  } catch {
    return null;
  }
}

interface ParsedMap {
  sources: unknown[];
  mappings: string;
  sourceRoot: string;
}

function parseMapJson(text: string): ParsedMap | null {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null) return null;
    const m = v as Record<string, unknown>;
    if (m['version'] !== 3) return null;
    if (!Array.isArray(m['sources'])) return null;
    if (typeof m['mappings'] !== 'string') return null;
    return {
      sources: m['sources'],
      mappings: m['mappings'],
      sourceRoot: typeof m['sourceRoot'] === 'string' ? m['sourceRoot'] : '',
    };
  } catch {
    return null;
  }
}

/** `webpack://…`, `https://…`, `file://…` — anything with a URL scheme. */
function hasScheme(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
}

/** Resolve a map `sources[]` entry to an absolute on-disk path, or null. */
function resolveSourcePath(
  source: string,
  sourceRoot: string,
  mapDir: string,
): string | null {
  let full = source;
  if (sourceRoot.length > 0 && !hasScheme(source) && !path.isAbsolute(source)) {
    full = sourceRoot.endsWith('/') ? sourceRoot + source : `${sourceRoot}/${source}`;
  }
  if (full.startsWith('file://')) {
    try {
      return fileURLToPath(full);
    } catch {
      return null;
    }
  }
  if (hasScheme(full)) return null; // webpack:// etc. — not addressable on disk
  return path.isAbsolute(full) ? path.normalize(full) : path.resolve(mapDir, full);
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame resolution
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveFrameResult =
  | { file: string; line: number | null; col: number | null; resolved: true }
  | { resolved: false; note: 'unresolved' }
  | { resolved: false; note: 'no-map' };

const NO_MAP: ResolveFrameResult = { resolved: false, note: 'no-map' };
const UNRESOLVED: ResolveFrameResult = { resolved: false, note: 'unresolved' };

/**
 * Resolve one generated-file location to its original source location.
 *
 *   - 'no-map': the generated file is unreadable or declares no
 *     sourceMappingURL — nothing was discoverable.
 *   - 'unresolved': a map WAS discoverable but resolution failed (missing or
 *     corrupt map, no matching segment, original source not on disk, …).
 *
 * Line/column conventions: the input frame is 1-based (V8 style); source-map
 * segments are 0-based; the returned line/col are 1-based again. Never throws.
 */
export function resolveFrame(
  frame: { file: string; line: number | null; col: number | null },
  io: SourceMapIO = DEFAULT_IO,
): ResolveFrameResult {
  try {
    const content = io.readFile(frame.file);
    if (content === null) return NO_MAP;
    const url = findSourceMappingUrl(content);
    if (url === null) return NO_MAP;

    const genDir = path.dirname(path.resolve(frame.file));
    let mapText: string | null;
    let mapDir: string;
    if (url.startsWith('data:')) {
      mapText = decodeDataUri(url);
      mapDir = genDir;
    } else if (url.startsWith('file://')) {
      let mapPath: string;
      try {
        mapPath = fileURLToPath(url);
      } catch {
        return UNRESOLVED;
      }
      mapText = io.readFile(mapPath);
      mapDir = path.dirname(mapPath);
    } else if (hasScheme(url)) {
      return UNRESOLVED; // http(s) etc. — offline by design
    } else {
      let rel = url;
      try {
        rel = decodeURIComponent(rel);
      } catch {
        /* keep the raw form */
      }
      const mapPath = path.isAbsolute(rel) ? rel : path.resolve(genDir, rel);
      mapText = io.readFile(mapPath);
      mapDir = path.dirname(mapPath);
    }
    if (mapText === null) return UNRESOLVED;

    const map = parseMapJson(mapText);
    if (map === null) return UNRESOLVED;
    if (frame.line === null || frame.line < 1) return UNRESOLVED;

    const decoded = decodeVlqMappings(map.mappings); // throws → outer catch
    const segments = decoded[frame.line - 1];
    if (!segments || segments.length === 0) return UNRESOLVED;
    const withSource = segments.filter((s) => s.length >= 4);
    if (withSource.length === 0) return UNRESOLVED;

    // Last segment on the line with generatedCol <= col; fall back to the
    // line's first source-carrying segment (also when the frame has no col).
    let match = withSource[0]!;
    if (frame.col !== null && frame.col >= 1) {
      const targetCol = frame.col - 1; // V8 cols are 1-based, maps 0-based
      for (const seg of withSource) {
        if (seg[0]! <= targetCol) match = seg;
      }
    }

    const sourceIndex = match[1]!;
    const origLine = match[2]!;
    const origCol = match[3]!;
    const rawSource = map.sources[sourceIndex];
    if (typeof rawSource !== 'string' || rawSource.length === 0) return UNRESOLVED;

    const sourcePath = resolveSourcePath(rawSource, map.sourceRoot, mapDir);
    if (sourcePath === null) return UNRESOLVED;
    if (!io.fileExists(sourcePath)) return UNRESOLVED;

    return { file: sourcePath, line: origLine + 1, col: origCol + 1, resolved: true };
  } catch {
    return UNRESOLVED;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch resolution over StackFrames
// ─────────────────────────────────────────────────────────────────────────────

const BUILD_DIR_RE = /\/(?:dist|build|out|\.next)\//;

/** Cheap pre-filter: only these frames are worth a readFile for discovery. */
function isCandidate(file: string): boolean {
  if (file.startsWith('node:')) return false;
  const norm = file.split('\\').join('/');
  if (norm.includes('/node_modules/')) {
    // Vendored code: only bother when a sibling external map is plausible via
    // the build-dir marker (kept cheap; inline-map vendored deps are rare).
    return BUILD_DIR_RE.test(norm);
  }
  if (BUILD_DIR_RE.test(norm)) return true;
  return /\.(?:js|mjs|cjs)$/.test(norm);
}

/**
 * Best-effort source-map pass over parsed stack frames.
 *
 * Frames matching build-output heuristics (path contains /dist/, /build/,
 * /out/, /.next/, or a .js/.mjs/.cjs file) get `resolveFrame` applied: on
 * success the frame's file is rewritten to the ORIGINAL source's absolute
 * path, line/column are remapped (1-based), and `sourceMapped` is set. On any
 * failure the frame is returned untouched. Frames already `sourceMapped` are
 * skipped.
 *
 * `unresolvedCount` counts frames whose generated file DID declare a
 * sourceMappingURL but could not be resolved ('sourcemap: unresolved' — the
 * caller may surface this as a bundle-level note). Sync and never throws.
 */
export function resolveFrames(
  frames: StackFrame[],
  io: SourceMapIO = DEFAULT_IO,
): { frames: StackFrame[]; unresolvedCount: number } {
  let unresolvedCount = 0;
  const out = frames.map((frame) => {
    if (frame.sourceMapped) return frame;
    if (!frame.file) return frame;
    if (!isCandidate(frame.file)) return frame;

    const result = resolveFrame(
      { file: frame.file, line: frame.line, col: frame.column },
      io,
    );
    if (!result.resolved) {
      if (result.note === 'unresolved') unresolvedCount++;
      return frame;
    }
    return {
      ...frame,
      file: result.file,
      line: result.line,
      column: result.col,
      // Recomputed by enrichFrames against the new (original) path.
      fileRelative: null,
      isInRepo: false,
      isUserCode:
        !result.file.includes('node_modules') && !result.file.startsWith('node:'),
      sourceMapped: true,
    };
  });
  return { frames: out, unresolvedCount };
}
