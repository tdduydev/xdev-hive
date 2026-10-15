# 0002. Write the hub and web app in TypeScript and the worker in Go

- Status: Accepted
- Date: 2026-10-11
- Deciders: maintainers

## Context

The hub needs the MCP SDK, Better Auth and shared types with the React web app. The worker runs all day on developer
machines (macOS, Linux, Windows), drives PTYs including ConPTY, and is bundled into the desktop app, so its size and
start-up cost matter.

## Decision

Hub and web in TypeScript on Node 24, executed without a build step (imports carry `.ts`). Worker, runner host and
egress proxy in Go as a separate module in `worker/`, released as static binaries for six platforms.

## Consequences

- Good: mature MCP and auth libraries; one type system from database to browser.
- Good: small, dependency-free worker binaries (about 8 MB).
- Bad: protocol types exist twice (TypeScript and Go) and must be kept in step ([0005](0005-contract-first-api.md)).

## Alternatives considered

- Worker in TypeScript with Bun: binaries of roughly 60 to 90 MB (estimate in decisions.md).
- Hub in Go: weaker MCP and authentication ecosystem at the time.

## Links

- [decisions.md](../decisions.md) section Stack
