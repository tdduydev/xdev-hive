# Implementation Plan: Organization Agent Policies

**Branch**: `002-agent-policies` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-agent-policies/spec.md`

## Summary

Implement centralized organization agent governance and policies. The hub stores organization policies (models, CLI permissions,
hooks, instruction files, global limits), enforces them during run scheduling and dispatch, pushes policy snapshots to workers
in `job_offer` messages, and automates PR updates for template files across project repositories.

## Technical Context

**Language/Version**: TypeScript 5.8+ (Hub & Contracts), Go 1.24+ (Worker for hook execution)

**Primary Dependencies**: `@xdev-hive/contracts`, `drizzle-orm`, `zod`, `pg-boss` (for PR sync background jobs)

**Storage**: PostgreSQL 18 with RLS enabled and forced on `agent_policies` table

**Testing**: Vitest (`*.db.test.ts`), Worker Go tests (`runner_test.go` for hook execution), Playwright for UI

**Target Platform**: Linux (Hub), macOS/Linux/Windows (Worker)

**Project Type**: Web application + Hub backend + Worker execution runner

**Performance Goals**: Effective policy resolution completed in < 1ms during run matching; template sync PRs batched without blocking HTTP requests

**Constraints**: Projects cannot override or exceed organization ceilings; policy snapshots are immutable per run attempt

## Constitution Check

- [x] **Principle I (Contract first)**: Schemas defined in `packages/contracts/src/policies.ts`; worker protocol updated if new optional fields added.
- [x] **Principle II (Tenant isolation)**: `agent_policies` table uses `org_id` with `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
- [x] **Principle III (Module boundaries)**: Managed inside `apps/hub/src/modules/platform/` or dedicated `apps/hub/src/modules/governance/` module with public exports via `index.ts`.
- [x] **Principle IV (Tested before merged)**: Covered by DB test suite and worker Go tests verifying hook execution order.
- [x] **Principle V (Secure by default)**: Deny wins over allow; gVisor sandbox enforced when configured.
- [x] **Principle VI (Vietnamese for people, English for code)**: UI strings and API error responses in Vietnamese.
- [x] **Principle VII (Simple to self-host)**: Background sync jobs run on pg-boss inside existing PostgreSQL instance.

## Project Structure

### Documentation

```text
specs/002-agent-policies/
├── spec.md
└── plan.md
```

### Source Code

```text
packages/contracts/src/
└── policies.ts                        # Schemas: AgentPolicy, HookDefinition, TemplateSyncInput, GlobalLimits

apps/hub/src/modules/governance/
├── schema.ts                          # Table: agent_policies with RLS
├── service.ts                         # Policy resolver, clamping logic, template renderer
├── sync-job.ts                        # pg-boss worker creating PRs for instruction templates
├── router.ts                          # oRPC endpoints for policy read/update/preview
└── policies.db.test.ts                # DB and RLS tests

worker/internal/runner/
└── hooks.go                           # Go execution logic for PreToolUse, PostToolUse, Stop hooks
```

---

## Database Design (Schema & RLS)

```sql
-- apps/hub/db/migrations/xxxx_agent_policies.sql

CREATE TABLE hive.agent_policies (
  org_id uuid PRIMARY KEY REFERENCES hive.orgs(id) ON DELETE CASCADE,
  allowed_models jsonb NOT NULL DEFAULT '{"claude": ["claude-sonnet-5-5"], "codex": ["gpt-5-codex"], "gemini": ["gemini-2.5-pro"]}'::jsonb,
  never_auto_upgrade boolean NOT NULL DEFAULT true,
  default_permission_mode text NOT NULL DEFAULT 'workspace' CHECK (default_permission_mode IN ('workspace', 'full')),
  allow_full_permission boolean NOT NULL DEFAULT false,
  require_sandbox boolean NOT NULL DEFAULT false,
  hooks jsonb NOT NULL DEFAULT '[]'::jsonb,
  managed_hooks_only boolean NOT NULL DEFAULT true,
  instruction_templates jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_sync_templates boolean NOT NULL DEFAULT false,
  per_run_budget_usd numeric(10, 2) NOT NULL DEFAULT 5.00,
  daily_org_budget_usd numeric(10, 2) NOT NULL DEFAULT 80.00,
  max_parallel_per_machine integer NOT NULL DEFAULT 3,
  log_retention_days integer NOT NULL DEFAULT 90 CHECK (log_retention_days IN (30, 90, 365)),
  updated_by_user_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE hive.agent_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.agent_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_policies_rw ON hive.agent_policies
  FOR ALL TO hive_app
  USING (org_id = hive.ctx_org())
  WITH CHECK (org_id = hive.ctx_org());
```

---

## Contracts & API Design

Exported from `packages/contracts/src/policies.ts`:

- `GET /policies`: Retrieve current organization agent policies (returns default values if no row exists).
- `PUT /policies`: Update organization policies (`allowedModels`, `permissionMode`, `hooks`, `templates`, `limits`).
- `POST /policies/templates/preview`: Generate sample instruction file content given a project key.
- `POST /policies/templates/sync`: Trigger immediate asynchronous background job to create PRs across projects.

---

## Permissions & Authorization

- Only callers with organization role `owner` or `admin` (or custom role with `policies.manage`) can update policies.
- Viewing policy is permitted for all organization members (`policies.read`).
- Mutating operations invoke `recordAudit()`:
  - `action`: `policies.update`, `policies.sync_templates`.
  - `targetType`: `org_policy`, `targetId`: `orgId`.
  - `data`: snapshot of updated fields.

---

## Background Jobs & Workers

- Job `governance.sync_templates`: Enqueued via pg-boss upon template changes when `auto_sync_templates` is enabled.
  - Queries active projects in the organization.
  - Generates updated content for `AGENTS.md`, `CLAUDE.md`, `.mcp.json`.
  - Opens a branch `hive/update-agent-instructions` and a Pull Request in each project's repository.
  - Retries up to 3 times on temporary network failures with exponential backoff.

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Large batch of PRs triggers Git host rate limits (e.g. GitHub API) | High | Rate-limit PR creation in pg-boss worker to 1 PR per 2 seconds per Git connection. |
| Malicious or invalid hook commands cause worker crashes | High | Validate hook command strings against injection syntax; worker executes hooks with timeouts and logs stderr. |
| Strict budget clamps unexpectedly cancel critical runs | Medium | Provide UI warning when project budget exceeds organization cap before save. |

## Complexity Tracking

No violations of constitution principles.
