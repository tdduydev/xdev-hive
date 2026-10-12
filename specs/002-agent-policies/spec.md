# Feature Specification: Organization Agent Policies

**Feature Branch**: `002-agent-policies`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Policies.dc: model, quyền CLI, hook, file hướng dẫn, giới hạn theo tổ chức/đội/dự án"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Model governance and cost guardrails (Priority: P1)

An organization administrator needs to define the allowlist of AI models available for each agent CLI (Claude Code,
Codex, Gemini CLI) and prevent automatic routing to expensive models.

**Why this priority**: Unrestricted model usage can quickly exhaust team budgets; administrators must ensure runs stay within affordable model tiers.

**Independent Test**: Can be tested by setting Claude Code allowed models to `['claude-sonnet-5-5']`, triggering a run on a project that requested `claude-opus-5-5`, and verifying that the hub automatically falls back to `claude-sonnet-5-5`.

**Acceptance Scenarios**:

1. **Given** an administrator on `/admin/policies`, **When** they update allowed models for Claude Code and enable "Never auto-upgrade to the priciest model", **Then** the policy is saved and subsequent runs reject or downgrade unsupported expensive models.
2. **Given** a project whose settings request a non-permitted model, **When** a new run is queued, **Then** the hub assigns the first allowed model from the CLI's allowlist and logs a notice in the run events.

---

### User Story 2 - CLI permissions and sandbox enforcement (Priority: P1)

An administrator needs to mandate that code runs execute inside gVisor containers and control whether projects can request full machine access.

**Why this priority**: Running arbitrary agent-generated commands directly on host machines without sandbox boundaries poses severe security and data integrity risks.

**Independent Test**: Can be tested by toggling "Require sandbox" and verifying that projects with sandbox disabled are forced to run in gVisor runner containers.

**Acceptance Scenarios**:

1. **Given** "Require sandbox" is enabled in organization policy, **When** a member triggers a code run in any project, **Then** the run is scheduled exclusively to runner hosts inside a gVisor container regardless of project-level sandbox settings.
2. **Given** "Allow projects to enable full access" is disabled in policy, **When** a project administrator visits project settings, **Then** the "Full access" mode option is disabled and locked with an explanatory tooltip.

---

### User Story 3 - Enforce managed lifecycle hooks (Priority: P2)

An administrator needs to enforce mandatory safety commands on worker machines before tool execution, after file edits, and before finishing runs.

**Why this priority**: Ensures organization-wide compliance (e.g. running formatting, blocking destructive commands like `rm -rf /`, or running security linters) cannot be bypassed by local repositories.

**Independent Test**: Can be tested by configuring a `PreToolUse` hook with `hive-guard --deny "rm -rf /"` and "Only run organization hooks", dispatching a run, and verifying that the worker executes the guard before every tool call.

**Acceptance Scenarios**:

1. **Given** configured hooks for `PreToolUse`, `PostToolUse`, and `Stop`, **When** the worker processes a job offer, **Then** it receives the hook definitions in the policy snapshot and executes them at the respective lifecycle milestones.
2. **Given** "Only run organization hooks" is toggled on, **When** a repository defines its own hooks in `.hive/hooks` or `.claude/hooks`, **Then** the worker ignores repository hooks and executes only organization-managed hooks.

---

### User Story 4 - Standard instruction files and automated repository sync (Priority: P2)

An administrator needs to standardize instruction templates (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`) committed to projects and automatically update them across all repositories when templates change.

**Why this priority**: Keeps all projects aligned with organization agent conventions and MCP gateway URLs without requiring manual PRs across dozens of repositories.

**Independent Test**: Can be tested by updating the `AGENTS.md` template with auto-sync enabled, verifying that the hub automatically generates pull requests updating `AGENTS.md` across active projects.

**Acceptance Scenarios**:

1. **Given** an administrator editing the `AGENTS.md` template, **When** they click "Preview generated files" with project key `payment-api`, **Then** the template renders with substituted project variables (`{{project.name}}`, `{{project.key}}`, `{{mcp.url}}`).
2. **Given** "Open a PR when template changes" is enabled, **When** the administrator saves template changes, **Then** a background job creates pull requests updating instruction files in all connected Git repositories.

---

### User Story 5 - Enforce organization global limits (Priority: P1)

An administrator needs to impose global ceilings on run budgets, daily spending, parallel runs per machine, and log retention.

**Why this priority**: Prevents runaway token consumption and disk exhaustion on worker and database hosts.

**Independent Test**: Can be tested by setting per-run cap to 5 USD, attempting to dispatch a run with a 10 USD budget in project settings, and verifying that the run is capped at 5 USD.

**Acceptance Scenarios**:

1. **Given** a global per-run cap of 5 USD, **When** a project sets `perRunUsd: 10`, **Then** the hub clamps the effective run ceiling to 5 USD.
2. **Given** an organization daily cap of 80 USD, **When** daily aggregate spend reaches 80 USD, **Then** all subsequent runs are queued and blocked from dispatch until the next UTC day.

---

### Edge Cases

- What happens if an organization-managed `Stop` hook fails (non-zero exit code)?
  The run outcome is marked as `failed` or `needs_review` depending on the project outcome policy.
- How does the system handle template sync if a repository branch is protected or PR creation fails?
  The job logs an error, generates an admin inbox notification, and allows retrying from the administration interface.
- What happens if worker CLI version does not support native `PreToolUse` hooks?
  The worker runs commands through a wrapper process that intercepts tool invocation commands before dispatching to the shell.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (POL-01)**: System MUST allow organization administrators to define allowed models per CLI (Claude Code, Codex, Gemini CLI) and toggle "Never auto-upgrade to the priciest model".
- **FR-002 (POL-02)**: System MUST allow administrators to set the default CLI permission mode (`workspace` vs `full`), toggle whether individual projects can enable `full` access, and require gVisor sandbox execution for all code runs.
- **FR-003 (POL-03)**: System MUST allow administrators to define lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`) with command strings and enforce "Only run organization hooks" to bypass local repository hooks.
- **FR-004 (POL-04)**: System MUST maintain templates for `AGENTS.md`, `CLAUDE.md`, and `.mcp.json`, support variable expansion (`{{project.name}}`, `{{project.key}}`), and optionally create automated pull requests across project repositories on template modification.
- **FR-005 (POL-05)**: System MUST enforce global ceilings: per-run budget (USD), organization daily budget (USD), max parallel runs per machine, and log retention period (30, 90, 365 days).
- **FR-006**: System MUST embed an immutable snapshot of effective agent policies in each run record (`runs.policy_snapshot`).
- **FR-007**: System MUST log all policy changes in the `audit_log` with before and after state diffs.

### Key Entities

- **Agent Policy**: Organization-level record storing allowed models, permission constraints, hooks, instruction templates, and global budget/concurrency limits.
- **Lifecycle Hook**: Sub-entity specifying event trigger (`PreToolUse`, `PostToolUse`, `Stop`), descriptive name, and shell command.
- **Template Sync Job**: Background job tracking the status of automated pull requests updating instruction files across repositories.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of runs adhere to organization model allowlists; zero runs execute with unpermitted models.
- **SC-002**: Organization daily budget ceiling halts 100% of newly queued runs within 1 second of aggregate threshold breach.
- **SC-003**: Template sync background job successfully generates PRs across 50 repositories in under 3 minutes via asynchronous Git API batching.

---

## Out of Scope

- Real-time modification of policies for already running runs (policy is locked into `policy_snapshot` at offer time).
- Custom user-written WASM sandboxes for lifecycle hooks (hooks execute via shell in the worker execution environment).

---

## Assumptions

- Runner hosts support gVisor (`runsc`) when `requireSandbox` is enabled.
- Connected Git connections hold sufficient repository permissions to create branches and open pull requests for template sync.

---

## Open Questions & Clarifications *(NEEDS CLARIFICATION)*

- **[NEEDS CLARIFICATION 1]**: When `auto_sync_templates` is enabled, should the hub open PRs against ALL projects in the organization, or only projects with active status? (Assumed: only projects with status `active`).
- **[NEEDS CLARIFICATION 2]**: For Codex and Gemini CLIs that do not output cost in USD, how should `runBudgetUsd` and `dayBudgetUsd` be enforced? (Assumed: token-to-USD conversion heuristic or falling back to token limits).
- **[NEEDS CLARIFICATION 3]**: Should team administrators be allowed to define team-level policies that further narrow (never expand) the organization policy? (Assumed: deferred to future version; v2 enforces organization-to-project hierarchy).
