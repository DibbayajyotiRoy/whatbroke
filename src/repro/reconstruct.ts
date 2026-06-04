import type {
  ReproInput,
  ReproInfo,
  ReproStep,
  StackFrame,
} from '../types.js';
import { rankSuspects } from './suspects.js';
import { computeConfidence } from './confidence.js';
import { isWhatbrokeArtifact } from './changed.js';

/**
 * Deterministic assembly of observed facts into a `ReproInfo`. NO LLM — this is
 * the moat. Steps are produced in a fixed order (see spec 05); any step whose
 * inputs are absent is omitted. Each step is one copy-paste-legible line and
 * carries its provenance tier:
 *
 *   1. Starting state          (observed)
 *   2. Setup deltas vs green   (derived)   — only with a greenRef
 *   3. Environment notes       (observed)  — only the differentiators
 *   4. The action              (observed)
 *   5. Observed result         (observed)
 *   6. Where (first app frame) (derived)
 *
 * `narration` is left unset (off by default). Suspects are heuristic and live
 * in `suspects[]`, never in `steps[]`.
 */

// Cap on the number of changed-file paths we enumerate in step 2.
const CHANGED_FILES_CAP = 15;

// Dependency manifest / lockfiles whose changes are worth calling out.
const DEP_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
]);

function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) {
    out = out.slice(2);
  }
  return out;
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

export function reconstruct(input: ReproInput): ReproInfo {
  const steps: ReproStep[] = [];
  const push = (text: string, provenance: ReproStep['provenance']): void => {
    steps.push({ order: steps.length + 1, text, provenance });
  };

  const { crash, context, command } = input;
  const git = context.git;

  // Exclude whatbroke's own footprint from the user-facing changed-file accounting.
  const changedFiles = git.changedFiles.filter(
    (cf) => !isWhatbrokeArtifact(normalizePath(cf.path)),
  );

  // ── 1. Starting state (observed) ────────────────────────────────────────
  if (git.isRepo && git.head) {
    const branch = git.branch ?? 'DETACHED';
    const head = git.head.slice(0, 7);
    const state =
      changedFiles.length > 0 ? `dirty: ${changedFiles.length} files` : 'clean';
    push(`On branch \`${branch}\` at \`${head}\` (${state}).`, 'observed');
  }

  // ── 2. Setup deltas vs last green (derived) ─────────────────────────────
  if (git.greenRef) {
    const greenShort = git.greenRef.slice(0, 7);
    const changed = changedFiles;
    const depChanges = changed.filter((cf) =>
      DEP_FILES.has(basename(cf.path)),
    );

    let summary = `Since last passing run (\`${greenShort}\`): ${changed.length} file${
      changed.length === 1 ? '' : 's'
    } changed`;
    if (depChanges.length > 0) {
      summary += `, ${depChanges.length} dependency/lockfile change${
        depChanges.length === 1 ? '' : 's'
      }`;
    }
    summary += '.';
    push(summary, 'derived');

    if (changed.length > 0) {
      const paths = changed.map((cf) => normalizePath(cf.path));
      const shown = paths.slice(0, CHANGED_FILES_CAP);
      let list = `Changed: ${shown.join(', ')}`;
      if (paths.length > shown.length) {
        list += ` (+${paths.length - shown.length} more)`;
      }
      list += '.';
      push(list, 'derived');
    }

    if (depChanges.length > 0) {
      const depNames = depChanges.map((cf) => basename(cf.path));
      push(
        `Dependency manifest/lockfile changed: ${depNames.join(', ')} — possible dependency drift.`,
        'derived',
      );
    }
  }

  // ── 3. Environment notes (observed) ─────────────────────────────────────
  const env = context.env;
  const notes: string[] = [];
  if (env.runtime.name && env.runtime.version) {
    const label = env.runtime.name === 'node' ? 'Node' : env.runtime.name;
    notes.push(`${label} ${env.runtime.version}`);
  } else if (env.runtime.node) {
    notes.push(`Node ${env.runtime.node}`);
  }
  if (env.packageManager.name !== 'unknown') {
    const pm = env.packageManager.version
      ? `${env.packageManager.name} ${env.packageManager.version}`
      : env.packageManager.name;
    notes.push(pm);
  }
  if (env.os.platform) {
    const arch = env.os.arch ? `/${env.os.arch}` : '';
    notes.push(`${env.os.platform}${arch}`);
  }
  if (notes.length > 0) {
    push(`Environment: ${notes.join(', ')}.`, 'observed');
  }

  // ── 4. The action (observed) ────────────────────────────────────────────
  if (command.argv.length > 0) {
    const cmd = command.argv.join(' ');
    const relCwd = relativeCwd(command.cwd, git.isRepo ? git.head : null, context);
    push(`Run: \`${cmd}\` (cwd: \`${relCwd}\`).`, 'observed');
  }

  // ── 5. Observed result (observed) ───────────────────────────────────────
  const resultText = describeResult(input);
  if (resultText) {
    push(resultText, 'observed');
  }

  // ── 6. Where — first user-code frame (derived) ──────────────────────────
  const firstAppFrame = firstUserFrame(crash.error?.stack ?? []);
  if (firstAppFrame && firstAppFrame.fileRelative) {
    const loc = firstAppFrame.line != null ? `:${firstAppFrame.line}` : '';
    push(
      `First app frame: \`${normalizePath(firstAppFrame.fileRelative)}${loc}\`.`,
      'derived',
    );
  }

  return {
    steps,
    suspects: rankSuspects(input),
    confidence: computeConfidence(input),
  };
}

/**
 * A relative, legible cwd: '.' when the command ran at the git root, otherwise
 * the basename. We keep this simple and relative rather than leaking absolute
 * paths into the steps.
 */
function relativeCwd(
  cwd: string,
  _head: string | null,
  context: ReproInput['context'],
): string {
  // env.cwd is the recorded process cwd; if the command cwd equals the repo
  // root we collapse to '.'. We don't have the git root path directly, so use
  // the heuristic: when command cwd === env.cwd, the command ran at the
  // process root we observed — show '.' to avoid an absolute path.
  if (cwd === context.env.cwd) {
    return '.';
  }
  return basename(cwd) || '.';
}

function describeResult(input: ReproInput): string | null {
  const { crash, context } = input;

  // Prefer a parsed error name + message when present.
  if (crash.error) {
    const name = crash.error.name || 'Error';
    const message = crash.error.message ? `: ${crash.error.message}` : '';
    return `${name}${message}`;
  }

  // Test failure summary.
  const tf = context.testFailure;
  if (tf && (tf.failed != null || tf.failingTests.length > 0)) {
    const failed = tf.failed ?? tf.failingTests.length;
    const total = tf.total ?? failed;
    const ids = tf.failingTests.map((t) => t.id).join(', ');
    const idPart = ids ? `: ${ids}` : '';
    return `${failed} of ${total} tests failed${idPart}.`;
  }

  // Signal crash.
  if (crash.kind === 'signal' && crash.signal) {
    return `Terminated by signal ${crash.signal}.`;
  }

  // Bare nonzero exit.
  if (crash.exitCode != null && crash.exitCode !== 0) {
    return `Exited with code ${crash.exitCode}.`;
  }

  return null;
}

function firstUserFrame(frames: StackFrame[]): StackFrame | null {
  for (const frame of frames) {
    if (frame.isUserCode && frame.fileRelative) {
      return frame;
    }
  }
  return null;
}
