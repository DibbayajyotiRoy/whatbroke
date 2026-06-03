/** `whatbroke show <bundle-id|path>` — re-render a saved bundle as Markdown (07). */
import { renderMarkdown } from '../render/markdown.js';
import { resolveStorePaths } from '../paths.js';
import { BundleStore } from '../mcp/store.js';
import { loadBundle } from './load.js';
import { makeLogger, type Verbosity } from '../util/log.js';

export interface ShowArgs {
  ref?: string;
  cwd: string;
  out?: string;
  verbosity: Verbosity;
}

export async function showCmd(args: ShowArgs): Promise<number> {
  const log = makeLogger(args.verbosity);
  const store = resolveStorePaths(args.cwd, args.out);

  let ref = args.ref;
  if (!ref) {
    const latest = await new BundleStore(store.bundlesDir).latestId();
    if (!latest) {
      log.error('whatbroke show: no bundles found in ' + store.bundlesDir);
      return 1;
    }
    ref = latest;
  }

  const bundle = await loadBundle(ref, store.bundlesDir);
  if (!bundle) {
    log.error(`whatbroke show: bundle not found: ${ref}`);
    return 1;
  }
  process.stdout.write(renderMarkdown(bundle) + '\n');
  return 0;
}
