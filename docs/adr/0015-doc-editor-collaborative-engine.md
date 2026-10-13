# 0015. Block-based document editor using Tiptap and patch proposals without a dedicated collaboration service

- Status: Accepted
- Date: 2026-10-12 (accepted 2026-10-13)
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

Implement the document editor with Tiptap (ProseMirror headless framework) in the shared package `packages/doc-editor`,
used by both the admin web and the desktop app, storing document content and metadata directly in PostgreSQL:

1. **Storage Format**:
   - Markdown is the canonical stored format (`doc_drafts.content`, doc versions, proposals). The hub, agents, the review
     workflow and repo sync (spec 011) read Markdown only; there is no ProseMirror JSON column. Tiptap is only the
     editing layer: load Markdown, edit WYSIWYG, write Markdown back.
   - Custom node extensions provide auto-numbered requirements (`- R-n: …` list items), Mermaid diagrams (fenced
     `mermaid` code with a preview), GitHub-style callouts (`> [!note]`), embedded docs (`![[key]]`), tables and task lists,
     each serialized back to the same Markdown syntax agents already read.
   - Round-trip must not change meaning: each Markdown block is parsed separately and kept as a raw Markdown block when
     the editor cannot rebuild it with the same rendered HTML, and blocks the user did not touch are written back with
     their original text.
   - Only MIT-licensed Tiptap packages (including the official `@tiptap/markdown`) at exact versions; no Tiptap Pro
     extensions and no Tiptap Cloud.
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
  notifications instead of real-time collaborative cursor merging. Real-time collaboration (Yjs) is out of scope for now.
- Bad: Tiptap and ProseMirror add about 560 kB (176 kB gzip) to the editor chunk; the package lazy-loads the editor so
  pages that only show review panes do not download it.

## Implementation note (2026-10-12)

The first version (DOC-01 to DOC-05) keeps the storage and review model above but stores Markdown only: the editor is
a block editor over Markdown in `apps/web` (no Tiptap yet, no `content_json`), so agents and the review workflow read
the same text. Drafts, suggestions, comment threads, snapshots and presence live in `doc_*` tables keyed by doc key;
submitting a draft creates a doc proposal that enters the matching review workflow. Presence and new comments use
polling rather than SSE. AI assistance is a read-only `docassist` run pinned to the requester's own machine.

## Implementation note (2026-10-13)

The block editor (one textarea per Markdown block) is replaced by Tiptap in `packages/doc-editor`: toolbar commands,
a bubble menu for inline formatting, a `/` menu built from the block templates in `blocks.ts`, link editing (Mod-K),
pasting from Word and Google Docs as clean Markdown, and Vietnamese input methods. Suggesting mode still turns edits into
block-level suggestions (`suggestionsFromEdit`), suggestion cards are anchored under their block inside the editor, and
comment quotes are highlighted. The desktop app uses the same `MarkdownEditor` for `.md` files and for the Edit mode of
hub docs in "Docs from code". Storage stays Markdown, so no migration was needed.

## Alternatives considered

- Standalone WebSocket collaboration server (Yjs/Hocuspocus): Rejected because it adds operational overhead, memory state,
  and connection management outside the PostgreSQL-centric hub architecture.
- Storing ProseMirror JSON next to Markdown: Rejected because two sources of truth drift, and every reader (agents,
  review, repo sync) would still need the Markdown.
- Plain Markdown textarea: Rejected because it cannot provide rich interactive widgets (rendered Mermaid, tri-state suggestions,
  anchor-based commenting, and requirement auto-numbering).

## Links

- [0001](0001-modular-monolith-hub.md), [0003](0003-postgresql-only-state.md), [srs.md (DOC-01 to DOC-05)](../srs.md#315-collaborative-document-editor-doc), `specs/005-doc-editor/`
