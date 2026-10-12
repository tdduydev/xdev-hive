# Implementation Plan: Audit Log Viewer and Export

**Branch**: `007-audit-log-viewer` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-audit-log-viewer/spec.md`

## Summary

Implement query API, multi-faceted filtering, cursor pagination, and CSV/JSON export for the existing append-only
`hive.audit_log` table. Add composite database indexes for performant time-range and facet filtering, and implement the
web UI (`/admin/audit`) for organization administrators and auditors.

## Technical Context

**Language/Version**: TypeScript 5.8+ (Hub, Contracts, Web)

**Primary Dependencies**: `@xdev-hive/contracts`, `drizzle-orm`, `zod`, `@tanstack/react-query`, fast-csv

**Storage**: PostgreSQL 18 with RLS enabled and forced on `audit_log`

**Testing**: Vitest (`audit.db.test.ts`), Playwright for audit viewer filters and export triggers

**Target Platform**: Linux (Hub), Modern Web Browsers (Web)

**Project Type**: Web application + Modular monolith API backend

**Performance Goals**: Keyset pagination query latency < 50ms; CSV stream generation > 5,000 rows/second

**Constraints**: `audit_log` remains strictly append-only for `hive_app`; no update or delete permissions; 365-day retention

## Constitution Check

- [x] **Principle I (Contract first)**: Query and export contracts defined in `packages/contracts/src/audit.ts`; `pnpm openapi` run and `openapi.json` committed.
- [x] **Principle II (Tenant isolation)**: All queries use `withTenant()`; RLS enforced on `audit_log` using `org_id = hive.ctx_org()`.
- [x] **Principle III (Module boundaries)**: Implemented in `apps/hub/src/modules/audit/`, exported via `index.ts`.
- [x] **Principle IV (Tested before merged)**: Covered by `audit.db.test.ts` verifying keyset pagination and filtering correctness.
- [x] **Principle V (Secure by default)**: Read access restricted to `owner`, `admin`, or custom roles with `audit.read`; no secret fields leaked in `data`.
- [x] **Principle VI (Vietnamese for people, English for code)**: UI text and error messages in Vietnamese with i18n support.
- [x] **Principle VII (Simple to self-host)**: PostgreSQL only; no external Elasticsearch or OpenSearch cluster needed.

## Project Structure

### Documentation

```text
specs/007-audit-log-viewer/
├── spec.md
└── plan.md
```

### Source Code

```text
packages/contracts/src/
└── audit.ts                           # Schemas: AuditQueryInput, AuditLogItem, AuditExportFormat, FacetCounts

apps/hub/src/modules/audit/
├── schema.ts                          # Additional composite indexes on hive.audit_log
├── query-service.ts                   # Keyset cursor pagination, multi-facet filtering, CSV/JSON streaming
├── router.ts                          # oRPC endpoints for audit log list, facets, and export
└── audit.db.test.ts                   # DB integration tests for query performance, cursor, RLS

apps/web/src/
├── routes/admin/audit.tsx             # Audit log viewer screen (/admin/audit based on Audit.dc.html)
└── components/audit/
    ├── audit-table.tsx                # DataTable with avatar, action badge, source, result
    └── export-menu.tsx                # Export to CSV / JSON actions
```

---

## Database Design (Schema & Indexes)

The `hive.audit_log` table already exists. We add composite indexes to optimize multi-faceted filtering and keyset pagination:

```sql
-- apps/hub/db/migrations/xxxx_audit_log_indexes.sql

-- Index for time-range filtering and keyset pagination (created_at DESC, id DESC)
CREATE INDEX IF NOT EXISTS audit_log_org_created_id
  ON hive.audit_log (org_id, created_at DESC, id DESC);

-- Index for filtering by action within an organization
CREATE INDEX IF NOT EXISTS audit_log_org_action_created
  ON hive.audit_log (org_id, action, created_at DESC);

-- Index for filtering by actor within an organization
CREATE INDEX IF NOT EXISTS audit_log_org_actor_created
  ON hive.audit_log (org_id, actor_user_id, created_at DESC);

-- Verify RLS is enabled and forced
ALTER TABLE hive.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.audit_log FORCE ROW LEVEL SECURITY;
```

---

## Contracts & API Design

Exported from `packages/contracts/src/audit.ts`:

- `GET /audit`: Query audit events.
  - Query parameters:
    - `cursor`: Opaque base64 token containing `created_at` and `id` of the last record.
    - `limit`: Number of records (default: 20, max: 100).
    - `range`: Time range in days (`1`, `7`, `30`, `365`).
    - `actorType`: `'user' | 'run' | 'system'`.
    - `actorId`: Specific actor identifier.
    - `area`: `'work' | 'know' | 'proj' | 'people' | 'agent'`.
    - `action`: Specific action name (e.g. `members.invite`, `runs.cancel`).
    - `source`: `'web' | 'mcp' | 'hub'`.
    - `result`: `'ok' | 'denied'`.
    - `q`: Search keyword.
  - Response: `{ items: AuditLogItem[], nextCursor: string | null, totalMatching?: number }`.
- `GET /audit/export`: Stream export of audit events matching query filters.
  - Query parameters: Same filters as `GET /audit` + `format: 'csv' | 'json'`.
  - Response: Chunked HTTP stream with `Content-Type: text/csv` or `application/json`.

---

## Permissions & Authorization

- Access to `GET /audit` and `GET /audit/export` requires organization role `owner` or `admin`, or a custom role with `audit.read` / `audit.export`.
- Every export download is itself logged into `audit_log` with action `audit.export`.

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Deep page offset scans degrade PostgreSQL database performance | High | Strictly use keyset (cursor) pagination using `(created_at, id) < (cursor_time, cursor_id)`; disallow `OFFSET`. |
| Memory exhaustion from massive unconstrained CSV exports | High | Stream results from database directly to HTTP response in 500-row chunks; enforce maximum export limit of 20,000 rows per request. |

## Complexity Tracking

No violations of constitution principles.
