# Implementation Plan: Skills Repository Synchronization

**Branch**: `006-skills-repo-sync` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-skills-repo-sync/spec.md`

## Summary

Implement bidirectional skills synchronization between xDev Hive and a designated Git repository (e.g. `tdduydev/xdev-skills`)
following ADR 0014. Skills are laid out by directory scope (`org/`, `teams/<slug>/`, `projects/<key>/`) containing `SKILL.md`.
The hub uses Git webhooks and manual triggers to synchronize changes into a PostgreSQL read cache for low-latency agent
MCP access, and commits direct hub edits to the default branch.

## Technical Context

**Language/Version**: TypeScript 5.8+ (Hub, Contracts, Web)

**Primary Dependencies**: `@xdev-hive/contracts`, `drizzle-orm`, `zod`, `gray-matter` (YAML frontmatter parsing), `@octokit/rest` / GitLab API

**Storage**: PostgreSQL 18 with RLS enabled and forced on `skill_repo_configs` and updated `skills` table

**Testing**: Vitest (`*.db.test.ts`), unit tests for frontmatter parser and scope resolver

**Target Platform**: Linux (Hub), Modern Web Browsers (Web)

**Project Type**: Web application + Modular monolith API backend + SCM webhook receiver

**Performance Goals**: Webhook reconciliation < 5 seconds; PostgreSQL cached MCP read < 5ms

**Constraints**: Adheres to ADR 0014: Git is canonical; PostgreSQL is the read cache; zero cross-tenant leakage

## Constitution Check

- [x] **Principle I (Contract first)**: Defined in `packages/contracts/src/skills-sync.ts`; webhook schema updated in contracts.
- [x] **Principle II (Tenant isolation)**: All queries use `withTenant()`; RLS enabled and forced with `org_id = hive.ctx_org()`.
- [x] **Principle III (Module boundaries)**: Implemented in `apps/hub/src/modules/knowledge/`, calling `scm` module solely via `scm/index.ts`.
- [x] **Principle IV (Tested before merged)**: Covered by DB integration tests (`skills-sync.db.test.ts`) with local bare Git repositories.
- [x] **Principle V (Secure by default)**: Webhook signatures verified before processing; Git secrets encrypted with master key.
- [x] **Principle VI (Vietnamese for people, English for code)**: UI text and error messages in Vietnamese with i18n support.
- [x] **Principle VII (Simple to self-host)**: No external sync daemons; background sync jobs use pg-boss.

## Project Structure

### Documentation

```text
specs/006-skills-repo-sync/
├── spec.md
└── plan.md
```

### Source Code

```text
packages/contracts/src/
└── skills-sync.ts                     # Schemas: SkillRepoConfig, SyncStatus, BulkPushInput

apps/hub/src/modules/knowledge/
├── skills-sync-schema.ts              # Table: skill_repo_configs, alterations to skills table
├── skills-sync-service.ts             # Git tree puller, frontmatter parser, diff reconciler, commit pusher
├── skills-webhook-handler.ts          # Handler for /hooks/skills/{repoId}
├── skills-sync-router.ts              # oRPC endpoints for repo configuration, sync trigger, bulk push
└── skills-sync.db.test.ts             # DB and Git provider integration tests

apps/web/src/
├── routes/knowledge/
│   └── skills.tsx                     # Skills catalog & sync view (/knowledge/skills based on Skills.dc.html)
└── components/skills/
    ├── sync-banner.tsx                # Status banner (Synced, Not pushed, Diverged) + Sync Now button
    └── skill-detail-pane.tsx          # Drawer displaying SKILL.md, repo path, commit info, shadowing badge
```

---

## Database Design (Schema & RLS)

```sql
-- apps/hub/db/migrations/xxxx_skills_repo_sync.sql

CREATE TABLE hive.skill_repo_configs (
  org_id uuid PRIMARY KEY REFERENCES hive.orgs(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES hive.scm_connections(id),
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  branch text NOT NULL DEFAULT 'main',
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'syncing', 'failed')),
  last_synced_at timestamptz,
  last_commit_sha text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Extend existing skills table with Git repository tracking columns
ALTER TABLE hive.skills ADD COLUMN repo_path text;
ALTER TABLE hive.skills ADD COLUMN commit_sha text;
ALTER TABLE hive.skills ADD COLUMN sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'hub_only', 'diverged'));
ALTER TABLE hive.skills ADD COLUMN shadows boolean NOT NULL DEFAULT false;

-- RLS Enforcement
ALTER TABLE hive.skill_repo_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.skill_repo_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_repo_configs_rw ON hive.skill_repo_configs
  FOR ALL TO hive_app
  USING (org_id = hive.ctx_org())
  WITH CHECK (org_id = hive.ctx_org());
```

---

## Contracts & API Design

Exported from `packages/contracts/src/skills-sync.ts`:

- `GET /skills/repo-config`: Retrieve skill repository connection details and sync health.
- `PUT /skills/repo-config`: Configure or update repository settings (`connectionId`, `repoOwner`, `repoName`, `branch`).
- `POST /skills/sync`: Trigger manual immediate reconciliation job.
- `GET /skills/sync-status`: Check current sync status and count of unsynced skills.
- `POST /skills/push-bulk`: Push unsynced hub-only skills into the Git repository in a single commit.
- `POST /hooks/skills/{repoId}`: Webhook receiver for push events on skill repository.

---

## Permissions & Authorization

- Configuring the repository and triggering bulk push requires `skills.manage` (Organization Owner or Admin).
- Editing skills and creating proposals requires `skills.write` or `proposals.create`.
- Mutating operations invoke `recordAudit()`:
  - `action`: `skills.sync`, `skills.commit`, `skills.push_bulk`, `skills.repo_config`.
  - `targetType`: `skill` | `skill_repo_config`.

---

## Background Jobs & Workers

- Job `skills.reconcile`: Triggered by webhook or manual sync API.
  - Clones or fetches latest tree using SCM connection.
  - Traverses `org/`, `teams/*/`, `projects/*/` directories.
  - Parses frontmatter and body of `SKILL.md`.
  - Upserts matching skills in `skills` and `skill_versions` tables in a single transaction.
  - Flags shadowed skills where team/project names match organization names.

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Concurrent Git pushes create merge conflicts during hub direct edits | High | Hub fetches the latest head commit and rebases/retries before pushing; on conflict, leaves draft as `diverged`. |
| Webhook delivery loss causes stale skills in hub | Medium | Provide manual "Sync now" button; schedule periodic hourly liveness reconcile job. |

## Complexity Tracking

No violations of constitution principles.
