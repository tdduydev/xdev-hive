# 0005. Define APIs and the worker protocol contract-first in zod

- Status: Accepted
- Date: 2026-10-11 (amended 2026-10-12 for hand-written Go protocol types)
- Deciders: maintainers

## Context

The web app, the Go worker and third parties call the hub. Types must not drift between them.

## Decision

`packages/contracts` holds every API as oRPC contracts with zod schemas. The hub serves the same router as oRPC
(`/rpc`, for the web app) and OpenAPI (`/api/v1`). `pnpm openapi` writes `openapi.json`; CI fails on drift; the Go REST
client is generated from it. The worker protocol is zod in `worker-protocol.ts`; the Go message types are written by
hand and kept in step by a shared fixture file that both test suites round-trip.

## Consequences

- Good: one source of truth; drift fails CI.
- Bad: Go protocol types need manual edits, guarded by the fixture test.

## Alternatives considered

- Generating Go protocol types with oapi-codegen (original notes): the protocol is not an OpenAPI surface; the fixture
  test gives the same guarantee with simpler code.
- PostgREST as the main API: the hub mostly orchestrates and calls out, which PostgREST does not fit.

## Links

- [add.md section 8.4](../add.md#84-contracts-and-code-generation), SRS IF-01, IF-02
