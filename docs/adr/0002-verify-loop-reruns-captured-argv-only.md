# ADR-0002: `verify` re-runs only the captured argv (no agent-supplied commands)

**Status**: Proposed (Roadmap Theme 1)
**Date**: 2026-07-10

## Context

The roadmap adds `whatbroke verify` and a `verify_fix` MCP tool so an agent can
confirm a fix by re-running the failing command. The MCP server is currently
read-only; adding any execution capability is the single largest change to
whatbroke's trust posture. An MCP tool that executed an arbitrary
caller-supplied command would be a prompt-injection-to-shell vector.

## Decision Drivers

- Preserve the "nothing to trust beyond a local child process" story.
- The agent loop needs pass/fail ground truth, not general execution.
- Determinism: verify must be as auditable as ranking.

## Considered Options

1. **Re-run only the argv recorded in the bundle** — narrow, auditable;
   the only inputs are a bundle id and optional timeout.
2. Accept a command parameter on `verify_fix` — flexible, but turns the MCP
   server into a remote shell; rejected.
3. Keep MCP read-only and require the human to run `verify` in the terminal —
   safe but breaks the autonomous agent loop, the core of the 10x thesis.

## Decision

Option 1. `verify` (CLI and MCP) executes exactly the child argv, cwd, and env
policy captured in the bundle, via the same spawn path as `run` (argv array,
no shell). `verify_fix` takes `{bundleId?, timeoutMs?}` and nothing else.
A test asserts no MCP-supplied string ever reaches the spawn call.

## Consequences

**Good**: the execution surface is exactly "commands the developer already ran";
the loop (get_suspects → edit → verify_fix) closes without a human.
**Bad**: cannot verify with a narrowed command (e.g. single-test filter) in v1;
a future `--repro-cmd` recorded at capture time (still developer-originated,
never agent-originated) is the sanctioned extension path.
**Risk**: cwd moved/deleted since capture → typed error, never a hang.
