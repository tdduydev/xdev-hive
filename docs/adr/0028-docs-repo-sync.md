# 0028. Keep documents in the hub and synchronize them with repository folders

- Status: Accepted
- Date: 2026-10-15
- Deciders: Project owner

## Context

The project owner requires the hub to be the primary place to author, find and authorize documents, while GitHub
and GitLab repositories retain durable copies and Git history, including documents created in the hub. Existing
repository documents must be importable without losing their paths, relative links or Markdown formatting.
Attachments need a local copy for display, extraction and search even when the provider is unavailable.

Requirements [DSYNC-01–DSYNC-12](../srs.md#323-document-repository-synchronization-dsync) cover configuration,
import, both synchronization directions, conflicts, attachments, search, access and operations. The owner accepted
all Q1–Q12 recommendations in [spec 018](../../specs/018-docs-repo-sync/spec.md) on 15 October 2026.

`knowledge` already owns versioned documents, access checks, drafts and reviews. SDLC synchronization and the skill
repository provide useful patterns but different ownership and conflict policies. A document must not be managed
by two synchronization mechanisms. PostgreSQL remains the only required stateful dependency (ADR 0003).

## Decision

1. **Keep hub versions and repository files.** Each linked document has a home: a Git connection, repository,
   default branch and folder, with mode `pr`, `direct` or `off`. Project homes default to `docs/` and `pr`; one
   organization repository defaults to `direct`, with `org/` and `teams/<slug>/` folders. Images and attachments
   live beside documents under the home's assets directory. Existing unlinked hub documents require an explicit
   path preview and a separate adoption PR. Unlinking a home retains hub documents and does not delete Git files.
2. **Add a hub module `docsync`.** It owns homes, imports, batches, repository mappings, conflicts, attachments and
   extraction. `knowledge` continues to own documents, versions, authorization, reviews and search. It publishes
   saves through `provideDocSaved` in the save transaction; it does not import `docsync`. Provider operations use
   `scm`'s `GitProvider`; merge queue operations use `catalog`. Cross-module calls go through `index.ts`.
   SDLC-managed paths and the skill repository are excluded, and overlapping homes are rejected.
3. **Batch hub changes and reconcile before writing.** Debounce saves per home for 60 seconds after the last save,
   with a ten-minute ceiling from the first pending save. Persist both time markers: the T002 spike established
   that pg-boss `singletonKey` with `startAfter` suppresses duplicates but does not move the first job's deadline.
   In `pr` mode keep one rolling PR per home on `hive/docs-sync-<home>`, set `xdev-hive/docs` and use the project's
   merge policy; in `direct` mode commit to the configured default branch. Protected-branch failures are reported
   with a suggestion to use `pr`. Retry transient errors with provider backoff and report exhausted retries.
   Check repository hashes before a write and reject a concurrent head change. Record batch trailers and author
   co-authorship; use trailers and content hashes to prevent echo versions. Repository-origin versions are not
   queued for another push.
4. **Resolve changes against a common base.** Pull after verified push webhooks (30-second coalescing) and a
   fifteen-minute fallback scan. If only the repository changed, create a hub version recording its commit and
   author; optionally route it through review when `repoChangesNeedReview` is enabled. If both sides changed,
   reuse `mergeBlocks` for edits to different Markdown blocks. Otherwise keep base, hub and repository content in
   one open conflict per document. A user with `manage` permission chooses hub, repository or manual content,
   producing a new version for synchronization. Further repository edits update that conflict. A repository
   deletion asks whether to archive the hub document or write it back. Renames retain document ID, key and
   history; repository paths are separate metadata. A default-branch change pauses the home until an
   administrator accepts it and a full comparison runs.
5. **Share one BlobStore in `platform`.** Implement `platform/blob-store.ts` over `blobs` and `blob_chunks`, with
   512 KiB PostgreSQL `bytea` chunks and SHA-256 deduplication within an organization. Both tables carry `org_id`,
   enable and force RLS, and are accessed through `withTenant()` as `hive_app`. Artifacts (spec 012 T062) reuse
   this implementation instead of adding `artifact_blobs` tables. Enforce file and organization quotas, validate
   MIME types from bytes and garbage-collect unreferenced blobs using reference providers registered by consumers;
   `platform` does not import those consumers. Downloads check the owning document's access and serve SVG/HTML
   as attachments or with script-blocking CSP. Git LFS is used only for paths already matching `filter=lfs` rules
   in the repository's `.gitattributes`; the hub never enables LFS itself.
6. **Keep derived content in the hub.** Preserve attachment originals in Git and the BlobStore. Extract Office
   documents and text PDFs in bounded background workers, require review before search or agent use, and retain
   the last approved extract until its replacement is approved. Extract Markdown is never committed to Git.
   OCR is outside this release. Search combines keyword and optional vector results using the memory embedding
   configuration, falling back to keyword search. Secret checks apply on import, save, pull, extraction and
   before embedding. Secret-blocked versions are not pushed or exposed to agents pending an audited confirmation;
   secret-flagged or `confidential` content is never sent for embedding. Read authorization applies to lists,
   search, MCP, attachments and import reports.
7. **Leave an explicit path to object storage.** Blob consumers use the replaceable `put`, `get` and `stat`
   interface and opaque blob IDs, not chunk queries or filesystem paths. S3/MinIO is deferred and requires a
   separate ADR revisiting the PostgreSQL-only constraint. That change can add an adapter and storage locators
   behind existing IDs, copy and verify objects by SHA-256, and switch reads after verification without changing
   document or artifact callers. Authorization, tenant isolation, quotas and reference-based collection must
   remain enforced; deployment and backup procedures must cover both stores before the switch.

## Consequences

- Good: people author and search in one hub while Git retains portable files, reviewable changes and history.
- Good: `docsync` keeps provider orchestration out of `knowledge`, and documents and artifacts share binary storage.
- Good: common-base reconciliation and human conflict resolution avoid silently choosing one author's work.
- Bad: synchronization is eventually consistent and needs durable pending state, retries and operator visibility.
- Bad: PostgreSQL backups grow with attachments; deduplication, quotas and collection limit growth but do not remove
  the need to measure it. S3 would add operational and migration work.
- Bad: hub permissions can grant broader access than a private repository; configuration must warn administrators.
- Bad: extraction libraries add dependencies and resource risks. T002 found Excel streaming failures and dependency
  advisories; implementation must resolve them and bound decoded bytes, rather than treating a worker heap limit
  as complete isolation.

## Alternatives considered

- Git as the source of truth with a hub cache, as for skills: rejected because hub edits must be available before
  provider writes complete, and conflicts must ask a person rather than always prefer Git.
- Every repository edit becomes a review proposal, as in SDLC sync: too much review work by default; retained as
  the per-home `repoChangesNeedReview` option.
- Add synchronization to `knowledge`: expands an already large module and risks dependency cycles with `scm` and
  `catalog`; a save hook keeps the dependency direction explicit.
- Reuse `sdlc/sync.ts` directly: tightly coupled to SDLC items and their mapping table; extracting it would broaden
  this feature and disturb spec 011. Reuse patterns and exclude SDLC-owned files instead.
- Clone repositories on the hub: adds Git tooling, temporary disk and permissions; provider APIs cover this scope.
- One PR per document: creates excessive PRs and merge queue work compared with one rolling PR per home.
- S3/MinIO now: adds a stateful service before measured storage needs justify changing ADR 0003.
- PostgreSQL Large Objects: lack the tenant RLS model used for ordinary tables.
- Keep binaries only in Git: makes display and extraction depend on provider availability and API limits.

## Links

- [Spec 018](../../specs/018-docs-repo-sync/spec.md), [plan and alternatives](../../specs/018-docs-repo-sync/plan.md),
  [research decisions 1, 3, 5 and T002 findings](../../specs/018-docs-repo-sync/research.md).
- [SRS 3.15 DOC](../srs.md#315-collaborative-document-editor-doc),
  [SRS 3.23 DSYNC](../srs.md#323-document-repository-synchronization-dsync).
- [ADR 0003: PostgreSQL-only state](0003-postgresql-only-state.md),
  [ADR 0004: tenant RLS](0004-row-level-security-tenancy.md),
  [ADR 0014: skills in Git](0014-store-skills-in-git.md),
  [ADR 0015: document editor](0015-doc-editor-collaborative-engine.md),
  [ADR 0023: artifacts](0023-artifacts.md), [spec 012 T062](../../specs/012-artifacts/tasks.md).
