/**
 * Crash history index (roadmap 3.1, ADR-0004): `.whatbroke/index.json`.
 *
 * A local, deterministic ledger of crash fingerprints → occurrences +
 * resolutions. It is exactly the accumulated ground truth an LLM cannot fake:
 * "this failure matches bundle X from <date>, fixed by commit Y touching Z".
 * Nothing here leaves the machine; there is no backend and no telemetry.
 *
 * Same durability discipline as the journal: atomic temp+rename writes,
 * corrupt/missing file degrades to empty, self-GC (age + entry cap).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { HistoryMatch, SuspectFile } from '../types.js';

export interface HistoryOccurrence {
  bundleId: string;
  at: string; // ISO-8601 (bundle createdAt)
  head: string | null; // sha at crash time
  suspects: string[]; // top suspect paths at capture time (ranked)
}

export interface HistoryResolution {
  bundleId: string; // the bundle that got fixed
  commit: string; // resolving commit sha
  at: string; // ISO-8601
  filesTouched: string[];
  /** Ranking feedback ledger (3.2): was a touched file the top-1 / top-3 suspect? */
  top1Hit: boolean;
  top3Hit: boolean;
}

export interface HistoryEntry {
  occurrences: HistoryOccurrence[]; // oldest → newest
  resolved?: HistoryResolution;
}

export interface HistoryFile {
  version: 1;
  entries: Record<string, HistoryEntry>; // keyed by crash fingerprint (1.2)
}

const MAX_AGE_DAYS = 60;
const MAX_ENTRIES = 200;
const MAX_OCCURRENCES_PER_ENTRY = 20;

export function historyPath(storeDir: string): string {
  return path.join(storeDir, 'index.json');
}

export class HistoryIndex {
  private constructor(
    private readonly file: string,
    private data: HistoryFile,
  ) {}

  /** Missing or corrupt index degrades to empty — never throws (AC5). */
  static async open(file: string): Promise<HistoryIndex> {
    let data: HistoryFile = { version: 1, entries: {} };
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as HistoryFile;
      if (parsed && parsed.version === 1 && typeof parsed.entries === 'object' && parsed.entries !== null) {
        data = { version: 1, entries: parsed.entries };
      }
    } catch {
      // fall through to empty
    }
    return new HistoryIndex(file, data);
  }

  entry(fingerprint: string): HistoryEntry | undefined {
    return this.data.entries[fingerprint];
  }

  /** All entries, for stats. */
  entries(): Record<string, HistoryEntry> {
    return this.data.entries;
  }

  /**
   * Build the bundle-facing `history` block for a new crash with this
   * fingerprint (AC2/AC3), or undefined when this fingerprint is new.
   *
   * `greenShaForCommand` is the journal's green sha for the same command +
   * branch: when a prior occurrence of this fingerprint crashed at that same
   * sha, the same code has both passed and failed → flaky (AC3).
   */
  match(
    fingerprint: string,
    greenShaForCommand: string | null,
  ): HistoryMatch | undefined {
    const entry = this.data.entries[fingerprint];
    if (!entry || entry.occurrences.length === 0) return undefined;
    const last = entry.occurrences[entry.occurrences.length - 1]!;
    const m: HistoryMatch = {
      fingerprint,
      matchedBundleId: last.bundleId,
      matchedAt: last.at,
      occurrences: entry.occurrences.length,
      provenance: 'derived',
    };
    if (entry.resolved) {
      m.resolvedBy = {
        commit: entry.resolved.commit,
        filesTouched: [...entry.resolved.filesTouched],
      };
    } else if (
      greenShaForCommand !== null &&
      entry.occurrences.some((o) => o.head !== null && o.head === greenShaForCommand)
    ) {
      m.flaky = true;
    }
    return m;
  }

  recordCrash(fingerprint: string, occ: HistoryOccurrence): void {
    const entry = (this.data.entries[fingerprint] ??= { occurrences: [] });
    entry.occurrences.push(occ);
    if (entry.occurrences.length > MAX_OCCURRENCES_PER_ENTRY) {
      entry.occurrences = entry.occurrences.slice(-MAX_OCCURRENCES_PER_ENTRY);
    }
    // A recurrence of a previously-resolved crash is a NEW bug with the same
    // shape: the old resolution stays (it is the provenance the history block
    // cites) — stats treat resolution as latest-known outcome.
  }

  recordResolution(
    fingerprint: string,
    res: {
      bundleId: string;
      commit: string;
      at: string;
      filesTouched: string[];
      suspects: SuspectFile[];
    },
  ): void {
    const entry = (this.data.entries[fingerprint] ??= { occurrences: [] });
    const touched = new Set(res.filesTouched.map(normalizeRel));
    const ranked = res.suspects.map((s) => normalizeRel(s.path));
    entry.resolved = {
      bundleId: res.bundleId,
      commit: res.commit,
      at: res.at,
      filesTouched: res.filesTouched,
      top1Hit: ranked.length > 0 && touched.has(ranked[0]!),
      top3Hit: ranked.slice(0, 3).some((p) => touched.has(p)),
    };
  }

  /** Evict entries idle > MAX_AGE_DAYS, then cap at MAX_ENTRIES (freshest kept). */
  gc(now: Date = new Date()): void {
    const cutoff = now.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const fresh = (e: HistoryEntry): number => {
      const last = e.occurrences[e.occurrences.length - 1]?.at ?? e.resolved?.at ?? '';
      const t = Date.parse(last);
      return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t; // unparseable → keep
    };
    let pairs = Object.entries(this.data.entries).filter(([, e]) => fresh(e) >= cutoff);
    if (pairs.length > MAX_ENTRIES) {
      pairs = pairs.sort((a, b) => fresh(b[1]) - fresh(a[1])).slice(0, MAX_ENTRIES);
    }
    this.data.entries = Object.fromEntries(pairs);
  }

  /** Atomic persist (temp + rename), creating the store dir if needed. */
  async persist(): Promise<void> {
    this.gc();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.file);
  }
}

/** Compare repo-relative paths forgivingly (./ prefixes, backslashes). */
function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
