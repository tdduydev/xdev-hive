# 0007. Run sandboxed work in gVisor containers with a per-run egress proxy

- Status: Accepted
- Date: 2026-10-11
- Deciders: maintainers

## Context

Some projects must not run agent work on developer machines, and agents must not reach arbitrary network hosts
(SRS SBX-01 to SBX-04).

## Decision

Projects with the sandbox feature run only on runner hosts (`hive-worker host`). Each run gets one container with the
gVisor runtime, `--network=none`, a read-only root, no capabilities and resource limits. The only way out is an egress
proxy started for that run inside the worker process, reached through a bind-mounted Unix socket; it enforces the
run's allowlist snapshot, blocks private and metadata addresses and IPv6, and checks TLS SNI. gVisor must allow host
Unix sockets (`--host-uds=open`).

## Consequences

- Good: a kernel boundary per run and default-deny egress, without a separate proxy service.
- Bad: Linux only; requires gVisor configuration on the host; environment images are executed but not built or cached
  yet.

## Alternatives considered

- Plain Docker (`runc`): weaker isolation; allowed only with `--allow-runc` for development.
- A sidecar proxy container per run: more containers to manage for the same policy.

## Links

- [add.md section 6.4](../add.md#64-a-sandboxed-run)
