# Implementation Plan: MCP Tools and External Servers Administration

**Branch**: `003-mcp-tools-admin` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-mcp-tools-admin/spec.md`

## Summary

Implement administration interfaces, database schema, contracts, and enforcement logic for MCP tools, external MCP servers,
and personal developer MCP tokens. Administrators can enable/disable built-in hub tools, configure allow/deny rules for external
MCP servers, and manage the lifecycle of user access tokens.

## Technical Context

**Language/Version**: TypeScript 5.8+ (Hub, Contracts, Web)

**Primary Dependencies**: `@xdev-hive/contracts`, `drizzle-orm`, `zod`, `@tanstack/react-query`, shadcn/ui (DataTable, Tabs)

**Storage**: PostgreSQL 18 with RLS enabled and forced on `mcp_tool_overrides`, `mcp_server_rules`, `mcp_user_tokens`

**Testing**: Vitest (`*.db.test.ts`), Playwright for UI tab navigation and dialog flows

**Target Platform**: Linux (Hub), Modern Web Browsers (Web)

**Project Type**: Web application + Modular monolith API backend

**Performance Goals**: Token authentication check in < 1ms via SHA-256 hash lookup; tool status lookup in memory cache

**Constraints**: Plaintext tokens never stored; SHA-256 hashing used; Deny rules take precedence over allow rules

## Constitution Check

- [x] **Principle I (Contract first)**: New endpoints defined in `packages/contracts/src/mcp-admin.ts`; `pnpm openapi` run and `openapi.json` committed.
- [x] **Principle II (Tenant isolation)**: All queries use `withTenant()`; RLS enabled and forced on all tables with `org_id = hive.ctx_org()`.
- [x] **Principle III (Module boundaries)**: Implemented in `apps/hub/src/modules/mcp/` and exported via `index.ts`.
- [x] **Principle IV (Tested before merged)**: Covered by `mcp-admin.db.test.ts` with Testcontainers.
- [x] **Principle V (Secure by default)**: Tokens hashed with SHA-256; prefix exposed for auditing; deny precedence on servers.
- [x] **Principle VI (Vietnamese for people, English for code)**: UI text and error messages in Vietnamese with i18n support.
- [x] **Principle VII (Simple to self-host)**: PostgreSQL only; no separate Redis token store required.

## Project Structure

### Documentation

```text
specs/003-mcp-tools-admin/
├── spec.md
└── plan.md
```

### Source Code

```text
packages/contracts/src/
└── mcp-admin.ts                       # Schemas for tool overrides, server rules, and token lifecycle

apps/hub/src/modules/mcp/
├── schema.ts                          # Tables: mcp_tool_overrides, mcp_server_rules, mcp_user_tokens
├── admin-service.ts                   # Tool toggle logic, server rules evaluator, token hasher & validator
├── admin-router.ts                    # oRPC router for tools, servers, tokens
└── mcp-admin.db.test.ts               # Test suite for admin operations and RLS

apps/web/src/
├── routes/admin/mcp.tsx               # MCP management screen (/admin/mcp based on McpTools.dc.html)
└── components/mcp/
    ├── tools-tab.tsx                  # Hub tools listing with metrics and toggles
    ├── servers-tab.tsx                # External servers rules table with allow/deny badges
    └── tokens-tab.tsx                 # Personal tokens table, creation dialog, revocation
```

---

## Database Design (Schema & RLS)

```sql
-- apps/hub/db/migrations/xxxx_mcp_admin.sql

CREATE TABLE hive.mcp_tool_overrides (
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_by_user_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, tool_name)
);

CREATE TABLE hive.mcp_server_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  match_pattern text NOT NULL,
  match_type text NOT NULL CHECK (match_type IN ('url', 'name', 'command', 'wildcard')),
  rule text NOT NULL CHECK (rule IN ('allow', 'deny')),
  scope_type text NOT NULL DEFAULT 'org' CHECK (scope_type IN ('org', 'project')),
  project_id uuid REFERENCES hive.projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hive.mcp_user_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  client_id text NOT NULL,
  lifetime_days integer NOT NULL DEFAULT 30,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS Enforcement
ALTER TABLE hive.mcp_tool_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.mcp_tool_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_tool_overrides_rw ON hive.mcp_tool_overrides
  FOR ALL TO hive_app
  USING (org_id = hive.ctx_org())
  WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.mcp_server_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.mcp_server_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_server_rules_rw ON hive.mcp_server_rules
  FOR ALL TO hive_app
  USING (org_id = hive.ctx_org())
  WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.mcp_user_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.mcp_user_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_user_tokens_rw ON hive.mcp_user_tokens
  FOR ALL TO hive_app
  USING (org_id = hive.ctx_org())
  WITH CHECK (org_id = hive.ctx_org());
```

---

## Contracts & API Design

Exported from `packages/contracts/src/mcp-admin.ts`:

- `GET /mcp/admin/tools`: List hub tools with enablement status, 7-day call count, and error count.
- `PATCH /mcp/admin/tools/{toolName}`: Update enablement status (`enabled: boolean`).
- `GET /mcp/admin/servers`: List external server rules (filters by scope, rule, search).
- `POST /mcp/admin/servers`: Create external server rule (`name`, `matchPattern`, `matchType`, `rule`, `scopeType`, `projectId`).
- `PATCH /mcp/admin/servers/{id}`: Edit external server rule.
- `DELETE /mcp/admin/servers/{id}`: Delete external server rule.
- `GET /mcp/admin/tokens`: List user tokens (prefix, owner, client, expiration, last used).
- `POST /mcp/admin/tokens`: Generate token (`clientId`, `lifetimeDays`) -> returns plaintext token once.
- `POST /mcp/admin/tokens/{id}/extend`: Extend token expiration by specified days.
- `POST /mcp/admin/tokens/{id}/revoke`: Immediately revoke token.

---

## Permissions & Authorization

- Managing tool overrides and server rules requires `owner` or `admin` organization role (or custom role with `mcp.manage`).
- Creating and revoking personal tokens requires `member` or higher (`mcp.tokens`).
- Mutating operations invoke `recordAudit()`:
  - `action`: `mcp.tool_toggle`, `mcp.server_rule_create`, `mcp.server_rule_delete`, `mcp.token_create`, `mcp.token_revoke`.
  - `targetType`: `mcp_tool` | `mcp_server_rule` | `mcp_token`.
  - `targetId`: entity ID or tool name.

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Token leakage from browser memory or network logs | Critical | Return plaintext token only in the response body of `POST /tokens`; never log authorization headers. |
| Overly broad wildcard allow rule permits insecure MCP commands | High | Enforce "Deny wins over allow" precedence; warn admin in UI when adding wildcard allow rules. |
| High database traffic on token authentication | Medium | Add unique index on `token_hash`; cache active token validation results in server memory for 60 seconds. |

## Complexity Tracking

No violations of constitution principles.
