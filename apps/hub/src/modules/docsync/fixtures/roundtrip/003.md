# 0001. Build the hub as a modular monolith

- Status: Accepted
- Date: 2026-10-11
- Deciders: maintainers

## Context

The hub covers identity, tenancy, projects, Git integration, tasks, runs, machines, knowledge, leader chat, sandbox
policy, notifications, costs and audit. It is self-hosted by small teams. GitHub Actions, GitLab Runner, Buildkite and
Coder all use one central control plane with thin agents that call out.

## Decision

One hub package (`apps/hub`) and one container image. Business logic lives in modules under `src/modules/<name>`,
each exposing only `index.ts`; dependency-cruiser (`pnpm deps`) fails the build on deep imports, cycles or imports of
`app.ts`/`main.ts`. The process runs roles selected by `HIVE_ROLES`: `api` (HTTP, MCP, SSE, worker gateway) and
`jobs` (pg-boss workers and schedules).

## Consequences

- Good: one deploy unit, in-process calls inside one transaction, boundaries checked in CI.
- Good: roles can be split into separate containers later.
- Bad: only one `api` process is supported today, because offers go out over sockets that process holds (SRS NFR-15).

## Alternatives considered

- Separate services per area: more operations work than a small self-hosted team needs.
- Separate `gateway` and `collab` roles (original notes): not built; the gateway lives in `api` and there is no
  collaborative editing service.

## Links

- [add.md section 5](../add.md#5-building-block-view), SRS NFR-13, NFR-15
