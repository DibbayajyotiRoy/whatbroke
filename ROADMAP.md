# whatbroke Roadmap — from "nice capture tool" to indispensable

**Thesis for 10x:** today whatbroke captures one crash well. The 10x version closes the
loop — it doesn't just hand the agent a bundle, it *verifies the fix*, *learns across
crashes*, *works where crashes actually happen at scale (CI)*, and *proves its ranking
is right with numbers*. Each theme below multiplies the others: verified fixes make the
benchmark self-updating, CI makes the journal fill itself, and the benchmark makes the
README claim ("names the right file") an evidenced fact instead of a mechanism.

Ordering is by leverage-per-effort. Each feature has explicit acceptance criteria (AC).
Key decisions behind this roadmap are recorded as ADRs in [docs/adr/](docs/adr/README.md).

## Architecture validation (current state)

Automated analysis plus manual review confirm the codebase can absorb this roadmap
without restructuring:

- **No circular dependencies, no layer violations** across the 82-file, ~10k-line tree.
- **Ports already exist where the roadmap extends:** `Sink` (PR-comment sink is
  additive), `DiffProvider` (isolated git shell-out), and the v0.2 language `Adapter`
  registry (Python/Go grammars plug in without core changes). New surfaces implement a
  port; core stages stay untouched (ADR-0001).
- **The one hotspot:** `src/commands/run.ts` is the composition root (34 imports) and
  `verify`/`--ci`/`watch` would each re-wire the same pipeline. **Prerequisite refactor:**
  extract a shared `executePipeline()` orchestrator before Theme 1 (ADR-0007).
- **Trust invariants that every feature below must preserve:** the branded
  `RedactedBundle` gate is the only path to any output (extends to PR comments, CI
  summaries, verify reports, and the history index); the MCP server gains exactly one
  narrowly-scoped execution capability — re-running the bundle's own captured argv,
  never a caller-supplied command (ADR-0002); everything new is deterministic and
  local-only (ADR-0003, ADR-0004).

---

## Theme 1 — Close the loop: from "diagnose" to "verified fix" (highest leverage)

### 1.1 `whatbroke verify` + `verify_fix` MCP tool
The agent reads the bundle, edits code — and today whatbroke's job is over. Add the
other half: re-run the exact captured command and report pass/fail *against the bundle*.
This turns whatbroke into the agent's ground-truth oracle for "did my fix work?", which
is the single most requested capability in agent debugging loops, and it requires no
LLM — it's the same deterministic wrapper pointed backward.

- **AC1:** `whatbroke verify [bundle-id]` re-runs the bundle's captured argv from the
  captured cwd; exits 0 and prints `✓ fixed` if the command now passes; exits with the
  child's code and prints a *delta report* (same error / different error / new crash)
  if it still fails.
- **AC2:** A `verify_fix` MCP tool exposes the same, returning `{status: 'fixed' |
  'same-failure' | 'different-failure', newBundleId?}`. On `different-failure` a new
  bundle is captured and its id returned so the agent can iterate without leaving MCP.
- **AC3:** On `fixed`, the run is recorded green in the journal and the bundle is marked
  `resolved` with the resolving commit sha (feeds Theme 3 and the benchmark).
- **AC4:** Timeout, cwd-moved, and command-no-longer-exists cases produce typed errors,
  never a hang; covered by tests.
- **AC5:** `verify` never runs anything except the argv recorded in the bundle
  (no shell interpolation of MCP-supplied strings); asserted by test.

### 1.2 Failure-delta classification ("same bug or new bug?")
Needed by 1.1 and valuable standalone: deterministic comparison of two crashes
(error name/message similarity, top-frame identity, failing-test identity).

- **AC1:** Pure function `compareCrashes(a, b) → {verdict: 'same'|'related'|'different',
  reasons[]}` with fixed rules, no LLM; byte-deterministic across runs (tested).
- **AC2:** Message comparison is robust to volatile substrings (timestamps, hex
  addresses, tmp paths, port numbers) via normalization; corpus test with ≥10 pairs.
- **AC3:** Verdict + reasons surface in `verify` output and the MCP result.

## Theme 2 — CI mode: capture where most crashes actually happen

Local adoption is one dev at a time; CI adoption is one YAML line for a whole team, and
CI is where the "context decayed, can't reproduce" pain is worst. This is also the
distribution unlock: bundle artifacts in CI are seen by every teammate.

### 2.1 First-class `--ci` mode + GitHub Action
- **AC1:** `whatbroke run --ci -- <cmd>` (auto-detected via `CI` env) disables tty
  coloring/interactive output, always writes the bundle, and prints a stable
  machine-readable line `::whatbroke bundle=<path> confidence=<level> suspect=<file>`.
- **AC2:** A published composite GitHub Action (`whatbroke/action@v1`) wraps a step,
  uploads `.whatbroke/bundles/` as an artifact on failure, and posts a job-summary
  Markdown (the rendered bundle) — working end-to-end in this repo's own CI.
- **AC3:** Green journal in CI: on passing default-branch runs the action records the
  commit green into a cache-restored journal, so PR crashes get a real `diff vs green`
  against the last passing main build. AC: a demo repo shows a PR crash whose top
  suspect reason cites "changed since green <main sha>".
- **AC4:** Redaction gate unchanged and mandatory in CI mode; the CI corpus test runs
  with `--ci` too.

### 2.2 PR comment sink
- **AC1:** `--github-pr` (or the Action, by default) posts/updates a single sticky PR
  comment with the rendered bundle: error, top-3 suspects with reasons, diff-vs-green
  summary, and a copy-paste `npx whatbroke show <id>` line. Re-runs update the same
  comment, never spam new ones.
- **AC2:** Works via `gh` when available, REST fallback with `GITHUB_TOKEN`; never
  fails the build if commenting fails.

## Theme 3 — Memory: from one crash to a project crash history

The journal already accumulates ground truth; extend that from "last green sha" to
"what has broken here before and how it got fixed." Deterministic, local, and exactly
the accumulated data an LLM cannot fake — a direct extension of the moat.

### 3.1 Crash history & recurrence detection
- **AC1:** Bundles gain a lightweight index (`.whatbroke/index.json`) tracking error
  fingerprint (from 1.2's normalizer), suspect files, resolved status, and resolving
  commit.
- **AC2:** On a new crash, if the fingerprint matches a previously *resolved* bundle,
  the bundle and MCP `get_suspects` include a `history` block: "this failure matches
  bundle <id> from <date>, fixed by commit <sha> touching <files>" — provenance tier
  `derived`.
- **AC3:** Recurring-but-unresolved matches add a `flaky?` annotation when the same
  fingerprint has both green and crashing runs at the same commit.
- **AC4:** New MCP tool `get_history(fingerprint|id)` returns prior occurrences;
  read-only, served from the index.
- **AC5:** Index self-GCs with the same policy discipline as the journal; corrupt index
  degrades to empty (tested).

### 3.2 Suspect-ranking feedback loop
- **AC1:** When 1.1 marks a bundle resolved, whatbroke records which file(s) the fixing
  commit touched and whether the top-ranked suspect was among them (a local hit/miss
  ledger, no telemetry, nothing leaves the machine).
- **AC2:** `whatbroke stats` prints local top-1/top-3 suspect hit-rate over resolved
  bundles — the user's own evidence for the README claim.

## Theme 4 — Prove the ranking: a public benchmark

The README promises "names the right file"; the spec admits there is no measurement.
A published hit-rate is the difference between a claim and a category-defining fact,
and it's the strongest possible launch/README asset.

### 4.1 Regression benchmark harness
- **AC1:** A repo-local harness (`bench/`) replays N real regression cases (synthetic
  repos + mined open-source "commit X broke test Y" pairs, ≥30 cases) through the full
  pipeline and scores top-1/top-3 suspect accuracy.
- **AC2:** One command (`npm run bench`) prints a scoreboard and writes JSON; runs in
  CI on every PR and fails if top-3 accuracy drops below the recorded baseline.
- **AC3:** README's moat section cites the measured numbers with a link to the harness.
- **AC4:** Cases where ranking misses are kept in the suite as labeled known-misses —
  the improvement backlog for weights/signals (import-graph hop lands here first).

### 4.2 Import-graph one-hop signal (already stubbed, +2 weight)
- **AC1:** For Node/TS, a file that imports (or is imported by) a changed-since-green
  file and appears on the stack gets the +2 signal with reason "imports changed file X";
  computed from static import parsing, no execution.
- **AC2:** Deterministic and bounded (≤1 hop, capped file count); determinism test.
- **AC3:** Measurable: benchmark top-3 accuracy does not regress and at least one
  known-miss case flips to a hit.

## Theme 5 — Finish the polyglot promise (v0.2 follow-through)

The adapter layer and Python/Go grammars exist; what's missing is the proof they work
sharply end-to-end and that the journal/ranking moat carries over.

### 5.1 Python & Go end-to-end parity
- **AC1:** Wrapping `pytest` and `go test` in real sample projects produces bundles
  with correctly parsed stack frames (file:line), crash kind, and failing-test identity;
  golden-file e2e tests per language run in CI.
- **AC2:** Suspect ranking (stack ∩ changed-since-green) works for both, demonstrated
  by a benchmark case per language.
- **AC3:** README language matrix states exactly what each language tier gets
  (parsed frames / test identity / suspects) — no overclaiming.
- **AC4:** Conformance suite (`adapters/conformance.test.ts`) extended so a third-party
  grammar author can validate a new language with zero core changes; documented in
  `docs/adding-a-language.md`.

### 5.2 Source-map resolution (Node/TS sharpness)
- **AC1:** Stack frames pointing into `dist/` are resolved to original `.ts` sources
  when a sourcemap is present, so suspects name the file the developer actually edits.
- **AC2:** Resolution is best-effort and offline; failure leaves the raw frame with a
  `sourcemap: unresolved` note. Benchmark includes a bundler-built case.

## Theme 6 — Agent-native ergonomics (distribution polish)

### 6.1 One-command agent registration
- **AC1:** `whatbroke init` detects Claude Code / Cursor / generic MCP config in the
  project, offers to write the `mcpServers` entry (with confirmation), and verifies the
  server starts. `whatbroke doctor` checks registration health.
- **AC2:** Also emits a project `CLAUDE.md`/rules snippet telling the agent to call
  `get_suspects` → edit → `verify_fix` — the full loop from Theme 1.

### 6.2 Watch mode
- **AC1:** `whatbroke watch -- <cmd>` re-runs on file change (or wraps an existing
  watcher), recording greens and capturing crashes continuously, so the journal
  populates during normal dev without the user thinking about it.
- **AC2:** Rapid crash successions are debounced/deduped via the 1.2 fingerprint —
  at most one bundle per distinct failure per session unless it changes.

---

## Sequencing & milestones

| Milestone | Contents | Why this order |
|---|---|---|
| **M0 (week 1)** | ADR-0007 refactor: extract `executePipeline()` from `run.ts` | Pure refactor; every later theme reuses it instead of re-wiring the pipeline |
| **M1 (weeks 1–3)** | 1.2 failure-delta → 1.1 verify loop → 6.1 init | Closes the agent loop; biggest per-user value jump, all deterministic, no new surface area |
| **M2 (weeks 3–6)** | 2.1 CI mode + Action → 2.2 PR sink | Team-scale distribution; journal fills itself on main |
| **M3 (weeks 6–9)** | 4.1 benchmark → 4.2 import-graph → 3.1/3.2 history | Turns the moat claim into published numbers; history compounds local ground truth |
| **M4 (weeks 9–12)** | 5.1 Python/Go parity → 5.2 sourcemaps → 6.2 watch | TAM expansion once the Node loop is provably sharp |

**Anti-scope guardrails (unchanged from spec):** no fixing code, no hosted backend, no
accounts, no telemetry, redaction gate never weakened, everything above is
deterministic/local — the LLM stays confined to opt-in `--explain`.

**Definition of "10x" (measurable):** an agent can go crash → `get_suspects` →
edit → `verify_fix` → green without a human pasting anything (M1); a team gets a
suspect-ranked PR comment on every red CI run from one YAML line (M2); the README cites
a measured top-3 hit-rate from a public benchmark (M3); the same loop works for
Python and Go (M4).
