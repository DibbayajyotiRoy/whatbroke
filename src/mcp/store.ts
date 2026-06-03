/**
 * Read-only bundle store for the MCP server (08).
 *
 * Reads persisted `whatbroke-<id>.json` files from a project's bundles directory,
 * parses them, and serves them. It computes nothing and mutates nothing. The
 * files on disk were written post-redaction-gate (06/07), so the parsed objects
 * are trusted as already-redacted and typed `RedactedBundle`.
 *
 * Everything is tolerant: a missing directory or an unparseable file is skipped,
 * never thrown.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RedactedBundle } from '../types.js';
import { debugError } from '../util/debug.js';

/** Lightweight projection of a bundle for the `list_bundles` surface. */
export interface BundleSummary {
  id: string;
  createdAt: string;
  error: string;
  confidence: string;
}

const FILE_RE = /^whatbroke-(.+)\.json$/;

/** Best-effort one-line error summary from a parsed bundle. */
function errorSummary(bundle: RedactedBundle): string {
  const err = bundle.crash?.error;
  if (err && (err.name || err.message)) {
    const name = err.name || 'Error';
    return err.message ? `${name}: ${err.message}` : name;
  }
  const crash = bundle.crash;
  if (crash) {
    if (crash.signal) return `signal ${crash.signal}`;
    if (typeof crash.exitCode === 'number') return `exit ${crash.exitCode} (${crash.kind})`;
    return crash.kind;
  }
  return 'unknown';
}

export class BundleStore {
  private readonly bundlesDir: string;

  constructor(bundlesDir: string) {
    this.bundlesDir = bundlesDir;
  }

  /** All parsed bundles, most-recent-first, skipping anything unreadable. */
  private async readAll(): Promise<RedactedBundle[]> {
    let names: string[];
    try {
      names = await readdir(this.bundlesDir);
    } catch {
      return [];
    }

    const out: RedactedBundle[] = [];
    for (const name of names) {
      if (!FILE_RE.test(name)) continue;
      const bundle = await this.readFileSafe(join(this.bundlesDir, name));
      if (bundle) out.push(bundle);
    }

    out.sort((a, b) => {
      const ta = Date.parse(a.createdAt) || 0;
      const tb = Date.parse(b.createdAt) || 0;
      return tb - ta; // most-recent-first
    });
    return out;
  }

  private async readFileSafe(path: string): Promise<RedactedBundle | null> {
    try {
      const text = await readFile(path, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { id?: unknown }).id === 'string') {
        return parsed as RedactedBundle;
      }
      return null;
    } catch (err) {
      debugError(`mcp store: skipped unreadable bundle ${path}`, err);
      return null;
    }
  }

  /** Most-recent-first summaries, capped by `limit` (default: all). */
  async list(limit?: number): Promise<BundleSummary[]> {
    const all = await this.readAll();
    const capped = typeof limit === 'number' && limit >= 0 ? all.slice(0, limit) : all;
    return capped.map((b) => ({
      id: b.id,
      createdAt: b.createdAt,
      error: errorSummary(b),
      confidence: b.repro?.confidence ?? 'unknown',
    }));
  }

  /** A specific bundle by id, or the most recent when id is omitted. */
  async get(id?: string): Promise<RedactedBundle | null> {
    const all = await this.readAll();
    if (id === undefined) {
      return all[0] ?? null;
    }
    return all.find((b) => b.id === id) ?? null;
  }

  /** The id of the most recent bundle, or null if there are none. */
  async latestId(): Promise<string | null> {
    const all = await this.readAll();
    return all[0]?.id ?? null;
  }
}
