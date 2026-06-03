import type { ReproInput, Confidence, StackFrame } from '../types.js';
import { changedSinceGreen, normalizePath } from './changed.js';

/**
 * Deterministic confidence rating for the reconstructed repro.
 *
 *   - `high`:   the (stack-trace files ∩ changed-since-green) intersection is
 *               non-empty — you changed code that is on the failure path.
 *   - `medium`: there is a green ref AND a user-code frame, but no intersection.
 *   - `low`:    no green ref, OR no user-code frame, OR not a git repo.
 *
 * Uses the SAME changed-set derivation as `rankSuspects` so the two can never
 * disagree about the marquee intersection.
 */
export function computeConfidence(input: ReproInput): Confidence {
  const frames: StackFrame[] = input.crash.error?.stack ?? [];
  const { files: changed, hasGreen } = changedSinceGreen(input.context.git);

  const userFramePaths = new Set<string>();
  for (const frame of frames) {
    if (frame.isUserCode && frame.fileRelative) {
      userFramePaths.add(normalizePath(frame.fileRelative));
    }
  }
  const hasUserFrame = userFramePaths.size > 0;

  // Intersection of user-code stack files with changed-since-green files.
  let intersects = false;
  if (hasGreen) {
    for (const path of changed) {
      if (userFramePaths.has(path)) {
        intersects = true;
        break;
      }
    }
  }

  if (intersects) {
    return 'high';
  }
  if (hasGreen && hasUserFrame) {
    return 'medium';
  }
  return 'low';
}
