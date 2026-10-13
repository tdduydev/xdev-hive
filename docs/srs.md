# xDev Hive: Software Requirements Specification

| | |
|---|---|
| Status | Baseline of the code on `main` at commit `221d5b6` (12 October 2026) |
| Structure | Reduced from ISO/IEC/IEEE 29148:2018, section 9.6 |
| Related | [add.md](add.md) (architecture), [sdd.md](sdd.md) (detailed design), [adr/](adr/README.md) (decisions), [feature-checklist.md](feature-checklist.md) |

New features add requirements here with a new ID. Each feature spec under `specs/` (Spec Kit) lists the IDs it adds or
changes. Requirements are never renumbered; a removed requirement keeps its ID with status `Withdrawn`.

## 1. Introduction

### 1.1 Purpose

This document states what xDev Hive must do and how well, so that features can be specified, implemented and verified
against stable, numbered requirements.

### 1.2 Scope

xDev Hive is a self-hosted system that lets teams in an organization assign coding tasks to agent CLIs (Claude Code,
Codex, Gemini CLI) running on the teams' own machines, share memory, documents and skills between agents, and review
and merge the results. It consists of the hub (API, web app, background jobs), the worker and runner host, the egress
proxy and the desktop app.

### 1.3 Definitions

Terms are defined in [add.md section 12](add.md#12-glossary). Additionally:

| Term | Meaning |
|---|---|
| Organization administrator | Organization role `admin` or `owner` |
| Team administrator | Team role `admin`, or an organization administrator |
| Team member | Team role `member` or higher |

### 1.4 Requirement format

Each requirement has an ID (`AREA-NN`), a statement using "shall", a status and a verification reference.

| Status | Meaning |
|---|---|
| Implemented | In the code and covered by the listed test |
| Partial | In the code with stated gaps |
| Planned | Accepted but not built; see [add.md section 11](add.md#11-risks-technical-debt-and-planned-work) |

Verification references are test files: `hub:` is `apps/hub/src/`, `web:` is `apps/web/e2e/`, `worker:` is `worker/`,
`e2e:` is `scripts/`.

## 2. Overall description

### 2.1 Product perspective

The hub is the single control plane. Workers on developer machines and runner hosts connect out to it. Git hosting
(GitHub, GitLab) holds the code; the hub opens pull requests and merges them through an organization Git connection.
See the context diagram in [add.md section 3](add.md#3-context-and-scope).

### 2.2 User classes

| Class | Typical use |
|---|---|
| Hub operator | Deploys, backs up and upgrades the hub |
| Organization owner and administrators | Members, teams, sign-in, Git connections, notification channels, sandbox policy |
| Team administrators | Machines, systems, projects, project settings, documents and skills |
| Team members | Tasks, runs, plans, reviews, merge queue, leader chat, memory |
| Agent CLIs | Read context and report through MCP within a run |

### 2.3 Operating environment

- Hub: Linux server with Docker Compose; PostgreSQL 18 (pgvector optional); modern browsers.
- Worker: macOS, Linux and Windows on amd64 and arm64, with at least one supported agent CLI logged in.
- Runner host: Linux with Docker and gVisor (`runsc`).

### 2.4 Constraints and assumptions

- The hub never receives agent CLI credentials.
- Machines can open outbound HTTPS and WebSocket connections to the hub.
- User-facing text is Vietnamese.

## 3. Functional requirements

### 3.1 Sign-in and accounts (AUTH)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| AUTH-01 | The hub shall let the first administrator, whose address is listed in `HIVE_ORG_CREATORS`, create an e-mail and password account before any organization exists. | Implemented | `hub:invite-only.db.test.ts`, `web:login.spec.ts` |
| AUTH-02 | The hub shall reject self-registration that is not backed by an invitation, a creator listing or a verified SSO domain, unless `HIVE_ALLOW_EMAIL_SIGNUP=1`. | Implemented | `hub:invite-only.db.test.ts` |
| AUTH-03 | The hub shall support sign-in with e-mail and password (at least 10 characters), GitHub and GitLab. | Implemented | `hub:auth.db.test.ts`, `hub:invite-only.db.test.ts` |
| AUTH-04 | An organization administrator shall configure one OIDC SSO provider per organization and verify an e-mail domain with a DNS TXT record. | Implemented | `hub:sso-domain.db.test.ts`, `web:admin.spec.ts` |
| AUTH-05 | SSO shall create accounts only for addresses in a verified domain, as pending or member according to the organization's join policy. | Implemented | `hub:invite-sso.db.test.ts` |
| AUTH-06 | The hub shall delete accounts older than 7 days that belong to no organization and have no pending invitation, except creator addresses. | Implemented | `hub:modules/tenancy/orphans.db.test.ts` |

### 3.2 Organizations, teams and members (TEN)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| TEN-01 | A creator shall create an organization and become its owner. | Implemented | `hub:tenancy.db.test.ts` |
| TEN-02 | Organization administrators shall invite people by e-mail with an organization role and optional team; only the owner may invite administrators. Invitations are single-use and revocable. | Implemented | `hub:tenancy.db.test.ts`, `hub:invite-only.db.test.ts`, `web:invite.spec.ts` |
| TEN-03 | Administrators shall approve, deny or lock members; the owner shall change organization roles. | Implemented | `web:admin.spec.ts` |
| TEN-04 | Team administrators shall manage teams, team members and team roles, and systems within a team. | Implemented | `hub:modules/tenancy/permissions.db.test.ts` |
| TEN-05 | Every organization's data shall be invisible to members of other organizations, enforced by the database. | Implemented | `hub:modules/*/rls.db.test.ts` |

### 3.3 Git connections and projects (PROJ)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| PROJ-01 | Organization administrators shall add GitHub (App or token) and GitLab connections, test their permissions and delete unused ones; secrets shall be stored encrypted. | Implemented | `hub:modules/scm/connections.db.test.ts` |
| PROJ-02 | Team administrators shall create a project in a system, with a dry run that lists the provisioning steps and warnings first. | Implemented | `hub:modules/catalog/projects.db.test.ts` |
| PROJ-03 | Provisioning shall check access, create or link the repository, commit agent templates, protect the default branch and add a webhook, record each step's state, and allow retrying a failed step. | Implemented | `hub:modules/catalog/projects.db.test.ts`, `hub:modules/catalog/steps.test.ts` |
| PROJ-04 | Project settings shall cover merge mode and approvals, outcome policy, features (plan mode, cross-review, merge queue, leader chat, sandbox), issue intake, budget and per-CLI model and permissions. | Implemented | `hub:project-settings.db.test.ts`, `web:projects-runs.spec.ts` |
| PROJ-05 | Incoming webhooks shall be verified with the project's secret and processed once per delivery. | Implemented | `hub:webhooks.db.test.ts` |

### 3.4 Tasks and plans (TASK)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| TASK-01 | Team members shall create, edit and cancel tasks; cancelling a task cancels its waiting and running runs. | Implemented | `hub:modules/tasks/tasks.db.test.ts`, `hub:runs.db.test.ts` |
| TASK-02 | With issue intake enabled, an issue labelled or mentioning the configured keyword shall create a task, queue a run with the default CLI and comment a link back. | Implemented | `hub:scm-handlers.db.test.ts` |
| TASK-03 | A merged pull request on branch `ai/<task key>` shall mark the task done; a pull request closed without merge shall return the task to to-do with a note. | Implemented | `hub:scm-handlers.db.test.ts` |
| TASK-04 | With plan mode, an agent shall submit a plan before coding; a member shall approve it (optionally edited, with a note) or reject it with a reason and optionally request a new plan; the code run shall follow the approved plan. | Implemented | `hub:plan.db.test.ts`, `web:plan-review.spec.ts` |

### 3.5 Runs (RUN)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| RUN-01 | Team members shall assign a task to an agent CLI, optionally overriding the model. | Implemented | `hub:runs.db.test.ts` |
| RUN-02 | The hub shall offer a run only to an online, unpaused machine of the owning team that has the CLI and free capacity; a rejected offer shall go to another machine; with no suitable machine the run stays queued. | Implemented | `hub:runs.db.test.ts` |
| RUN-03 | A run shall be leased to one machine at a time; when the lease expires the run shall become lost and be retried with a new attempt, and messages from older attempts shall be ignored. | Implemented | `hub:runs.db.test.ts` |
| RUN-04 | Members shall watch a run's state, events and logs live, and resume the stream without gaps after reconnecting. | Implemented | `hub:runs.db.test.ts`, `web:tasks-runs.spec.ts` |
| RUN-05 | Members shall cancel a run; the machine shall receive the cancellation even if one channel fails. | Implemented | `hub:runs.db.test.ts` |
| RUN-06 | Members shall send instructions to a running run; the worker shall report whether the agent received them. | Partial: only Claude accepts instructions mid-run | `hub:runs.db.test.ts` |
| RUN-07 | After a run the hub shall evaluate the project's outcome policy and set `succeeded`, `no_changes`, `needs_review` or `failed`, open a pull request for pushed changes, and notify on failure. | Partial: `command` and `ci` checks are not evaluated | `hub:runs.db.test.ts`, `hub:modules/runs/policy.test.ts` |
| RUN-08 | With cross-review, the hub shall run a read-only review with the configured CLI and compare its score with the project minimum. | Implemented | `hub:review.db.test.ts` |
| RUN-09 | With the merge queue, passing pull requests shall be merged one at a time per project according to merge mode, approvals and CI; members may add or remove entries. | Implemented | `hub:merge-queue.db.test.ts`, `web:queue-notifications.spec.ts` |
| RUN-10 | The hub shall stop a run that exceeds the project's per-run cost ceiling and refuse new runs for a task that has used its budget. | Implemented | `hub:runs.db.test.ts` |
| RUN-11 | Members shall search runs by state, project, CLI and machine with cursor paging. | Implemented | `hub:runs-search.db.test.ts`, `web:projects-runs.spec.ts` |
| RUN-12 | An agent shall be able to ask a person for approval mid-run and wait for the answer. | Planned | — |

### 3.6 Machines and workers (FLEET)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| FLEET-01 | Team administrators shall create single-use registration tokens valid for one hour, for a developer machine or a runner host, together with one-line install commands for Linux, macOS and Windows. | Implemented | `hub:modules/fleet/registration.db.test.ts`, `web:admin.spec.ts` |
| FLEET-02 | The install script shall verify the release signature and checksum before installing, register the machine and install a user service. | Implemented | `worker:internal/update/scripts_test.go` |
| FLEET-03 | Team administrators shall list, pause, resume and revoke machines; a revoked machine shall be disconnected and unable to reconnect. | Implemented | `hub:modules/fleet/registration.db.test.ts`, `hub:fleet.db.test.ts` |
| FLEET-04 | The hub shall notify administrators when a machine stays offline longer than `HIVE_MACHINE_OFFLINE_NOTIFY_SEC` (default 300 seconds). | Implemented | `hub:fleet-offline.db.test.ts` |
| FLEET-05 | The Machines page shall show each machine's worker version and mark versions older than the latest release. | Implemented | `hub:worker-releases.test.ts`, `web:admin.spec.ts` |
| FLEET-06 | A team administrator shall request a worker update; the worker shall finish its current runs, install the verified release and restart. | Implemented | `hub:modules/fleet/registration.db.test.ts`, `worker:internal/channel/worker_e2e_test.go` |
| FLEET-07 | The worker shall delete every worktree it creates and remove orphans at start. | Implemented | `worker:internal/runner/runner_test.go` |
| FLEET-08 | Review, plan and leader runs shall run the CLI in its read-only mode and never push. | Implemented | `worker:internal/runner/runner_test.go` |
| FLEET-09 | A machine shall be personal by default and run only runs owned by the user who registered it; team administrators shall mark machines as shared, and team runs without an owner (Leader, review gate, webhooks) shall run only on shared machines or runner hosts, recording why they wait when none is available (ADR 0017). | Implemented | `hub:runs.db.test.ts` (máy cá nhân và máy dùng chung) |
| FLEET-10 | When a run's project is bound to a local repository in the machine's `projects.json`, the worker shall create the run's worktree from that repository (fetching `origin`, branch visible locally, never in the developer's working tree), fail with a clear message when the folder is missing, its `origin` does not match the project repository or the run would overwrite local work, and run with full permission only when the machine enabled it for that project and the organization policy allows it (ADR 0020). | Implemented | `worker:internal/runner/local_test.go`, `worker:internal/projects/projects_test.go`, `worker:internal/channel/projects_test.go`, `hub:runs.db.test.ts` (toàn quyền bật tại máy) |

### 3.7 Sandbox (SBX)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| SBX-01 | Projects with the sandbox feature shall run only on runner hosts, one gVisor container per run with no network interface, read-only root, no capabilities and resource limits. | Implemented | `e2e:e2e-sandbox.ts`, `worker:internal/runner/sandbox_test.go` |
| SBX-02 | A sandboxed run shall reach only the hosts in its effective allowlist, through a per-run egress proxy that blocks private and metadata addresses and IPv6. | Implemented | `worker:internal/egress` tests, `e2e:e2e-sandbox.ts` |
| SBX-03 | Organization administrators shall manage organization allowlist entries, enable suggested defaults and lock the list; team administrators shall manage project entries unless locked. | Implemented | `hub:sandbox.db.test.ts`, `web:sandbox.spec.ts` |
| SBX-04 | Team administrators shall set a project's environment image (base image and SHA-256 of `.hive/setup.sh`); the runner host shall refuse a setup script with a different hash. | Implemented | `hub:modules/sandbox/service.db.test.ts`, `web:sandbox.spec.ts` |
| SBX-05 | The runner host shall build and cache environment images and keep warm containers. | Planned | — |

### 3.8 Knowledge (KNOW)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| KNOW-01 | Team members and agents shall write memories; anyone with access shall search them by words and, when embeddings are configured, by meaning. | Implemented | `hub:knowledge.db.test.ts`, `hub:modules/knowledge/vector.db.test.ts` |
| KNOW-02 | Team administrators shall publish versioned documents and skills; members and agents shall read them by key, version or project scope. | Implemented | `hub:knowledge.db.test.ts` |
| KNOW-03 | Members and agents shall propose changes to documents and skills; team administrators shall approve (creating a new version) or reject them. | Implemented | `hub:knowledge.db.test.ts`, `hub:mcp-knowledge.db.test.ts` |
| KNOW-04 | The hub shall import memories, documents and skills from the previous xDev Hive, idempotently. | Implemented | `hub:modules/knowledge/legacy-import.db.test.ts` |

### 3.9 Leader (LEAD)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| LEAD-01 | Members shall chat with a leader agent in threads, optionally scoped to a project. | Implemented | `hub:leader.db.test.ts`, `web:leader.spec.ts` |
| LEAD-02 | The leader shall only propose actions (create task, dispatch run, cancel run, change project settings); the hub shall execute a proposal only after a person with the required rights approves it, and a rejection shall need a reason. | Implemented | `hub:leader.db.test.ts`, `web:leader.spec.ts` |

### 3.10 MCP for agents (MCP)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| MCP-01 | The hub shall expose MCP tools for identity, organization structure, tasks, plans, reviews, memory, documents, skills and leader replies. | Implemented | `hub:mcp.db.test.ts`, `hub:mcp-run.db.test.ts` |
| MCP-02 | Agents in a run shall authenticate with the run token; other MCP clients with OAuth (client ID metadata documents). | Implemented (OAuth chỉ bật khi hub chạy HTTPS theo spec MCP; hub HTTP như máy 34 nhận run token và token cá nhân `hive_pat_` với `HIVE_MCP_ALLOW_HTTP=1`) | `hub:mcp-http.db.test.ts`, `hub:mcp.db.test.ts` (OAuth, client ID metadata) |
| MCP-03 | Tools shall be limited by principal and run kind (read-only kinds get no write tools), run inside the tenant context and be audited. | Implemented | `hub:mcp.db.test.ts`, `hub:modules/mcp/registry.test.ts` |
| MCP-04 | Organization administrators shall enable or disable individual hub MCP tools for agent runs and user clients. | Implemented | `hub:modules/mcp/mcp-admin.db.test.ts`, `hub:modules/mcp/rls.db.test.ts`, `web:mcp-admin.spec.ts` |
| MCP-05 | Organization administrators shall configure external MCP server rules (allow or deny by URL, name, command, or wildcard) with deny precedence, scoped to organization or project. | Implemented | `hub:modules/mcp/server-rules.test.ts`, `hub:modules/mcp/server-rules.db.test.ts`, `hub:modules/mcp/rls.db.test.ts`, `web:mcp-admin.spec.ts` |
| MCP-06 | The hub shall distribute allowed external MCP servers and configuration to CLI managed settings on assigned run machines, blocking unauthorized servers. | Implemented | `hub:runs.db.test.ts`, `worker:internal/runner/mcp_test.go` (Claude Code, Codex, Gemini CLI), `worker:internal/channel/jobs_test.go` |
| MCP-07 | Organization members shall create personal MCP tokens with expiration periods, and administrators shall view, extend lifetime, and revoke MCP tokens. | Implemented | `hub:modules/mcp/mcp-admin.db.test.ts`, `hub:modules/mcp/rls.db.test.ts`, `web:mcp-admin.spec.ts` |

### 3.11 Notifications, costs and audit (OPS)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| OPS-01 | Organization administrators shall configure Telegram and e-mail channels per event type and send a test; secrets shall never be returned. Delivery shall retry temporary failures up to five times. | Implemented | `hub:notify.db.test.ts` |
| OPS-02 | Each user shall have an in-app inbox with unread count and mark-as-read. | Implemented | `hub:inbox.db.test.ts`, `web:queue-notifications.spec.ts` |
| OPS-03 | Team administrators shall see tokens and cost per project by task, CLI, machine and day, and the runs stopped by budget. | Implemented | `hub:runs.db.test.ts` |
| OPS-04 | Administrative writes and every MCP call shall be recorded in an append-only audit log. | Implemented | `hub:modules/audit/audit.db.test.ts` |
| OPS-05 | Organization administrators and auditors shall query the audit log with filters (time range, actor type, actor, area, action, source, result) and cursor-based pagination. | Implemented | `hub:modules/audit/audit.db.test.ts`, `web:audit.spec.ts` (owner/admin; custom auditor roles await RBAC) |
| OPS-06 | Organization administrators and auditors shall export filtered audit logs in CSV and JSON formats. | Implemented | `hub:modules/audit/audit.db.test.ts`, `hub:modules/audit/csv.test.ts`, `web:audit.spec.ts` (owner/admin; 20,000-row limit) |
| OPS-07 | The hub shall retain audit log entries according to the organization retention policy (default 365 days) and prevent modification or premature deletion. | Implemented | `hub:modules/audit/retention.db.test.ts`, `hub:modules/audit/audit.db.test.ts`, `web:audit.spec.ts` (retention 90–3650 days set by owner/admin; daily cleanup deletes expired entries and records `audit.purge`; no archival before deletion) |

### 3.12 Roles and custom permissions (ROLE)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| ROLE-01 | Organization administrators shall define custom roles with unique keys, names, descriptions, and hierarchical permission node selections. | Implemented | `hub:modules/tenancy/roles.db.test.ts`, `web:roles.spec.ts` |
| ROLE-02 | System roles (organization roles owner, admin, member; team roles admin, member, viewer) shall be immutable but cloneable into custom roles. | Implemented | `hub:modules/tenancy/roles.db.test.ts`, `web:roles.spec.ts` |
| ROLE-03 | The hub shall enforce permissions structured as a tree across access, work, knowledge, projects, agents, and monitoring areas, where checking a parent node grants all descendant leaf permissions. | Implemented | `hub:modules/tenancy/roles.db.test.ts` (custom roles extend audit, costs, members, teams, SSO, machines, sandbox, projects, plans, runs checks) |
| ROLE-04 | Organization administrators shall assign custom roles to organization members and teams, and the hub shall evaluate effective permissions with tenant isolation. | Implemented | `hub:modules/tenancy/roles.db.test.ts`, `web:roles.spec.ts` |
### 3.13 Agent policies (POL)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| POL-01 | Organization administrators shall configure organization-wide agent policies including allowed model lists per CLI (Claude Code, Codex, Gemini CLI) and restrictions on automatic upgrades to expensive models. | Implemented | `hub:modules/governance/policies.db.test.ts`, `hub:runs.db.test.ts` (chính sách agent), `web:e2e/policies.spec.ts` |
| POL-02 | Organization administrators shall specify CLI permission levels (worktree restricted vs full access), require gVisor sandbox execution, and control whether individual projects may request full access. | Implemented | `hub:modules/governance/policies.db.test.ts`, `hub:runs.db.test.ts` (toàn quyền, sandbox), `web:e2e/projects-runs.spec.ts` |
| POL-03 | Organization administrators shall configure mandatory lifecycle hooks (PreToolUse, PostToolUse, Stop) executed on worker machines, with the option to enforce managed-only hooks ignoring personal or repository hooks. | Implemented | `worker:internal/runner/hooks_test.go`, `worker:internal/channel/jobs_test.go`, `hub:runs.db.test.ts` |
| POL-04 | The hub shall maintain agent instruction file templates (AGENTS.md, CLAUDE.md, .mcp.json) and automatically propose pull requests to update project repositories when templates change. | Implemented | `hub:modules/governance/policies.db.test.ts` (xem trước, mở PR), `hub:modules/catalog/template.test.ts` |
| POL-05 | The hub shall enforce global limits for runs (per-run cost cap, organization daily budget cap, maximum parallel runs per machine, log retention period) that cannot be exceeded by project settings. | Implemented | `hub:runs.db.test.ts` (trần run, trần ngày, run song song), `hub:modules/governance/policies.db.test.ts` (giữ log) |

### 3.14 Review workflows (WF)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| WF-01 | Team and organization administrators shall configure document review workflows with phased checkpoints based on standard presets (AI-DLC, Spec Kit, BMAD) or custom pipelines. | Implemented | `hub:modules/knowledge/reviews.db.test.ts` (quy trình, quyền, chạy thử), `web:e2e/workflows.spec.ts` |
| WF-02 | Review workflows shall support heterogeneous checkpoint gates including AI automated pre-checks, designated human reviewers (by user, team role, or group), automated rules, and external CI status checks. | Implemented | `hub:modules/knowledge/reviews.db.test.ts` (người duyệt N/M, quy tắc, AI), `hub:runs.db.test.ts` (run doccheck), `hub:modules/knowledge/review-rules.test.ts` |
| WF-03 | Review checkpoints shall support conditional triggers (document type, keywords, diff size thresholds, skipping formatting-only edits) and configurable SLAs with escalation or alerts. | Implemented | `hub:modules/knowledge/review-rules.test.ts` (điều kiện, hạn), `hub:modules/knowledge/reviews.db.test.ts` (bỏ qua, nhắc quá hạn) |
| WF-04 | On rejection at a review gate, the workflow shall route the document back to the author, prompt an agent to revise based on feedback, or return to a previous checkpoint. | Implemented | `hub:modules/knowledge/reviews.db.test.ts` (về người viết, agent sửa rồi tiếp tục, về checkpoint trước), `web:e2e/reviews.spec.ts` |
| WF-05 | On approval through all gates, the workflow shall baseline the document version, optionally triggering subsequent agent tasks linked to the approved baseline. | Implemented | `hub:modules/knowledge/reviews.db.test.ts` (chốt phiên bản, đề xuất duyệt) |

### 3.15 Collaborative document editor (DOC)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| DOC-01 | The web application shall provide a block-based rich text and Markdown editor supporting headings, checklists, tables, code blocks, Mermaid diagrams, embedded documents, and auto-numbered requirement IDs (R-n). | Partial: block editor over Markdown (slash menu, toolbar, checklists, tables, code, `R-n` numbering, `![[key]]` embeds); Mermaid blocks show their source, not a rendered diagram | `web:lib/doc-editor.test.ts`, `web:doc-editor.spec.ts`, `contracts:doc-text.test.ts` |
| DOC-02 | The document editor shall support suggestion mode alongside direct editing, allowing AI agents and human collaborators to propose inline edits that can be accepted or rejected. | Implemented | `hub:modules/knowledge/editor.db.test.ts`, `hub:mcp-run.db.test.ts` (`doc_suggest`), `web:doc-editor.spec.ts` |
| DOC-03 | The document editor shall provide contextual commenting threads anchored to document blocks with reply and resolve capabilities. | Implemented | `hub:modules/knowledge/editor.db.test.ts`, `web:doc-editor.spec.ts` |
| DOC-04 | The document editor shall maintain version history with named snapshots, change diffs, and the ability to submit frozen versions into review workflows. | Implemented | `hub:modules/knowledge/editor.db.test.ts` (snapshots, rebase, submit into workflows), `web:doc-editor.spec.ts` |
| DOC-05 | The document editor shall integrate AI assistance actions (continue writing, template completeness audit, drafting acceptance criteria, cross-referencing related documents, and translation) powered by desktop subscription or agent runs. | Implemented: runs on the requester's own machine (`docassist` run, read-only) | `hub:runs.db.test.ts`, `hub:mcp-run.db.test.ts`, `web:doc-editor.spec.ts` |

### 3.16 Skills repository synchronization (SKILL)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| SKILL-01 | The hub shall synchronize skills bidirectionally with a designated Git repository (e.g., tdduydev/xdev-skills), mapping folders to scopes: `org/<skill>/`, `teams/<team>/<skill>/`, and `projects/<key>/<skill>/`. | Implemented | `hub:modules/knowledge/skill-repo.db.test.ts`, `web:knowledge.spec.ts` |
| SKILL-02 | Each skill shall be stored as a directory containing `SKILL.md` with YAML frontmatter metadata and Markdown instruction bodies. | Implemented | `hub:modules/knowledge/skill-repo.db.test.ts` |
| SKILL-03 | The hub shall process Git webhooks on push events to update the skill catalog within seconds, and provide manual "Sync now" triggering. | Implemented | `hub:modules/knowledge/skill-repo.db.test.ts` (webhook, sync job), `web:knowledge.spec.ts` |
| SKILL-04 | Edits made on the hub shall commit to the Git repository default branch as the editing user, and skill change proposals shall be managed as Git pull requests. | Implemented | `hub:modules/knowledge/skill-repo.db.test.ts` (commit with Co-authored-by, proposal PRs) |
| SKILL-05 | The hub shall resolve skill lookups by scope hierarchy, allowing team or project skills to shadow organization skills with identical keys. | Implemented | `hub:mcp-knowledge.db.test.ts`, `hub:modules/knowledge/skill-repo.db.test.ts` |
### 3.17 Desktop application (DESK)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| DESK-01 | The desktop app shall provide a local user interface built with React, Vite, and Tailwind matching design system v2, containing screens: AppNav, AppRegister, AppTray, AppHome, AppDocs, AppSkills, AppTokens, and AppSetup. | Implemented | `desktop:src/shell/app-shell.test.tsx`, `desktop:src/screens/*-screen.test.tsx` (home, docs, skills, tokens, setup, register) |
| DESK-02 | The desktop app shall register machines with single-use tokens from command strings or form inputs, passing the token to the worker sidecar via environment variable `HIVE_REGISTRATION_TOKEN`. | Implemented | `desktop:src/screens/register-screen.test.tsx`, `desktop:src-tauri/src/register.rs` |
| DESK-03 | The desktop app shall manage worker sidecar lifecycle through a system tray menu and native notifications across all 7 states: stopped, starting, connecting, online, disconnected, stopping, and failed. | Implemented | `desktop:src-tauri/src/worker.rs`, `desktop:src-tauri/src/tray_icon.rs`, `desktop:src/shell/app-shell.test.tsx` |
| DESK-04 | The desktop app shall provide an overview dashboard (AppHome) displaying machine readiness score, synced skills, recent document summaries, and weekly token consumption. | Implemented | `desktop:src/screens/home-screen.test.tsx`, `desktop:src-tauri/src/workspace.rs`, `hub:mcp-knowledge.db.test.ts` (project_list) |
| DESK-05 | The desktop app shall execute local agent CLIs (Claude Code, Codex) non-interactively with streaming JSON in a user-selected project directory to inspect code and propose documentation, without exposing hub secrets to the CLI environment. | Implemented | `desktop:src-tauri/src/cli.rs` (stream parsers, env allowlist, read-only arguments, cancel), `desktop:src/screens/docs-screen.test.tsx` |
| DESK-06 | The desktop app shall synchronize skills between the hub and local folders (`.claude/skills/`, `.agents/skills/`) and user home folders, detecting local modifications before updating or removing skill files. | Implemented | `desktop:src-tauri/src/skills.rs`, `desktop:src/screens/skills-screen.test.tsx`, `hub:mcp-knowledge.db.test.ts` (skill_propose), `hub:knowledge.db.test.ts` (hidden skills) |
| DESK-07 | The desktop app shall inspect token consumption and context allocations (via non-interactive `/context` and `/usage` for Claude Code; session turn metrics for Codex) and display actionable optimization recommendations. | Implemented | `desktop:src-tauri/src/usage.rs`, `desktop:src/screens/tokens-screen.test.tsx` |
| DESK-08 | The desktop app shall diagnose local development environments (CLIs, runtimes, tools, MCP servers, project dependencies), show remediation commands, and require explicit user confirmation before executing non-admin install commands. | Implemented | `desktop:src-tauri/src/doctor.rs`, `desktop:src-tauri/src/setup_extra.rs` (.hive/setup.sh, MCP server được phép, token MCP), `desktop:src/screens/setup-screen.test.tsx`, `hub:mcp-knowledge.db.test.ts` (mcp_server_list) |
| DESK-09 | The desktop app shall authenticate human users via personal tokens stored in the OS keychain, mapping hub roles (`owner`, `admin`, `member`, `viewer`) to app permission profiles (`lead`, `dev`, `writer`). | Implemented | `desktop:src-tauri/src/account.rs`, `desktop:src/shell/account.test.tsx`, `hub:mcp.db.test.ts` (hive_whoami teams) |
| DESK-10 | The desktop app shall install bundle updates via `tauri-plugin-updater` from `/api/v1/desktop/updates/{os}/{arch}/{version}`, with worker sidecar self-update disabled to prevent binary drift. | Implemented | `hub:desktop-updates.test.ts` (manifest theo nền tảng, phiên bản), `desktop:src-tauri/src/lib.rs` (check_updates), `.github/workflows/desktop.yml` + `release.yml` (ký, latest.json), `worker:internal/channel` (SelfUpdate tắt khi đi kèm app) |
| DESK-11 | The desktop app shall sign users in through the system browser (RFC 8252 loopback redirect with PKCE S256): after the user approves on the hub, the app shall exchange a single-use code for a machine registration token and a personal token, then register the machine and link the account without manual token entry. | Implemented | `hub:modules/fleet/desktop-connect.db.test.ts`, `web:hub/desktop-connect.spec.ts`, `desktop:src-tauri/src/browser_login.rs` (tests), `desktop:register-screen.test.tsx` |
| DESK-12 | The desktop app shall list the hub projects the user can see on a "Projects on this machine" screen, bind each to a local folder (folder picker, `origin` check, first-time import from the previous app), show its state (not bound, bound, remote mismatch, folder missing), offer to create a hub project from a local repository without one, and provide a per-project "full permission on this machine" switch with a risk confirmation, locked when the organization forbids full permission (ADR 0020). | Implemented | `desktop:src/screens/projects-screen.test.tsx`, `desktop:src/lib/local-projects.test.ts`, `desktop:src-tauri/src/local_projects.rs`, `worker:cmd/hive-worker/projects_test.go` |

### 3.18 Code review workflows (CR)

Spec [009](../specs/009-code-review-workflows/spec.md), [ADR 0018](adr/0018-code-review-workflows.md).

| ID | Requirement | Status | Verification |
|---|---|---|---|
| CR-01 | Team and organization administrators shall configure code review workflows on the review workflow page, choosing per workflow whether it applies to documents or code, with triggers by project, target branch, task type and changed paths, presets, and a dry run against an existing code run. | Planned | — |
| CR-02 | Code review workflows shall support gates for AI review (one to three CLIs and models, rubric, minimum score, aggregation, blocking severity), automated rules (commands, file count, denied paths, diff size, secrets, agent report), CI on the pull request head, and human reviewers by user, role or team with quorum and SLA, each with conditions on paths, task types and diff size. | Planned | — |
| CR-03 | When a code run ends `succeeded` or `needs_review` with an open pull request and a matching code workflow, the hub shall start a code review instance and evaluate its gates in order, replacing the outcome policy's cross-review check and automatic merge-queue entry for that run. | Planned | — |
| CR-04 | Members shall see pull requests awaiting their decision in "Awaiting my review" on the web and in the desktop app, with the diff, AI review results and automated check results, and shall approve or request changes against the head commit they reviewed. | Planned | — |
| CR-05 | On a request for changes the instance shall route to an agent fix run carrying the feedback as instructions (bounded by a revision limit and the task budget), to the requester, or to the previous human gate; a new commit on the pull request shall start a new round. | Planned | — |
| CR-06 | An approved instance shall put the pull request into the merge queue automatically or wait for a member, according to the workflow or project merge mode; the merge queue shall not merge a pull request whose code review is not approved. | Planned | — |
| CR-07 | Projects without a matching code workflow shall keep the existing outcome policy behaviour; administrators may create a code workflow draft from a project's cross-review, CI and approval settings. | Planned | — |
| CR-08 | AI review runs of a code workflow shall be team runs that run only on shared machines or runner hosts, unless the gate is set to run on the requester's machine. | Planned | — |
| CR-09 | Gate results, decisions, overrides of automated gates (with a mandatory reason) and routing shall be audited and notified, and overdue human gates shall be reminded once per wait. | Planned | — |

## 4. External interface requirements

| ID | Requirement | Status |
|---|---|---|
| IF-01 | The web app shall use the oRPC API under `/rpc`; third parties shall use the equivalent OpenAPI under `/api/v1`, whose description is committed as `packages/contracts/openapi.json`. | Implemented |
| IF-02 | Workers shall use the WebSocket protocol in `packages/contracts/src/worker-protocol.ts`, version 1, with version negotiation in `hello`. | Implemented |
| IF-03 | Agents shall use MCP over streamable HTTP at `/mcp`. | Implemented |
| IF-04 | Git hosts shall deliver webhooks to `/hooks/git/{projectId}`. | Implemented |
| IF-05 | The desktop app shall query `/api/v1/desktop/updates/{os}/{arch}/{version}` in the Tauri updater format. | Partial: the app has no update endpoint or key configured |
| IF-06 | Git hosts shall deliver skill repository webhooks to `/hooks/skills/{repoId}`. | Implemented |
## 5. Non-functional requirements

| ID | Category | Requirement | Status | Verification |
|---|---|---|---|---|
| NFR-01 | Security | All tenant tables shall have row-level security enabled and forced; the application role shall not bypass it. | Implemented | `hub:modules/*/rls.db.test.ts` |
| NFR-02 | Security | Registration and machine tokens shall be stored only as SHA-256 hashes; run tokens shall be audience-bound to `/mcp` and expire with the run. | Implemented | `hub:modules/fleet/registration.db.test.ts`, `hub:modules/runs/token.test.ts` |
| NFR-03 | Security | Stored secrets shall be encrypted with AES-256-GCM under the master key. | Implemented | `hub:modules/platform/secrets.test.ts` |
| NFR-04 | Security | Worker releases shall be signed; installers and the updater shall refuse unsigned or altered builds. | Implemented | `worker:internal/update/update_test.go` |
| NFR-05 | Security | Secrets shall be masked in run logs and available only during setup. | Planned | — |
| NFR-06 | Security | Runs shall push with short-lived, repository-scoped Git tokens. | Planned | — |
| NFR-07 | Reliability | Run messages shall be delivered at least once and stored exactly once (deduplicated by run, attempt and sequence or offset). | Implemented | `hub:runs.db.test.ts`, `worker:internal/channel` tests |
| NFR-08 | Reliability | A machine that misses three heartbeats (30 seconds each) shall be disconnected; a run whose lease (90 seconds) expires shall be retried. | Implemented | `hub:fleet.db.test.ts`, `hub:runs.db.test.ts` |
| NFR-09 | Reliability | Database migrations shall apply to databases created by earlier releases. | Implemented | `hub:migrations-upgrade.db.test.ts` |
| NFR-10 | Recoverability | The operator shall be able to back up the database with the configuration and restore it in one transaction. | Implemented | `deploy/test-backup.sh` |
| NFR-11 | Usability | Every screen shall be usable at 360 px wide without horizontal scrolling, in light and dark themes, with Vietnamese text. | Partial: Playwright checks 360 px on the admin, project, run, task, plan and queue screens | `web:tasks-runs.spec.ts`, `web:projects-runs.spec.ts`, `web:admin.spec.ts` |
| NFR-12 | Portability | The worker shall run on macOS, Linux and Windows (amd64 and arm64). | Implemented | CI worker matrix, release builds |
| NFR-13 | Maintainability | Hub modules shall depend on each other only through their public `index.ts`. | Implemented | `pnpm deps` |
| NFR-14 | Operability | The hub shall run as one container plus PostgreSQL and report its deployed commit at `/api/v1/health`. | Implemented | `deploy/compose.yaml`, `hub:app.test.ts` |
| NFR-15 | Scalability | Several hub `api` processes shall share the worker connections. | Planned | — |
| NFR-16 | Observability | The hub and worker shall export metrics and traces. | Planned | — |
