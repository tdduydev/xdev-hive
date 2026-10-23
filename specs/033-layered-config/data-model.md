# Data Model: Layered configuration

## Registry entry (code, not a table)

| Field | Meaning |
|---|---|
| `key` | Stable id, for example `limits.perRunUsd` |
| `group` | `agent`, `limits`, `project` |
| `kind` | `ceiling`, `override`, `additive` |
| `layers` | Layers allowed to set it (`instance`, `org`, `team`, `project`) |
| `schema` | zod schema of one value |
| `default` | Value when no layer sets it; equals today's code default |
| `safe` | Value a client uses when its snapshot is too old (only for settings that widen permissions) |
| `dangerous` | Loosening needs `policies.fullaccess` |
| `merge` | Ceiling only: `restrictive-bool`, `min-number`, `scale` (with ordered list) |

## Table `config_layer_entries` (new, RLS forced)

| Column | Type | Notes |
|---|---|---|
| `org_id` | uuid, default `hive.ctx_org()` | RLS key |
| `layer` | text, `org` or `team` (check) | `project` and `instance` are not stored here |
| `target_id` | uuid | org id for `org`, team id for `team` |
| `key` | text | registry key |
| `value` | jsonb, nullable | null means "no value, only the lock flag" |
| `locked` | boolean, default false | lower layers cannot change it |
| `version` | integer, default 1 | optimistic concurrency |
| `updated_by` | text | user id |
| `updated_at` | timestamptz | |

Primary key `(org_id, layer, target_id, key)`. Policy `config_layer_entries_rw` for `hive_app`, `org_id = hive.ctx_org()`.
Team deletion removes its rows in the same transaction as before (checked by test), and the table has no foreign key to
`teams` so module boundaries stay clean; a stale row for a missing team is ignored on read.

## Effective setting (response)

`key`, `value`, `source { layer, targetId }`, `lock { layer } | null`, `overCeiling { layer, targetId, value } | null`,
`chain` (per layer value, filtered by the viewer's rights; the MVP returns the chain only to users allowed to write
the project settings).

## Snapshot

`projectId`, `schemaVersion`, `generatedAt`, `configVersion`, `settings[]` (effective settings without chain).
