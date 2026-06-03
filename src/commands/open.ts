/** `whatbroke open <bundle-id|path> [--github [repo]]` — send a saved bundle to a sink (07). */
import { renderMarkdown } from '../render/markdown.js';
import { createGithubSink } from '../sinks/github.js';
import { resolveStorePaths } from '../paths.js';
import { BundleStore } from '../mcp/store.js';
import { loadBundle } from './load.js';
import { makeLogger, type Verbosity } from '../util/log.js';

export interface OpenArgs {
  ref?: string;
  cwd: string;
  out?: string;
  github?: { repo?: string };
  verbosity: Verbosity;
}

export async function openCmd(args: OpenArgs): Promise<number> {
  const log = makeLogger(args.verbosity);
  const store = resolveStorePaths(args.cwd, args.out);

  let ref = args.ref;
  if (!ref) {
    const latest = await new BundleStore(store.bundlesDir).latestId();
    if (!latest) {
      log.error('whatbroke open: no bundles found in ' + store.bundlesDir);
      return 1;
    }
    ref = latest;
  }

  const bundle = await loadBundle(ref, store.bundlesDir);
  if (!bundle) {
    log.error(`whatbroke open: bundle not found: ${ref}`);
    return 1;
  }

  if (!args.github) {
    log.error('whatbroke open: specify a sink (currently: --github [owner/repo])');
    return USAGE_OPEN;
  }

  const ghOpts: { repo?: string; cwd: string; render: typeof renderMarkdown } = {
    cwd: args.cwd,
    render: renderMarkdown,
  };
  if (args.github.repo) ghOpts.repo = args.github.repo;
  const result = await createGithubSink(ghOpts)(bundle);

  if (result.ok) {
    log.info(result.url ? `→ ${result.url}` : `→ ${result.message}`);
    return 0;
  }
  log.error(`whatbroke open: ${result.message}`);
  return 1;
}

const USAGE_OPEN = 64;
