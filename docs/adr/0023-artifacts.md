# 0023. Store versioned artifacts in the hub and run interactive ones in a sandboxed frame on a separate CSP

- Status: Proposed
- Date: 2026-10-14
- Deciders: product owner (tdduydev), maintainers

## Context

The product owner asked (2026-10-14) that Hive "store Claude Artifacts — dedicated, interactive workspaces that open in
a side panel next to your chat rather than staying buried inside the text stream".

Today everything an agent produces in a conversation is plain text: `chat_messages.content` is rendered with
`whitespace-pre-wrap` on the Leader page, the leader run may only call `leader_reply` and `leader_propose`, and the
desktop app has no Leader screen. Knowledge documents (`docs`, `doc_versions`) are versioned but are reviewed, keyed
documents with organization, team and project scope only. The hub keeps all state in PostgreSQL
([0003](0003-postgresql-only-state.md)); there is no blob store. The hub serves the SPA on the same origin as `/rpc` and
`/mcp` and sets no Content-Security-Policy; the desktop app sets `default-src 'self'` and reaches the hub over IPC.

Interactive artifacts (HTML, React, SVG, Mermaid) are written by agents that read untrusted repositories and issues, so
their content must be treated as hostile: it must never run in the hub or app origin, must not read the session, and
must not send data out.

Requirements: ART-01 … ART-14, NFR-18, IF-08 ([srs.md](../srs.md#321-artifacts-art)); spec
[012](../../specs/012-artifacts/spec.md).

## Decision

1. **A new hub module `artifacts`** owns artifacts (type, owner, scope `private | project | team | org`, origin), their
   immutable versions (author is a user or a run, optimistic locking with `baseVersion`, restore creates a new version)
   and links to chat threads, terminal sessions, runs, tasks, AI SDLC items and documents. It does not go through review
   workflows; "Convert to document" creates a knowledge proposal instead. Tables have row-level security enabled and
   forced; scope is filtered by one function used on every read path. `hive_app` cannot update or delete versions except
   through two `SECURITY DEFINER` functions (tombstone a version that leaked a secret, rename a version).
2. **Text content lives in PostgreSQL.** Images and PDFs (after the MVP) go through a `BlobStore` interface whose first
   implementation is chunked `bytea` in PostgreSQL, so an S3 store can replace it without API changes.
3. **Agents use four MCP tools**: `artifact_create`, `artifact_update`, `artifact_get`, `artifact_list`, available to the
   leader run (new `forLeader` flag on tools), to task runs except `doccheck`, `docassist` and `brief`, and to user
   clients. Limits per version, per artifact, per run and per organization; every save passes a shared secret scanner
   (`packages/contracts/src/secret-scan.ts`, fixture shared with the worker) that blocks by default.
4. **Chat shows a reference card, the artifact opens in a side panel.** Creating an artifact in a thread adds a chat
   message carrying `artifact_id` and `artifact_version`; the Leader screen on web and desktop renders it as a card and
   opens a side panel built from the shared package `@xdev-hive/artifacts-ui`.
5. **Interactive content runs only in a sandboxed frame loaded by URL.** The parent creates
   `<iframe sandbox="allow-scripts">` (never `allow-same-origin`, top navigation, popups, forms or modals) whose source is
   `/_artifact/frame/{ticket}`. The ticket is an HMAC-signed, five-minute grant for one artifact version. The response
   carries its own CSP: `default-src 'none'`, scripts and styles only inline and from the frame's library path (plus
   organization-approved CDN origins), `img-src data: blob:`, `connect-src 'none'`, `form-action 'none'`,
   `frame-src 'none'`, `base-uri 'none'` and the `sandbox allow-scripts` directive, so the document stays sandboxed even
   when opened directly. `srcdoc` and `blob:` documents are not used because they inherit the parent's policy container.
   Operators may set `HIVE_ARTIFACT_ORIGIN` to serve frames from a separate site (recommended in production).
6. **Libraries are bundled, not fetched.** `@xdev-hive/artifacts-runtime` builds pinned ESM libraries (Mermaid in the MVP;
   React, Recharts, d3 and others later) with an SRI manifest; the hub serves them from the frame origin and the desktop
   app ships them as resources. React artifacts are compiled on save with `sucrase`, and imports outside the manifest are
   rejected.
7. **The desktop app caches opened versions** (LRU, 200 MiB, per profile and organization, cleared on sign-out) and serves
   frames from a `hive-artifact://` protocol with the same CSP, so downloaded artifacts work offline. The hub renders the
   frame document (`artifacts.frameDocument`) so the app does not duplicate that logic.

## Consequences

- Good: agent output becomes durable, versioned and shareable inside the organization, on web and desktop.
- Good: hostile content has no path to the hub session or the network; one component (`SandboxFrame`) and one route
  create frames, which keeps the attack surface reviewable and testable (Playwright escape suite).
- Good: no new service; self-hosted and air-gapped installations work.
- Bad: artifact versions grow the database; limits, quotas, a 30-day trash and an 80% warning are needed.
- Bad: bundled libraries must be updated by us; artifacts cannot use arbitrary npm packages or call APIs.
- Bad: without `HIVE_ARTIFACT_ORIGIN`, frames share the hub's site; isolation then relies on the sandbox and CSP alone.
- Bad: the desktop app gains a minimal Leader screen that partly duplicates the web page until a shared Leader UI exists.

## Alternatives considered

- Store artifacts as knowledge documents: documents need keys and reviews and have no personal scope or executable
  content; mixing them would spread sandbox and limit logic into `knowledge`.
- Render HTML with `srcdoc` or in a `blob:` URL: inherits the parent CSP, which would either block the artifact or force a
  weaker CSP on the hub and the app.
- Load libraries from public CDNs: fails offline and in installations without Internet access, and opens a channel for
  data exfiltration and supply-chain changes outside our lockfile.
- Require a separate domain for frames: strongest isolation, but adds DNS and TLS work for every self-hoster; kept
  optional and recommended.
- An S3-compatible blob store now: [0003](0003-postgresql-only-state.md) defers it; the `BlobStore` interface keeps the
  door open.

## Links

- Spec [012](../../specs/012-artifacts/spec.md), [plan](../../specs/012-artifacts/plan.md),
  [tasks](../../specs/012-artifacts/tasks.md)
- SRS ART-01 … ART-14, NFR-18, IF-08; related LEAD-01, LEAD-02, MCP-01, MCP-03, MCP-04, DOC-01, NFR-01, NFR-11
- [0003](0003-postgresql-only-state.md), [0004](0004-row-level-security-tenancy.md),
  [0013](0013-ui-shadcn-base-ui.md), [0015](0015-doc-editor-collaborative-engine.md),
  [0016](0016-desktop-local-ui.md), [0017](0017-admin-web-client-app-and-machine-ownership.md),
  [0021](0021-ai-sdlc-mode.md)
