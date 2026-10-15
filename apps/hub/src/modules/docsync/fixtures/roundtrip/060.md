# Implementation Plan: Block-Based Collaborative Document Editor

**Branch**: `005-doc-editor` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-doc-editor/spec.md`

## Summary

Implement the block-based rich text and Markdown document editor (`/knowledge/docs/$key/edit`) using Tiptap and ProseMirror.
In accordance with ADR 0015, the editor uses PostgreSQL-backed draft and version snapshots, supporting inline suggestions,
anchored comment threads, auto-numbered requirements (`R-n`), and review workflow integration without an external collaboration daemon.

## Technical Context

**Language/Version**: TypeScript 5.8+ (React 19 on Web, Node.js 24 on Hub)

**Primary Dependencies**: `@xdev-hive/contracts`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `mermaid`, `shiki` (syntax highlighting)

**Storage**: PostgreSQL 18 with RLS enabled and forced on all document editing, suggestion, and commenting tables

**Testing**: Vitest for document serialization and markdown conversions; Playwright for editor user interactions

**Target Platform**: Modern Web Browsers (Web), Linux (Hub)

**Project Type**: Rich Web Client + Modular API Backend

**Performance Goals**: Sub-16ms typing latency; client-side document parsing < 50ms; instant slash menu activation

**Constraints**: Complies with ADR 0015: no dedicated WebSocket CRDT server; PostgreSQL is the single stateful store

## Constitution Check

- [x] **Principle I (Contract first)**: Contracts for drafts, suggestions, comments defined in `packages/contracts/src/docs-editor.ts`.
- [x] **Principle II (Tenant isolation)**: All queries use `withTenant()`; RLS enabled and forced on `doc_suggestions`, `doc_comments`, `doc_comment_replies`.
- [x] **Principle III (Module boundaries)**: Implemented within `apps/hub/src/modules/knowledge/`, exported via `index.ts`.
- [x] **Principle IV (Tested before merged)**: Unit tests for Markdown/JSON conversions; DB tests for optimistic concurrency.
- [x] **Principle V (Secure by default)**: Content sanitized against XSS; Mermaid and code rendered securely.
- [x] **Principle VI (Vietnamese for people, English for code)**: UI labels and error responses in Vietnamese with i18n support.
- [x] **Principle VII (Simple to self-host)**: Implements ADR 0015: zero extra collaboration microservices.

## Project Structure

### Documentation

```text
specs/005-doc-editor/
├── spec.md
└── plan.md
```

### Source Code

```text
packages/contracts/src/
└── docs-editor.ts                     # Schemas: DraftContent, Suggestion, CommentThread, AIActionInput

apps/hub/src/modules/knowledge/
├── editor-schema.ts                   # Tables: doc_suggestions, doc_comments, doc_comment_replies
├── editor-service.ts                  # Draft persistence, patch merging, version freezing
├── editor-router.ts                   # oRPC endpoints for editor drafts, comments, and AI triggers
└── editor.db.test.ts                  # DB integration tests for draft locking and comments

apps/web/src/
├── routes/knowledge/
│   └── doc-editor.tsx                 # Full-screen editor route (/knowledge/docs/$key/edit based on DocEditor.dc.html)
└── components/editor/
    ├── tiptap-editor.tsx              # Tiptap headless core with ProseMirror schema
    ├── slash-menu.tsx                 # Interactive '/' command palette
    ├── requirement-node.tsx           # Custom ProseMirror node for auto-numbered R-n requirements
    ├── mermaid-node.tsx               # Client-rendered Mermaid diagram node
    ├── suggestions-layer.tsx          # Inline diff highlights with Accept/Reject floating UI
    ├── comments-sidebar.tsx           # Anchored comment threads with reply/resolve
    └── ai-assistant-pane.tsx          # AI actions sidecar panel
```

---

## Database Design (Schema & RLS)

```sql
-- apps/hub/db/migrations/xxxx_doc_editor.sql

-- Add draft json storage to docs table
ALTER TABLE hive.docs ADD COLUMN draft_json jsonb;
ALTER TABLE hive.docs ADD COLUMN draft_version integer NOT NULL DEFAULT 1;

-- Add rich json content to historical versions
ALTER TABLE hive.doc_versions ADD COLUMN content_json jsonb;

CREATE TABLE hive.doc_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  doc_id uuid NOT NULL REFERENCES hive.docs(id) ON DELETE CASCADE,
  base_version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  author_type text NOT NULL CHECK (author_type IN ('user', 'agent')),
  author_id text NOT NULL,
  rationale text,
  diff_patch jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE hive.doc_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  doc_id uuid NOT NULL REFERENCES hive.docs(id) ON DELETE CASCADE,
  block_id text NOT NULL,
  anchor_range jsonb,
  author_user_id text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hive.doc_comment_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hive.orgs(id) ON DELETE CASCADE,
  comment_id uuid NOT NULL REFERENCES hive.doc_comments(id) ON DELETE CASCADE,
  author_user_id text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS Enforcement
ALTER TABLE hive.doc_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.doc_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY doc_suggestions_rw ON hive.doc_suggestions FOR ALL TO hive_app USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.doc_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.doc_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY doc_comments_rw ON hive.doc_comments FOR ALL TO hive_app USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());

ALTER TABLE hive.doc_comment_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive.doc_comment_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY doc_comment_replies_rw ON hive.doc_comment_replies FOR ALL TO hive_app USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
```

---

## Contracts & API Design

Exported from `packages/contracts/src/docs-editor.ts`:

- `GET /docs/{key}/draft`: Retrieve current document draft (JSON and Markdown), open suggestions, and active comments.
- `PUT /docs/{key}/draft`: Save draft changes (`version`, `contentJson`, `contentMd`) with optimistic concurrency.
- `POST /docs/{key}/suggestions`: Propose a change (`baseVersion`, `rationale`, `diffPatch`).
- `POST /docs/{key}/suggestions/{id}/accept`: Accept a suggestion and apply to draft.
- `POST /docs/{key}/suggestions/{id}/reject`: Reject a suggestion.
- `GET /docs/{key}/comments`: List comments and replies.
- `POST /docs/{key}/comments`: Add anchored comment (`blockId`, `anchorRange`, `content`).
- `POST /docs/{key}/comments/{id}/reply`: Add reply to comment thread.
- `POST /docs/{key}/comments/{id}/resolve`: Mark comment thread as resolved.
- `POST /docs/{key}/submit-review`: Freeze current draft into a new `doc_versions` row and initiate review workflow.

---

## Permissions & Authorization

- Editing drafts and accepting suggestions requires `docs.write` permission.
- Proposing suggestions and adding comments requires `docs.read` (or `proposals.create`).
- Freezing and submitting to review requires `docs.write`.
- Mutating operations invoke `recordAudit()`:
  - `action`: `docs.draft_update`, `docs.suggestion_accept`, `docs.submit_review`.
  - `targetType`: `doc`, `targetId`: `doc.id`.

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Concurrent direct edits overwrite each other without CRDT | Medium | Optimistic locking on draft version; warn user if draft was updated elsewhere and offer to load diff. |
| Malicious Markdown or Mermaid code executes script in browser | High | Sanitize HTML on render; run Mermaid inside an isolated iframe or web worker boundary with CSP. |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Dual format storage (JSON + Markdown) | Enables rich block editing while retaining Git/MCP plain-text compatibility | Storing only Markdown loses cursor anchors and fine-grained block attributes; storing only JSON breaks Git and agent CLI readability |
