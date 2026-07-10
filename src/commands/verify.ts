/**
 * `whatbroke verify [bundle-id]` (roadmap 1.1) — re-run the bundle's captured
 * command and report pass/fail against it: `✓ fixed` on green, a crash-delta
 * report (same / related / different failure) otherwise.
 */
import { verifyBundle, VerifyError } from '../verify/verify.js';
import { makeLogger, type Verbosity } from '../util/log.js';

export interface VerifyArgs {
  cwd: string;
  id?: string;
  out?: string;
  timeoutMs?: number;
  verbosity: Verbosity;
}

/** Typed verify errors exit with 66 (EX_NOINPUT-ish): not the child's failure. */
export const VERIFY_ERROR_EXIT = 66;

export async function verifyCmd(args: VerifyArgs): Promise<number> {
  const log = makeLogger(args.verbosity);
  const s = log.style;

  let outcome;
  try {
    const opts: Parameters<typeof verifyBundle>[0] = { projectCwd: args.cwd };
    if (args.id !== undefined) opts.id = args.id;
    if (args.out !== undefined) opts.out = args.out;
    if (args.timeoutMs !== undefined) opts.timeoutMs = args.timeoutMs;
    outcome = await verifyBundle(opts);
  } catch (err) {
    if (err instanceof VerifyError) {
      log.error(`whatbroke verify: ${err.message} [${err.kind}]`);
      return VERIFY_ERROR_EXIT;
    }
    throw err;
  }

  if (outcome.status === 'fixed') {
    const commit = outcome.resolvedCommit
      ? s.dim(` (resolved by ${outcome.resolvedCommit.slice(0, 7)})`)
      : '';
    log.line(`${s.green('✓ fixed')} · bundle ${s.cyan(outcome.bundleId)}${commit}`);
    return 0;
  }

  const head =
    outcome.status === 'same-failure'
      ? s.red('✕ same failure')
      : s.yellow('✕ different failure');
  log.line(`${head} · bundle ${s.cyan(outcome.bundleId)}`);
  for (const reason of outcome.delta?.reasons ?? []) {
    log.line(s.dim(`  · ${reason}`));
  }
  if (outcome.newBundleId) {
    log.line(`  new bundle ${s.cyan(outcome.newBundleId)} — whatbroke show ${outcome.newBundleId}`);
  }
  return outcome.exitCode || 1;
}
