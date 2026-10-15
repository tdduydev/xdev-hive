# Implementation Plan: Document Review Workflows and Queue

**Branch**: `004-review-workflows` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-review-workflows/spec.md`

## Summary

Implement AI SDLC review workflows (AI-DLC, Spec Kit, BMAD, Custom) and the "Awaiting my review" queue. The system coordinates
multi-phase document reviews across AI pre-checks, human reviewers, automated rules, and external CI gates, rendering unified
diffs and executing automated routing upon approval or change request.

## Technical Context

**Language/Version**: TypeScript 5.8+ (Hub, Contracts, Web)

**Primary Dependencies**: `@xdev-hive/contracts`, `drizzle-orm`, `zod`, `pg-boss`, `@tanstack/react-query`, diff-match-patch

**Storage**: PostgreSQL 18 with RLS enabled and forced on all workflow and review execution tables

**Testing**: Vitest (`*.db.test.ts`), Playwright for review approval and rejection user journeys

**Target Platform**: Linux (Hub), Modern Web Browsers (Web)

**Project Type**: Web application + Modular monolith API backend + Asynchronous job execution

**Performance Goals**: Queue listing < 100ms; line-by-line diff computation for 2,000-line documents < 50ms

**Constraints**: Tenant isolation enforced; in-flight review instances snapshot workflow definitions

## Constitution Check

- [x] **Principle I (Contract first)**: Contracts defined in `packages/contracts/src/workflows.ts`; `pnpm openapi` run and `openapi.json` committed.
- [x] **Principle II (Tenant isolation)**: All queries use `withTenant()`; RLS enabled and forced on all tables with `org_id = hive.ctx_org()`.
- [x] **Principle III (Module boundaries)**: Implemented in `apps/hub/src/modules/knowledge/` (or dedicated submodule), exporting through `index.ts`.
- [x] **Principle IV (Tested before merged)**: Unit tests for state machine and diff evaluator; DB integration tests for RLS and concurrency.
- [x] **Principle V (Secure by default)**: Only authorized reviewers can sign off; all gate decisions recorded in `audit_log`.
- [x] **Principle VI (Vietnamese for people, English for code)**: UI text and error messages in Vietnamese with i18n support.
- [x] **Principle VII (Simple to self-host)**: State machine and AI jobs run on pg-boss inside PostgreSQL.

## Project Structure

### Documentation

```text
specs/004-review-workflows/
├── spec.md
└── plan.md
```

### Source Code

```text
packages/contracts/src/
└── workflows.ts                       # Schemas: WorkflowDefinition, ReviewInstance, DecisionInput, DiffResponse

apps/hub/src/modules/knowledge/
├── workflows-schema.ts                # Tables: review_workflows, review_phases, review_gates, review_instances, review_gate_executions
├── workflows-service.ts               # Workflow state machine, gate progression, baseline locking
├── ai-check-worker.ts                 # pg-boss worker executing AI rubric checks via LLM provider
├── workflows-router.ts                # oRPC endpoints for workflow configuration and review queue
└── workflows.db.test.ts               # Test suite for state transitions and RLS

apps/web/src/
├── routes/knowledge/
│   ├── workflows.tsx                  # Pipeline configuration (/knowledge/workflows based on Workflows.dc.html)
│   └── reviews.tsx                    # Review queue & detail pane (/knowledge/reviews based on DocReview.dc.html)
└── components/reviews/
    ├── review-diff.tsx                # Unified diff viewer (+/- changes vs baseline)
    ├── ai-rubric-card.tsx             # AI check rubric checklist and score
    └── decision-form.tsx              # Approve/Reject form with note and routing select
```

---

## Database Design (Schema & RLS)

```sql
-- apps/hub/db/migrations/xxxx_review_workflows.sql

CREATE TABLE hive.review_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  preset text NOT NULL CHECK (preset IN ('aidlc', 'speckit', 'bmad', 'custom')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hive.review_phases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES hive.review_workflows(id) ON DELETE CASCADE,
  position integer NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  description text,
  output_types text[] NOT NULL DEFAULT '{}'::text[],
  CONSTRAINT review_phases_pos UNIQUE (workflow_id, position)
);

CREATE TABLE hive.review_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  phase_id uuid NOT NULL REFERENCES hive.review_phases(id) ON DELETE CASCADE,
  position integer NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ai', 'human', 'rule', 'ext')),
  assignee_type text NOT NULL CHECK (assignee_type IN ('user', 'role', 'group', 'agent', 'auto')),
  assignee_id text,
  sla_minutes integer,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  skip_small_edits boolean NOT NULL DEFAULT false,
  on_reject text NOT NULL DEFAULT 'author' CHECK (on_reject IN ('author', 'agent', 'prev_gate')),
  on_pass text NOT NULL DEFAULT 'next_gate' CHECK (on_pass IN ('next_gate', 'create_task', 'baseline')),
  CONSTRAINT review_gates_pos UNIQUE (phase_id, position)
);

CREATE TABLE hive.review_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  doc_id uuid NOT NULL,
  doc_version_id uuid NOT NULL,
  workflow_id uuid NOT NULL REFERENCES hive.review_workflows(id),
  current_gate_id uuid REFERENCES hive.review_gates(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'rejected', 'cancelled')),
  sla_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hive.review_gate_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES hive.review_instances(id) ON DELETE CASCADE,
  gate_id uuid NOT NULL REFERENCES hive.review_gates(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'rejected', 'skipped')),
  actor_user_id text,
  actor_agent_model text,
  ai_score numeric(3, 1),
  checklist_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_note text,
  decided_at timestamptz
);

-- RLS Enforcement
ALTER TABLE hive.review_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.review_workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY review_workflows_rw ON hive.review_workflows FOR ALL TO hive_app USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.review_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.review_phases FORCE ROW LEVEL SECURITY;
CREATE POLICY review_phases_rw ON hive.review_phases FOR ALL TO hive_app USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.review_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.review_gates FORCE ROW LEVEL SECURITY;
CREATE POLICY review_gates_rw ON hive.review_gates FOR ALL TO hive_app USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.review_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.review_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY review_instances_rw ON hive.review_instances FOR ALL TO hive_app USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.review_gate_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.review_gate_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY review_gate_executions_rw ON hive.review_gate_executions FOR ALL TO hive_app USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
```

---

## Contracts & API Design

Exported from `packages/contracts/src/workflows.ts`:

- `GET /workflows`: List workflows for organization.
- `POST /workflows`: Create workflow with phases and gates.
- `GET/PATCH/DELETE /workflows/{id}`: Workflow CRUD.
- `GET /reviews/queue`: List items awaiting review by caller (supports filters: `type`, `gate`, `sla`, `authorType`, cursor paging).
- `GET /reviews/{instanceId}`: Full review details (diff against baseline, stepper, AI checklist, requirement traceability).
- `POST /reviews/{instanceId}/decide`: Submit decision (`action: 'approve' | 'reject'`, `note`, `routingTarget`).
- `POST /reviews/{instanceId}/reassign`: Reassign gate reviewer to another user or group.

---

## Permissions & Authorization

- Managing workflows requires `workflows.manage` (Admin/Owner).
- Deciding a review gate requires `reviews.decide` AND being either the assigned reviewer, a member of the assigned group, or an organization administrator.
- Mutating operations invoke `recordAudit()`:
  - `action`: `reviews.approve`, `reviews.reject`, `reviews.reassign`, `workflows.update`.
  - `targetType`: `review_instance` | `review_workflow`.

---

## Background Jobs & Workers

- Job `reviews.ai_check`: Enqueued when review instance enters an `ai` gate.
  - Generates evaluation prompt based on document content and template rubric.
  - Calls configured LLM provider.
  - Stores parsed JSON checklist and numerical score.
  - Auto-advances instance to next gate upon passing.

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| SLA expiry without reviewer action stalls development | High | Compute SLA deadlines at gate entry; notify backup reviewers and display warning badges 12 hours before deadline. |
| Complex diff calculations cause high CPU usage on large documents | Medium | Compute diffs once upon submission; store diff patch in `review_instances.diff_snapshot`. |

## Complexity Tracking

No violations of constitution principles.
