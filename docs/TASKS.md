# whatbroke Roadmap — Development Task List

Derived from [ROADMAP.md](../ROADMAP.md). Every task lists concrete implementation steps
and the tests that prove it works. Order matters: each milestone builds on the previous.

Conventions used throughout:
- Test runner is `node:test` via `tsx` (`npm test`); tests are colocated `src/**/*.test.ts`.
- The redaction gate is inviolable: any new output surface consumes `RedactedBundle` only,
  and `redact.ts:175` stays the sole brand-minting cast.
- All new logic is deterministic and local-only; no LLM, no network (except the PR sink,
  which is opt-in and never fails the build).

---

## M0 — Pipeline extraction (ADR-0007)

### T0.1 Extract `executePipeline()` from `run.ts`
- [x] Create `src/pipeline.ts` exporting `executePipeline(opts): Promise<PipelineResult>`
      that encapsulates stages 2–11 of the current `run.ts` flow: capture → green
      fast-path → adapter selection → frame enrichment → collect → reconstruct →
      assemble → redact → store → sinks.
- [x] `PipelineOptions`: `{ command: CommandSpec, config, storePaths, journal, sinks?,
      captureOpts?: { timeoutMs?, logLines? }, mode?: 'local' | 'ci' }` (mode used by M2).
- [x] `PipelineResult`: discriminated union `{ outcome: 'green', exitCode: 0 } |
      { outcome: 'crash', exitCode, bundle: RedactedBundle, bundleId, sinkResults }`.
- [x] `run.ts` shrinks to: parse flags → build options → `executePipeline` → print summary.
      No behavior change.
- **Tests:**
  - [x] `src/pipeline.test.ts`: green run records journal green and returns
        `outcome: 'green'`; crashing script returns `outcome: 'crash'` with a redacted
        bundle written to a temp store.
  - [x] Entire existing suite passes unchanged (`npm test`) — the refactor's main proof.

---

## M1 — Close the loop

### T1.1 Crash fingerprint normalizer + `compareCrashes` (roadmap 1.2)
- [x] `src/repro/fingerprint.ts`: `normalizeMessage(msg)` strips volatile substrings —
      ISO/locale timestamps, hex addresses (`0x…`), tmp paths, port numbers, durations,
      PIDs, UUIDs, base36 bundle ids — replacing each with a stable token (`‹hex›` etc.).
- [x] `crashFingerprint(crash: CrashInfo): string` — sha256 (16 hex) over
      `kind + error.name + normalizeMessage(error.message) + topInRepoFrame(file:line
      identity, not line number) + testFailure identity`.
- [x] `compareCrashes(a, b): { verdict: 'same' | 'related' | 'different', reasons: string[] }`
      — fixed rules: same fingerprint → `same`; same error name + same top in-repo frame
      file → `related`; same failing test but different error → `related`; else `different`.
      Every verdict carries human-readable reasons.
- **Tests (`src/repro/fingerprint.test.ts`):**
  - [x] Corpus of ≥10 crash pairs (same-modulo-timestamp, same-modulo-port, different
        error same file, same test different error, totally different…) asserting exact
        verdict + at least one reason each.
  - [x] Determinism: fingerprinting the same crash twice, and across key orderings,
        yields byte-identical output.
  - [x] Normalizer unit cases: each volatile-substring class in isolation.

### T1.2 `whatbroke verify` (roadmap 1.1)
- [x] Bundle schema: add optional `resolution?: { status: 'resolved', at: ISO,
      commit: string }` field (schema stays version 1 — additive).
- [x] `src/commands/verify.ts`: `whatbroke verify [bundle-id]` (default: latest).
      Loads bundle via `BundleStore`, re-runs **exactly** `bundle.repro`'s captured argv
      from the captured cwd via `executePipeline` (no shell string, `spawn` array argv).
- [x] Outcomes: pass → print `✓ fixed`, exit 0, record green in journal, stamp bundle
      `resolved` with `git rev-parse HEAD`; fail → run `compareCrashes(old, new)` and
      print a delta report (`same failure` / `related` / `different failure — new bundle
      <id>`), exit with the child's code. A `different` verdict captures a new bundle.
- [x] Typed errors, never hangs: `cwd-missing`, `command-missing` (ENOENT), `timeout`
      (default 10 min, `--timeout` flag) → distinct exit codes + messages.
- [x] Wire into `cli.ts` dispatch + help text.
- **Tests (`src/commands/verify.test.ts`):**
  - [x] E2E in temp git repo: capture a crash from a broken script, fix the file, verify
        → exits 0, bundle JSON gains `resolution.status === 'resolved'`, journal has a
        green entry.
  - [x] Still-broken script → same-failure delta, exit code preserved, no resolution stamp.
  - [x] Different crash injected → `different-failure` + a *new* bundle file exists.
  - [x] cwd deleted → typed error, no hang; fake argv `["definitely-not-a-cmd"]` → typed
        ENOENT error; `--timeout 100` against `sleep`-like script → typed timeout.
  - [x] **AC5 security test:** verify's spawn is called with the bundle's argv array
        verbatim — assert no shell (`spawn` without `shell: true`) and argv equals the
        recorded array even when the bundle message contains `"; rm -rf"`-style content.

### T1.3 `verify_fix` MCP tool
- [x] `src/mcp/server.ts`: add `verify_fix` tool (input `{ id?: string }`) returning
      `{ status: 'fixed' | 'same-failure' | 'different-failure', newBundleId?,
      delta?: { verdict, reasons } }`. Implemented on the same code path as T1.2
      (extract `verifyBundle()` core into `src/commands/verify.ts` or `src/verify/`).
- [x] This is the **only** MCP execution capability; it takes no command/argv input
      (ADR-0002). Server description documents that.
- **Tests (`src/mcp/verify.test.ts`):**
  - [x] Call the extracted core with a fixed/broken fixture repo → correct statuses and
        `newBundleId` populated only on `different-failure`.
  - [x] Input schema rejects/ignores any attempt to pass a command: tool handler
        signature accepts only `id`; test that extra fields cannot alter the argv run.

### T1.4 `whatbroke init` + `doctor` registration checks (roadmap 6.1)
- [x] `src/commands/init.ts`: detect `.claude/`, `.cursor/`, or generic `.mcp.json` in
      the project; print the exact `mcpServers` JSON entry; with `--yes` (or interactive
      confirm) write/merge it; then smoke-start the MCP server (spawn `whatbroke mcp`,
      wait for handshake banner, kill) to verify it boots.
- [x] Emit (with confirmation) a `CLAUDE.md`/rules snippet documenting the agent loop:
      `get_suspects` → edit → `verify_fix`.
- [x] Extend `doctor.ts`: report whether an MCP registration pointing at whatbroke exists
      and whether `whatbroke mcp` starts.
- **Tests (`src/commands/init.test.ts`):**
  - [x] In a temp dir with a fake `.claude/settings.json` / `.mcp.json`, `init --yes`
        merges the entry without clobbering existing keys (golden comparison).
  - [x] Idempotency: running twice produces no duplicate entries.
  - [x] Snippet content includes all three tool names.

---

## M2 — CI mode

### T2.1 `--ci` mode (roadmap 2.1 AC1, AC4)
- [x] `run.ts`/`pipeline.ts`: `--ci` flag, auto-enabled when `process.env.CI` is truthy
      (overridable with `--no-ci`). Effects: no ANSI color, no interactive output, file
      sink always on, and on crash print exactly one stable line:
      `::whatbroke bundle=<abs path> confidence=<level> suspect=<top suspect relpath>`.
- [x] Redaction path identical in CI mode (it's the same `executePipeline`; assert, don't
      fork).
- **Tests (`src/commands/ci.test.ts`):**
  - [x] Crash under `CI=1` → stdout contains exactly one `::whatbroke ` line, parseable
        by a strict regex; no ANSI escape codes anywhere in output.
  - [x] Redaction corpus test re-run with `--ci` (parameterize `corpus.test.ts` or add a
        CI-mode case): planted secrets never appear in the machine line or bundle.

### T2.2 GitHub Action (roadmap 2.1 AC2, AC3)
- [x] `action.yml` at repo root: composite action — inputs `run` (command) and
      `journal-cache` (default true). Steps: restore `.whatbroke/journal.json` from
      `actions/cache` keyed by default-branch, run `npx whatbroke run --ci -- <cmd>`,
      on failure upload `.whatbroke/bundles/` via `actions/upload-artifact` and append
      the bundle's rendered Markdown to `$GITHUB_STEP_SUMMARY`; on success on the default
      branch, save the journal cache (green baseline, ADR-0005).
- [x] Dogfood: `.github/workflows/selftest.yml` job that intentionally runs a crashing
      fixture through the action and asserts the artifact + summary exist.
- **Tests:**
  - [x] `src/actions/action.test.ts` (or script): parse `action.yml`, assert required
        steps/ordering exist (schema-level guard, since composite actions can't run
        locally).
  - [x] Local simulation test: script that mimics the action's shell steps in a temp dir
        (restore journal → run --ci → check summary md written) — proves the glue logic.
  - [x] Real proof is the dogfood workflow going green in this repo's CI (AC2).

### T2.3 PR comment sink (roadmap 2.2)
- [x] `src/sinks/githubPr.ts` implementing `Sink`: renders bundle Markdown (error, top-3
      suspects with reasons, diff-vs-green summary, `npx whatbroke show <id>` line) with
      a hidden marker comment `<!-- whatbroke-sticky -->`; finds an existing comment with
      the marker and updates it (never posts a second one).
  - Transport: `gh api` when `gh` is on PATH; REST `fetch` fallback with `GITHUB_TOKEN`.
  - Never throws: all failures → `SinkResult` warning, build proceeds.
- [x] `--github-pr` flag; Action enables it by default when `GITHUB_TOKEN` present.
- **Tests (`src/sinks/githubPr.test.ts`):**
  - [x] Comment body golden test from a fixture `RedactedBundle` (marker present, top-3
        suspects, show-command line).
  - [x] Update-vs-create logic against a mocked transport: existing marker comment →
        PATCH same id; none → POST once.
  - [x] Transport failure (mock rejects) → `SinkResult` error, function resolves, no throw.
  - [x] Type-level: sink signature only accepts `RedactedBundle`.

---

## M3 — Benchmark + import graph + history

### T3.1 Benchmark harness (roadmap 4.1)
- [x] `bench/` directory: `bench/cases/<name>/` each containing a self-describing
      `case.json` (`{ language, setup: script to materialize a tiny git repo with a
      green commit + breaking change, expected: { culpritFiles: [...] } }`) plus fixture
      sources. ≥30 cases: synthetic Node/TS regressions across crash kinds (throw, type
      error, failed assertion, unhandled rejection, bad import), plus mined-style pairs.
- [x] `bench/run.ts`: for each case, materialize repo in tmp, record green (run passing
      commit through `executePipeline`), apply breaking change, run pipeline, score
      whether expected culprit is top-1 / top-3. Prints scoreboard, writes
      `bench/results.json` (`{ perCase[], top1, top3 }`).
- [x] `npm run bench` script; `bench/baseline.json` recording the accepted floor;
      CI job fails if `top3 < baseline.top3`.
- [x] Known-misses live in the suite labeled `"expectedMiss": true` — scored separately,
      never fail CI, tracked as the improvement backlog (AC4).
- [x] README moat section cites the measured numbers + link (AC3).
- **Tests:**
  - [x] `bench/harness.test.ts`: harness on 2 known-good mini-cases yields
        deterministic scores; corrupt case.json is reported, not crashing the run.
  - [x] The benchmark itself in CI is the ongoing regression test (AC2).

### T3.2 Import-graph one-hop signal (roadmap 4.2)
- [x] `src/repro/importGraph.ts`: static, regex/lexer-level parse of `import`/`require`
      specifiers in changed-since-green files and stack files (Node/TS only). Resolve
      relative specifiers to repo paths (with `.ts/.tsx/.js/index.*` probing), **no
      execution, no tsconfig path mapping in v1**. Bounded: ≤1 hop, cap 200 files parsed,
      cap file size 512 KB.
- [x] `suspects.ts`: `WEIGHT_IMPORT_HOP = 2` — a stack file that imports (or is imported
      by) a changed-since-green file gets +2 with reason `imports changed file X` /
      `imported by changed file X`. Replaces the `SCOPE-CHECK` stub at `suspects.ts:28`.
- **Tests (`src/repro/importGraph.test.ts`):**
  - [x] Parser cases: ESM import, dynamic import, require, export-from, specifier with/
        without extension, index resolution, ignores node_modules + type-only imports.
  - [x] Determinism: same tree parsed twice → identical edge list.
  - [x] Caps respected: >200 candidate files → parse count capped (assert via injected
        counter).
  - [x] Ranking integration: fixture where culprit is only reachable via one hop moves
        into top-3; at least one bench known-miss case flips to hit and top-3 does not
        regress (asserted by the bench baseline gate).

### T3.3 Crash history index (roadmap 3.1)
- [x] `src/history/index.ts`: `.whatbroke/index.json` —
      `{ version: 1, entries: { [fingerprint]: { occurrences: [{ bundleId, at, head,
      suspects[] }], resolved?: { bundleId, commit, at, filesTouched[] } } } }`.
      Written by `executePipeline` on crash and by `verify` on resolution
      (`filesTouched` = `git show --name-only <commit>`).
- [x] Pipeline: on new crash, if fingerprint matches a *resolved* entry, attach
      `history` block to the bundle (`provenance: 'derived'`): "matches bundle <id> from
      <date>, fixed by <sha> touching <files>". Surface in `get_suspects` output too.
- [x] `flaky?` annotation when the same fingerprint has both green (via verify/journal)
      and crashing runs recorded at the same head sha.
- [x] MCP `get_history({ fingerprint | id })` — read-only, served from the index.
- [x] GC: same discipline as journal (60 days / 200 fingerprints, freshest kept);
      corrupt index → empty, never throws.
- **Tests (`src/history/index.test.ts` + integration):**
  - [x] Crash → fix+verify → same crash again: second bundle contains the `history`
        block naming the first bundle and resolving commit.
  - [x] Same fingerprint green+crash at same head → `flaky` annotation.
  - [x] Corrupt/truncated index.json → loads empty, pipeline still completes.
  - [x] GC eviction at 201 entries and >60 days.
  - [x] `get_history` returns occurrences for both fingerprint and bundle-id lookups.

### T3.4 `whatbroke stats` — ranking feedback (roadmap 3.2)
- [x] On resolution (T1.2/T3.3), record hit/miss: was any `filesTouched` in top-1 /
      top-3 suspects? Ledger lives inside `index.json` entries (no new file).
- [x] `src/commands/stats.ts`: prints local top-1/top-3 hit-rate over resolved bundles
      (n, hits, %). Purely local.
- **Tests (`src/commands/stats.test.ts`):**
  - [x] Seed index with 3 resolved entries (2 top-1 hits, 1 miss) → stats prints
        top-1 2/3, top-3 3/3 (golden output).
  - [x] Zero resolved bundles → friendly empty-state message, exit 0.

---

## M4 — Polyglot parity + sharpness + watch

### T4.1 Python & Go end-to-end golden tests (roadmap 5.1)
- [x] `src/adapters/e2e/`: per-language sample project fixture (tiny pytest project, tiny
      `go test` module) checked into `bench/fixtures/` or `src/adapters/e2e/fixtures/`.
      E2E test wraps the real runner **when the toolchain is present** (skip with a clear
      message otherwise; CI installs python3 + go so they always run there).
- [x] Golden assertions: parsed frames have correct `file:line`, crash kind, failing-test
      identity; suspects rank the culprit via stack∩changed.
- [x] One benchmark case per language (feeds T3.1 scoring, AC2).
- [x] README language matrix (exact per-tier capabilities, no overclaiming) +
      `docs/adding-a-language.md` documenting the conformance suite for third-party
      grammar authors.
- **Tests:** the golden e2e files themselves (`python.e2e.test.ts`, `go.e2e.test.ts`),
      plus conformance suite extension asserting a brand-new toy grammar passes with zero
      core changes.

### T4.2 Source-map resolution (roadmap 5.2)
- [x] `src/capture/sourcemap.ts`: for frames pointing into `dist/`-like build output,
      look for `//# sourceMappingURL` (file or inline data URI), decode the VLQ mappings
      (small self-contained decoder, offline, no new runtime dep), map to original
      `.ts` source + line, set `sourceMapped: true` and rewrite `file`/`fileRelative`.
      Best-effort: any failure leaves the raw frame + `sourcemap: unresolved` note.
- [x] Runs during frame enrichment, before suspects, so ranking names the source file.
- **Tests (`src/capture/sourcemap.test.ts`):**
  - [x] Fixture: `tsc`-style output with external map → frame resolves to `.ts:line`.
  - [x] Inline base64 map resolves too; missing/corrupt map → raw frame +
        `unresolved` note, never throws.
  - [x] Bench case built from a bundler-style fixture (AC2) — suspect names the `.ts`.

### T4.3 Watch mode (roadmap 6.2)
- [x] `src/commands/watch.ts`: `whatbroke watch -- <cmd>` — `fs.watch`-based recursive
      watcher (gitignore-aware, ignores `.whatbroke/`, `node_modules/`, dot-dirs) with
      300 ms debounce; on change, re-run via `executePipeline`; greens recorded, crashes
      captured.
- [x] Dedup: fingerprint (T1.1) of the new crash vs the session's last crash — same
      fingerprint → update in place / skip new bundle; new fingerprint → new bundle.
      At most one bundle per distinct failure per session.
- [x] Clean shutdown on SIGINT; child killed on re-trigger.
- **Tests (`src/commands/watch.test.ts`):**
  - [x] Programmatic harness (exported `createWatchSession()` core, tested without TTY):
        touch file → rerun triggered once despite 3 rapid writes (debounce).
  - [x] Same crash twice → 1 bundle; crash A then crash B → 2 bundles.
  - [x] Green after crash → journal green recorded.

---

## Cross-cutting definition of done (every milestone)

- [x] `npm run typecheck` clean, `npm test` green, `npm run bench` ≥ baseline (from M3).
- [x] Redaction corpus test passes on every new output surface.
- [x] No new runtime dependencies without an ADR.
- [x] README + `docs/adr/` updated when a decision deviates from the roadmap.
