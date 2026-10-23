# 0029. Use pandoc and LibreOffice for Word import

- Status: Accepted
- Date: 2026-10-23
- Deciders: Project owner

## Context

Business analysts keep requirements in Word files (about 261 SRS documents in the first real corpus). The hub must turn
`.docx`, `.odt` and `.doc` into Markdown documents, with headings, numbering, tables and images intact, without asking an
analyst to install Python or pandoc. Requirements are in [SRS 3.24 (WIMP)](../srs.md#324-word-import-wimp); the design is
in [spec 019](../../specs/019-word-import/spec.md) and [plan.md](../../specs/019-word-import/plan.md).

A trial of mammoth with turndown (both already in the hub) on real SRS files lost list numbering and headings that use
custom styles inheriting `Heading N` ([research.md section 2](../../specs/019-word-import/research.md)). Fixing that
would mean reading `styles.xml` and `numbering.xml` ourselves. pandoc plus a Lua filter ran on all 261 files, and the same
rules already exist in the `tools/srs2md` script outside this repository.

Conversion runs untrusted input on the hub, so it must be bounded in time and memory, and the hub must keep working when
a tool is missing. PostgreSQL stays the only required stateful dependency (ADR 0003).

## Decision

1. **pandoc converts `.docx` and `.odt`.** The hub runs `pandoc -f docx|odt -t gfm --wrap=none --eol=lf
   --track-changes=accept --sandbox --extract-media` with a Lua filter (`word/filter.lua`) that implements the SRS
   rules. `--eol=lf` and a fixed filter version give byte-identical output for the same file (FR-013). mammoth is not
   used for Word import.
2. **LibreOffice is for `.doc` only (planned).** A `.doc` file is first converted to `.docx` by headless LibreOffice
   Writer, then follows the pandoc path. **Not built yet:** `word/soffice.ts` is a stub that reports LibreOffice as
   missing, so the hub rejects `.doc` today and `wordImportDoc` stays `false`. The design in plan.md section 12b stands:
   one LibreOffice process at a time per hub process (queue `docsync-word-doc`), a private profile directory, a timeout
   `HIVE_DOC_WORD_DOC_TIMEOUT_MS` that kills the whole process group, no shell, no macros, no network.
3. **Every run is bounded.** Processes start with `spawn`, never through a shell, in a private temporary directory that is
   removed afterwards. pandoc runs with `--sandbox` (no file or network access beyond its input), a 120 second timeout
   (`HIVE_DOC_WORD_TIMEOUT_MS`) and a 512 MB heap (`+RTS -M512m`). Before pandoc, the hub checks ZIP structure with the
   same limits as document extraction. File size and batch size are limited by `HIVE_DOC_WORD_MAX_BYTES`,
   `HIVE_DOC_WORD_BATCH_FILES` and `HIVE_DOC_WORD_BATCH_BYTES`.
4. **Packaging.** The `Dockerfile` has a `pandoc` stage that downloads the official static release (pinned to 3.12 with
   a SHA-256 per architecture, checked with `sha256sum -c`) and copies the binary into the runtime image; the build fails
   if `pandoc --version` does not run. The Debian package is too old (2.17) for the filter. A server that cannot reach
   GitHub puts the tarball in `deploy/vendor/` (ignored by Git); the checksum is still verified. Alternatively
   `HIVE_PANDOC_PATH` points to an installed pandoc. CI reads the pinned version from the `Dockerfile` and fails, rather
   than skips, Word import tests when pandoc is missing; on a developer machine they skip with a message.
5. **Each tool can be off on its own.** At start the hub runs `pandoc --version` (at least the pinned version) and, when
   built, the LibreOffice check. No usable pandoc: `/api/v1/health` reports `wordImport: false` and the UI hides the
   import button. pandoc without LibreOffice: `wordImportDoc: false` and only `.docx` and `.odt` are accepted.
6. **Original files go to the BlobStore, not to Git.** The converted Markdown is the document; the Word file stays in the
   hub and is downloadable only by people who can read the resulting document.

## Consequences

- Good: Numbering and custom heading styles survive; the same filter can be copied back to `tools/srs2md`.
- Good: Conversion adds one static binary to the hub image, with no separate service.
- Good: A missing or old tool turns off only the feature that needs it; the rest of the hub is unaffected.
- Bad: The image grows by the size of the pandoc binary and, later, LibreOffice Writer. **Not measured yet:** the
  pandoc stage and the Writer package size were never recorded for this decision. Add the numbers here when T014
  lands and `docker build` sizes are known.
- Bad: Building the image needs access to GitHub (or a vendored tarball). Whether the production server can reach
  GitHub is an open check for the project owner (T024).
- Bad: Raising the pinned pandoc version means changing three `ARG`s and re-running the golden tests.

## Alternatives considered

- mammoth and turndown (already in the hub): loses list numbering and custom heading styles on real SRS files.
- LibreOffice for every format: heavy, with a per-user profile that cannot be shared; the `.docx` path was verified with
  pandoc on 261 files.
- Converting in the browser: same weaknesses as mammoth, and results depend on the browser; the hub would still have to
  re-check.
- A separate converter service (pandoc container): one more service to run, against the constitution's preference for a
  single deployable; one binary in the hub image is enough.
- Keeping only the `tools/srs2md` script: analysts cannot install Python and pandoc, so every Word edit would need a
  developer.
- Writing the Word file into the repository: the repository would grow about threefold on the SRS corpus; Markdown is what
  people and agents need.

## Links

- [ADR 0028](0028-docs-repo-sync.md), [ADR 0003](0003-postgresql-only-state.md)
- [SRS 3.24 WIMP](../srs.md#324-word-import-wimp), [spec 019](../../specs/019-word-import/spec.md)
- Pull requests #509, #510, #520, #524, #535, #540; desktop import screen on branch `ai/WORD019G` (not merged yet)
