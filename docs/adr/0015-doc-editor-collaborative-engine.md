# 0015. Block-based document editor using Tiptap and patch proposals without a dedicated collaboration service

- Status: Proposed
- Date: 2026-10-12
- Deciders: maintainers

## Context

The v2 design introduces a rich document editor (`DocEditor.dc.html`) for engineering specifications, PRDs, ADRs,
and runbooks (DOC-01 through DOC-05). It requires slash commands (`/`), structured blocks (Mermaid diagrams, syntax-highlighted
code, auto-numbered requirement IDs `R-n`), inline AI suggestions, comments, and version snapshots.

Early architecture explorations noted a possible `collab` service (running a real-time CRDT/OT engine like Yjs or
Hocuspocus over WebSockets). However, Constitution Principle VII mandates that PostgreSQL is the only stateful dependency,
and self-hosting must remain simple without extra long-running services. Furthermore, engineering documents in an AI SDLC
are authored in deliberate phases (drafting, suggestion review, gate approval) rather than simultaneous multi-user
keystroke typing.

## Decision

Implement the document editor inside `apps/web` using Tiptap (ProseMirror headless framework), storing document content
and metadata directly in PostgreSQL:

1. **Storage Format**:
   - Store canonical structured content as ProseMirror JSON (`doc_versions.content_json`) alongside compiled
     Markdown (`doc_versions.content`).
   - Custom ProseMirror node extensions provide auto-numbered requirements (`R-1`, `R-2`), Mermaid diagrams, and embedded docs.
2. **Review & Suggestion Model**:
   - Rather than simultaneous character-level CRDT streams, collaborative contributions use a Git-like patch proposal
     model (`doc_suggestions`).
   - AI agents (via MCP or background jobs) and human reviewers submit structured suggestions with rationale, which authors
     can accept or reject individually.
3. **Commenting and Awareness**:
   - Comments and replies are stored in PostgreSQL (`doc_comments`) linked to block identifiers.
   - Presence indicators and live comment updates use existing PostgreSQL `LISTEN/NOTIFY` and Server-Sent Events (SSE).
4. **Lifecycle and Baselining**:
   - Drafts are versioned using optimistic concurrency (`version` counter).
   - Submitting a document for review freezes the version snapshot into `doc_versions` and launches a review workflow instance.

## Consequences

- Good: Strictly adheres to Principle VII; zero new daemon services, memory brokers, or external dependencies.
- Good: Matches the AI-DLC paradigm where AI modifications are presented as accountable proposals to accept or reject.
- Good: Full compatibility with headless Markdown export, git sync, and automated agent prompts.
- Bad: Two human users concurrently editing the same document draft in direct edit mode require optimistic locking
  notifications instead of real-time collaborative cursor merging.

## Implementation note (2026-10-12)

The first version (DOC-01 to DOC-05) keeps the storage and review model above but stores Markdown only: the editor is
a block editor over Markdown in `apps/web` (no Tiptap yet, no `content_json`), so agents and the review workflow read
the same text. Drafts, suggestions, comment threads, snapshots and presence live in `doc_*` tables keyed by doc key;
submitting a draft creates a doc proposal that enters the matching review workflow. Presence and new comments use
polling rather than SSE. AI assistance is a read-only `docassist` run pinned to the requester's own machine.

## Alternatives considered

- Standalone WebSocket collaboration server (Yjs/Hocuspocus): Rejected because it adds operational overhead, memory state,
  and connection management outside the PostgreSQL-centric hub architecture.
- Plain Markdown textarea: Rejected because it cannot provide rich interactive widgets (rendered Mermaid, tri-state suggestions,
  anchor-based commenting, and requirement auto-numbering).

## Links

- [0001](0001-modular-monolith-hub.md), [0003](0003-postgresql-only-state.md), [srs.md (DOC-01 to DOC-05)](../srs.md#315-collaborative-document-editor-doc), `specs/005-doc-editor/`
