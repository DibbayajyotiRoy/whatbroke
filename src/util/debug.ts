/**
 * Internal diagnostics for debugging whatbroke ITSELF.
 *
 * whatbroke degrades gracefully on internal failure (collectors never crash the
 * pipeline, redaction fails closed, configs fall back to defaults). That keeps
 * the tool robust — but it also means a bug in whatbroke can hide behind a silent
 * fallback. `WHATBROKE_DEBUG=1` turns every such swallowed error into a stderr
 * breadcrumb with its stack, so we can diagnose and fix the package.
 *
 * This is opt-in and goes to stderr only; it never affects the bundle or the
 * child's output on the happy path.
 */
export function isDebug(): boolean {
  const v = process.env['WHATBROKE_DEBUG'];
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/** Stringify an error with its stack when available. */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * Record an internally-swallowed error. No-op unless WHATBROKE_DEBUG is set, so
 * it is safe to sprinkle into graceful-degradation catch blocks.
 */
export function debugError(scope: string, err: unknown): void {
  if (!isDebug()) return;
  process.stderr.write(`whatbroke[debug] ${scope}: ${errorDetail(err)}\n`);
}
