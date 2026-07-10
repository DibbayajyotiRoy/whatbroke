# ADR-0008: Captured argv is redacted without the env-value detector; verify fails closed on placeholders

**Status**: Accepted
**Date**: 2026-07-10

## Context

Verify (ADR-0002) re-runs the bundle's captured `command.argv` verbatim. The
bundle persists that argv on disk, and bundles are shared surfaces (CI
artifacts, PR comments), so argv must pass the redaction gate like every other
field — a `--token=...` typed on the command line must never persist.

But the gate's env-value detector scrubs *any* occurrence of *any*
non-allowlisted environment variable's value. Under npm/npx wrappers the
environment contains variables like `npm_node_execpath` whose value is the
interpreter path that **is** `argv[0]` (e.g. `/usr/bin/node`). Full-chain
redaction therefore rewrote `argv[0]` to `‹redacted:env-value›`, making every
captured command unrunnable — verify's core contract broken by its own
safety rail.

## Decision

1. `command.argv` elements are scrubbed by the known-format detectors, the
   config denylist, and the entropy detector — but **not** the env-value
   detector. Interpreter/binary paths mirrored into env vars by package
   managers are not credential material; real secrets in argv (AWS keys,
   tokens, high-entropy strings, anything deny-listed) are still caught.
2. Verify **fails closed on placeholders**: if any argv element contains
   `‹redacted:`, verify refuses to execute it (typed error `argv-redacted`)
   rather than running a corrupted command. A redacted argv is not the
   recorded command, and running a guess would violate ADR-0002.

## Consequences

**Good**: the crash → edit → `verify_fix` loop works under npm/npx/nvm
wrappers; secrets typed into argv still never persist; there is no path on
which verify executes anything other than the byte-exact recorded argv.

**Trade-off**: a secret that only the env-value detector would catch (a raw
env var value pasted as an argument, in a format the known-format/entropy
detectors don't recognize) persists in `command.argv`. This is the user's own
command line echoed back to them; the residual risk is accepted and the
corpus test pins the behavior in both directions (secret argv scrubbed +
verify fail-closed; interpreter path preserved).
