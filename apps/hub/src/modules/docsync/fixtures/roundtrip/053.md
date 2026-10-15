# Feature Specification: Custom Roles and Permissions

**Feature Branch**: `001-custom-roles`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Roles.dc: vai trò tự tạo dạng cây quyền, gán cho người và đội"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create and configure custom role with permission tree (Priority: P1)

An organization administrator needs to define specialized roles (e.g. "Merge reviewer" or "Auditor") with a granular
subset of permissions across access, work, knowledge, projects, agents, and monitoring areas.

**Why this priority**: Without custom roles, organizations must grant broad `admin` access or overly restricted `member`
access, violating the principle of least privilege.

**Independent Test**: Can be tested by creating a custom role with specific permissions (e.g., `plans.decide`, `merge.enqueue`),
assigning it to a user, and verifying that the user can approve plans and enqueue merges but is forbidden from modifying project settings.

**Acceptance Scenarios**:

1. **Given** an authenticated organization administrator on `/admin/roles`, **When** they click "New role", enter name "Merge reviewer", scope "Organization", and select the "Work > Review & Merge" permission branch, **Then** all leaf permissions under that branch are selected and the role is saved.
2. **Given** a custom role, **When** the administrator toggles off an individual leaf permission under a parent branch, **Then** the parent branch checkbox displays a tri-state (mixed) indicator and only granted leaves are saved.
3. **Given** an existing custom role, **When** the administrator attempts to grant a sensitive permission marked as dangerous (e.g., `policies.fullaccess`), **Then** the UI displays a warning confirmation dialog before applying the change.

---

### User Story 2 - Clone system roles into custom roles (Priority: P2)

Administrators want to create a role slightly different from built-in system roles (organization roles `owner`, `admin`, `member`; team roles `admin`, `member`, `viewer`)
without building a permission list from scratch.

**Why this priority**: Reduces manual configuration effort and ensures custom roles retain standard baseline capabilities.

**Independent Test**: Can be tested by cloning the `viewer` team role, adding `costs.read` and `audit.read`, saving as "Auditor", and verifying the resulting permission list.

**Acceptance Scenarios**:

1. **Given** a system role (team role `viewer`) displayed in `/admin/roles`, **When** the administrator selects "Duplicate role" and provides name "Auditor", **Then** a new editable custom role is created with the exact permission set of `viewer`.
2. **Given** a system role, **When** an administrator tries to directly edit or delete it, **Then** the action is blocked and a notice indicates system roles are immutable.

---

### User Story 3 - Assign custom roles to users and teams (Priority: P1)

Administrators need to bind custom roles to specific organization members or entire teams to grant effective permissions.

**Why this priority**: Defining roles has zero effect unless members and teams inherit the effective permissions at runtime.

**Independent Test**: Can be tested by assigning a custom role to a team, verifying that any team member receives the custom role's permissions for the team's resources.

**Acceptance Scenarios**:

1. **Given** a member with base role `member`, **When** an administrator assigns custom role "Auditor" to that member, **Then** the member can immediately access `/admin/audit` and read cost summaries.
2. **Given** a team with assigned custom role "Doc Reviewer", **When** a team member performs a document review action, **Then** the hub authorizes the action based on the team's inherited role.
3. **Given** a custom role currently assigned to 3 members, **When** an administrator attempts to delete the role, **Then** the hub rejects the deletion until all assignments are removed or reassigned.

---

### User Story 4 - Permission tree navigation and inspection (Priority: P3)

Administrators navigating the large permission tree need search, collapsible categories, and a filter to show only granted permissions.

**Why this priority**: Improves usability for roles with dozens of permissions and prevents accidental misconfiguration.

**Independent Test**: Can be tested by searching "audit" in the permission search input and verifying that non-matching categories collapse while matching leaf nodes remain visible.

**Acceptance Scenarios**:

1. **Given** the permission tree view, **When** the administrator enters a query in the search input, **Then** only matching nodes and their parent category branches are displayed.
2. **Given** an active role, **When** the administrator toggles "Only granted", **Then** unchecked permission nodes are hidden and only active permissions are displayed.

---

### Edge Cases

- What happens when a user is assigned multiple custom roles with overlapping permissions?
  Effective permission is the logical union of all granted permissions across their base role, team roles, and assigned custom roles.
- What happens if a permission key is deprecated or removed in a newer hub version?
  Database migration prunes deprecated keys from `role_permissions` and records a system audit event.
- How does the system prevent privilege escalation?
  An administrator cannot grant permissions that they themselves do not possess, unless they hold the `owner` role.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (ROLE-01)**: System MUST allow organization administrators to create, update, and delete custom roles with a unique name, optional description, scope (`org` or `team`), and permission set.
- **FR-002 (ROLE-02)**: System MUST keep system roles (organization roles `owner`, `admin`, `member`; team roles `admin`, `member`, `viewer`) immutable, while allowing administrators to duplicate them into new custom roles.
- **FR-003 (ROLE-03)**: System MUST organize permissions in a hierarchical tree (areas: `access`, `work`, `know`, `proj`, `agent`, `ops`), where toggling a branch node toggles all descendant leaf permissions.
- **FR-004 (ROLE-04)**: System MUST allow assigning custom roles to organization members and teams, enforcing tenant isolation so that roles cannot be viewed or assigned across organizations.
- **FR-005**: System MUST evaluate effective permissions in hub modules using `hasPermission(ctx, permissionKey)` checking the union of base roles, team memberships, and custom roles.
- **FR-006**: System MUST record all role creations, edits, deletions, and member assignments in the append-only `audit_log` with `recordAudit()`.
- **FR-007**: System MUST reject deletion of any custom role that is actively assigned to one or more members or teams.
- **FR-008**: System MUST flag sensitive permissions (e.g., `policies.fullaccess`, `roles.manage`) with a danger badge and require explicit confirmation when toggled.

### Key Entities

- **Custom Role**: Represents a named set of permissions within an organization. Belongs to `org_id`, has `name`, `description`, `scope` (`org` or `team`), and `is_system` flag.
- **Role Permission**: Join entity mapping a role to a leaf permission key (e.g. `tasks.create`, `plans.decide`, `audit.read`).
- **Member Custom Role**: Join entity mapping an organization member to a custom role.
- **Team Custom Role**: Join entity mapping a team to a custom role, inherited by team members.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Role permission check latency adds less than 2 milliseconds to request authorization overhead by caching parsed role permissions in the request context.
- **SC-002**: 100% of custom role management operations are recorded in the audit log with actor ID, target role ID, and modified permission keys.
- **SC-003**: 0% cross-tenant leakage: custom roles from organization A are strictly invisible and unassignable in organization B, enforced by database RLS.
- **SC-004**: Web UI renders the 50+ permission node tree without lag (< 100ms render time) and supports full keyboard accessibility and tri-state checkbox toggles.

---

## Out of Scope

- Negative/Deny permission overrides (permissions are additive only; explicit "deny" rules are not supported in this version).
- Time-limited or expiring role assignments (e.g. temporary role valid for 24 hours).
- Resource-specific attribute-based access control (ABAC) beyond organization and team boundaries.

---

## Assumptions

- System roles remain hardcoded in code definitions and are seeded or recognized automatically.
- Users always possess at least one base organization role (`owner`, `admin`, or `member`).
- Custom roles supplement rather than completely replace the base Better Auth user session.

---

## Open Questions & Clarifications *(NEEDS CLARIFICATION)*

- **[NEEDS CLARIFICATION 1]**: Conflict resolution when a member has `viewer` in team A, but an org-level custom role grants `tasks.create`: does the org-level custom role grant write access in team A, or do team-level boundaries restrict write actions within the team? (Assumed: org-level custom roles grant global capabilities, team-scoped custom roles grant capabilities only within that team).
- **[NEEDS CLARIFICATION 2]**: Maximum limit on custom roles per organization (e.g., capped at 25 or unlimited?).
- **[NEEDS CLARIFICATION 3]**: Should custom roles be allowed to scope directly to a single Project, or only Organization and Team? (Design shows Org and Team scopes; Project scope is deferred).
