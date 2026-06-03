/** `whatbroke journal [--list|--clear]` — inspect/clear the green-commit journal (07). */
import { resolveStorePaths } from '../paths.js';
import { openJournal } from '../journal/journal.js';
import { makeLogger, type Verbosity } from '../util/log.js';

export interface JournalArgs {
  cwd: string;
  action: 'list' | 'clear';
  verbosity: Verbosity;
}

export async function journalCmd(args: JournalArgs): Promise<number> {
  const log = makeLogger(args.verbosity);
  const store = resolveStorePaths(args.cwd);
  const journal = await openJournal(store.journal);

  if (args.action === 'clear') {
    await journal.clear();
    log.info('whatbroke: journal cleared.');
    return 0;
  }

  const entries = journal.list();
  if (entries.length === 0) {
    log.info('whatbroke: journal is empty.');
    return 0;
  }
  log.info(`whatbroke: ${entries.length} green entr${entries.length === 1 ? 'y' : 'ies'}:`);
  for (const { fingerprint, entry } of entries) {
    log.info(
      `  ${fingerprint}  green=${entry.greenSha.slice(0, 7)}  at=${entry.greenAt}  runs=${entry.runCount}`,
    );
  }
  return 0;
}
