/**
 * Config resolution (07). Order of precedence: CLI flag > project config >
 * user config > defaults. Config is additive to safe defaults: it can tighten
 * redaction (add allow/deny) but a documented invariant is that it can never
 * disable the redaction gate (06) — there is simply no field to do so.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { debugError } from './util/debug.js';

export interface WhatbrokeConfig {
  logLines: number;
  out: string;
  defaultSink: 'file';
  redaction: { allowEnv: string[]; denyPatterns: string[]; entropy: boolean };
  explain: { enabled: boolean; provider?: string };
}

export const DEFAULT_CONFIG: WhatbrokeConfig = {
  logLines: 500,
  out: './.whatbroke/bundles',
  defaultSink: 'file',
  redaction: { allowEnv: [], denyPatterns: [], entropy: true },
  explain: { enabled: false },
};

type PartialConfig = Partial<{
  logLines: number;
  out: string;
  defaultSink: 'file';
  redaction: Partial<WhatbrokeConfig['redaction']>;
  explain: Partial<WhatbrokeConfig['explain']>;
}>;

const PROJECT_FILES = ['whatbroke.config.js', 'whatbroke.config.json', '.whatbrokerc'];

async function readConfigFile(file: string): Promise<PartialConfig | null> {
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  try {
    if (file.endsWith('.js') || file.endsWith('.mjs')) {
      const mod = (await import(pathToFileURL(file).href)) as {
        default?: PartialConfig;
      };
      return mod.default ?? null;
    }
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as PartialConfig;
  } catch (err) {
    // A malformed config should not crash a run; fall back to defaults.
    debugError(`config: failed to load ${file}`, err);
    return null;
  }
}

async function loadFrom(dir: string): Promise<PartialConfig | null> {
  for (const name of PROJECT_FILES) {
    const found = await readConfigFile(path.join(dir, name));
    if (found) return found;
  }
  return null;
}

/** Load + merge user config (~) then project config (cwd) over the defaults. */
export async function loadConfig(cwd: string): Promise<WhatbrokeConfig> {
  const user = await loadFrom(os.homedir());
  const project = await loadFrom(cwd);
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, user), project);
}

function mergeConfig(base: WhatbrokeConfig, over: PartialConfig | null): WhatbrokeConfig {
  if (!over) return base;
  return {
    logLines: over.logLines ?? base.logLines,
    out: over.out ?? base.out,
    defaultSink: over.defaultSink ?? base.defaultSink,
    redaction: {
      allowEnv: over.redaction?.allowEnv ?? base.redaction.allowEnv,
      denyPatterns: over.redaction?.denyPatterns ?? base.redaction.denyPatterns,
      entropy: over.redaction?.entropy ?? base.redaction.entropy,
    },
    explain: {
      enabled: over.explain?.enabled ?? base.explain.enabled,
      provider: over.explain?.provider ?? base.explain.provider,
    },
  };
}

/** CLI flags that override the resolved file config. */
export interface CliOverrides {
  logLines?: number;
  out?: string;
  explain?: boolean;
}

export function applyCliOverrides(
  config: WhatbrokeConfig,
  cli: CliOverrides,
): WhatbrokeConfig {
  return {
    ...config,
    logLines: cli.logLines ?? config.logLines,
    out: cli.out ?? config.out,
    explain: { ...config.explain, enabled: cli.explain ?? config.explain.enabled },
  };
}
