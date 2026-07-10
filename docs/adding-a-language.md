# Adding a language to whatbroke

whatbroke's capture supervisor is language-neutral: it wraps any child process,
records bounded log tails, and classifies how the process died. Everything
language-*specific* — recognizing a stack trace in stderr, naming the error,
mapping frames to files — lives behind one seam: the **language adapter**.

Adding a language does **not** mean writing a parser. You write a ~40-line
declarative **grammar** (pure data: a handful of regexes), wrap it with
`makeDeclarativeAdapter`, register it, and validate it against the conformance
suite. Zero core changes. This document walks through the whole path, using the
`toylang` example that ships (and is executed) in
[`src/adapters/conformance.test.ts`](../src/adapters/conformance.test.ts).

## What a grammar-tier adapter gets you (and what it doesn't)

Be precise about the tiers — whatbroke does not overclaim, and neither should
your README:

| Capability | `node` (imperative adapter) | `python`, `go`, yours (grammar tier) |
| --- | --- | --- |
| Parsed stack frames (file:line:function) from **stderr** | yes (V8 parser + `Error:` banners) | yes (your grammar's regexes) |
| Crash kind (`uncaught-exception`, `nonzero-exit`, `signal`, …) | yes, incl. unhandled-rejection detection | yes (`error` presence + your `crashKinds` overrides) |
| Suspect ranking (stack ∩ changed-since-green) + confidence | yes | yes — the ranker consumes normalized frames, it never knows the language |
| Test-runner failure identity (`crash.testFailure`) | yes (jest, vitest, mocha, node:test, playwright) | **no** — `parseTestFailure` returns `null` unless you supply a collector |
| Dependency resolution (versions of packages on the stack) | yes (package.json + lockfiles) | detection only (`makeGenericDeps` reports which manifest/lockfile exists) |
| Runtime version in `environment.runtime.version` | yes | `''` (unless you supply a `collectEnv`) |
| Source-map resolution | planned (roadmap 5.2) | n/a |

**The stderr caveat (read this twice).** The pipeline hands your grammar
exactly one string to parse: the child's **stderr tail**
(`executePipeline` → `adapter.parseError(logs.stderrTail)`). Crash text that a
tool routes to *stdout* is captured in the bundle's log tails but is **not**
parsed into frames today. Concretely, for the built-ins:

- **python:** any traceback CPython prints to stderr is parsed — `python app.py`
  crashes, crashing worker threads, etc. `pytest`'s own failure report goes to
  stdout, so a plain assertion failure under pytest produces a bundle with
  `language: 'python'`, kind `nonzero-exit`, **no frames**, the report preserved
  in `logs.stdoutTail`, and suspects still ranked from changed-since-green.
- **go:** panics from `go run` / a directly-executed binary land on stderr and
  parse into frames. `go test` **merges the test binary's stderr into its own
  stdout**, so a panicking test yields a bundle with `language: 'go'`, kind
  `nonzero-exit`, no frames, the full panic text in `logs.stdoutTail`, and
  changed-since-green suspects. (Plain `t.Errorf` failures never panic and have
  no parseable trace at all; the go grammar has no test-report parser.)

The executable spec for both statements is
[`src/adapters/e2e/python.e2e.test.ts`](../src/adapters/e2e/python.e2e.test.ts)
and [`src/adapters/e2e/go.e2e.test.ts`](../src/adapters/e2e/go.e2e.test.ts).

## The seam, in three pieces

1. **`LanguageAdapter`** ([`src/adapters/types.ts`](../src/adapters/types.ts)) —
   what the pipeline calls:

   ```ts
   interface LanguageAdapter {
     readonly id: string;                            // becomes Bundle.language
     detect(ctx: DetectionContext): number;          // confidence 0..1
     parseError(stderrText: string): ErrorInfo | null;
     classify(input: ClassifyInput): CrashSignal | null; // null = green run
     collectEnv(cwd: string): Promise<EnvInfo>;
     collectDeps(cwd: string, frames: StackFrame[]): Promise<DepInfo>;
     parseTestFailure(logs: LogBuffer): TestFailure | null;
   }
   ```

2. **`StackGrammar`** ([`src/adapters/grammar.ts`](../src/adapters/grammar.ts)) —
   the pure-data description you actually write (field names are exact):

   ```ts
   interface StackGrammar {
     id: string;                       // adapter id, Bundle.language
     detect: {
       commands?: RegExp[];            // tested against joined argv   (+0.5)
       cwdFiles?: string[];            // manifest/lock basenames in cwd (+0.3)
       extensions?: string[];          // source extensions in cwd      (+0.2)
       stderrMarkers?: RegExp[];       // strongest: markers in stderr  (+0.6)
     };                                // score capped at 1.0
     error: {
       header: RegExp;                 // named groups: name, message
       headerAfterFrames?: boolean;    // true = header trails frames (Python)
       chainSeparator?: RegExp;        // split chained traces; LAST segment wins
     };
     frame: {
       line: RegExp;                   // ONE frame line; named groups:
                                       //   func, file, line, col (all optional)
       funcLine?: RegExp;              // two-line frames (Go): the preceding
                                       //   line carrying `func`
       order: 'top-first' | 'bottom-first'; // how the RAW text prints frames
     };
     userCode: {
       vendorPatterns: RegExp[];       // file matching ANY → isUserCode: false
     };
     crashKinds?: { pattern: RegExp; kind: CrashKind }[]; // stderr → kind override
   }
   ```

   The engine (`parseWithGrammar`) tolerates non-frame lines interleaved with
   frames (source echoes, blank lines) and **always normalizes the output to
   most-recent-call-first** (V8 convention), whatever `order` says about the raw
   text — so the suspect ranker and renderer treat every language uniformly.

3. **`makeDeclarativeAdapter`**
   ([`src/adapters/declarative.ts`](../src/adapters/declarative.ts)) — turns a
   grammar into a full adapter. Optional collectors:

   ```ts
   const adapter = makeDeclarativeAdapter(myGrammar, {
     // detection-only deps: [lockfile basename, DepInfo.lockfile tag][]
     collectDeps: makeGenericDeps([['Cargo.lock', 'cargo.lock']], 'Cargo.toml'),
     // collectEnv defaults to makeGenericEnv(grammar.id): OS + runtime name,
     // version '' — supply your own to shell out for a real version.
     // parseTestFailure defaults to () => null — supply one to populate
     // crash.testFailure (this is what promotes you out of grammar tier).
   });
   ```

## Detection scoring, exactly

`selectAdapter` (see [`src/adapters/registry.ts`](../src/adapters/registry.ts))
asks every registered adapter for a score and picks the highest one at or above
`DETECT_THRESHOLD = 0.3`; ties break by registration order; below the
threshold, the `node` adapter is the fallback. A declarative adapter's score is
`scoreGrammar`: `commands` +0.5, `cwdFiles` +0.3, `extensions` +0.2,
`stderrMarkers` +0.6, capped at 1.0. Practical guidance: make `stderrMarkers`
anchored and unmistakable (`/^Traceback \(most recent call last\):/m`,
`/^panic:/m`-style) — stderr is the signal that exists even when argv is a
wrapper script.

## Registration

```ts
import { registerAdapter } from './src/adapters/registry.js'; // re-exported by adapters/index.js
registerAdapter(makeDeclarativeAdapter(myGrammar, { /* collectors */ }));
```

- **In-tree contribution:** add `src/adapters/grammars/<lang>.ts` and register
  it in [`src/adapters/index.ts`](../src/adapters/index.ts) next to python/go.
  Keep `node` registered first — it must stay the fallback.
- **Out-of-tree (embedding whatbroke programmatically):** call
  `registerAdapter` before running the pipeline. Registration is idempotent by
  id (re-registering replaces), so tests stay isolated. There is no runtime
  plugin discovery today — the registry function *is* the extension API.

## The validation gate: the conformance suite

The conformance suite is the quality bar every grammar must clear — it asserts
the two things that make a bundle useful, per adapter:

1. **parse:** real crash stderr → structured frames (right order, right
   file:line, vendor frames flagged), and
2. **rank (the moat):** those frames flow through `enrichFrames` +
   `rankSuspects` and the in-repo culprit that also changed-since-green comes
   out as suspect #1.

Run it with:

```sh
npx tsx --test src/adapters/conformance.test.ts
```

Add a section for your language mirroring the existing python/go/toylang
blocks: a verbatim stderr sample from a real crash, a parse test, a moat test
(`enrichFrames` → `makeInput` → `rankSuspects` → `suspects[0].path`), a
`classify` test, and a `selectAdapter` routing test. If your grammar passes the
same four tests toylang passes, the downstream pipeline (redaction, sinks, MCP,
rendering) needs no changes at all.

## Worked example: `toylang`, end to end

This is the exact grammar the conformance suite runs — a made-up language with
Go-style two-line frames — shown here as the copy-paste starting point:

```ts
import { makeDeclarativeAdapter } from './declarative.js';
import { registerAdapter } from './registry.js';
import type { StackGrammar } from './grammar.js';

// A toylang crash prints:
//
//   !! crash: GizmoJamError: spinner jammed after 3 spins
//   -> spin_up()
//      in /repo/gizmo/spinner.toy line 12
//   -> boot()
//      in /repo/main.toy line 3
const toyGrammar: StackGrammar = {
  id: 'toylang',
  detect: {
    commands: [/\btoyc\b/],
    extensions: ['.toy'],
    cwdFiles: ['toy.manifest'],
    stderrMarkers: [/^!! crash:/m],
  },
  error: {
    header: /^!! crash: (?<name>[A-Za-z_]\w*): (?<message>.*)$/,
    headerAfterFrames: false, // header sits above the frames, Go-style
  },
  frame: {
    line: /^\s+in (?<file>\S+) line (?<line>\d+)$/, // the location line
    funcLine: /^-> (?<func>[\w.]+)\(\)$/,           // the line above it
    order: 'top-first',
  },
  userCode: { vendorPatterns: [/[\\/]toy_modules[\\/]/] },
  crashKinds: [{ pattern: /^!! crash: OutOfGears:/m, kind: 'nonzero-exit' }],
};

registerAdapter(makeDeclarativeAdapter(toyGrammar));
```

What falls out for free once this is registered: `selectAdapter` routes toylang
crashes by argv/cwd/stderr; `parseError` produces most-recent-first
`StackFrame[]` with `isUserCode` set; `classify` reports
`uncaught-exception` when a trace parsed (with your `crashKinds` overrides
applied); frames get `fileRelative`/`isInRepo` from `enrichFrames`; the suspect
ranker and confidence scoring work unchanged; the redaction gate and every sink
render your bundles like any other language's.

Checklist for a new language PR:

- [ ] `src/adapters/grammars/<lang>.ts` — the `StackGrammar` (+ a doc comment
      showing a verbatim sample trace).
- [ ] Registration in `src/adapters/index.ts` (after `node`).
- [ ] Conformance section: parse + moat + classify + routing tests, from real
      captured stderr.
- [ ] If the ecosystem's runner reports to stdout (most do), say so in your
      docs/README entry — grammar-tier frames come from **stderr only**.
- [ ] Optional collectors when you need them: `collectEnv` (real runtime
      version), `collectDeps` beyond lockfile detection, `parseTestFailure`
      for failing-test identity.
