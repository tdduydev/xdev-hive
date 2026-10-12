---
description: "Task list for Desktop Application v2 implementation"
---

# Tasks: Desktop Application v2

**Input**: Design documents and feature specifications from `/specs/008-desktop-v2/`
**Prerequisites**: `spec.md`, `plan.md`

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (operates on disjoint file sets with no blocking dependencies)
- **[Story]**: Identifies the associated user story from `spec.md` (e.g. US1, US2, ...)
- Every task includes an explicit **PHẠM VI** (file scope) defining the exact paths permitted for edits, ensuring parallel agent tasks do not collide.

---

## Phase 1: Setup & Foundation (Blocking Prerequisite)

**Purpose**: Establish the modern React 19 + Vite + Tailwind 4 frontend in `apps/desktop`, shadcn base-nova components, design tokens, bilingual i18n, light/dark theme, AppNav navigation shell, and AppRegister v2.

- [ ] **T001 [US1] Foundation: React/Vite/Tailwind/shadcn Setup, i18n, AppNav and AppRegister v2**
  - **Goal**: Replace the vanilla TS frontend with React 19, Vite 8, and Tailwind 4. Add shadcn base-nova primitives, import CSS variables from `docs/design-system/tokens.json`, implement bilingual dictionary hook (`useT` in `src/lib/i18n.ts`), build `AppNav` (with role profiles `dev`, `writer`, `lead`, project breadcrumbs, and worker badge), and build `AppRegister` v2 (supporting 5 states: `empty`, `parsed`, `busy`, `error`, `done`, light/dark theme, language switcher, command pasting). Preserve existing Tauri commands `parse_registration` and `register_worker` with secure environment variable passing via `HIVE_REGISTRATION_TOKEN`.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/package.json`
    - `apps/desktop/vite.config.ts` (new)
    - `apps/desktop/tsconfig.json`
    - `apps/desktop/scripts/build-frontend.ts`
    - `apps/desktop/src/index.html`
    - `apps/desktop/src/main.tsx` (new)
    - `apps/desktop/src/App.tsx` (new)
    - `apps/desktop/src/lib/i18n.ts` (new)
    - `apps/desktop/src/lib/tauri.ts` (new)
    - `apps/desktop/src/components/ui/**` (new)
    - `apps/desktop/src/components/AppNav.tsx` (new)
    - `apps/desktop/src/screens/AppRegister.tsx` (new)
    - `apps/desktop/src-tauri/tauri.conf.json`
    - `apps/desktop/src-tauri/capabilities/default.json`
  - **Dependencies**: None.

- [ ] **T002 [P] [US1] Unit and Component Tests for AppRegister & AppNav**
  - **Goal**: Implement component unit tests verifying `AppRegister` form validation, clipboard parsing, `parse_registration` IPC mocking, language switching, theme toggling, and `AppNav` role-based item visibility.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppRegister.test.tsx` (new)
    - `apps/desktop/src/components/AppNav.test.tsx` (new)
  - **Dependencies**: T001.

- [ ] **T003 [P] [US1] Rust Integration Test for Registration Command & Env Token**
  - **Goal**: Add Rust unit test in `src-tauri/src/register.rs` verifying multiline bash, PowerShell, and cmd command parsing, whitespace trimming, and ensuring tokens are never formatted into CLI flag strings.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/register.rs`
  - **Dependencies**: T001.

**Checkpoint**: Foundation ready. Modern React app mounts, AppRegister v2 parses tokens and registers worker, AppNav renders role-based navigation.

---

## Phase 2: User Story 2 - System Tray & Worker Lifecycle (AppTray)

**Goal**: Full 7-state worker management with colored status dots, native notifications, and graceful stdin shutdown.

- [ ] **T004 [US2] Enhance Rust Worker State Machine for 7 States & Native Notifications**
  - **Goal**: Update `apps/desktop/src-tauri/src/worker.rs` and `lib.rs` to support all 7 states (`stopped`, `starting`, `connecting`, `online`, `disconnected`, `stopping`, `failed`). Emit notification when disconnected >60s. Enforce graceful `stop\n` stdin shutdown with 30s timeout before forced kill. Expose `worker_get_state` and `worker_toggle` Tauri commands.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/worker.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
  - **Dependencies**: T001.

- [ ] **T005 [P] [US2] Implement System Tray Controller & Menu Sync (AppTray)**
  - **Goal**: Update system tray menu creation in `src-tauri/src/lib.rs` to dynamically update menu item labels ("Bật worker" / "Tắt worker"), status label, and tooltip with error details. Add frontend listener in `src/screens/AppTray.tsx` or background listener in `App.tsx` responding to tray events.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppTray.tsx` (new)
    - `apps/desktop/src/lib/tauri.ts`
  - **Dependencies**: T004.

- [ ] **T006 [P] [US2] Unit Tests for Worker 7-State Transitions & Shutdown**
  - **Goal**: Write tests in `src-tauri/src/worker.rs` validating transitions between all 7 states, timer countdowns for 60s notifications, retry backoffs, and rejection on exit code 3.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/worker.rs` (test module)
  - **Dependencies**: T004.

**Checkpoint**: Worker tray icon reflects live state with 7 color indicators; native notifications alert upon network loss; shutdown is clean and safe.

---

## Phase 3: User Story 3 - Overview Dashboard (AppHome)

**Goal**: Deliver the workspace overview dashboard showing readiness metrics, applicable skills, recent document digests, and token charts.

- [ ] **T007 [US3] Build AppHome Dashboard Screen**
  - **Goal**: Implement `apps/desktop/src/screens/AppHome.tsx` based on `docs/design-system/screens/AppHome.dc.html`. Render header with active workspace and git branch, 4 metric tiles (Machine Readiness, Applicable Skills, Changed Docs, Weekly Tokens), approved document digest list with version badges and diff highlights, missing environment card, and 7-day token consumption bar chart. Respect role profiles (hide environment tiles for `writer`).
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppHome.tsx` (new)
    - `apps/desktop/src/App.tsx`
  - **Dependencies**: T001.

- [ ] **T008 [P] [US3] Rust Workspace Metadata Inspection Command**
  - **Goal**: Add Rust command `get_workspace_meta` in `src-tauri/src/lib.rs` to detect the current directory git branch (`git symbolic-ref --short HEAD`) and summarize project configuration status.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/capabilities/default.json`
  - **Dependencies**: T001.

- [ ] **T009 [P] [US3] Component Unit Tests for AppHome**
  - **Goal**: Test metric tile calculations, document digest list rendering, role filtering for writer vs dev, and navigation link clicks ("Sửa →", "Chi tiết →").
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppHome.test.tsx` (new)
  - **Dependencies**: T007.

**Checkpoint**: AppHome renders live workspace metrics, role-tailored view, and document digest summaries.

---

## Phase 4: User Story 4 - Local Folder Documentation Engine (AppDocs)

**Goal**: Drive local agent CLIs (`claude`, `codex`) non-interactively with streaming JSON in a chosen folder to propose doc updates with diffs.

- [ ] **T010 [US4] Rust Backend CLI Runner with Streaming JSON & Sandbox Isolation**
  - **Goal**: Implement `apps/desktop/src-tauri/src/cli.rs`. Expose `run_cli_stream(engine, folder, prompt)`. For Claude: invoke `claude -p --output-format=stream-json --restricted --tools "Read,Edit,Write,Glob,Grep" --permission-prompts none` with `cwd` set to folder. For Codex: invoke `codex exec -C <folder> -s workspace-write --approve-for-me --json`. Scrub process env of all hub secrets. Stream JSON lines over Tauri event `cli:event`.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/cli.rs` (new)
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/capabilities/default.json`
  - **Dependencies**: T001.

- [ ] **T011 [US4] Build AppDocs Screen (Folder Picker, Explorer & Chat/Review Pane)**
  - **Goal**: Implement `apps/desktop/src/screens/AppDocs.tsx` following `AppDocs.dc.html`. Include folder picker modal, explorer file tree with AI read indicators (blue dots), live streaming chat pane showing tool calls, todos, and patches, side-by-side document review pane with insertion highlights and code citations, and batch "Nhận tất cả" / "Bỏ tất cả" buttons.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppDocs.tsx` (new)
    - `apps/desktop/src/App.tsx`
  - **Dependencies**: T010.

- [ ] **T012 [P] [US4] Account & Subscription Modal for AI Engines**
  - **Goal**: Build the account modal in `AppDocs.tsx` displaying subscription quota usage, weekly window reset dates, and fallback configuration (use default / logout / manual login instructions).
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/components/AccountModal.tsx` (new)
  - **Dependencies**: T011.

- [ ] **T013 [P] [US4] Tests for CLI Stream Parser & Event Formatting**
  - **Goal**: Write unit tests simulating Claude stream-json lines and Codex JSONL events, verifying that tool calls, file reading events, and patch proposals are properly formatted for UI consumption.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppDocs.test.tsx` (new)
  - **Dependencies**: T011.

**Checkpoint**: AppDocs drives local agent CLIs safely inside workspace bounds and streams live doc review diffs.

---

## Phase 5: User Story 5 - Skill Hub-to-Local Synchronization (AppSkills)

**Goal**: Synchronize skills from the hub repository into `.claude/skills/` and `.agents/skills/` with conflict detection.

- [ ] **T014 [US5] Rust Skill File Sync Engine with SHA-256 Conflict Detection**
  - **Goal**: Implement `apps/desktop/src-tauri/src/skills.rs`. Expose `list_installed_skills(folder)` and `sync_skill_files(target, skill_name, files)`. Compute SHA-256 hashes to detect uncommitted local modifications. Prompt conflict on drift; overwrite atomically on clean versions. Support writing to `.claude/skills/<name>/` and `.agents/skills/<name>/`. Support deleting skill folders on disable.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/skills.rs` (new)
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/capabilities/default.json`
  - **Dependencies**: T001.

- [ ] **T015 [US5] Build AppSkills Screen (DataTable & Diff Inspector)**
  - **Goal**: Implement `apps/desktop/src/screens/AppSkills.tsx` based on `AppSkills.dc.html`. Include skill DataTable (name, source, machine status, version, idle context cost, usage count), detail side pane with `SKILL.md` diff viewer, bulk actions ("Cài / cập nhật", "Tắt với tôi"), and target selector (project folder vs user home).
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppSkills.tsx` (new)
    - `apps/desktop/src/App.tsx`
  - **Dependencies**: T014.

- [ ] **T016 [P] [US5] Tests for Skill Synchronization & Conflict Detection**
  - **Goal**: Test skill hash comparison, local modification detection, and directory removal on uninstall in both Rust backend and React frontend.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/skills.rs` (test module)
    - `apps/desktop/src/screens/AppSkills.test.tsx` (new)
  - **Dependencies**: T014, T015.

**Checkpoint**: Skills sync cleanly between hub catalog and local agent directories; local changes are protected from accidental overwrites.

---

## Phase 6: User Story 6 - Token & Context Analytics (AppTokens)

**Goal**: Inspect session context breakdown and quota drivers, providing actionable context reduction tips.

- [ ] **T017 [US6] Rust CLI Context & Usage Reader**
  - **Goal**: Implement `read_claude_context(folder)` and `read_claude_usage(folder)` in `src-tauri/src/cli.rs`. Execute `claude -p /context` and `claude -p /usage` synchronously, parse stdout tables into structured JSON, and return to frontend. For Codex, scan `~/.codex/sessions` JSONL files to return token sums.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/cli.rs`
    - `apps/desktop/src-tauri/src/lib.rs`
  - **Dependencies**: T010.

- [ ] **T018 [US6] Build AppTokens Screen**
  - **Goal**: Implement `apps/desktop/src/screens/AppTokens.tsx` based on `AppTokens.dc.html`. Display engine selector (Claude Code vs Codex), metric tiles (Input tokens 7d, Cache hit rate, Context at start, Plan session used), initial context segmented bar chart (System prompt, MCP tools, Memory files, Skills, Autocompact buffer), quota drivers list, optimization tips list with one-click apply, and session history DataTable.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppTokens.tsx` (new)
    - `apps/desktop/src/App.tsx`
  - **Dependencies**: T017.

- [ ] **T019 [P] [US6] Tests for AppTokens Parser & Optimization Toggles**
  - **Goal**: Test parsing of `claude -p /context` markdown tables into segmented bar charts and test recommendation apply state transitions.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppTokens.test.tsx` (new)
  - **Dependencies**: T018.

**Checkpoint**: Token consumption and context allocations are fully transparent with actionable optimization tips.

---

## Phase 7: User Story 7 - Environment Doctor & Remediation (AppSetup)

**Goal**: Scan local system tools, runtimes, MCP servers, and project dependencies, providing safe one-click fixes.

- [ ] **T020 [US7] Rust Environment Scanner & Safe Runner**
  - **Goal**: Implement `apps/desktop/src-tauri/src/doctor.rs`. Expose `scan_environment(folder)` and `run_remediation_command(cmd)`. Probe binaries on `$PATH` (`go`, `node`, `claude`, `codex`, `pnpm`, `docker`, `golangci-lint`) and extract versions. Read project requirements from `go.mod` and `package.json`. If command contains `sudo` or requires root, return `admin_required: true`. Only execute non-admin commands after confirmation.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/doctor.rs` (new)
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src-tauri/capabilities/default.json`
  - **Dependencies**: T001.

- [ ] **T021 [US7] Build AppSetup Screen**
  - **Goal**: Implement `apps/desktop/src/screens/AppSetup.tsx` based on `AppSetup.dc.html`. Render circular readiness score ring, diagnostic DataTable (Item, Type, Needs, Have, Status), detail side pane with OS-tailored install command, copy button, and "Chạy" button with confirmation modal. Disable direct execution for admin commands.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src/screens/AppSetup.tsx` (new)
    - `apps/desktop/src/App.tsx`
  - **Dependencies**: T020.

- [ ] **T022 [P] [US7] Tests for Environment Scanner & Safety Guardrails**
  - **Goal**: Test version comparison logic (semver comparison for Go, Node, Codex), verify admin command detection flags `sudo`, and test confirmation dialog interactions.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/doctor.rs` (test module)
    - `apps/desktop/src/screens/AppSetup.test.tsx` (new)
  - **Dependencies**: T020, T021.

**Checkpoint**: AppSetup diagnoses environment gaps accurately and enforces execution safety guardrails.

---

## Phase 8: User Story 8 - Identity, Security & Auto-Update

**Goal**: Persist personal user tokens in the OS keychain, isolate remote webviews, and configure updater workflows.

- [ ] **T023 [US8] Native Keychain Storage for Personal User Tokens**
  - **Goal**: Add `tauri-plugin-keyring` / `keyring-rs` to `src-tauri/Cargo.toml`. Implement `apps/desktop/src-tauri/src/keychain.rs` exposing `get_user_token()` and `set_user_token(token)`. Connect to desktop settings dialog so users can store and update personal token `hmt_...` without saving plain text to disk.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/Cargo.toml`
    - `apps/desktop/src-tauri/src/keychain.rs` (new)
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/src/components/UserSettingsModal.tsx` (new)
  - **Dependencies**: T001.

- [ ] **T024 [P] [US8] Multi-Window Capability Verification & Remote Sandboxing**
  - **Goal**: Audit `apps/desktop/src-tauri/capabilities/default.json`. Verify that all desktop host commands (`register_worker`, `run_cli_stream`, `sync_skill`, etc.) are bound strictly to windows `["register", "app"]`. Verify the remote Hub window (`main`) has zero permissions, preventing remote XSS or code injection.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/capabilities/default.json`
    - `apps/desktop/src-tauri/src/lib.rs`
  - **Dependencies**: T001.

- [ ] **T025 [P] [US8] Auto-Updater Endpoint & Sidecar Bundle Verification**
  - **Goal**: Ensure `tauri-plugin-updater` checks `/api/v1/desktop/updates/{os}/{arch}/{version}` when `pubkey` is set. Confirm `SelfUpdate: false` is maintained on the sidecar Go worker so worker binaries are never mutated independently of the app bundle. Add end-to-end build test script for `pnpm --filter @xdev-hive/desktop app:build`.
  - **PHẠM VI (File scope)**:
    - `apps/desktop/src-tauri/src/lib.rs`
    - `apps/desktop/package.json`
  - **Dependencies**: T001.

---

## Task Dependencies & Parallel Execution Graph

```
T001 (Foundation: React/Vite/Tailwind, AppNav, AppRegister v2)
 ├──> T002 [P] (AppRegister/AppNav Tests)
 ├──> T003 [P] (Registration Command Parser Tests)
 ├──> T004 (Worker 7-State & Shutdown) ──> T005 [P] (AppTray Menu) / T006 [P] (Worker Tests)
 ├──> T007 (AppHome Dashboard) ──> T008 [P] (Workspace Meta) / T009 [P] (AppHome Tests)
 ├──> T010 (CLI Streaming Runner) ──> T011 (AppDocs Screen) ──> T012 [P] (Account Modal) / T013 [P] (AppDocs Tests)
 ├──> T014 (Skill Sync Engine) ──> T015 (AppSkills Screen) ──> T016 [P] (AppSkills Tests)
 ├──> T017 (CLI Context Reader) ──> T018 (AppTokens Screen) ──> T019 [P] (AppTokens Tests)
 ├──> T020 (Doctor Scanner) ──> T021 (AppSetup Screen) ──> T022 [P] (AppSetup Tests)
 └──> T023 (Keychain Storage) ──> T024 [P] (Capability Audit) / T025 [P] (Updater Config)
```
