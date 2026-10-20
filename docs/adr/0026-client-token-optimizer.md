# 0026. Embed client token optimization and memory tools in the Go sidecar

- Status: Proposed
- Date: 2026-10-14
- Deciders: product owner, maintainers

## Context

Most measured token use on the development machine came from client sessions that do not pass through worker runs.
Over seven days, Claude interactive sessions accounted for 72.4% of converted tokens; 51 of 244 sessions exceeded
400k context tokens and accounted for 84% of interactive converted-token use. Tool output from Bash and Read made up
52.7% and 41.2% of reread output respectively. Memory was also split between account profiles for the same project.
These figures are a local baseline, not a general estimate; see the [research](../../specs/015-client-token-optimizer/research.md).

The desktop client needs local optimization and memory management that works offline, without hub login, and applies
to sessions opened outside the app as well as in it. Existing worker code already contains token presets, CLI version
checks, output hooks and context-pack support. The app also ships the Go worker sidecar.

## Decision

Choose option (a): extend the shipped Go `hive-worker` sidecar with local optimizer and memory commands. Keep the
optimization and file operations in Go; let the desktop UI call the sidecar and present its results. Reuse worker
presets and hook logic where possible. Apply changes to explicitly selected CLI profiles, keep backups, and make
reports compare measurements from before and after enablement. The feature works offline and does not require login.

RTK and CodeGraph may be used when installed, but the optimizer does not depend on either. The balanced profile is the
default; the more aggressive profile remains an explicit choice because it lowers output limits further and can
change subagent behavior.

## Consequences

- Good: interactive and headless client sessions can receive the same profile settings without duplicating worker
  logic or installing another runtime.
- Good: local memory inventory, backup, restore and sharing remain available when the hub is offline or the user is
  signed out.
- Good: per-profile changes can be inspected and reverted, while user-modified settings are preserved.
- Bad: users must enable optimization for each desired profile; the default CLI configuration is not changed
  implicitly.
- Bad: the measured reduction is not yet known. The research estimates a 30–45% reduction for interactive sessions
  from compaction settings, but labels this an inference that requires before/after measurement.
- Bad: platform-specific CLI capabilities can limit hooks or integrations; unsupported options must be reported rather
  than silently applied.

## Score

The desktop app also shows a token optimization score from 0 to 100 ([spec 025](../../specs/025-token-score/spec.md)).
The sidecar computes it with `hive-worker optimize score`, for the same reasons as above: the inputs are local CLI
settings and session logs, the score must work offline, and one implementation avoids two sources of truth.

- Session logs, project paths and profile names are private. They stay on the machine. The score history keeps only
  numbers, criterion ids and CLI names, and the copyable report omits profile ids and paths.
- Every quick fix shows a preview and can be undone. Fixes that change model behavior (the aggressive level) need their
  own confirmation. No fix edits memory or instruction files, or removes MCP servers or skills.
- `/context` calls the model and costs tokens, so it runs only when the user presses the measure button. The result is
  kept for seven days, and recalculating the score never runs it.
- The score measures configuration and context size, not the quality of the agent's results.

## Alternatives considered

- **(b) Reimplement the feature in Rust inside Tauri:** rejected because it would duplicate preset, version-detection,
  hook and context-pack behavior, creating two sources of truth. Tauri is also not a suitable standalone binary for
  hooks invoked by the CLI.
- **(c) Require external tools such as RTK or CodeGraph:** rejected as the core implementation because they are not
  shipped with the app and do not cover configuration management, memory operations or the measured `sed`/`cat`
  output pattern. RTK can still be enabled optionally when already available.

## Links

- [Spec 015: client token optimizer](../../specs/015-client-token-optimizer/spec.md)
- [Plan](../../specs/015-client-token-optimizer/plan.md) and [research](../../specs/015-client-token-optimizer/research.md)
- [Spec 025: token optimization score](../../specs/025-token-score/spec.md)
- [ADR 0019: local interactive sessions](0019-hive-cli-and-remote-sessions.md)
