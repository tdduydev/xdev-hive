# Event automation

Hub-admin RPC in `/api/rpc`:

- `automation.list`: saved rules (maximum 100).
- `automation.save`: create/update a rule; `enabled: false` pauses it. Saving binds execution to the saving user's account or token. New rules default to paused.
- `automation.dryRun`: `{id, event}` evaluates the project, trigger and conditions without writing or executing. It returns the action and explicitly reports that execution permissions have not been checked.
- `automation.history`: latest 200 execution receipts, including status, attempts, error code and timestamp.
- `automation.retry`: `{id}` manually retries a failed or pending receipt, up to three total attempts. Paused rules, modified actions/owners/conditions that no longer match, completed and uncertain executions cannot be replayed.

Example `automation.save` input:

```json
{
  "name": "Investigate high severity incident",
  "project": "demo",
  "trigger": "alert.opened",
  "enabled": false,
  "conditions": [{"path": "alert.severity", "equals": "high"}],
  "action": {
    "method": "tasks.create",
    "input": {"project": "demo", "id": "INCIDENT-1", "title": "Investigate incident"}
  }
}
```

Triggers reuse committed `onEvent` events: `proposal.created`, `memory.pending`, `run.failed`, `mr.created`, `run.ciLimit`, `alert.opened`. All conditions must hold; equality is strict and paths traverse own properties only. Actions are limited to `tasks.create` and `memory.write`, in the same project. Inputs use existing method schemas. Inputs are static; a fixed task ID succeeds once and later distinct events produce a duplicate-task failure. There is no templating or shell execution.

Execution re-resolves the owner from the current user/token stores. Removed tokens, disabled users, downgraded roles and changed project grants take effect on the next execution. Actions pass through `SqliteHive.call`, preserving existing authorization, project archival, policy, approval and audit checks. Generated events carry `automation: true`; the automation listener suppresses them while other listeners still receive them.

SQLite receipts deduplicate by rule and event entity identity (type/project/entity ID; machine/run ID for run notices). Changes to incidental payload fields do not bypass dedupe. A receipt is claimed before execution, so concurrent deliveries execute once. Errors store codes, not thrown messages. On hub startup, interrupted `running` receipts become `uncertain`: a crash may have occurred after the action committed, so these are never automatically retried. Pending/failed receipts require a manual retry; no automatic catch-up or backoff is implemented.

This increment exposes the admin API and engine. A visual rule editor, additional action types, dynamic input mapping, receipt retention and external-effect recovery are outside this implementation.

Validation: `node --test apps/web/test/automation.test.ts`, `npm run typecheck`, `npm test`.
