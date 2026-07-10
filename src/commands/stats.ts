/**
 * `whatbroke stats` (roadmap 3.2): local suspect-ranking hit-rate over
 * resolved bundles — the user's own evidence for the README claim. Read from
 * .whatbroke/index.json; nothing leaves the machine.
 */
import { HistoryIndex, historyPath } from '../history/history.js';
import { resolveStorePaths } from '../paths.js';
import { makeLogger, type Verbosity } from '../util/log.js';

export interface StatsArgs {
  cwd: string;
  verbosity: Verbosity;
}

export interface StatsSummary {
  resolved: number;
  top1Hits: number;
  top3Hits: number;
}

/** Pure aggregation, exported for tests. */
export function summarizeStats(entries: Record<string, { resolved?: { top1Hit: boolean; top3Hit: boolean } }>): StatsSummary {
  let resolved = 0;
  let top1Hits = 0;
  let top3Hits = 0;
  for (const entry of Object.values(entries)) {
    if (!entry.resolved) continue;
    resolved += 1;
    if (entry.resolved.top1Hit) top1Hits += 1;
    if (entry.resolved.top3Hit) top3Hits += 1;
  }
  return { resolved, top1Hits, top3Hits };
}

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);

export async function statsCmd(args: StatsArgs): Promise<number> {
  const log = makeLogger(args.verbosity);
  const s = log.style;
  const storePaths = resolveStorePaths(args.cwd);
  const history = await HistoryIndex.open(historyPath(storePaths.dir));
  const { resolved, top1Hits, top3Hits } = summarizeStats(history.entries());

  if (resolved === 0) {
    log.line(
      'whatbroke stats: no resolved bundles yet. Fix a crash and run ' +
        `'whatbroke verify' — every verified fix scores the ranking here.`,
    );
    return 0;
  }

  log.line(`${s.bold('suspect ranking, verified locally')} (${resolved} resolved crash${resolved === 1 ? '' : 'es'})`);
  log.line(`  top-1 hit-rate  ${s.cyan(`${top1Hits}/${resolved}`)}  ${s.dim(pct(top1Hits, resolved))}`);
  log.line(`  top-3 hit-rate  ${s.cyan(`${top3Hits}/${resolved}`)}  ${s.dim(pct(top3Hits, resolved))}`);
  return 0;
}
