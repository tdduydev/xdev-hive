# 0023. Store versioned artifacts in the hub and run interactive ones in a sandboxed frame on a separate CSP

- Status: Accepted
- Date: 2026-10-14 (proposed and accepted the same day; product owner answers recorded in spec 012
  "Clarifications")
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

The product owner then decided (2026-10-14): React artifacts, public links and "ask Leader to fix" are part of the MVP;
frames are served from the hub's own host; pages may not use the network or any CDN, only bundled libraries; the secret
scanner always blocks; organization administrators do not read other members' private artifacts.

Requirements: ART-01 … ART-16, NFR-18, IF-08 ([srs.md](../srs.md#321-artifacts-art)); spec
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
   (`packages/contracts/src/secret-scan.ts`, fixture shared with the worker) that always blocks and reports the line and kind.
4. **Chat shows a reference card, the artifact opens in a side panel.** Creating an artifact in a thread adds a chat
   message carrying `artifact_id` and `artifact_version`; the Leader screen on web and desktop renders it as a card and
   opens a side panel built from the shared package `@xdev-hive/artifacts-ui`.
5. **Interactive content runs only in a sandboxed frame loaded by URL.** The parent creates
   `<iframe sandbox="allow-scripts">` (never `allow-same-origin`, top navigation, popups, forms or modals) whose source is
   `/_artifact/frame/{ticket}` on the hub's own host. The ticket is an HMAC-signed, five-minute grant for one artifact
   version. The response carries its own CSP: `default-src 'none'`, scripts and styles only inline and from the hub's
   `/_artifact/lib/` path, `img-src data: blob:`, `connect-src 'none'`, `form-action 'none'`, `frame-src 'none'`,
   `base-uri 'none'` and the `sandbox allow-scripts` directive, so the document stays sandboxed even when opened directly.
   No CDN and no organization setting can widen it. `/_artifact/*` routes ignore session cookies. `srcdoc` and `blob:`
   documents are not used because they inherit the parent's policy container.
6. **Libraries are bundled, not fetched.** `@xdev-hive/artifacts-runtime` builds pinned ESM libraries (React, ReactDOM,
   Recharts, lucide-react, Tailwind's browser build, Mermaid, markdown-it) with an SRI manifest; the hub serves them from
   `/_artifact/lib/` with `Access-Control-Allow-Origin: *` (the frame has an opaque origin) and the desktop app ships them
   as resources.
7. **React artifacts are compiled on the hub when saved**, with `sucrase` (JSX and TypeScript to ESM); `es-module-lexer`
   rejects imports outside the manifest and dynamic `import()`. Syntax errors are stored with the version and returned to
   the caller. Compiling in the frame with `esbuild-wasm` was rejected: the agent would not see errors until someone opened
   the page, the import check would run inside content it is meant to constrain, and every view would download the
   compiler.
8. **The desktop app caches opened versions** (LRU, 200 MiB, per profile and organization, cleared on sign-out) and serves
   frames from a `hive-artifact://` protocol with the same CSP, so downloaded artifacts work offline. The hub renders the
   frame document (`artifacts.frameDocument`) so the app does not duplicate that logic. The desktop app gets a minimal
   Leader screen with the side panel.
9. **Public links.** Only the owner creates a link to one version, valid 1–30 days, revocable by the owner or an
   organization administrator, disabled organization-wide by policy. The hub stores only the SHA-256 of a 256-bit token
   and resolves it through a `SECURITY DEFINER` function, so the URL carries no organization id. `/_artifact/s/{token}` is a
   static page without scripts that shows the title, version and expiry, a warning label and the sandboxed frame. Every
   failure returns the same 404. Requests are rate limited per IP and per link in memory, views are counted and audited
   hourly, and the secret scanner runs again when a link is created.
10. **"Ask Leader to fix".** The frame reports runtime errors and console errors to the panel; the viewer reviews them and
    sends them to their own Leader conversation, with the artifact attached. The Leader prompt places the errors in a
    block marked as untrusted page data.

## Consequences

- Good: agent output becomes durable, versioned and shareable inside the organization, on web and desktop.
- Good: hostile content has no path to the hub session or the network; one component (`SandboxFrame`) and one route
  create frames, which keeps the attack surface reviewable and testable (Playwright escape suite).
- Good: no new service; self-hosted and air-gapped installations work.
- Bad: artifact versions grow the database; limits, quotas, a 30-day trash and an 80% warning are needed.
- Bad: bundled libraries must be updated by us; artifacts cannot use arbitrary npm packages or call APIs.
- Bad: frames share the hub's site; isolation relies on the sandbox, the CSP and cookie-blind routes, with no site
  isolation between the frame and the hub tab. A browser sandbox escape would land in the hub origin.
- Bad: public links put agent-written pages on the company domain for people outside the organization; the warning label,
  the no-form, no-network frame, expiry, revocation, rate limits and audit reduce but do not remove phishing and leak risk.
- Bad: React compilation adds CPU work on save and a dependency (`sucrase`) to the hub.
- Bad: the desktop app gains a minimal Leader screen that partly duplicates the web page until a shared Leader UI exists.

## Alternatives considered

- Store artifacts as knowledge documents: documents need keys and reviews and have no personal scope or executable
  content; mixing them would spread sandbox and limit logic into `knowledge`.
- Render HTML with `srcdoc` or in a `blob:` URL: inherits the parent CSP, which would either block the artifact or force a
  weaker CSP on the hub and the app.
- Load libraries from public CDNs: fails offline and in installations without Internet access, and opens a channel for
  data exfiltration and supply-chain changes outside our lockfile.
- Serve frames from a separate domain (`HIVE_ARTIFACT_ORIGIN`): strongest isolation, but adds DNS and TLS work for every
  self-hoster; the product owner chose the hub's host. The frame base stays a single setting so it can be added later.
- Allow organization-approved CDN origins: rejected by the product owner; pages may only use the bundled libraries.
- Redact secrets instead of blocking: silently changes code and HTML; the product owner chose blocking.
- Public access through a `public` scope read by the SPA: would expose `/rpc` to anonymous users and has no per-link
  expiry or revocation.
- An S3-compatible blob store now: [0003](0003-postgresql-only-state.md) defers it; the `BlobStore` interface keeps the
  door open.

## Links

- Spec [012](../../specs/012-artifacts/spec.md), [plan](../../specs/012-artifacts/plan.md),
  [tasks](../../specs/012-artifacts/tasks.md)
- SRS ART-01 … ART-16, NFR-18, IF-08; related LEAD-01, LEAD-02, MCP-01, MCP-03, MCP-04, DOC-01, NFR-01, NFR-11
- [0003](0003-postgresql-only-state.md), [0004](0004-row-level-security-tenancy.md),
  [0013](0013-ui-shadcn-base-ui.md), [0015](0015-doc-editor-collaborative-engine.md),
  [0016](0016-desktop-local-ui.md), [0017](0017-admin-web-client-app-and-machine-ownership.md),
  [0021](0021-ai-sdlc-mode.md)
