# ADR-0007: Extract a shared pipeline orchestrator from `run`

**Status**: Proposed (prerequisite for Roadmap Themes 1–2)
**Date**: 2026-07-10

## Context

`src/commands/run.ts` is the composition root wiring capture → collectors →
reconstruct → redact → sinks (34 imports; flagged by architecture analysis as
the only structural hotspot — no circular dependencies or layer violations
exist elsewhere). The roadmap adds three more consumers of the same pipeline:
`verify` (re-run + compare), CI mode (different sinks and output framing), and
watch mode (repeated runs with dedup). Duplicating the wiring per command would
triple the hotspot and risk divergence — e.g. a sink added in `run` but
forgotten in `verify`.

## Decision

Extract `executePipeline(argv, opts): Promise<PipelineResult>` — the single
function that runs capture through redaction and returns the `RedactedBundle`
plus classification, without deciding sinks. Commands (`run`, `verify`,
`watch`, CI mode) become thin adapters that call it and choose delivery. Sink
selection moves to a small factory keyed by flags/mode. This is a pure
refactor: the pipeline stages themselves do not change.

## Consequences

**Good**: verify is then "executePipeline + compareCrashes + journal update" —
small and safe; the redaction gate sits in exactly one call path; the hotspot
shrinks instead of multiplying.
**Bad**: one indirection layer; the refactor must land before Theme 1 work to
avoid rebasing verify on moving ground.
