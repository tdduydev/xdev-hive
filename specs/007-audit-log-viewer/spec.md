# Feature Specification: Audit Log Viewer and Export

**Feature Branch**: `007-audit-log-viewer`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Audit.dc: API đọc audit_log có lọc, phân trang con trỏ; quyền quản trị tổ chức"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Time-scoped query with cursor-based pagination (Priority: P1)

An organization administrator or auditor needs to inspect audit events spanning predefined time ranges (24 hours, 7 days,
30 days, 365 days) with fast, stable cursor-based pagination.

**Why this priority**: Without efficient reading and paging, administrators have no visibility into administrative mutations,
agent actions, or security incidents across thousands of events.

**Independent Test**: Can be tested by seeding audit log rows, calling the query endpoint with time range 7 days and limit 20,
verifying 20 rows are returned alongside a valid opaque cursor, and fetching the subsequent page with the cursor.

**Acceptance Scenarios**:

1. **Given** an administrator navigating to `/admin/audit`, **When** the page loads, **Then** recent audit entries within the selected time range (default: 7 days) are rendered in reverse chronological order with timestamp, actor avatar, action badge, target description, result, and source.
2. **Given** the audit log list, **When** the user clicks "Next page", **Then** the subsequent page is retrieved using the opaque cursor without skipped rows or duplicate records.

---

### User Story 2 - Multi-faceted filtering and search (Priority: P1)

An auditor investigating an incident needs to filter the audit log by actor type (Person, Agent, System), specific actor,
functional area (Work, Knowledge, Projects & infra, People & access, Agent governance), action name, source (Web, MCP, Hub),
result (Success, Denied), and free-text search.

**Why this priority**: Finding specific actions in a stream of tens of thousands of records requires immediate, composable filtering.

**Independent Test**: Can be tested by filtering by `actorType = 'run'` and `action = 'memory.write'`, verifying that only
agent memory write events appear in the filtered results.

**Acceptance Scenarios**:

1. **Given** the audit log DataTable, **When** the auditor selects facet "Actor type: Agent (run)", **Then** only events triggered by agent runs over MCP or background processes are shown.
2. **Given** the search input, **When** the auditor types a specific IP address or target string (e.g., `payment-api`), **Then** matching events across actor identity and target details are returned.
3. **Given** an action resulting in authorization rejection, **When** displayed, **Then** the result badge shows "Denied" in red tone.

---

### User Story 3 - Export audit log to CSV and JSON (Priority: P2)

An auditor needs to export filtered audit records in CSV or JSON format for external compliance reporting, archiving, or
analysis in external SIEM systems.

**Why this priority**: Compliance frameworks (SOC 2, ISO 27001) mandate exportable audit records for external auditors.

**Independent Test**: Can be tested by applying a 30-day filter, clicking "Export CSV", and verifying the downloaded file
contains all filtered records with standard CSV headers (`timestamp,actor,action,target,result,source,ip`).

**Acceptance Scenarios**:

1. **Given** a filtered view on `/admin/audit`, **When** the user clicks "Export CSV", **Then** the browser downloads a CSV file containing all matching records within the selected filters up to the export limit.
2. **Given** the export menu, **When** the user selects "Export JSON", **Then** a structured JSON array of audit objects is downloaded.

---

### User Story 4 - Strict immutability and retention guarantee (Priority: P1)

The system must guarantee that audit entries cannot be modified or deleted by regular application roles, and are retained
for 365 days.

**Why this priority**: Integrity of audit records is essential for legal compliance and non-repudiation.

**Independent Test**: Can be tested by verifying that any `UPDATE` or `DELETE` SQL statement on `audit_log` executed with
the `hive_app` role fails with permission denied or violates RLS policies.

**Acceptance Scenarios**:

1. **Given** the `audit_log` table, **When** any application client or administrator attempts an update or delete via API, **Then** no endpoint exists and direct database statements fail.
2. **Given** records older than the organization retention policy (365 days), **When** the automated archival worker runs, **Then** expired records are securely archived or pruned.

---

### Edge Cases

- What happens if an audit event has no associated user (e.g. system background worker or webhook)?
  `actor_user_id` is null; the UI renders the actor as "xDev Hive" with a System badge.
- How does the system handle high query concurrency during large export requests?
  Exports stream rows in chunks of 500 using keyset pagination to prevent database memory exhaustion.
- What happens if an organization member without audit permissions tries to call the audit API?
  The API responds with an oRPC `FORBIDDEN` error and logs an authorization failure.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (OPS-05)**: System MUST provide an API endpoint to query the `audit_log` table with cursor-based pagination and time range filters (24 hours, 7 days, 30 days, 365 days).
- **FR-002 (OPS-05)**: System MUST support filtering audit logs by actor type (`user`, `run`, `system`), specific actor, functional area (`work`, `know`, `proj`, `people`, `agent`), action name, source (`web`, `mcp`, `hub`), and outcome result (`ok`, `denied`).
- **FR-003 (OPS-05)**: System MUST support free-text search across actor names, targets, and source IP addresses.
- **FR-004 (OPS-06)**: System MUST support exporting filtered audit logs into CSV and JSON formats.
- **FR-005 (OPS-07)**: System MUST preserve append-only immutability for the `audit_log` table, ensuring no update or delete operations are granted to the `hive_app` role.
- **FR-006 (OPS-07)**: System MUST retain audit log entries for at least 365 days by default before archival or cleanup.
- **FR-007**: System MUST restrict access to audit log endpoints to organization owners, administrators, or custom roles with `audit.read` and `audit.export` permissions.

### Key Entities

- **Audit Log Entry**: Append-only event in `audit_log` (`id`, `org_id`, `actor_user_id`, `action`, `target_type`, `target_id`, `data`, `created_at`).
- **Audit Filter Query**: Specification of time ranges, facets, search terms, and cursor pagination tokens.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Audit log query response time < 100ms for p95 requests across 1,000,000 rows using indexed keyset pagination.
- **SC-002**: CSV export of 10,000 records completes within 3 seconds using streaming HTTP responses.
- **SC-003**: 100% of administrative mutations, policy updates, and MCP calls are captured with zero missing audit records.

---

## Out of Scope

- Visual chart dashboards or anomaly detection machine learning models over audit logs (data table and export only).
- Real-time SIEM streaming over Syslog/Kafka protocols (export via API and CSV/JSON only).

---

## Assumptions

- Audit rows are written via the existing `recordAudit()` helper inside transactions.
- The `audit_log` table exists in PostgreSQL schema `hive` with `FORCE ROW LEVEL SECURITY`.

---

## Open Questions & Clarifications *(NEEDS CLARIFICATION)*

- **[NEEDS CLARIFICATION 1]**: For exports exceeding 50,000 rows, should the API use synchronous HTTP streaming or generate an asynchronous download link delivered to the user's inbox? (Assumed: synchronous streaming up to 20,000 rows; larger exports require asynchronous background generation).
- **[NEEDS CLARIFICATION 2]**: Should IP addresses captured in audit logs be masked or anonymized after 30 days to comply with regional privacy regulations (e.g. GDPR)? (Assumed: full IP retained for security auditing within the 365-day retention period).
