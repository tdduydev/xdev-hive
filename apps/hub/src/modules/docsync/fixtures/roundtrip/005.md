# 0003. Keep PostgreSQL as the only stateful dependency

- Status: Accepted
- Date: 2026-10-11 (amended 2026-10-12 to match the code)
- Deciders: maintainers

## Context

Self-hosting teams want few moving parts. The hub needs relational data, a job queue, live notifications for run
streams, full-text and vector search for memory, and storage for run logs.

## Decision

PostgreSQL 18 does all of it: pg-boss (schema `pgboss`) for jobs, `LISTEN/NOTIFY` for run updates, `tsvector` plus
optional pgvector for memory search, and `bytea` chunks in `run_logs`. Jobs are enqueued inside the business
transaction (`enqueue(..., { tx })`), so a job exists exactly when its change commits.

## Consequences

- Good: one database to run, back up (`deploy/backup.sh`) and restore.
- Good: transactional enqueue removes the need for an outbox table.
- Bad: run logs grow in the database; archival to object storage is planned, not built.
- Bad: `NOTIFY` takes a global lock at commit, so it carries only run ids, and log notifications are batched to at
  most one per run every 200 ms.

## Alternatives considered

- Outbox table with a relay (original notes): not needed with transactional pg-boss enqueue.
- S3-compatible blob store for logs and artifacts (original notes): deferred until logs outgrow PostgreSQL.
- Redis or a message broker: another service to operate.

## Links

- [add.md section 8.5](../add.md#85-background-jobs), [0001](0001-modular-monolith-hub.md)
