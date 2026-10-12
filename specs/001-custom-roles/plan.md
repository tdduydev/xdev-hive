# Implementation Plan: Custom Roles and Permissions

**Branch**: `001-custom-roles` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-custom-roles/spec.md`

## Summary

Implement custom roles and hierarchical permissions tree for xDev Hive. This feature allows organization administrators
to create custom roles (e.g. "Merge reviewer", "Auditor"), configure granular permission nodes grouped by areas, and
assign these roles to members and teams. System roles (`owner`, `admin`, `member`, `teamAdmin`, `viewer`) remain immutable
but cloneable.

## Technical Context

**Language/Version**: TypeScript 5.8+ (Node.js 24 runtime, Hono + oRPC on Hub, React 19 on Web)

**Primary Dependencies**: `@xdev-hive/contracts`, `drizzle-orm`, `zod`, `@tanstack/react-query`, shadcn/ui (Base UI)

**Storage**: PostgreSQL 18 with Row-Level Security (RLS) enabled and forced on all new tables

**Testing**: Vitest (`*.db.test.ts` for database & RLS, unit tests for permission evaluator), Playwright for UI

**Target Platform**: Linux (Hub), Modern Web Browsers (Web)

**Project Type**: Web application + Modular monolith API backend

**Performance Goals**: Permission check execution overhead < 2ms per request via request-scoped memoization

**Constraints**: Tenant isolation enforced at database level with `hive_app` role; zero cross-tenant leakage

**Scale/Scope**: Up to 50 custom roles per organization, ~60 leaf permission keys, up to 10,000 members per org

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **Principle I (Contract first)**: All role and permission models defined in `packages/contracts/src/roles.ts`; `pnpm openapi` run and `openapi.json` committed.
- [x] **Principle II (Tenant isolation)**: All queries use `withTenant()`. Tables `custom_roles`, `role_permissions`, `member_custom_roles`, and `team_custom_roles` have RLS enabled and forced with `org_id = hive.ctx_org()`.
- [x] **Principle III (Module boundaries)**: Implemented in `apps/hub/src/modules/tenancy/`, exported through `apps/hub/src/modules/tenancy/index.ts`.
- [x] **Principle IV (Tested before merged)**: Covered by unit tests and `roles.db.test.ts` with Testcontainers PostgreSQL; Playwright test for `/admin/roles`.
- [x] **Principle V (Secure by default)**: Privilege escalation prevented; administrators cannot grant permissions they do not possess.
- [x] **Principle VI (Vietnamese for people, English for code)**: Identifiers in English; UI and error messages in Vietnamese with i18n support.
- [x] **Principle VII (Simple to self-host)**: PostgreSQL only; no external auth service or cache server needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-custom-roles/
├── spec.md
└── plan.md
```

### Source Code

```text
packages/contracts/src/
└── roles.ts                           # Zod schemas for roles, permission tree, assignment contracts

apps/hub/src/modules/tenancy/
├── schema.ts                          # Drizzle schema: custom_roles, role_permissions, member_custom_roles, team_custom_roles
├── permissions-tree.ts                # Permission hierarchy catalog, leaf definitions, danger flags
├── permissions-service.ts             # Permission evaluation & effective role resolver
├── roles-router.ts                    # oRPC routes for roles CRUD and assignment
└── roles.db.test.ts                   # Database and RLS tests for roles

apps/web/src/
├── routes/admin/roles.tsx             # Roles management screen (/admin/roles based on Roles.dc.html)
└── components/roles/
    ├── role-nav.tsx                   # Role groups sidebar (org, team, custom)
    └── permission-tree.tsx            # Interactive collapsible permission tree with tri-state checkboxes
```

**Structure Decision**: Extend existing `tenancy` module in `apps/hub` since roles directly bind to `org_members` and `team_members`.

---

## Database Design (Schema & RLS)

### New Tables

```sql
-- apps/hub/db/migrations/xxxx_custom_roles.sql

CREATE TABLE hive.custom_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  scope text NOT NULL DEFAULT 'org' CHECK (scope IN ('org', 'team')),
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_roles_org_name UNIQUE (org_id, name)
);

CREATE TABLE hive.role_permissions (
  org_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES hive.custom_roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key),
  CONSTRAINT role_permissions_role_org FOREIGN KEY (role_id, org_id) REFERENCES hive.custom_roles(id, org_id) ON DELETE CASCADE
);

CREATE TABLE hive.member_custom_roles (
  org_id uuid NOT NULL,
  user_id text NOT NULL,
  role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, role_id),
  CONSTRAINT member_custom_roles_role FOREIGN KEY (role_id, org_id) REFERENCES hive.custom_roles(id, org_id) ON DELETE CASCADE
);

CREATE TABLE hive.team_custom_roles (
  org_id uuid NOT NULL,
  team_id uuid NOT NULL,
  role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, team_id, role_id),
  CONSTRAINT team_custom_roles_role FOREIGN KEY (role_id, org_id) REFERENCES hive.custom_roles(id, org_id) ON DELETE CASCADE
);

-- RLS Enforcement
ALTER TABLE hive.custom_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.custom_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_roles_rw ON hive.custom_roles
  FOR ALL TO hive_app
  USING (org_id = hive.ctx_org())
  WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_rw ON hive.role_permissions
  FOR ALL TO hive_app
  USING (org_id = hive.ctx_org())
  WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.member_custom_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.member_custom_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY member_custom_roles_rw ON hive.member_custom_roles
  FOR ALL TO hive_app
  USING (org_id = hive.ctx_org())
  WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.team_custom_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.team_custom_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY team_custom_roles_rw ON hive.team_custom_roles
  FOR ALL TO hive_app
  USING (org_id = hive.ctx_org())
  WITH CHECK (org_id = hive.ctx_org());
```

---

## Contracts & API Design

Exported from `packages/contracts/src/roles.ts`:

- `GET /roles`: List all system roles and custom roles with member counts and granted permission counts.
- `GET /roles/tree`: Retrieve hierarchical permission taxonomy schema with localized labels and danger flags.
- `POST /roles`: Create custom role (`name`, `description`, `scope`, `permissionKeys: string[]`).
- `GET /roles/{roleId}`: Get single role details with complete list of granted permissions.
- `PATCH /roles/{roleId}`: Update custom role details and permission keys.
- `DELETE /roles/{roleId}`: Delete custom role (returns `CONFLICT` if currently assigned to members or teams).
- `POST /roles/{roleId}/clone`: Clone an existing role into a new custom role with a new name.
- `POST /members/{userId}/custom-roles`: Assign custom role to organization member.
- `DELETE /members/{userId}/custom-roles/{roleId}`: Unassign custom role from member.
- `POST /teams/{teamId}/custom-roles`: Assign custom role to team.
- `DELETE /teams/{teamId}/custom-roles/{roleId}`: Unassign custom role from team.

---

## Permissions & Authorization

- Only callers with `roles.manage` or organization `owner`/`admin` can create, update, or delete custom roles.
- `recordAudit()` invoked on every mutating action:
  - `action`: `roles.create`, `roles.update`, `roles.delete`, `roles.assign`, `roles.unassign`.
  - `targetType`: `custom_role`, `targetId`: `role.id`.
  - `data`: snapshot of permission keys added/removed and recipient user/team.

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Deep permission recursion slows down API requests | High | Pre-compute and flatten leaf permission keys at save time; store in indexed `role_permissions` rows. |
| Inadvertent privilege escalation by delegating role admin | Critical | Check caller permissions before saving: caller must possess every permission they attempt to grant. |
| System roles modified by SQL injection or bugs | High | Enforce database CHECK constraint `is_system = false` on user INSERTs/UPDATEs; immutable system roles defined in code. |

## Complexity Tracking

No violations of constitution principles.
