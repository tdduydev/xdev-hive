# 0036. Send the token score as a machine client event

- Status: Accepted
- Date: 2026-10-21
- Deciders: Project owner

## Context

Spec [025](../../specs/025-token-score/spec.md) US6 (Q5) lets administrators see each machine's token optimization
score on the web. Its plan (section 9) had the desktop app post the score with the user's personal token. On
2026-10-20 the project owner put T010/T011 on hold until spec [027](../../specs/027-hub-client-model/spec.md) had a plan,
because 027 decides how clients write to the hub:

- every client write carries an idempotency key and a source (027 FR-001, FR-004);
- writes made while the hub is away wait in the `hive-worker` outbox (FR-011, FR-012);
- the hub only receives numbers, enums and reason codes from machines, never paths or account data (FR-050, 025
  FR-015);
- machines authenticate as machines with a machine key and short-lived tokens, not with a person's token (FR-020,
  FR-021).

The 027 plan ([research R16](../../specs/027-hub-client-model/research.md)) names this event kind `machine.token_score`.
The outbox ([ADR 0032](0032-client-events-and-outbox.md), planned) and machine keys
([ADR 0033](0033-machine-keys-and-run-git-tokens.md), planned) are not built yet; this decision must work before and
after they land.

## Decision

1. **Event.** The token score is a 027 client event of kind `machine.token_score`, source `worker`, posted to
   `POST /api/v1/client-events` with body `{ key, kind, createdAt, payload }`. `key` is a ULID made once per score
   snapshot, so resending the same snapshot is a duplicate.
2. **Sender and identity.** `hive-worker optimize score` sends the report after it records the score history. The
   identity is the machine: the hub takes `org_id`, `team_id` and `machine_id` from the credential, never from the
   body. Until ADR 0033 lands the credential is the existing machine token (`hwm_`); afterwards the endpoint accepts only
   the machine access token, following the 027 FR-021 transition.
3. **Opt-in.** Sending is off by default and set per machine with `hive-worker optimize report on|off` (the desktop
   Token screen toggles it). Nothing is sent while it is off, while the machine is not registered, or more often than
   once an hour.
4. **Payload.** A strict schema (`tokenScoreReport` in `packages/contracts/src/client-events.ts`) with only numbers,
   enums and fixed reason codes: `scoreVersion`, `generatedAt`, `days`, the machine score, level, coverage and
   provisional flag, and per CLI the score, coverage, share, group totals and each criterion's id, status, earned, max,
   measured value, unit and reason code. Profile ids, labels, e-mails, project keys, paths, criterion items and warnings
   are not part of the schema, so the hub rejects a body that carries them.
5. **Hub storage.** The hub records the event in `hive.client_events` (the first slice of 027 US1: the table and
   `withClientEvent`, used only by this endpoint until the rest of US1 lands) and the report in
   `hive.machine_token_scores` (module `fleet`), both with forced RLS. Reports are kept 90 days. A report less than 10
   minutes after the previous one for the same machine is `rejected` with `TOKEN_SCORE_TOO_FREQUENT`.
6. **Hub away.** Until the outbox lands, the worker keeps at most one unsent report in
   `~/.xdev-hive/optimizer/score-report.json` and retries it on the next score run. A newer snapshot replaces an unsent
   older one: the score is a latest-value reading, and the history stays on the machine. When the outbox lands, the
   worker submits the same body with the same key to it instead, group `progress`.
7. **Who reads it.** The latest score shows in the machine list and its detail with the same permission as the list
   (team administrators of the machine's team, organization administrators). The machine's owner sees their own machine.

## Consequences

- Good: 025 T010/T011 follow the 027 contract from the start; nothing changes for the user when the outbox and machine
  keys land.
- Good: the strict schema makes the "numbers only" promise of 025 FR-015 enforceable on the hub, not only in the client.
- Good: `client_events` exists and is tested before the larger 027 US1 work starts.
- Bad: until ADR 0033 lands, the score uses a long-lived machine token; this is the same token the worker already uses
  for its WebSocket, so it adds no new secret.
- Bad: until the outbox lands only the latest unsent report survives a long hub outage.

## Alternatives considered

- Desktop posts with the personal token (025 plan section 9): ties a machine reading to a person and needs an owner
  check per ADR 0017; 027 moves machine data to machine identity.
- Send the score over the worker WebSocket as a new protocol message: only works while the worker is connected and
  bypasses the client-event contract that the outbox will use.
- Wait for ADR 0032 and 0033 before T010: blocks a small feature on the largest parts of 027 for weeks.

## Links

- Spec 025 US6, FR-015, FR-016; tasks T010, T011.
- Spec 027 FR-001, FR-004, FR-011, FR-012, FR-020, FR-021, FR-050; plan research R1, R5, R16.
- ADR 0017 (personal and shared machines), ADR 0032 and 0033 (planned).
