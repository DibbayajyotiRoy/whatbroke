/**
 * File sink (07): the default output target.
 *
 * Writes the bundle as pretty-printed JSON and the rendered Markdown to the
 * configured bundles directory (created if absent). All I/O lives inside the
 * returned Sink so the factory itself is side-effect free.
 *
 * The Markdown renderer is injected (see 07 decoupling note) so this module
 * never depends on the renderer's source.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RedactedBundle, Sink, SinkResult } from '../types.js';

export interface FileSinkOptions {
  /** Directory bundles are written to; created with mkdir -p if missing. */
  bundlesDir: string;
  /** Injected Markdown renderer (pure: RedactedBundle -> string). */
  render: (b: RedactedBundle) => string;
}

export function createFileSink(opts: FileSinkOptions): Sink {
  const { bundlesDir, render } = opts;

  return async function fileSink(bundle: RedactedBundle): Promise<SinkResult> {
    const jsonPath = join(bundlesDir, `whatbroke-${bundle.id}.json`);
    const mdPath = join(bundlesDir, `whatbroke-${bundle.id}.md`);

    await mkdir(bundlesDir, { recursive: true });
    await writeFile(jsonPath, JSON.stringify(bundle, null, 2), 'utf8');
    await writeFile(mdPath, render(bundle), 'utf8');

    return {
      sink: 'file',
      ok: true,
      message: `wrote ${jsonPath} and ${mdPath}`,
      paths: [jsonPath, mdPath],
    };
  };
}
