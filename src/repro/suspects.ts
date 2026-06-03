import type { ReproInput, SuspectFile, StackFrame } from '../types.js';
import { changedSinceGreen, normalizePath } from './changed.js';

/**
 * Deterministic suspect-file ranking — the moat. NO LLM.
 *
 * Scores candidate files from two observed inputs:
 *   - the parsed stack trace (`input.crash.error?.stack`), whose
 *     `fileRelative` / `isInRepo` / `isUserCode` flags are populated by
 *     integration before we run, and
 *   - the set of files changed since the last green run
 *     (`input.context.git.changedFiles`, paths repo-relative).
 *
 * The marquee signal is the intersection: a file that is BOTH on the failure
 * path AND something you just touched. Everything is correlation-based and
 * lives in `suspects[]` (heuristic), never in the deterministic steps.
 */

// Scoring weights (from the spec table). Named constants so they stay tunable
// against the eval set.
const WEIGHT_STACK_AND_CHANGED = 5; // on stack AND changed since green
const WEIGHT_TOP_FRAME = 3; // first user-code frame
const WEIGHT_FRAME_DECAY_STEP = 1; // decay per subsequent user frame: 3, 2, 1, ...
const WEIGHT_FRAME_FLOOR = 1; // user frames never score below this
const WEIGHT_CHANGED_ONLY = 1; // changed since green, not on stack
const WEIGHT_NODE_MODULES_FRAME = 0.5; // on stack but inside node_modules

// SCOPE-CHECK: import-graph hop ("changed since green, imported by a stack file",
// +2) is OPTIONAL / post-v1 and is intentionally NOT implemented here. It needs
// lightweight import parsing; ship the intersection signal first.

const MAX_SUSPECTS = 5;

interface Candidate {
  path: string;
  score: number;
  reasons: string[];
}

export function rankSuspects(input: ReproInput): SuspectFile[] {
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
  let userFrameOrdinal = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame || !frame.fileRelative) {
      continue;
    }
    const path = normalizePath(frame.fileRelative);

    if (frame.isUserCode) {
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
    } else {
      c.score += WEIGHT_CHANGED_ONLY;
      c.reasons.push(label);
    }
  }

  const candidates = [...byPath.values()];
  if (candidates.length === 0) {
    return [];
  }

  candidates.sort((a, b) => {
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
