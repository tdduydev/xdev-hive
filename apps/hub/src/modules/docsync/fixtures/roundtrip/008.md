# 0006. Connect machines outbound over WebSocket with leases and fencing

- Status: Accepted
- Date: 2026-10-11
- Deciders: maintainers

## Context

Developer machines sit behind NAT and firewalls. Runs must not be lost or duplicated when machines sleep, crash or
reconnect (SRS RUN-03, NFR-07, NFR-08).

## Decision

Machines open a WebSocket to `/ws/worker` and authenticate with a machine token. The hub pushes `job_offer`; an
accepted offer gets a time-limited lease renewed by heartbeats. Every run message carries `attempt`; the hub drops
messages from older attempts or other machines. The worker persists unacknowledged messages on disk and resends them;
the hub stores them idempotently by `(run, attempt, seq)` or `(run, attempt, offset)`. Cancellations ride on
heartbeat acknowledgements so they arrive even if one message is lost.

## Consequences

- Good: no inbound ports on machines; crash-safe delivery; stale workers cannot overwrite a reassigned run.
- Bad: proxies that block WebSocket stop the worker; a long-poll fallback is planned, not built.

## Alternatives considered

- Hub calls machines: needs inbound access to every machine.
- Polling only: higher latency and load.

## Links

- [add.md section 6.2](../add.md#62-a-code-run), [sdd.md section 4.2](../sdd.md#42-worker-protocol)
