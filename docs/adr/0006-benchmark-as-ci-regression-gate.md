# ADR-0006: Suspect-ranking benchmark is a CI regression gate, not a one-off study

**Status**: Proposed (Roadmap Theme 4)
**Date**: 2026-07-10

## Context

The README claims the ranking "names the right file"; the specs concede there
is no measurement. Ranking weights (+5 intersection, decaying stack weights,
the planned +2 import-graph hop) will be tuned over time — without a fixed
benchmark, every tweak is a guess and the marquee claim stays unevidenced.

## Decision

Ship `bench/` in-repo: ≥30 replayable regression cases (synthetic repos plus
mined open-source "commit X broke test Y" pairs), scored on top-1/top-3
suspect accuracy by `npm run bench`, with the baseline JSON committed. CI runs
the benchmark on every PR and fails if top-3 accuracy drops below baseline.
Misses stay in the suite as labeled known-misses. The README cites the measured
numbers and links the harness. Weight changes (e.g. the import-graph signal)
are accepted only with a benchmark delta in the PR.

## Consequences

**Good**: the moat claim becomes a published, reproducible number; weight
tuning becomes empirical; new language adapters get parity cases proving the
ranking carries over.
**Bad**: benchmark cases require git-history fixtures, which are fiddly to
build and slow CI slightly (mitigate: synthetic repos constructed by script at
bench time, cached); a public number invites comparison — that is the point.
