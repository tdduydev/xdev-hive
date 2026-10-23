# 0032. Give every client write an idempotency key, and queue machine writes in the worker outbox

- Status: Accepted
- Date: 2026-10-23
- Deciders: Project owner
- Accepted: plan of spec 027 settled by the project owner on 2026-10-21 (P1–P3); this record writes it down

## Context

Spec [027](../../specs/027-hub-client-model/spec.md) makes the hub a coordinator: it keeps data and progress, it does not
run agents, and it never calls into a machine. Machines and their clients (desktop app, `hive` CLI, the `hive mcp`
proxy, VS Code) therefore keep working while the hub is away and send their writes later. Before this decision:

- MCP tools and oRPC procedures wrote straight to the hub; a call that timed out after the hub had committed was either
  lost or written twice when the client tried again;
- each client handled "hub away" on its own, or not at all, so the order between clients on one machine was lost;
- the hub could not tell a write it refused (task cancelled, no permission) from a write it never received.

Requirements: 027 FR-001 … FR-006 (one write contract, source, history), FR-011 … FR-018 (outbox, groups, identity),
constitution VII (no new always-on service, state in Postgres or on disk).

## Decision

1. **One write contract.** Every client write over `/mcp` and `/rpc` may carry `Idempotency-Key` (16–64 characters
   from `A-Za-z0-9_-`, a ULID in practice), `X-Hive-Source` (`worker-run`, `worker`, `desktop`, `hive-cli`, `mcp-local`, `vscode`, `web`),
   `X-Hive-Machine`, `X-Hive-Created-At` and `X-Hive-Client`. Names and limits live in
   `packages/contracts/src/client-events.ts` (`CLIENT_EVENT_HEADERS`).
2. **One table, same transaction.** The hub records each keyed write in `hive.client_events` with
   `UNIQUE (org_id, idempotency_key)` and forced RLS, inside the same transaction as the business write
   (`withClientEvent` in `platform`). Two shared places call it, so tools and procedures do not each handle keys:
   - `runTool` in `mcp/server.ts` for every tool registered with `writes: true`;
   - `runClientWrite` in `platform/client-write.ts`, which an oRPC handler calls instead of opening its own transaction
     (first user: `memory.write`).
3. **Outcomes.** The result is `accepted`, `duplicate` or `rejected`, returned in the MCP tool result
   `_meta["dev.xdev.hive/clientEvent"]` and in the `Hive-Client-Event` response header for oRPC.
   - A resend with the same key returns the stored response and `duplicate`; the handler does not run again.
   - A business error (`Forbidden`, `NotFound`, `Conflict`, `BadRequest`) rolls the write back and is stored as
     `rejected` with its code and Vietnamese reason in a second transaction. A resend gets the same code (oRPC: 409),
     so a write refused once is never accepted later in a different state.
   - 5xx, 429 and network errors are not outcomes: the client keeps the item and tries again.
4. **Old clients.** A write without a key runs as before and is counted (`noteMissingKey`); a malformed key is refused
   with `IDEMPOTENCY_KEY_INVALID` before anything is written, because running it unkeyed would make the resend a second
   write.
5. **History.** `tasks.history` merges the client events that target a task or its runs with the run state changes,
   ordered by the time the hub received them, and shows source, machine, person, client time and rejection reason.
6. **Outbox in `hive-worker`.** Package `worker/internal/outbox` keeps one queue per OS user and hub identity, one JSON
   file per item under `DataDir/outbox/<identity key>/` (0600, directory 0700, DACL on Windows). Every client on the
   machine writes through the worker's local socket (ADR 0019): `outbox.submit` stores the item first, tries to send it
   and waits up to `waitMs` (10 s by default), then answers `accepted`, `duplicate`, `rejected` or `queued`.
7. **Groups.** `CLIENT_WRITE_TOOLS` in contracts puts each write kind in `progress`, `proposal` or `immediate`; the
   fixture `client-write-tools.json` keeps the Go copy in step. While the hub is away, `progress` and `proposal` items
   wait; `immediate` writes and reads fail with "Hub đang vắng". Items are sent in order per stream (task or target);
   an item `held` for a person (login required, identity mismatch) blocks only its own stream.
8. **Identity.** An item records `hubUrl`, `orgId` and `userId` when it is made. The worker reads the person's token
   from the OS keychain when it sends, and holds the item when the current login is someone else. Tokens are never
   written into an item.

## Consequences

- Good: a retry after a timeout cannot write twice, and a refused write stays refused; clients can retry blindly.
- Good: one queue keeps the order between the desktop app, the CLI and agents on the same machine.
- Good: no tool schema changes; agents do not see keys.
- Bad: `client_events` grows with every keyed write and needs a retention job (follow-up in 027 tasks).
- Bad: work before the transaction (embedding a memory, preparing a tool) may run again on a resend, even though the
  write itself does not.
- Bad: oRPC writes do not check `X-Hive-Machine` against the caller's machines yet; MCP writes do.
- Bad: the outbox can only be as safe as the worker's disk; an item deleted by hand is lost.

## Alternatives considered

- Key in MCP `tools/call` `_meta` only: does not exist for oRPC. Still read as a fallback
  (`dev.xdev.hive/idempotencyKey`).
- One key column per business table: more than 15 tools and tables to change, and no common history.
- Keep keys in memory or Redis: lost on restart, against constitution VII.
- SQLite in the worker: adds a driver; files are enough for the size limit and readable when broken.
- A queue per client: loses order between clients and repeats the size limit in three places.
- Queue only when a direct call fails: a call that timed out after the hub committed would still be ambiguous.

## Links

- Spec 027 FR-001 … FR-006, FR-011 … FR-018; research R1 … R6, R16; tasks T001 … T025.
- ADR [0019](0019-hive-cli-and-remote-sessions.md) (local socket), [0036](0036-machine-sends-token-score.md)
  (first client event kind), [0033](0033-machine-keys-and-run-git-tokens.md) (planned, machine keys).
