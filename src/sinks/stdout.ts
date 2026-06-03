/**
 * Stdout-markdown sink (07, `--md`): print the rendered Markdown so the dev can
 * pipe or copy it immediately.
 *
 * The write function is injectable so tests can capture output without touching
 * the real process.stdout. The renderer is injected per the 07 decoupling note.
 */
import type { RedactedBundle, Sink, SinkResult } from '../types.js';

export interface StdoutMarkdownSinkOptions {
  /** Injected Markdown renderer (pure: RedactedBundle -> string). */
  render: (b: RedactedBundle) => string;
  /** Output writer; defaults to writing to process.stdout. */
  write?: (s: string) => void;
}

export function createStdoutMarkdownSink(
  opts: StdoutMarkdownSinkOptions,
): Sink {
  const { render } = opts;
  const write = opts.write ?? ((s: string) => void process.stdout.write(s));

  return async function stdoutMarkdownSink(
    bundle: RedactedBundle,
  ): Promise<SinkResult> {
    write(render(bundle));
    return {
      sink: 'stdout',
      ok: true,
      message: 'rendered to stdout',
    };
  };
}
