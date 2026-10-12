# Feature Specification: MCP Tools and External Servers Administration

**Feature Branch**: `003-mcp-tools-admin`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "McpTools.dc: tool của hub bật/tắt, MCP server ngoài, token"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Toggle built-in Hub MCP tools (Priority: P1)

An organization administrator needs to selectively enable or disable individual built-in MCP tools (e.g. `doc_propose`,
`memory_write`, `plan_submit`) and inspect recent invocation volume and error counts.

**Why this priority**: Disabling untested, risky, or irrelevant tools limits attack surface and enforces workflow discipline for agents.

**Independent Test**: Can be tested by disabling tool `doc_propose`, executing an MCP call to `doc_propose` with a valid run token, and verifying that the gateway responds with an oRPC `FORBIDDEN` error indicating the tool is disabled.

**Acceptance Scenarios**:

1. **Given** an administrator on `/admin/mcp` under the "Hub tools" tab, **When** they toggle the state of `doc_propose` to "Off", **Then** the tool override is saved and the tool is hidden from MCP `tools/list` or rejected with `TOOL_DISABLED`.
2. **Given** the Hub tools tab, **When** viewing the tool list, **Then** each tool displays its group (Knowledge, Tasks, Runs), caller scope (Run token vs Run & Users), 7-day call volume, and error count.

---

### User Story 2 - Govern external MCP servers with allow/deny rules (Priority: P1)

An administrator needs to restrict which third-party MCP servers (e.g. GitHub, Playwright, Figma, Shell, Filesystem)
agents are allowed to connect to on worker machines, enforcing that "Deny wins over allow".

**Why this priority**: Rogue or unvetted MCP servers (such as arbitrary shell or unrestricted filesystem access) could leak proprietary code or compromise worker machines.

**Independent Test**: Can be tested by creating an allow rule for `name: github` and a deny rule for `command: npx @modelcontextprotocol/server-filesystem` and wildcard `*`, verifying that the worker managed settings block the filesystem server.

**Acceptance Scenarios**:

1. **Given** an administrator under the "External MCP servers" tab, **When** they add a rule matching `command: npx @modelcontextprotocol/server-filesystem` with rule "Deny", **Then** the rule is stored and distributed to workers.
2. **Given** conflicting rules matching an external server (e.g., specific allow rule vs broader deny rule), **When** evaluated, **Then** the hub enforces "Deny wins over allow" and denies server access.
3. **Given** a project-scoped rule, **When** runs are dispatched for that specific project, **Then** the project-specific rule applies in addition to organization rules.

---

### User Story 3 - Manage personal user MCP tokens (Priority: P1)

Developers need personal MCP tokens to connect their IDE clients (Claude Code, Cursor, VSCode, Codex, Hermes) to the
hub MCP gateway, while administrators need visibility to extend or revoke tokens.

**Why this priority**: Developers need access to hub knowledge and memory from their desktop IDEs without sharing permanent passwords or service accounts.

**Independent Test**: Can be tested by generating a new token with 30-day lifetime, copying the token once, making an MCP request with `Authorization: Bearer <token>`, and subsequently revoking the token and verifying rejection.

**Acceptance Scenarios**:

1. **Given** a developer creating a new token on `/admin/mcp`, **When** they select their client (`cursor`) and 30-day lifetime, **Then** the plaintext token (prefixed with `hmt_...`) is displayed once in a modal dialog, and only its SHA-256 hash is persisted.
2. **Given** an administrator viewing the "MCP tokens" tab, **When** a token is expiring in less than 7 days, **Then** the token is displayed with a warning badge and the administrator can click "Extend lifetime".
3. **Given** an active token, **When** an administrator or token owner clicks "Revoke", **Then** the token is immediately invalidated and future MCP calls with it fail with HTTP 401 Unauthorized.

---

### Edge Cases

- What happens if a personal MCP token is used while the user's account is locked or deactivated?
  The gateway checks the member's active status; tokens belonging to inactive or blocked members are rejected immediately.
- How does the system handle wildcard `*` rules for external servers?
  A wildcard `*` deny rule denies all servers that are not explicitly matched by more specific allow rules, unless a specific deny rule also matches.
- What happens if a worker machine cannot reach the hub to verify an external MCP rule?
  Rules are baked into the CLI managed settings file inside the worktree prior to CLI launch; offline CLI execution respects the generated configuration.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (MCP-04)**: System MUST allow organization administrators to enable or disable individual built-in hub MCP tools (`doc_list`, `doc_get`, `doc_propose`, `skill_list`, `skill_get`, `memory_search`, `memory_write`, `task_get`, `task_update`, `plan_submit`, `review_submit`).
- **FR-002 (MCP-05)**: System MUST allow administrators to create, edit, and delete external MCP server governance rules, matching by `url`, `name`, `command`, or wildcard `*`, with rule type `allow` or `deny`, scoped to organization or project.
- **FR-003**: System MUST enforce precedence: "Deny wins over allow" across matching external MCP server rules.
- **FR-004 (MCP-06)**: System MUST write effective external MCP server allow/deny rules into CLI managed settings on assigned run machines before run execution.
- **FR-005 (MCP-07)**: System MUST allow users to generate personal MCP tokens with expiration periods (e.g. 30 or 90 days), storing only the SHA-256 hash and displaying the raw token string once.
- **FR-006**: System MUST allow administrators to list all active, expiring, and expired tokens, extend token expiration, and revoke tokens immediately.
- **FR-007**: System MUST record 7-day call counts and error rates for each hub tool and expose them via an administrative metrics endpoint.
- **FR-008**: System MUST record all token creations, token revocations, tool toggles, and server rule modifications with `recordAudit()`.

### Key Entities

- **MCP Tool Override**: Per-organization toggle for a built-in hub MCP tool (`org_id`, `tool_name`, `enabled`).
- **MCP Server Rule**: Governance rule defining permitted or blocked external MCP servers (`org_id`, `match_pattern`, `match_type`, `rule`, `project_id`).
- **MCP User Token**: Secure token for external developer clients (`org_id`, `user_id`, `token_hash`, `prefix`, `client_id`, `expires_at`, `last_used_at`).

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Disabling a tool takes effect globally within 1 second; subsequent MCP calls fail with clear Vietnamese error messages.
- **SC-002**: 100% of plain user tokens are hashed with SHA-256; zero plaintext secrets are stored in the database or logs.
- **SC-003**: Revoking a token terminates all active API and SSE sessions for that token within 5 seconds.

---

## Out of Scope

- Hosting external MCP servers as containers inside the Hub process (servers run on external URLs or local worker host processes).
- Automatic discovery of unauthorized MCP servers running inside developer local networks.

---

## Assumptions

- External clients (Claude Code, Cursor, VSCode) connect to `/mcp` via HTTP/HTTPS with Bearer authorization.
- Worker machines have internet or intranet connectivity to allowed external MCP URLs if configured.

---

## Open Questions & Clarifications *(NEEDS CLARIFICATION)*

- **[NEEDS CLARIFICATION 1]**: Should personal MCP tokens have a mandatory maximum lifespan (e.g., hard limit of 90 days) with no option for perpetual tokens? (Assumed: yes, max 90 days to enforce rotation).
- **[NEEDS CLARIFICATION 2]**: Should project-level rules be capable of overriding an organization-wide deny rule? (Assumed: no, organization deny rules are absolute ceilings; deny always wins).
