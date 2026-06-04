/**
 * Language adapter seam (v0.2).
 *
 * An adapter owns *interpretation* for one ecosystem: parsing an error block out
 * of stderr, classifying how the process died, and collecting env/deps/test
 * context. The capture supervisor (`runCommand`) stays language-neutral — it just
 * watches any child process — and the downstream moat (suspect ranking),
 * redaction, MCP, and sinks consume the adapter's output unchanged.
 *
 * Adding a language should mean adding a small declarative grammar (see
 * `grammar.ts` + `declarative.ts`), not writing a new adapter by hand.
 */
import type {
  CommandSpec,
  CrashSignal,
  DepInfo,
  EnvInfo,
  ErrorInfo,
  LogBuffer,
  StackFrame,
  TestFailure,
} from '../types.js';

/** Cheaply-gathered signals used to pick an adapter for a run. */
export interface DetectionContext {
  /** The wrapped command: argv + cwd. */
  command: CommandSpec;
  /** Basenames of entries in cwd (lockfiles, manifests, configs). */
  cwdEntries: string[];
  /** Distinct source-file extensions seen in cwd (e.g. '.py', '.go'). */
  fileExtensions: Set<string>;
  /** Captured stderr tail (the strongest signal — `Traceback`, `panic:`). */
  stderrText: string;
  /** Captured stdout tail. */
  stdoutText: string;
}

/** Arguments handed to an adapter's `classify`, with the error already parsed. */
export interface ClassifyInput {
  exitCode: number | null;
  signal: string | null;
  stderrText: string;
  error: ErrorInfo | null;
}

/** The per-ecosystem collectors an adapter provides. */
export interface AdapterCollectors {
  collectEnv(cwd: string): Promise<EnvInfo>;
  collectDeps(cwd: string, frames: StackFrame[]): Promise<DepInfo>;
  parseTestFailure(logs: LogBuffer): TestFailure | null;
}

export interface LanguageAdapter {
  /** Stable id; also becomes `Bundle.language` and `EnvInfo.runtime.name`. */
  readonly id: string;

  /**
   * Confidence in [0,1] that this adapter should own the run. The registry
   * selects the highest scorer above a threshold; ties break by registration
   * order. Return 0 to decline.
   */
  detect(ctx: DetectionContext): number;

  /** Parse an error/exception block out of raw stderr, or null if none found. */
  parseError(stderrText: string): ErrorInfo | null;

  /** Classify how the process died; null means a green (exit 0) run. */
  classify(input: ClassifyInput): CrashSignal | null;

  collectEnv(cwd: string): Promise<EnvInfo>;
  collectDeps(cwd: string, frames: StackFrame[]): Promise<DepInfo>;
  parseTestFailure(logs: LogBuffer): TestFailure | null;
}
