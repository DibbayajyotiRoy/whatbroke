/**
 * Authoritative type model for whatbroke.
 *
 * Spec: 02-bundle-schema.md is the source of truth. This file mirrors it exactly and
 * adds the internal pipeline types (CrashSignal, LogBuffer, RawContext, ...) that flow
 * between stages but never appear on disk.
 *
 * The pipeline is:
 *   Capture   → CrashSignal + LogBuffer
 *   Collectors→ RawContext  (env, deps, git, testFailure)
 *   Repro     → ReproInfo
 *   Assemble  → Bundle       (in memory, pre-gate)
 *   Redact    → RedactedBundle (the ONLY producer of the brand)
 *   Sinks/Readers consume RedactedBundle only.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Bundle schema (02) — authoritative, persisted to disk
// ─────────────────────────────────────────────────────────────────────────────

/** Branding: a RedactedBundle can ONLY be produced by the redaction gate (06). */
export declare const __redacted: unique symbol;
export type Redacted = { readonly [__redacted]: true };

export interface Bundle {
  schemaVersion: 1;
  id: string; // short id, stable per crash
  createdAt: string; // ISO-8601
  tool: { name: string; version: string };

  /**
   * The language/ecosystem adapter that interpreted this crash ('node',
   * 'python', 'go', ... or 'unknown'). Additive in v0.2; older bundles omit it.
   */
  language: string;

  crash: CrashInfo;
  environment: EnvInfo;
  dependencies: DepInfo;
  git: GitInfo;
  logs: LogInfo;
  repro: ReproInfo; // from 05
  redaction: RedactionReport; // filled by 06; empty pre-gate

  /**
   * The verbatim captured command + cwd, so `verify` (1.1) can re-run exactly
   * what crashed — never anything a caller supplies (ADR-0002). Additive;
   * bundles from before v0.3 omit it. argv elements pass the redaction gate.
   */
  command?: { argv: string[]; cwd: string };

  /** Set by `verify` when this crash was re-run green (1.1 AC3). */
  resolution?: { status: 'resolved'; at: string; commit: string };

  /**
   * Crash-history match (3.1): this failure's fingerprint was seen before.
   * Derived locally from .whatbroke/index.json; never leaves the machine.
   */
  history?: HistoryMatch;

  /** Non-fatal collector failures (04). Never throws the pipeline. */
  collectorErrors: CollectorError[];
}

/** A prior occurrence of the same crash fingerprint (3.1). */
export interface HistoryMatch {
  fingerprint: string;
  matchedBundleId: string;
  matchedAt: string; // ISO-8601 createdAt of the matched bundle
  occurrences: number;
  resolvedBy?: { commit: string; filesTouched: string[] };
  flaky?: boolean;
  provenance: 'derived';
}

/** A Bundle that has passed the redaction gate (06). Sinks/readers accept only this. */
export type RedactedBundle = Bundle & Redacted;

export type CrashKind =
  | 'nonzero-exit'
  | 'uncaught-exception'
  | 'unhandled-rejection'
  | 'signal';

export interface CrashInfo {
  kind: CrashKind;
  exitCode: number | null;
  signal: string | null; // e.g. 'SIGSEGV'
  error?: ErrorInfo;
  testFailure?: TestFailure; // present if a known runner was detected (04/05)
}

export interface ErrorInfo {
  name: string;
  message: string;
  stack: StackFrame[]; // parsed
  rawStack: string; // original, redacted post-gate
}

export interface StackFrame {
  functionName: string | null;
  file: string | null; // absolute path
  fileRelative: string | null; // relative to repo root if inside repo
  line: number | null;
  column: number | null;
  isUserCode: boolean; // false if inside node_modules / node internals
  isInRepo: boolean;
  sourceMapped: boolean; // true if resolved through a .map (v1.5)
}

/**
 * Known test runners, kept as literals for autocomplete, but open to any string
 * so language adapters (pytest, go-test, cargo-test, ...) can register their own
 * without a type change. The `(string & {})` member preserves the literal hints.
 */
export type TestRunner =
  | 'jest'
  | 'vitest'
  | 'mocha'
  | 'node:test'
  | 'playwright'
  | 'pytest'
  | 'go-test'
  | 'cargo-test'
  | 'rspec'
  | 'junit'
  | 'unknown'
  | (string & {});

export interface TestFailure {
  runner: TestRunner;
  failingTests: { id: string; file: string | null; message?: string }[];
  total?: number;
  failed?: number;
  passed?: number;
}

export interface EnvInfo {
  os: { platform: string; release: string; arch: string };
  runtime: {
    /** Runtime identity: 'node' | 'python' | 'go' | ... */
    name: string;
    /** Runtime version, or '' when undetectable. */
    version: string;
    /** Extra ecosystem details (e.g. { v8 }, { goos, goarch }). */
    details?: Record<string, string>;
    /** @deprecated prefer name/version; retained so Node bundles/tests keep `runtime.node`. */
    node?: string;
    /** @deprecated prefer details.v8. */
    v8?: string;
  };
  packageManager: {
    name: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
    version: string | null;
  };
  // env var KEYS only by default; values redacted unless explicitly allowlisted (06)
  envKeys: string[];
  envValues: Record<string, string>; // post-redaction only (allowlisted keys)
  cwd: string;
}

export interface DepInfo {
  declared: Record<string, string>; // from package.json deps+devDeps
  // resolved versions of packages that appear in the stack trace (high signal)
  relevantResolved: Record<string, string>;
  lockfile:
    | 'package-lock'
    | 'pnpm-lock'
    | 'yarn.lock'
    | 'bun.lockb'
    | 'requirements'
    | 'pipfile'
    | 'poetry'
    | 'go.sum'
    | 'none'
    | (string & {});
  /** Manifest file that declared the deps, when known (package.json, go.mod, ...). */
  manifest?: string;
}

export interface ChangedFile {
  path: string;
  status: string; // porcelain status code(s)
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  head: string | null; // sha
  dirty: boolean;
  changedFiles: ChangedFile[]; // porcelain
  greenRef: string | null; // last known-good sha for this command (04)
  greenRefSource?: 'journal' | 'merge-base' | 'head~1' | 'none';
  diffVsGreen?: {
    base: string;
    truncated: boolean;
    patch: string; // redacted post-gate
  };
  /** Why git info is incomplete, if applicable (e.g. "not a git repository"). */
  note?: string;
}

export interface LogInfo {
  stdoutTail: string; // redacted, ring-buffer last N
  stderrTail: string; // redacted
  combinedTail?: string; // interleaved, optional
  truncated: boolean;
  bufferLines: number;
}

export type Provenance = 'observed' | 'derived' | 'heuristic';
export type Confidence = 'high' | 'medium' | 'low';

export interface ReproInfo {
  steps: ReproStep[]; // ordered, deterministic
  suspects: SuspectFile[]; // ranked
  confidence: Confidence;
  narration?: string; // OPTIONAL LLM output; absent by default
}

export interface ReproStep {
  order: number;
  text: string; // human-readable
  provenance: Provenance;
}

export interface SuspectFile {
  path: string;
  score: number;
  reasons: string[];
}

export interface RedactionReport {
  redactedCount: number;
  rules: { rule: string; hits: number }[]; // which detectors fired, never the value
}

export interface CollectorError {
  collector: string;
  error: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal pipeline types — flow between stages, never persisted
// ─────────────────────────────────────────────────────────────────────────────

/** Produced by the capture engine (03). Describes how the child died. */
export interface CrashSignal {
  kind: CrashKind;
  exitCode: number | null;
  signal: string | null;
  error?: ErrorInfo; // parsed from stderr banner when present
  /** Raw stderr-derived error block (pre-redaction), if one was found. */
  rawErrorBlock?: string;
}

/** Produced by the capture engine (03). Bounded tails of child output. */
export interface LogBuffer {
  stdoutTail: string;
  stderrTail: string;
  combinedTail: string;
  truncated: boolean;
  bufferLines: number;
}

/** The verbatim target command and where it ran. */
export interface CommandSpec {
  argv: string[]; // e.g. ['npm', 'test']
  cwd: string;
}

/** Produced by the collectors (04). Raw, pre-assembly context. */
export interface RawContext {
  env: EnvInfo;
  deps: DepInfo;
  git: GitInfo;
  testFailure?: TestFailure;
  collectorErrors: CollectorError[];
}

/** Input to the repro reconstructor (05). */
export interface ReproInput {
  crash: CrashSignal;
  context: RawContext;
  command: CommandSpec;
}

/** Options for the capture engine (03). */
export interface RunOptions {
  /** Ring-buffer size per stream, in lines. Default 500. */
  logLines?: number;
  /** Kill the child and treat as a signal crash after this many ms. */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/** Result of supervising the child (03). crash === null means a green (exit 0) run. */
export interface CaptureResult {
  exitCode: number | null;
  signal: string | null;
  crash: CrashSignal | null;
  logs: LogBuffer;
  /** True when the signal termination was our own timeout kill (03). */
  timedOut?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// DiffProvider seam (04) — git impl ships in v1; diffcore is a future swap
// ─────────────────────────────────────────────────────────────────────────────

export interface DiffOptions {
  cwd: string;
  /** Truncate patches larger than this many bytes. */
  maxBytes?: number;
}

export interface DiffResult {
  patch: string;
  truncated: boolean;
}

export interface DiffProvider {
  /** Unified diff from baseRef to the current working tree (includes uncommitted). */
  diff(baseRef: string, opts: DiffOptions): Promise<DiffResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redaction options (06) — passed into redact(); config-derived, never disables gate
// ─────────────────────────────────────────────────────────────────────────────

export interface RedactOptions {
  /** Env var keys whose VALUES are safe to include in envValues. */
  allowEnv?: string[];
  /** Extra regex source strings to redact (config can only ADD redaction). */
  denyPatterns?: string[];
  /** Enable the high-entropy pass (last, lower precision). Default true. */
  entropy?: boolean;
  /** The env snapshot to scrub from text (defaults to process.env at call time). */
  env?: Record<string, string | undefined>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sinks (07)
// ─────────────────────────────────────────────────────────────────────────────

export interface SinkResult {
  sink: string;
  ok: boolean;
  /** Human-readable outcome (paths written, issue URL, etc.). */
  message: string;
  paths?: string[];
  url?: string;
}

export type Sink = (bundle: RedactedBundle) => Promise<SinkResult>;

// ─────────────────────────────────────────────────────────────────────────────
// Journal (04)
// ─────────────────────────────────────────────────────────────────────────────

export interface JournalEntry {
  greenSha: string;
  greenAt: string; // ISO-8601
  runCount: number;
}

export interface JournalFile {
  version: 1;
  entries: Record<string, JournalEntry>; // keyed by fingerprint(argv, branch)
}
