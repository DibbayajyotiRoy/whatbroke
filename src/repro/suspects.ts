import type { ReproInput, SuspectFile, StackFrame } from '../types.js';
import { changedSinceGreen, normalizePath } from './changed.js';
import { buildOneHopEdges, defaultFileExists, defaultReadFile } from './importGraph.js';

/**
 * Deterministic suspect-file ranking — the moat. NO LLM.
 *
 * Scores candidate files from three observed inputs:
 *   - the parsed stack trace (`input.crash.error?.stack`), whose
 *     `fileRelative` / `isInRepo` / `isUserCode` flags are populated by
 *     integration before we run,
 *   - the set of files changed since the last green run
 *     (`input.context.git.changedFiles`, paths repo-relative), and
 *   - a bounded static one-hop import graph connecting the two (T3.2 /
 *     roadmap 4.2) — no execution, no crawling beyond the candidates.
 *
 * The marquee signal is the intersection: a file that is BOTH on the failure
 * path AND something you just touched. One step weaker is the import hop: an
 * on-stack file one static import away from a changed file. Everything is
 * correlation-based and lives in `suspects[]` (heuristic), never in the
 * deterministic steps.
 */

// Scoring weights (from the spec table). Named constants so they stay tunable
// against the eval set.
const WEIGHT_STACK_AND_CHANGED = 5; // on stack AND changed since green
const WEIGHT_TOP_FRAME = 3; // first user-code frame
const WEIGHT_FRAME_DECAY_STEP = 1; // decay per subsequent user frame: 3, 2, 1, ...
const WEIGHT_FRAME_FLOOR = 1; // user frames never score below this
const WEIGHT_CHANGED_ONLY = 1; // changed since green, not on stack
const WEIGHT_NODE_MODULES_FRAME = 0.5; // on stack but inside node_modules
// Import-graph one-hop (roadmap 4.2): an on-stack in-repo file one static
// import away from a changed-since-green file. Weaker than the direct
// intersection (+5), stronger than changed-only (+1).
const WEIGHT_IMPORT_HOP = 2;

const MAX_SUSPECTS = 5;

interface Candidate {
  path: string;
  score: number;
  reasons: string[];
  /**
   * Carries the marquee stack∩changed signal. Direct evidence (you changed it
   * AND it is on the failure path) always outranks proximity evidence, no
   * matter how bonuses stack numerically — enforced by the final sort.
   */
  intersection?: boolean;
}

/**
 * Optional knobs for the import-hop signal. Production call sites
 * (reconstruct.ts) pass nothing: the one-hop graph is then computed lazily
 * from the filesystem via the default node:fs helpers. Tests stay hermetic by
 * injecting either a prebuilt `edges` map or fake `readFile`/`fileExists`.
 */
export interface RankSuspectsOptions {
  /**
   * Prebuilt one-hop adjacency (repo-relative importer → set of repo-relative
   * imported files). When provided it is used as-is — an empty map disables
   * the hop signal without touching the filesystem.
   */
  edges?: Map<string, Set<string>>;
  /**
   * Repo root for the lazy graph build. Default: derived from stack frames
   * (absolute `file` minus repo-relative `fileRelative`), falling back to the
   * recorded process cwd.
   */
  repoRoot?: string;
  /** Injectable reader for the lazy build (tests). Default: node:fs readFileSync. */
  readFile?: (p: string) => string | null;
  /** Injectable existence probe for the lazy build (tests). Default: statSync().isFile(). */
  fileExists?: (p: string) => boolean;
}

export function rankSuspects(
  input: ReproInput,
  options?: RankSuspectsOptions,
): SuspectFile[] {
  const frames: StackFrame[] = input.crash.error?.stack ?? [];
  const greenRef = input.context.git.greenRef;
  const greenShort = greenRef ? greenRef.slice(0, 7) : null;

  // Changed set (union of uncommitted + diff-vs-green), shared with confidence.
  const { files: changedSet, hasGreen } = changedSinceGreen(input.context.git);

  const byPath = new Map<string, Candidate>();
  const get = (path: string): Candidate => {
    let c = byPath.get(path);
    if (!c) {
      c = { path, score: 0, reasons: [] };
      byPath.set(path, c);
    }
    return c;
  };

  // Walk the stack and assign decaying frame scores to user-code frames. The
  // decay is by ordinal user frame, not raw frame index, so node_modules frames
  // between user frames don't consume the decay budget.
  const stackInRepo = new Set<string>(); // in-repo user frames — hop-eligible
  let userFrameOrdinal = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame || !frame.fileRelative) {
      continue;
    }
    const path = normalizePath(frame.fileRelative);

    if (frame.isUserCode) {
      if (frame.isInRepo) {
        stackInRepo.add(path);
      }
      const c = get(path);
      // 3 (top), 2, 1, then floored at 1 for deeper user frames.
      const decayed = WEIGHT_TOP_FRAME - userFrameOrdinal * WEIGHT_FRAME_DECAY_STEP;
      const frameScore = Math.max(WEIGHT_FRAME_FLOOR, decayed);
      c.score += frameScore;
      // Frame numbers are 1-based for human-legible reasons.
      c.reasons.push(`on stack at frame ${userFrameOrdinal + 1}`);
      userFrameOrdinal++;
    } else if (frame.file && frame.file.includes('node_modules')) {
      // Library frame: low weight unless it's all we have.
      const c = get(path);
      c.score += WEIGHT_NODE_MODULES_FRAME;
      c.reasons.push('on stack in node_modules');
    }
  }

  // Changed-since-green signal. If the file is also on the stack (already a
  // candidate), this is the marquee intersection; otherwise it's the weak
  // "you touched it recently" signal.
  for (const changed of changedSet) {
    const onStack = byPath.has(changed);
    const c = get(changed);
    // Honest labeling: only call it "since green" when a green ref exists;
    // otherwise it's an uncommitted working-tree change.
    const label = hasGreen ? `changed since green ${greenShort}` : 'uncommitted change';
    if (onStack) {
      c.score += WEIGHT_STACK_AND_CHANGED;
      c.reasons.push(`${label} (on the failure path)`);
      c.intersection = true;
    } else {
      c.score += WEIGHT_CHANGED_ONLY;
      c.reasons.push(label);
    }
  }

  // Import-graph one-hop: connect the stack to the change through one static
  // import edge, in BOTH directions of evidence (roadmap 4.2):
  //   - an on-stack file one import away from a changed file ("the crash site
  //     is near your change"), and
  //   - a changed-but-off-stack file one import away from an on-stack file
  //     ("your change is near the crash site") — this is the direction that
  //     surfaces culprits whose damage manifests elsewhere (renamed exports,
  //     bad producers behind async boundaries).
  // Files with the intersection (+5) signal are excluded — they already carry
  // the direct evidence. At most one bonus per file: the first matching
  // counterpart in sorted order wins, outgoing edge checked before incoming.
  // Best-effort — skipped outside a git repo or without changes, and edge
  // computation can never throw.
  if (input.context.git.isRepo && changedSet.size > 0) {
    const stackTargets = [...byPath.keys()]
      .filter((p) => stackInRepo.has(p) && !changedSet.has(p))
      .sort();
    const changedTargets = [...changedSet].filter((p) => !stackInRepo.has(p)).sort();
    if (stackTargets.length > 0 && changedTargets.length + changedSet.size > 0) {
      const edges =
        options?.edges ?? computeEdgesSafely(input, stackTargets, changedSet, options);
      if (edges && edges.size > 0) {
        const sortedChanged = [...changedSet].sort();
        const connects = (a: string, b: string): 'imports' | 'imported-by' | null => {
          if (edges.get(a)?.has(b)) return 'imports';
          if (edges.get(b)?.has(a)) return 'imported-by';
          return null;
        };
        for (const path of stackTargets) {
          const c = byPath.get(path);
          if (!c) continue;
          for (const chg of sortedChanged) {
            const link = connects(path, chg);
            if (link) {
              c.score += WEIGHT_IMPORT_HOP;
              c.reasons.push(
                link === 'imports'
                  ? `imports changed file ${chg}`
                  : `imported by changed file ${chg}`,
              );
              break;
            }
          }
        }
        const sortedStack = [...stackInRepo].sort();
        for (const path of changedTargets) {
          const c = byPath.get(path);
          if (!c) continue;
          for (const stk of sortedStack) {
            const link = connects(path, stk);
            if (link) {
              c.score += WEIGHT_IMPORT_HOP;
              c.reasons.push(
                link === 'imports'
                  ? `imports crashing file ${stk}`
                  : `imported by crashing file ${stk}`,
              );
              break;
            }
          }
        }
      }
    }
  }

  const candidates = [...byPath.values()];
  if (candidates.length === 0) {
    return [];
  }

  candidates.sort((a, b) => {
    // Direct evidence first: stack∩changed files outrank everything else even
    // when bonuses (frame weight + import hop) stack numerically higher.
    const tierA = a.intersection ? 1 : 0;
    const tierB = b.intersection ? 1 : 0;
    if (tierA !== tierB) {
      return tierB - tierA;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // Stable tie-break by path (ascending).
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return candidates.slice(0, MAX_SUSPECTS).map((c) => ({
    path: c.path,
    score: c.score,
    reasons: c.reasons,
  }));
}

/**
 * Lazy edge computation for call sites that pass no prebuilt graph —
 * reconstruct.ts keeps calling `rankSuspects(input)` unchanged and still gets
 * the hop signal. Parses at most the union of hop-eligible stack files and
 * changed files (bounded by buildOneHopEdges caps) through the injectable fs
 * helpers, and degrades to null (no bonus) on ANY failure: the hop signal
 * must never break ranking.
 */
function computeEdgesSafely(
  input: ReproInput,
  stackFiles: string[],
  changedSet: Set<string>,
  options: RankSuspectsOptions | undefined,
): Map<string, Set<string>> | null {
  try {
    const repoRoot = options?.repoRoot ?? deriveRepoRoot(input);
    if (!repoRoot) {
      return null;
    }
    return buildOneHopEdges({
      repoRoot,
      files: [...stackFiles, ...changedSet],
      readFile: options?.readFile ?? defaultReadFile,
      fileExists: options?.fileExists ?? defaultFileExists,
    });
  } catch {
    return null;
  }
}

/**
 * Best-effort repo root: the first stack frame carrying both an absolute
 * `file` and a repo-relative `fileRelative` reveals it by subtraction. Falls
 * back to the recorded process cwd (correct when whatbroke ran at the repo
 * root — the common case). A wrong root only makes the fs probes miss, which
 * silently disables the hop bonus; it can never mis-rank.
 */
function deriveRepoRoot(input: ReproInput): string | null {
  const frames: StackFrame[] = input.crash.error?.stack ?? [];
  for (const frame of frames) {
    if (!frame.file || !frame.fileRelative) {
      continue;
    }
    const abs = frame.file.replace(/\\/g, '/');
    const rel = normalizePath(frame.fileRelative);
    if (rel.length > 0 && abs.length > rel.length + 1 && abs.endsWith(`/${rel}`)) {
      return abs.slice(0, abs.length - rel.length - 1);
    }
  }
  return input.context.env.cwd || null;
}
