# ADR-0001: Baseline — staged pipeline with a type-enforced redaction gate

**Status**: Accepted (records existing design)
**Date**: 2026-07-10

## Context

whatbroke v0.1–v0.2 was built as a five-stage pipeline (CLI → capture →
collectors → repro reconstruction → redaction → sinks/readers) of typed,
mostly-pure functions, with the only persistent state being project-local files
(`.whatbroke/journal.json`, bundles). `RedactedBundle` is a branded type whose
sole producer is `redact()`; every sink and reader accepts only that brand.
This ADR records the baseline so later ADRs can build on (and never violate) it.

## Decision

- Keep the staged-pipeline shape: each stage takes an explicit typed input and
  produces an explicit typed output; no stage reads global state.
- The branded `RedactedBundle` gate is inviolable: any new output surface
  (PR comments, CI summaries, verify reports, history index) must be typed to
  accept only `RedactedBundle`-derived data.
- External effects stay behind ports: `Sink`, `DiffProvider`, and the language
  `Adapter` registry are the extension points; new integrations implement a
  port rather than modifying core stages.

## Consequences

**Good**: new features (verify, CI, history) slot in as new stages/ports;
compile-time leak prevention extends to them for free; everything remains
unit-testable with in-memory fakes.
**Bad**: `src/commands/run.ts` is the composition root (34 imports today) and
will grow; see ADR-0007.
