# Feature Specification: Skills Repository Synchronization

**Feature Branch**: `006-skills-repo-sync`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Skills.dc: đồng bộ skill với repo tdduydev/xdev-skills"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Multi-scope skill repository layout and synchronization (Priority: P1)

An organization administrator needs to connect a Git repository (e.g., `tdduydev/xdev-skills`) where skills are organized
into hierarchical folders by scope (`org/<skill>/`, `teams/<team>/<skill>/`, `projects/<key>/<skill>/`), synchronizing them
into the hub catalog.

**Why this priority**: Storing skills in Git enables version history, pull request reviews, and portability to local developer
directories (`.agents/skills/`), while the hub requires a fast PostgreSQL cache for MCP lookups.

**Independent Test**: Can be tested by connecting a repository containing `org/code-review/SKILL.md` and `teams/payment/money/SKILL.md`,
clicking "Sync now", and verifying that both skills appear in the hub catalog with their respective scopes.

**Acceptance Scenarios**:

1. **Given** a connected skill repository, **When** the administrator clicks "Sync now", **Then** the hub pulls the repository tree, parses `SKILL.md` frontmatter and body, and populates the PostgreSQL `skills` table.
2. **Given** a parsed skill, **When** stored in the hub, **Then** its scope is accurately set according to its parent directory (`org` -> Organization, `teams/<slug>` -> Team, `projects/<key>` -> Project).

---

### User Story 2 - Sub-second webhook-driven update on Git push (Priority: P1)

When a developer pushes changes to the skill repository default branch (`main`), the hub receives an incoming webhook
at `/hooks/git/skills` and reconciles updated skills within seconds.

**Why this priority**: Developers pushing new skills directly via Git should see their changes immediately available to agents
without waiting for manual sync or polling cycles.

**Independent Test**: Can be tested by simulating a Git push webhook delivery with modified `SKILL.md` files and verifying
that the hub updates the cached version and commit SHA immediately.

**Acceptance Scenarios**:

1. **Given** an incoming webhook on `/hooks/git/skills` with a valid signature, **When** processed by the hub, **Then** modified and added skills are updated in PostgreSQL within 5 seconds.
2. **Given** a deleted skill folder in the Git commit, **When** reconciled, **Then** the cached skill in PostgreSQL is archived or deleted.

---

### User Story 3 - Hub direct edits commit to Git default branch (Priority: P2)

When an authorized team or organization administrator edits a skill directly in the hub web interface, the hub creates
a Git commit on the default branch attributed to the editing user.

**Why this priority**: Maintains Git as the single canonical source of truth even when non-CLI users make changes through the web UI.

**Independent Test**: Can be tested by editing `SKILL.md` on `/knowledge/skills`, clicking "Save", and verifying that a new commit
authored by the user appears in the Git repository.

**Acceptance Scenarios**:

1. **Given** an administrator editing a skill on `/knowledge/skills`, **When** they click "Save", **Then** the hub commits the change to `main` with commit message `feat(skill): update <skill-name>` and author name/email.
2. **Given** a successful commit to Git, **When** complete, **Then** the skill's sync status is marked "Synced" with the new commit SHA.

---

### User Story 4 - Skill proposals become Git pull requests (Priority: P2)

When an agent during a run or a team member proposes an edit to a skill, the hub opens a Pull Request in the Git repository;
approving the proposal in the hub automatically merges the Pull Request.

**Why this priority**: Provides full peer review capabilities for agent-generated skill improvements through standard Git pull request mechanics.

**Independent Test**: Can be tested by calling MCP tool `skill_propose`, verifying a PR is opened in the repo on branch `hive/skill-<name>`,
and clicking "Approve proposal" on the hub to verify the PR is merged into `main`.

**Acceptance Scenarios**:

1. **Given** a skill proposal submitted via MCP, **When** accepted, **Then** the hub creates a branch and opens a PR in the repository with the proposed changes.
2. **Given** an open skill PR, **When** an administrator approves the proposal on `/knowledge/proposals`, **Then** the hub merges the PR using the project's Git connection.

---

### User Story 5 - Hierarchical scope shadowing (Priority: P1)

When an agent queries for a skill during a run, a team or project skill must shadow/override an organization skill
with the identical name.

**Why this priority**: Teams and projects need the ability to specialize or override organization-wide conventions without
breaking other projects.

**Independent Test**: Can be tested by having both `org/code-review` and `teams/payment/code-review`, running an agent under the
payment team, and verifying that the agent retrieves the team's specialized skill version.

**Acceptance Scenarios**:

1. **Given** an organization skill and a team skill with the identical name, **When** viewed in the skills catalog, **Then** the team skill displays a badge indicating "Hides org version" (`che bản Tổ chức`).
2. **Given** an agent calling `skill_get` with name `code-review`, **When** executing in project scope, **Then** the hub returns the most specific scoped skill (Project > Team > Org).

---

### Edge Cases

- What happens if a skill is edited concurrently on the hub and directly in Git?
  The skill is flagged with a `diverged` ("Khác repo") badge; the administrator is prompted to resolve the divergence by pulling or force-pushing.
- What happens if the repository contains non-conforming folders (no `SKILL.md`)?
  The hub sync engine ignores folders without a valid `SKILL.md` file and logs a warning in the sync report.
- What happens if the Git connection credentials expire or are revoked?
  Sync fails gracefully; the UI displays a warning banner ("Repository connection failed"), and agent runs continue using the cached PostgreSQL skills.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (SKILL-01)**: System MUST synchronize skills with a designated Git repository (e.g., `tdduydev/xdev-skills`), mapping folder structure to scopes: `org/<skill>/`, `teams/<team>/<skill>/`, `projects/<key>/<skill>/`.
- **FR-002 (SKILL-02)**: System MUST parse each skill directory containing `SKILL.md` with YAML frontmatter (`name`, `description`) and Markdown body.
- **FR-003 (SKILL-03, IF-06)**: System MUST receive Git webhooks at `/hooks/git/skills` on push events, synchronizing updated skills within seconds, and provide a manual "Sync now" endpoint.
- **FR-004 (SKILL-04)**: System MUST commit direct hub edits to the Git default branch with user attribution, and convert skill proposals into Git pull requests that are merged upon hub approval.
- **FR-005 (SKILL-05)**: System MUST enforce scope resolution where project skills shadow team skills, and team skills shadow organization skills with identical keys.
- **FR-006**: System MUST track sync status for every skill: `synced` (Đã đồng bộ), `hub_only` (Chưa đẩy lên repo), `diverged` (Khác repo).
- **FR-007**: System MUST provide bulk actions to push unsynced hub skills to the Git repository.
- **FR-008**: System MUST record all sync runs, manual reconciles, and commits in `audit_log`.

### Key Entities

- **Skill Repo Configuration**: Settings for the organization's linked skill repository (`org_id`, `connection_id`, `repo_owner`, `repo_name`, `branch`, `sync_status`, `last_synced_at`, `last_commit_sha`).
- **Skill Entity**: Cached skill in PostgreSQL with repository metadata (`repo_path`, `commit_sha`, `sync_status`, `shadows`).

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Webhook push events reconcile and update PostgreSQL cache for up to 100 skills in under 5 seconds.
- **SC-002**: Agent MCP lookups (`skill_list`, `skill_get`) resolve from the PostgreSQL cache in < 5ms without outbound network calls to Git.
- **SC-003**: 100% of direct hub skill edits result in signed/attributed Git commits on the repository default branch.

---

## Out of Scope

- Synchronizing binary assets or large media files inside skill folders (only Markdown, text, and metadata).
- Managing multi-repository skill federation (single Git repository per organization in v2).

---

## Assumptions

- The Git connection holds read/write repository permissions and webhook reception is configured.
- The Git repository uses standard UTF-8 encoded Markdown and YAML.

---

## Open Questions & Clarifications *(NEEDS CLARIFICATION)*

- **[NEEDS CLARIFICATION 1]**: When a divergence occurs (hub draft differs from Git commit), should the hub automatically prefer Git as the source of truth or preserve the hub draft? (Assumed: Git is canonical; hub flags divergence and requires admin confirmation before overwriting).
- **[NEEDS CLARIFICATION 2]**: Should a private skill repository require an organization-level Git connection or a dedicated per-feature token? (Assumed: reuses existing organization `scm_connections` with GitHub/GitLab).
- **[NEEDS CLARIFICATION 3]**: How should skill deletions in Git be handled if historical runs reference the skill version? (Assumed: soft-delete or archive in PostgreSQL to preserve historical audit trail).
