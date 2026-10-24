# 0039. Keep test cases as Markdown area files in the docs home, read through composable document hooks

- Status: Proposed
- Date: 2026-10-24
- Deciders: Project owner

## Context

Spec [036](../../specs/036-test-management/spec.md) gives each project a test case library. Testers keep test cases in
Excel today, and the results of manual runs are not in hive. The library must be editable both on the web and in the
docs repository (FR-005), keep a version per test case (FR-007), and let a tester save test case files without
managing other documents (FR-011).

Two parts of `knowledge` stand in the way:

- `provideDocSaved` holds one hook, and `docsync` already takes it. `provideDocAccess` holds one provider, and `sdlc`
  already takes it. The new `qa` module needs both.
- Saving a document directly needs `manage` on it, which only a team admin has. The editor gives everyone else
  `propose`.

The research ([research.md](../../specs/036-test-management/research.md) D2, D3, D3b, D4) and the plan
([plan.md](../../specs/036-test-management/plan.md), Complexity Tracking) chose the options below.

## Decision

1. **Markdown area files (D2).** Each `.md` file in the test case folder of the project docs home (default
   `test-cases/`, from `doc_homes.root`) is one area. The format is in
   [tc-markdown.md](../../specs/036-test-management/contracts/tc-markdown.md): a `# <AREA> <name>` heading, one
   `### TC-<AREA>-<NUMBER> <name>` heading per test case, a `- <Field>: <value>` list and a steps table. The parser is a
   pure function in `packages/contracts/src/test-library.ts`, so the web and the hub report the same errors. A file with
   errors is not applied; the hub keeps the previous test cases and stores the errors with their line numbers (FR-004).
2. **Composable document hooks (D3).** `provideDocSaved` and `provideDocAccess` in `knowledge` accept several functions
   instead of one. Hooks run in the save transaction in registration order; the order has no business meaning. Access
   providers are combined with OR, field by field.
3. **Apply in the save transaction (D3).** The `qa` hook filters keys under `project/<key>/<slug of the folder>/` and
   applies the whole file in the transaction that saves the document. A parse error is stored on the area; only a
   database error is thrown. Archiving the document retires every test case of the area; restoring reads the file
   again.
4. **The folder must be synced (D3b).** When a project turns the library on, `qa` calls
   `docsync.ensureProjectInclude(tx, actor, projectId, glob)`. It returns `no-home`, `covered` or `added`; `added`
   writes the glob into the include list, writes an audit entry and queues a pull. It does not call
   `configureProjectHome`, which talks to the git provider and needs docs home admin rights.
5. **Save grant per folder (D4).** `DocAccessGrant` gets a `save` field and the access scope a `saveGranted` flag.
   `authorize` lets a user (never a run) `manage` a document when `saveGranted` is set. The `qa` provider grants
   `{ read, propose, save }` for keys in the test case folder to callers who have `qa.cases.write` in the team of the
   project, and returns nothing for other keys. Other documents still need `docs.write`.

## Consequences

- Good: test cases are readable in the repository, in the web editor and in agent context, with no second format.
- Good: a web save and a repository sync go through the same `docChanged()` call, so one hook covers both sides
  (FR-005), and the library always matches the document version.
- Good: `knowledge` still knows nothing about `docsync`, `sdlc` or `qa`; each registers at hub start.
- Bad: the public API of `knowledge` changes. The `sdlc` and `docsync` tests that use the two hooks must run again.
- Bad: a failing hook rolls back the document save, so the `qa` hook must catch every parse error itself.
- Bad: a large area file is parsed inside the save transaction. An area holds a few hundred test cases at most
  [Inference from spec 036 A8], so this stays short.

## Alternatives considered

- One combined hook inside `knowledge`: `knowledge` would have to know `docsync`, `sdlc` and `qa` (constitution III).
- Read the file in a background job: the library lags behind the document and needs a "reading" state.
- YAML front matter per test case: hard to read for testers used to Excel, and steps tables are awkward.
- One file per test case: 20,000 test cases become 20,000 files; docsync and the web editor get slower [Inference].
- Excel import: cannot be edited on both sides, against FR-005.
- Give testers the `member` role so they can save: it also opens tasks and runs (FR-013).
- Make testers propose every change: adds a review for each edit, against US1.
- Ask the admin to edit the include list: easy to forget, and repository edits then never reach the hub.
- Add `**/test-cases/**` to the default include of every project: pulls in folders of projects that do not use the
  library.

## Links

- Spec 036 FR-001 to FR-011, research D2, D3, D3b, D4; plan Complexity Tracking.
- [ADR 0028](0028-docs-repo-sync.md) (docs home sync).
