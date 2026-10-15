# Feature Specification: Block-Based Collaborative Document Editor

**Feature Branch**: `005-doc-editor`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "DocEditor.dc: soạn tài liệu kiểu Tiptap, đề xuất của AI, bình luận, phiên bản"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Block-based document authoring with slash menu (Priority: P1)

An engineer or product owner needs a rich text and Markdown editor with specialized engineering blocks (Headings, Checklists,
Tables, auto-numbered Requirement IDs `R-n`, syntax-highlighted code blocks, Mermaid diagrams, and embedded docs) accessed
via a slash command (`/`).

**Why this priority**: Core content creation must be structured and pleasant so that specifications remain consistent and machine-readable for agents.

**Independent Test**: Can be tested by typing `/` on an empty block, selecting "Requirement with id", observing that `R-1` is auto-inserted, adding a Mermaid diagram block, and verifying the editor renders both properly.

**Acceptance Scenarios**:

1. **Given** an active document on `/knowledge/docs/$key/edit`, **When** the user types `/`, **Then** the slash menu appears with block options (Heading, Checklist, Table, Requirement with id, Code block, Mermaid diagram, Embed doc, Write with AI).
2. **Given** a user inserting a Requirement block, **When** inserted, **Then** the editor assigns the next sequential requirement identifier (e.g., `R-4`) and links it to document metadata.
3. **Given** a Mermaid block containing diagram code, **When** the block loses focus, **Then** the diagram renders interactively with error fallback if syntax is invalid.

---

### User Story 2 - Suggestion mode and AI proposals (Priority: P1)

Authors and AI agents need to propose inline edits (insertions and deletions) that can be individually accepted or rejected,
with explanatory rationale.

**Why this priority**: In an AI SDLC, automated agents should propose improvements without silently overwriting human author intent.

**Independent Test**: Can be tested by switching to "Suggesting" mode (or having an agent submit a proposal), observing green insertion and red strikethrough badges with "Claude suggests: matches fee rule", and clicking "Accept" to merge the change.

**Acceptance Scenarios**:

1. **Given** the editor in "Suggesting mode", **When** a collaborator replaces a sentence, **Then** the change appears as an inline proposal with "Accept" and "Reject" action buttons.
2. **Given** an AI agent proposing an edit via MCP, **When** displayed in the editor, **Then** the suggestion card displays the agent badge, the proposed text replacement, and the rationale for the change.
3. **Given** a pending suggestion, **When** the author clicks "Accept", **Then** the text replacement is applied to the document draft and the suggestion is marked accepted.

---

### User Story 3 - Contextual commenting and threads (Priority: P2)

Collaborators need to highlight specific text ranges or blocks, leave discussion comments, reply to threads, and mark them as resolved.

**Why this priority**: Discussion must stay attached to the exact text under question rather than scattered across external chat channels.

**Independent Test**: Can be tested by selecting a block, clicking "Add comment", submitting "Are collected fees refundable?", replying to the thread, and clicking "Resolve".

**Acceptance Scenarios**:

1. **Given** selected text in the document, **When** the user clicks the comment button, **Then** an anchored comment thread is created in the sidebar.
2. **Given** an open comment thread, **When** another collaborator types a reply and submits, **Then** the reply appears in chronological order with user avatar and relative timestamp.
3. **Given** an open comment thread, **When** the author clicks "Resolve", **Then** the thread is moved to the resolved comments drawer and the highlight is cleared.

---

### User Story 4 - Version snapshots and review submission (Priority: P1)

Authors need to view the history of document revisions (v1, v2, v3) and submit the current draft into a review workflow,
freezing the version.

**Why this priority**: Provides clear audit trails of how documents evolved and bridges drafting into formal review workflows.

**Independent Test**: Can be tested by editing draft v3, clicking "Submit for review", confirming the next checkpoints in the modal, and verifying that v3 is frozen and transitioned to the review pipeline.

**Acceptance Scenarios**:

1. **Given** the "Versions" sidebar tab, **When** opened, **Then** all previous versions are listed with author, timestamp, and change notes.
2. **Given** a draft document, **When** the author clicks "Submit for review", **Then** a confirmation dialog shows the pending checkpoints (e.g. AI pre-check, Product owner, Legal) and notes input.
3. **Given** the review submission confirmed, **When** processed, **Then** the draft is saved as an immutable `doc_version` and a new `review_instance` is created.

---

### User Story 5 - AI assistant sidecar actions (Priority: P2)

Authors need on-demand AI assistance to continue writing, verify template completeness, draft acceptance criteria from requirements,
cross-reference related documents, or translate text to English.

**Why this priority**: Accelerates specification authoring while keeping humans in control of final content.

**Independent Test**: Can be tested by opening the "AI" sidebar tab, clicking "Draft acceptance criteria", and verifying that concrete criteria are generated for each `R-n` requirement.

**Acceptance Scenarios**:

1. **Given** the AI sidebar tab, **When** the author selects "Check against the PRD template", **Then** the AI assistant lists present and missing sections with recommended additions.
2. **Given** an AI action output, **When** the author clicks "Insert into document", **Then** the content is inserted either as direct blocks or as inline proposals depending on the active editor mode.

---

### Edge Cases

- What happens if two users edit the same document draft concurrently?
  Optimistic concurrency control checks the base version; if a conflict occurs, the second user receives a conflict alert with an option to merge changes as suggestions.
- What happens if an AI suggestion conflicts with another pending suggestion?
  Accepting one suggestion automatically recalculates or supersedes overlapping suggestions.
- How are large Mermaid diagrams handled?
  Mermaid blocks include client-side error boundaries with syntax validation before rendering; invalid diagrams render as plain code blocks with error messages.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (DOC-01)**: System MUST provide a block-based editor supporting Headings, Checklists, Tables, Requirement IDs (`R-n`), Code blocks with syntax highlighting, Mermaid diagrams, and embedded docs via `/` menu.
- **FR-002 (DOC-02)**: System MUST support Direct Editing and Suggestion modes, tracking proposed insertions and deletions as discrete patch entities that can be accepted or rejected.
- **FR-003 (DOC-03)**: System MUST support block-anchored commenting threads with reply, resolve, and reopen capabilities.
- **FR-004 (DOC-04)**: System MUST maintain named version snapshots (`doc_versions`), change logs, and allow freezing versions for submission to review workflows.
- **FR-005 (DOC-05)**: System MUST provide AI sidecar actions (continue writing, template completeness check, acceptance criteria drafting, cross-referencing, translation) using the user's desktop subscription or organization budget.
- **FR-006**: System MUST persist document state as structured ProseMirror JSON alongside compiled Markdown without requiring a dedicated WebSocket collaboration daemon (per ADR 0015).
- **FR-007**: System MUST record all version creations, review submissions, and proposal resolutions with `recordAudit()`.

### Key Entities

- **Document Draft**: Current working state of a document (`docs.current_version`, `docs.draft_json`, `docs.draft_md`).
- **Document Suggestion**: Proposed text modification (`id`, `doc_id`, `base_version`, `author_type`, `author_id`, `rationale`, `diff_patch`, `status`).
- **Document Comment**: Anchored discussion thread (`id`, `doc_id`, `block_id`, `anchor_range`, `status`, `author_user_id`).
- **Document Version Snapshot**: Frozen, immutable historical version (`doc_versions` table).

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Editor typing latency remains < 16ms (60 fps) for documents up to 5,000 lines of text.
- **SC-002**: 100% of accepted suggestions are cleanly merged into the document draft without losing block structure or formatting.
- **SC-003**: Mermaid diagrams and syntax highlighting render within 200ms on modern web browsers.

---

## Out of Scope

- Multi-cursor real-time keystroke synchronization (Google Docs style continuous OT/CRDT stream).
- Export to Microsoft Word `.docx` binary format (Markdown and HTML export only).

---

## Assumptions

- Users author specifications primarily in Markdown and structured block formats.
- The Tiptap / ProseMirror headless framework executes within React 19 in `apps/web`.

---

## Open Questions & Clarifications *(NEEDS CLARIFICATION)*

- **[NEEDS CLARIFICATION 1]**: When an AI sidecar action executes, should it default to spending the user's personal desktop subscription (via the Tauri app bridge) or the organization agent budget? (Assumed: preference set by user toggle; defaults to desktop subscription if connected).
- **[NEEDS CLARIFICATION 2]**: Maximum allowed document length for a single spec file before suggesting splitting into multiple modular documents (e.g. 100,000 characters).
- **[NEEDS CLARIFICATION 3]**: Should deleted comments be hard-deleted or soft-deleted with an "Audit log" retention policy? (Assumed: soft-deleted to maintain auditability).
