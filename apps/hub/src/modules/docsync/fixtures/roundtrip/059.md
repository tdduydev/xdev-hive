# Feature Specification: Document Review Workflows and Queue

**Feature Branch**: `004-review-workflows`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Workflows.dc + DocReview.dc: quy trình duyệt theo AI-DLC, Spec Kit, BMAD, tự tạo; hàng chờ tôi duyệt, diff, AI tự kiểm, truy vết"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure phased review pipelines with AI SDLC presets (Priority: P1)

An organization or team administrator needs to set up formal document review workflows based on standard AI SDLC frameworks
(AI-DLC, Spec Kit, BMAD) or custom pipelines, defining phases (Inception, Construction, Operations) and heterogeneous gates
(AI pre-check, human approval, automated rule, external CI).

**Why this priority**: Without structured review workflows, document baselining is ad-hoc, allowing inconsistent PRDs,
unreviewed designs, and unverified architectural changes to proceed directly into implementation.

**Independent Test**: Can be tested by selecting the "Spec Kit" preset (Specify -> Plan -> Tasks), customizing the gate
for `plan.md` to require both an AI constitution check and human Architect sign-off, and verifying the workflow configuration saves.

**Acceptance Scenarios**:

1. **Given** an administrator on `/knowledge/workflows`, **When** they select the "AI-DLC" preset, **Then** three standard phases (Inception, Construction, Operations) are populated with their respective gates and default SLAs.
2. **Given** a phase gate configuration, **When** the administrator sets gate kind to "AI pre-check" with Claude Sonnet and 5-minute SLA, **Then** the gate is configured to run an automated check before human review.
3. **Given** a human review gate, **When** the administrator configures conditions (e.g. type = PRD, mentions keyword "fee, refund"), **Then** the gate triggers only when matching conditions are met.

---

### User Story 2 - Review queue and document diff inspection (Priority: P1)

Designated reviewers need a dedicated queue ("Chờ tôi duyệt" / Awaiting my review) to inspect documents pending their sign-off,
examine line-by-line diffs against the approved baseline, and monitor SLA deadlines.

**Why this priority**: Reviewers must quickly identify pending work, understand exactly what changed since the last approved
version, and prevent SLA breaches.

**Independent Test**: Can be tested by submitting a PRD revision, navigating to `/knowledge/reviews`, clicking the item in the
DataTable, and verifying the unified diff view shows additions in green and deletions in red.

**Acceptance Scenarios**:

1. **Given** an authenticated reviewer visiting `/knowledge/reviews`, **When** the page loads, **Then** they see all document review instances currently awaiting their decision, filtered by SLA status (Overdue, Due soon, On time).
2. **Given** a selected review instance, **When** the reviewer inspects the detail pane, **Then** they see the workflow stepper, the previous baseline version comparison (+/- lines), and the author information.

---

### User Story 3 - Automated AI pre-check and rubric scoring (Priority: P2)

When a document enters an AI pre-check gate, the hub automatically evaluates completeness against the document template,
detects contradictions with related documents, and checks acceptance criteria formatting.

**Why this priority**: Eliminates trivial review overhead for human reviewers by catching missing sections or malformed
requirements before humans spend time reviewing.

**Independent Test**: Can be tested by submitting an incomplete PRD (missing acceptance criteria), observing the AI pre-check
gate output a warning checklist ("No daily cap on refund count"), and calculating an AI quality score (e.g. 7.2/10).

**Acceptance Scenarios**:

1. **Given** a document advancing to an AI check gate, **When** the background job executes, **Then** it evaluates rubric checklist items (e.g., "All template sections present", "Every R-n has acceptance criteria") and records the results.
2. **Given** an AI check result with warnings, **When** the human reviewer views the review detail pane, **Then** the AI rubric checklist is prominently displayed alongside the quality score.

---

### User Story 4 - Approve, reject, and route revisions (Priority: P1)

Reviewers need to make formal decisions (Approve, Request changes) with notes and routing options (return to human author,
request agent revision, or return to a previous checkpoint).

**Why this priority**: High-fidelity decision feedback loops allow automated agent self-correction or human author revision.

**Independent Test**: Can be tested by requesting changes with note "Missing fee refund cap" and route "Agent revises",
verifying that the review status updates and an agent revision run is automatically dispatched.

**Acceptance Scenarios**:

1. **Given** a pending review gate, **When** the reviewer clicks "Approve", **Then** the review instance advances to the next gate in the phase, or completes the workflow if it is the final gate.
2. **Given** a reviewer clicking "Request changes", **When** they enter feedback and choose "Agent revises, then returns here", **Then** the hub dispatches an agent task containing the review note and pauses the gate until the revised draft is submitted.

---

### User Story 5 - Requirement traceability audit (Priority: P2)

Reviewers and architects need to verify that all functional requirements (`R-1`, `R-2`, ...) are mapped to concrete
acceptance criteria and downstream tasks.

**Why this priority**: Prevents requirements from being dropped during development and guarantees full testability.

**Independent Test**: Can be tested by clicking "Requirement traceability" on a PRD review, verifying each `R-n` requirement
displays its mapped acceptance criteria and downstream task status.

**Acceptance Scenarios**:

1. **Given** a document with auto-numbered requirements (`R-1`, `R-2`), **When** the traceability pane is opened, **Then** each requirement is displayed with its linked acceptance criteria and validation status.

---

### Edge Cases

- What happens if a reviewer does not act before the SLA deadline expires?
  The review item is flagged with an overdue badge, an escalation notification is sent to the inbox, and administrators can reassign the review.
- What happens if an edit only touches formatting or whitespace?
  If "Skip for typo or formatting-only edits" is enabled, the AI classifier marks the diff as trivial and auto-advances through intermediate gates.
- What happens if a document is deleted while a review is pending?
  The review instance is automatically marked `cancelled` and removed from the active review queue.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (WF-01)**: System MUST allow administrators to create and configure review workflows with phases and gates using presets (`aidlc`, `speckit`, `bmad`, `custom`).
- **FR-002 (WF-02)**: System MUST support four checkpoint gate kinds: `ai` (AI pre-check), `human` (designated reviewer by user, role, or group), `rule` (automated traceability/diff check), and `ext` (CI status check).
- **FR-003 (WF-03)**: System MUST support gate conditions (document type, keyword matching, line diff thresholds, skip small edits) and SLA durations.
- **FR-004 (WF-04)**: System MUST allow reviewers to approve or request changes with feedback notes, routing rejections back to author, to an agent for revision, or to a previous gate.
- **FR-005 (WF-05)**: System MUST baseline approved document versions upon completing all gates and optionally trigger subsequent agent tasks (e.g. creating technical design task from approved PRD).
- **FR-006**: System MUST provide a dedicated "Awaiting my review" queue with multi-faceted filtering (document type, gate, SLA status, author type) and cursor pagination.
- **FR-007**: System MUST display unified diffs (+/- lines and modified sections) against the baseline version in the review pane.
- **FR-008**: System MUST record all gate decisions, reassignments, and automated check outputs in `audit_log`.

### Key Entities

- **Review Workflow**: Organization or team workflow definition containing ordered phases.
- **Review Phase**: Sub-stage of a workflow (e.g. Inception, Construction, Operations) containing ordered gates.
- **Review Gate**: Specific checkpoint defining evaluator type (`ai`, `human`, `rule`, `ext`), SLA, trigger conditions, and routing rules.
- **Review Instance**: Active execution of a review workflow for a specific document version snapshot.
- **Review Gate Execution**: Record of an individual gate's evaluation, including evaluator identity, AI score, rubric checklist, decision note, and timestamps.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: AI pre-checks execute and produce structured rubric results in under 60 seconds from document submission.
- **SC-002**: Review queue queries load in under 150ms for reviewers with up to 1,000 pending organization reviews.
- **SC-003**: 100% of approved review workflows result in an immutable baseline snapshot in `doc_versions`.

---

## Out of Scope

- Real-time video or audio co-review sessions inside the browser.
- Legal electronic signature compliance (e.g. DocuSign integration).

---

## Assumptions

- Documents are stored as versioned Markdown/JSON in the knowledge module.
- AI pre-checks utilize the hub's configured LLM provider or local runner host model.

---

## Open Questions & Clarifications *(NEEDS CLARIFICATION)*

- **[NEEDS CLARIFICATION 1]**: When an AI check flags severe rubric failures, should the workflow automatically block human review or allow the human reviewer to override the AI warning? (Assumed: AI provides advisory warnings and score; human reviewer can override unless configured as strict blocking rule).
- **[NEEDS CLARIFICATION 2]**: How should review instances be handled if a workflow's definition is modified while instances are in-flight? (Assumed: in-flight instances follow the workflow snapshot captured at submission time).
- **[NEEDS CLARIFICATION 3]**: For group reviewer assignments (e.g. "Legal group · 1/2"), does approval by ANY single group member satisfy the gate, or is unanimous approval required? (Assumed: configurable quorum, default: 1 approval required).
