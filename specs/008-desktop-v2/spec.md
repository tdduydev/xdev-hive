# Feature Specification: Desktop Application v2

**Feature Branch**: `ai/SPEC-desktop-v2`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User request: "Viết đặc tả cho app desktop v2 theo Spec Kit (.specify/templates, constitution .specify/memory/constitution.md). Người dùng đã chọn làm đủ 8 màn trong docs/design-system/screens: AppNav, AppRegister, AppTray, AppHome, AppDocs, AppSkills, AppTokens, AppSetup (đọc README.md cùng thư mục, phần 'App máy')."

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Desktop Foundation & Registration v2 (Priority: P1, MVP)

A developer installs and launches the desktop app on a new machine. The app presents the redesign v2 registration
window (`AppRegister`) with bilingual support (VI/EN), light/dark theme, and command parsing. The user inputs their hub
URL and single-use registration token (or pastes the full CLI command `hive-worker register --hub ... --token ...`).
The token is safely passed to the sidecar via the `HIVE_REGISTRATION_TOKEN` environment variable. Once registration
succeeds, the app transitions to the main navigation shell (`AppNav`), showing the active folder, project context, and
the user's permission profile (`dev`, `writer`, `lead`).

**Why this priority**: Machine onboarding is the foundational entry point. Without registration and the base navigation
shell, no other desktop feature or worker connection can function.

**Independent Test**: Can be tested on a clean machine without existing configuration:
1. Launch `xdev-hive-desktop`.
2. Verify the registration window opens at 560x680 px with 5 sample states (`empty`, `parsed`, `busy`, `error`, `done`).
3. Paste a multiline `hive-worker register --hub https://hive.acme.vn --token hwr_test123` snippet.
4. Verify `parse_registration` extracts URL and token into form fields.
5. Submit registration; verify sidecar executes with `HIVE_REGISTRATION_TOKEN` in env, saves `worker.json`, and navigates to `AppNav`.

**Acceptance Scenarios**:
1. **Given** an unregistered machine, **When** the desktop app starts, **Then** it displays `AppRegister` in the user's preferred theme (light/dark) and language (default Vietnamese, toggled to English via VI/EN control).
2. **Given** a command string copied from the hub web UI, **When** pasted into the command textarea and "Điền từ lệnh" is clicked, **Then** the hub URL and registration token are automatically extracted and populated.
3. **Given** valid registration credentials, **When** submitting, **Then** the registration token is never passed as a CLI flag (preventing process table leaks); it is passed solely via `HIVE_REGISTRATION_TOKEN`.
4. **Given** successful registration, **When** the worker reports `registered: true`, **Then** the registration window hides and the app initializes the navigation shell (`AppNav`) displaying the active workspace directory, worker connection indicator, and user role.

---

### User Story 2 - System Tray & Worker Lifecycle Management (Priority: P1)

A user manages the background worker sidecar from the operating system menu bar / system tray (`AppTray`). The tray icon
shows real-time worker state via dynamic color dots and tooltips across 7 distinct states (`stopped`, `starting`,
`connecting`, `online`, `disconnected`, `stopping`, `failed`). Users can toggle worker execution on/off, open the hub,
or quit the application. If a worker remains disconnected for more than 60 seconds or exits abnormally, the app displays
a native system notification.

**Why this priority**: The worker executes coding runs dispatched from the organization. Users must have transparent,
reliable visibility and control over local machine resource usage and connection health directly from the desktop tray.

**Independent Test**:
1. Start the worker from the tray menu ("Bật worker"); observe transition `stopped` -> `starting` -> `connecting` -> `online`.
2. Disconnect the network interface; observe transition to `disconnected`.
3. Wait 60 seconds; verify a native desktop notification appears: "Worker mất kết nối với hub hơn 1 phút. Máy này tạm không nhận việc."
4. Click "Tắt worker"; verify the app sends `stop\n` over stdin and waits gracefully up to 30 seconds before terminating the child process.

**Acceptance Scenarios**:
1. **Given** the app running in the background, **When** closing windows, **Then** the app does not terminate; it minimizes to the system tray while the worker continues operating.
2. **Given** the system tray menu, **When** opened, **Then** it displays the current worker status label with state indicator dot, menu actions ("Mở xDev Hive", "Bật/Tắt worker", "Thoát"), and macOS template icon compatibility.
3. **Given** a graceful stop request, **When** the user clicks "Tắt worker" or quits the application, **Then** Tauri writes `stop\n` to the worker's stdin and allows up to 30 seconds for in-flight task execution and log flushing before forcing termination.
4. **Given** a rejected machine token (exit code 3), **When** the worker exits, **Then** the app does not enter an infinite retry loop; it displays a notification and reopens `AppRegister`.

---

### User Story 3 - Machine & Project Overview Dashboard (Priority: P2)

A developer opens the desktop overview dashboard (`AppHome`) to inspect their current workspace state. The screen displays
a summary header with active project and git branch (`payment-api · ⎇ feat/partial-refund`), four core metric tiles
(Machine Readiness score, Applicable Skills count, Changed Docs count, Weekly Token Consumption), an AI digest of approved
project documents with version diff highlights, an environment gap card with quick fixes, and a 7-day token consumption bar chart.

**Why this priority**: Provides instant orientation for engineers when starting work, summarizing whether their local machine
meets project prerequisites and what recent conventions or architecture decisions were approved on the hub.

**Independent Test**:
1. Open `AppHome` with a linked workspace directory.
2. Verify the 4 metric tiles render correct counts and status colors.
3. Inspect the document digest list; verify approved documents display versions (`v7`), status badges, and AI-generated summaries.
4. Verify clicking "Sửa →" navigates directly to `AppSetup`, while clicking "Chi tiết →" on tokens navigates to `AppTokens`.

**Acceptance Scenarios**:
1. **Given** a linked project folder, **When** viewing `AppHome`, **Then** the workspace breadcrumb shows the folder name, active git branch, and connection status to the hub project.
2. **Given** a user with the `writer` role, **When** rendering `AppHome`, **Then** technical environment setup tiles are hidden, and a primary "Viết tài liệu" action button is displayed.
3. **Given** approved documents with new changes since last inspection, **When** displayed in the digest list, **Then** each item shows version badges and diff highlights (e.g., "↻ Đổi từ v6: làm tròn theo dòng thay vì theo tổng").

---

### User Story 4 - Local Folder Documentation Engine via CLI (Priority: P2)

A technical writer, product manager, or developer uses `AppDocs` to generate, review, and update project documentation
(e.g., `docs/architecture.md`, PRDs, runbooks) directly from code in a selected local directory. The user selects a project
folder (or picks from recent workspaces), chooses an agent CLI engine (`claude` or `codex`), and enters instructions.
The desktop app executes the CLI non-interactively using streaming JSON, strictly sandboxed to the chosen directory.
The stream parses tool calls, file reading operations, and patch proposals in real time. The user reviews proposed diffs
side-by-side in a rich editor pane and accepts or rejects modifications before committing or pushing to the hub.

**Why this priority**: Fulfills the core xDev Hive workflow of using subscription plans (Claude Max/Pro, OpenAI Codex)
on local machines to keep documentation synchronized with real code, without manual copy-pasting or cloud secret leakage.

**Independent Test**:
1. In `AppDocs`, pick a repository folder.
2. Choose `Claude Code` or `Codex`.
3. Submit a prompt: "Viết tài liệu kiến trúc từ code hiện có. Phần nào chưa code thì đánh dấu dự kiến."
4. Verify the CLI spawns with `--restricted` (for Claude) or `-s workspace-write --approve-for-me` (for Codex) in non-interactive streaming mode.
5. Verify JSON stream events populate the chat panel (tool invocations, read dots) and document editor (highlighted insertions and diffs).
6. Verify clicking "Nhận tất cả" merges suggestions into the local file.

**Acceptance Scenarios**:
1. **Given** a folder selection dialog, **When** a user picks a project folder, **Then** the file explorer displays a categorized tree (`docs` vs `code`) and visual blue dots marking files read by the AI during the active session.
2. **Given** the agent CLI execution, **When** spawning `claude`, **Then** the app passes `-p --output-format=stream-json --restricted --tools "Read,Edit,Write,Glob,Grep" --permission-prompts none` with `cwd` set strictly to the selected folder, and strips all hub secrets from the environment.
3. **Given** the agent CLI execution, **When** spawning `codex`, **Then** the app passes `exec -C <folder> -s workspace-write --approve-for-me --json` with `cwd` set strictly to the selected folder, without exposing host credentials.
4. **Given** proposed document modifications, **When** rendered in the editor, **Then** insertions are highlighted in green with source code citations (e.g. `internal/channel/ws.go:42`), and unbuilt features are labeled as "dự kiến" (planned).

---

### User Story 5 - Skills Hub-to-Local Directory Synchronization (Priority: P2)

A developer or lead uses `AppSkills` to view and synchronize AI agent skills applicable to the current workspace.
Skills originate from the organization skill repository (`tdduydev/xdev-skills`) synchronized to the hub, scoped hierarchically
by organization (`org/`), team (`teams/<team>/`), and project (`projects/<key>/`). The app allows installing skills into
the project folder (`.claude/skills/<skill>/` and `.agents/skills/<skill>/`) or personal user profile (`~/.claude/skills/`,
`~/.codex/skills/`). The user can view version diffs, idle context token overhead, and selectively enable/disable or update skills.

**Why this priority**: Standardizes agent guidelines, coding conventions, and migration workflows across all team machines,
ensuring local CLI agents act with up-to-date domain rules.

**Independent Test**:
1. In `AppSkills`, review the DataTable of applicable skills.
2. Inspect `db-migration` (showing version `v4 → v5`, source `project`, context cost `~90 tokens`).
3. Click "Cập nhật lên v5"; verify `.claude/skills/db-migration/SKILL.md` and `.agents/skills/db-migration/SKILL.md` are updated with the new instructions.
4. Modify a local skill file manually; trigger update and verify a conflict prompt appears before overwriting.

**Acceptance Scenarios**:
1. **Given** skills defined on the hub, **When** loaded in `AppSkills`, **Then** skills follow hierarchical precedence where project-scoped skills shadow organization-scoped skills with the same key.
2. **Given** a skill update action, **When** writing to disk, **Then** files are written to both `.claude/skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md` (or user paths if account target is selected).
3. **Given** a local skill with uncommitted manual changes, **When** an update is triggered, **Then** the app detects content hash drift and prompts the user to overwrite, create a `.bak` backup, or keep local changes.
4. **Given** a disabled skill ("Tắt với tôi"), **When** confirmed, **Then** the app removes the corresponding skill directory from the workspace.

---

### User Story 6 - Token, Context & Quota Optimization (Priority: P3)

A developer opens `AppTokens` to inspect what consumes context window space and subscription quotas in the current project.
For Claude Code, the app parses local session context data from `claude -p /context` and quota metrics from `claude -p /usage`.
The screen renders initial context breakdowns (System prompt, System tools, MCP tools, Memory files, Skills, Autocompact buffer),
session history, and actionable recommendations (e.g. "Tắt MCP Playwright ở thư mục này để bớt 6,3k token ngữ cảnh"). For Codex,
the app displays session token history and context remaining percentage.

**Why this priority**: Context bloat degrades agent reasoning quality and prematurely burns through expensive weekly limits.
Providing visibility and one-click remediation directly on developer machines saves significant compute costs.

**Independent Test**:
1. Open `AppTokens` for a project directory using Claude Code.
2. Verify initial context breakdown renders categories matching `claude -p /context`.
3. Verify driver percentages match local statistics from `claude -p /usage`.
4. Click "Tắt ở thư mục này" on the Playwright MCP recommendation; verify the local project configuration is updated and context cost updates.

**Acceptance Scenarios**:
1. **Given** a project using Claude Code, **When** opening `AppTokens`, **Then** the app invokes `claude -p /context` and parses categories into the segmented bar chart and metric cards.
2. **Given** Claude subscription usage, **When** inspecting quota drivers, **Then** the screen renders 7-day metrics from `claude -p /usage` (e.g. % sessions >150k context, % subagent-heavy sessions, top MCP servers).
3. **Given** Codex engine selection, **When** viewing `AppTokens`, **Then** the screen clearly notes that Codex CLI does not provide granular category breakdowns, displaying turn token metrics and remaining context percentage instead.

---

### User Story 7 - Development Environment Doctor & Remediation (Priority: P3)

A developer runs `AppSetup` to verify whether their local machine satisfies the prerequisites for the active project
(e.g., `payment-api`). The app inspects installed agent CLIs (`claude`, `codex`, `gemini`), runtimes (`Go`, `Node.js`),
developer tools (`pnpm`, `docker`, `golangci-lint`), MCP servers (`xDev Hive`, `GitHub`), and project dependencies (`go.sum`,
`pnpm-lock.yaml`). It displays a circular score ring (e.g., 7/10 ready), itemized table with need vs have versions, and remediation
commands. Users can copy commands or click "Chạy" for safe commands after an explicit confirmation dialog.

**Why this priority**: Developers frequently experience failed runs or agent errors due to mismatched compiler versions,
missing linters, or expired MCP tokens. An automated local environment checker eliminates setup friction.

**Independent Test**:
1. In `AppSetup`, trigger "Kiểm tra lại".
2. Verify the Rust host checks binary versions on `$PATH` using native commands (`go version`, `node -v`, `claude --version`, etc.).
3. Select an outdated tool (e.g. `Codex CLI 0.158 -> >= 0.160`); inspect install command `codex update`.
4. Click "Chạy"; verify an interactive confirmation modal appears displaying the exact command before execution.
5. For commands requiring administrative access (`sudo`), verify the "Chạy" button is disabled and replaced by "Chép lệnh".

**Acceptance Scenarios**:
1. **Given** the environment check, **When** evaluating requirements, **Then** specifications are dynamically extracted from `go.mod`, `package.json`, `.hive/setup.sh`, and organization policy fetched from the hub.
2. **Given** missing or outdated items, **When** displaying remediation commands, **Then** commands are tailored to the host operating system (macOS Homebrew, Linux apt/pacman, Windows winget/scoop).
3. **Given** an action requiring administrative rights (`sudo`), **When** viewed in the detail pane, **Then** the app explicitly disallows direct background execution and provides a one-click copy to clipboard with a warning note.
4. **Given** safe developer commands, **When** the user clicks "Chạy", **Then** the app displays a confirmation dialog with command details before spawning in the terminal.

---

### User Story 8 - Human User Authentication & Security Isolation (Priority: P1)

A user authenticates their personal identity in the desktop app using a personal MCP/API token (`hive_pat_…`) or web loopback.
The human user token is securely stored in the native operating system keychain (macOS Keychain, Windows Credential Manager,
Linux Secret Service via `keyring-rs`), separate from the worker machine token (`hwm_…`; `hwr_…` is the one-time registration token). The app queries the hub to determine
the user's identity (`name`, `role`, `teams`, `permissions`) and dynamically configures the `AppNav` menu and view rights
(`lead`, `dev`, `writer`). The remote hub web window remains completely isolated in an external webview with zero Tauri IPC capabilities.

**Why this priority**: Machine worker tokens belong to the hardware and cannot identify human authors. Storing personal tokens
securely and enforcing least-privilege window capabilities protects organizational secrets and corporate machines.

**Independent Test**:
1. Save personal user token `hive_pat_…` in app settings.
2. Verify the token is written to the OS keychain and never committed to disk in plain text.
3. Verify subsequent API calls to Hub endpoints include `Authorization: Bearer <user_token>`.
4. Open the remote hub window (`main`); verify scripts running inside cannot invoke any Tauri Rust command.

**Acceptance Scenarios**:
1. **Given** user authentication, **When** saving credentials, **Then** user tokens are persisted in the native OS keychain using the Rust `keyring` crate.
2. **Given** the user profile fetched from the hub, **When** evaluating permissions, **Then** hub roles map deterministically to desktop profiles: `lead` = organization `owner`/`admin` or team `admin`; `dev` = team `member`; `writer` = team `viewer`. The profile only shapes the menu; every write is still authorized by the hub.
3. **Given** the remote web window (`main`), **When** inspecting Tauri capabilities in `capabilities/default.json`, **Then** the `main` window is granted zero permissions, completely preventing remote code execution via Tauri IPC.

---

### User Story 9 - Document Editor in the App for BA (Priority: P1)

A business analyst writes and revises PRDs, specs and ADRs from the app instead of the admin web. The app opens the
same document editor as the web (draft, suggestions, comments, snapshots, submit for review), and the AI assistant runs
on the analyst's own machine with their own CLI login (ADR 0017).

**Independent Test**: With a linked account, open a document from the app's Docs list, edit a block, accept an AI
suggestion, add a comment and submit; the hub records the same draft, suggestion, thread and proposal as the web.

**Acceptance Scenarios**:
1. **Given** a linked account with team member rights, **When** the user opens a document in the app, **Then** the
   editor shows the shared draft, its workflow steps, presence, comments and pending suggestions.
2. **Given** the user presses an AI action, **When** the run starts, **Then** it is pinned to this machine and never to a
   colleague's personal machine.
3. **Given** a viewer, **When** they open a document, **Then** they can read and comment but not edit or submit.

---

### User Story 10 - My Tasks and My Runs (Priority: P1)

A developer or analyst sees only their own tasks (created by them, or with a run they own; the hub has no separate
assignee) and the runs they own, hands a task to an agent CLI on
their own machine, and follows the run live. The full team board stays on the admin web.

**Independent Test**: Create a task as the user (or start a run on a colleague's task); it appears in the app's My tasks;
starting it creates a run owned by the user that is offered only to the user's machines or shared machines.

**Acceptance Scenarios**:
1. **Given** tasks of several people, **When** the user opens My tasks, **Then** only tasks they created or have a run
   they own are listed (`tasks.list` with `mine`); My runs uses `runs.search` with `mine`.
2. **Given** a task, **When** the user starts it, **Then** the run's owner is the user and its log streams in the app.
3. **Given** a run waiting for a machine, **When** the user opens it, **Then** the app shows why it waits.

---

### User Story 11 - Awaiting My Review (Priority: P2)

A reviewer (BA, PO, tech lead) approves or returns document proposals at the checkpoint assigned to them without
opening the admin web.

**Independent Test**: Submit a draft into a workflow whose current gate names the user; it appears in the app's
Awaiting my review with the diff and checklist; approving it advances the review on the hub.

**Acceptance Scenarios**:
1. **Given** reviews at gates the user may decide, **When** the user opens Awaiting my review, **Then** only those
   reviews are listed, with SLA state.
2. **Given** a review, **When** the user returns it with a note and route, **Then** the hub records the decision and
   notifies the author exactly as from the web.

---

### User Story 12 - Knowledge Lookup (Priority: P3)

A developer or analyst searches approved documents, memory and team skills while working, read-only.

**Independent Test**: Search a keyword present in an approved doc and a memory entry; both appear; opening the doc
shows the approved version; no edit control is offered.

**Acceptance Scenarios**:
1. **Given** a query, **When** the user searches, **Then** results come from docs, memory and skills the user can read.
2. **Given** a result, **When** opened, **Then** it is read-only with a link to edit in the document editor (US9).

---

### Edge Cases

- **What happens if the user's personal MCP token expires while the worker machine token is still valid?**
  The worker continues processing background runs normally (since machine tokens are separate). In the desktop UI, user-facing operations that require personal identity (loading doc proposals, syncing private skills) display a warning banner prompting the user to refresh their personal token in settings.
- **What happens if a user selects a folder outside of a git repository in AppDocs?**
  The app detects the lack of a `.git` root, warns the user that version tracking and diff reverting are unavailable, and runs the CLI with `--skip-git-repo-check` (for Codex) while restricting file edits to the selected path.
- **What happens if the Go worker sidecar process crashes repeatedly?**
  The Rust worker state machine applies exponential backoff (retrying from 5 seconds up to 5 minutes) and displays a notification after each abnormal exit. If exit code is 3 (`EXIT_REJECTED`), retries stop immediately and the registration window opens.
- **What happens if `tauri-plugin-updater` encounters an empty `pubkey`?**
  The updater gracefully skips update checks without error logs, matching current behavior until signing keys are provisioned in CI.
- **What happens if both `.claude/skills/` and `.agents/skills/` exist in a project folder during sync?**
  The sync engine writes updated skill definitions into both folders to ensure interoperability between Claude Code and Codex CLI.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (DESK-01)**: The desktop app MUST provide a local graphical user interface built with React 19, Vite 8, Tailwind 4, and shadcn/ui base-nova components across 8 screens: `AppNav`, `AppRegister`, `AppTray`, `AppHome`, `AppDocs`, `AppSkills`, `AppTokens`, and `AppSetup`.
- **FR-002 (DESK-02)**: The desktop app MUST allow registering machines by parsing command strings or direct form inputs, passing registration tokens to the `hive-worker` sidecar strictly via the `HIVE_REGISTRATION_TOKEN` environment variable.
- **FR-003 (DESK-03)**: The desktop app MUST maintain a system tray menu and emit native system notifications reflecting all 7 worker lifecycle states: `stopped`, `starting`, `connecting`, `online`, `disconnected`, `stopping`, and `failed`.
- **FR-004 (DESK-03)**: The desktop app MUST handle graceful worker termination by sending `stop\n` over stdin and waiting up to 30 seconds before terminating the child process.
- **FR-005 (DESK-04)**: The desktop app MUST provide an overview dashboard (`AppHome`) displaying workspace readiness, applicable skills, recent document digests, and 7-day token consumption charts.
- **FR-006 (DESK-05)**: The desktop app MUST allow selecting a local workspace folder and executing local agent CLIs (`claude`, `codex`) non-interactively in streaming JSON mode to inspect code and generate documentation proposals.
- **FR-007 (DESK-05)**: The desktop app MUST confine CLI file operations strictly to the selected workspace directory, omitting all hub and machine secrets from the spawned process environment.
- **FR-008 (DESK-06)**: The desktop app MUST synchronize skills from the hub into `.claude/skills/` and `.agents/skills/` (project scope) or user home directories (account scope), following hierarchical precedence (project shadows organization).
- **FR-009 (DESK-06)**: The desktop app MUST detect local skill file modifications prior to synchronization, prompting the user with options to overwrite, backup (`.bak`), or preserve local files.
- **FR-010 (DESK-07)**: The desktop app MUST inspect token usage and context allocations, parsing `claude -p /context` and `claude -p /usage` for Claude Code, and session turn metrics for Codex CLI.
- **FR-011 (DESK-07)**: The desktop app MUST provide actionable context reduction recommendations (e.g., toggling unused MCP tools, trimming memory files, configuring autocompact thresholds).
- **FR-012 (DESK-08)**: The desktop app MUST diagnose local development environments across agent CLIs, runtimes, linters/tools, MCP servers, and project dependencies using native Rust process execution.
- **FR-013 (DESK-08)**: The desktop app MUST require explicit user confirmation before executing non-admin remediation commands, and MUST restrict administrative commands (`sudo`) to clipboard copying.
- **FR-014 (DESK-09)**: The desktop app MUST authenticate human users via personal user tokens (`hive_pat_…`) stored securely in the native OS keychain, strictly separate from the worker machine token.
- **FR-015 (DESK-09)**: The desktop app MUST map hub roles (organization `owner`/`admin`/`member`, team `admin`/`member`/`viewer`) into app navigation profiles (`lead`, `dev`, `writer`); the hub remains the only authority for writes.
- **FR-016 (DESK-10)**: The desktop app MUST install package updates via `tauri-plugin-updater` from the hub endpoint `/api/v1/desktop/updates/{os}/{arch}/{version}`, with worker sidecar self-update disabled to preserve bundle coherence.
- **FR-017**: All user-facing copy MUST support bilingual display (Vietnamese and English) using the `useT` dictionary pattern, defaulting to Vietnamese.
- **FR-018**: All screens MUST support both light and dark themes, deriving styles strictly from design tokens in `tokens.css`.
- **FR-019**: All screens MUST be operable at 360 px width without horizontal scrolling, supporting keyboard navigation and visible focus rings.
- **FR-020 (ADR 0017)**: After registration and on every start of a registered machine, the app MUST open `AppNav`, never the hub web as its main window; the hub web opens only on explicit user action (tray, link to one hub page).
- **FR-021 (ADR 0017)**: The app MUST offer only client features for BA and DEV: machine, environment, skills, tokens, docs from code, document editor, my tasks and runs, awaiting my review, knowledge lookup. Administration (members, roles, policies, sign-in, machines, sandbox, audit, costs, workflow setup) stays on the admin web.
- **FR-022 (US9)**: The app MUST provide the document editor with the same contracts as the web (`docEditor.*`); AI actions MUST run as `docassist` runs pinned to this machine.
- **FR-023 (US10)**: The app MUST list the user's tasks (created by them or with a run they own) and runs the user owns, start a task as a run owned by the user, and stream its events and logs.
- **FR-024 (US11)**: The app MUST list reviews the user may decide at the current gate and support approve and return with note and route, using the `reviews.*` contracts.
- **FR-025 (US12)**: The app MUST search approved docs, memory and skills the user can read, read-only.
- **FR-026**: The hub MUST accept the user's personal token (`hive_pat_…`) as `Authorization: Bearer` on the user-scoped REST API (`/api/v1/…`) with exactly the user's rights, so the app reuses the web contracts; machine and run tokens MUST NOT be accepted there.
- **FR-027**: Screens present on both surfaces MUST share contracts and data logic through `packages/`; UI is not copied between `apps/web` and `apps/desktop`.

### Key Entities

- **Worker State**: The runtime lifecycle state of the background sidecar (`stopped`, `starting`, `connecting`, `online`, `disconnected`, `stopping`, `failed`).
- **Machine Registration**: The link between the local hardware and the Hub, authenticated via `HIVE_MACHINE_TOKEN` and stored in `worker.json`.
- **User Identity**: The personal authentication profile of the developer (`name`, `role`, `email`, personal token `hive_pat_…`), persisted in the OS keychain.
- **Skill Manifest**: Metadata tracking installed skills in a project (`name`, `scope`, `version`, `source_hash`, `installed_at`).
- **Doc Proposal**: An AI-generated documentation modification consisting of file paths, patch hunks, citations, and review status.
- **Environment Diagnostic**: A status record for a required local tool (`name`, `kind`, `need_version`, `have_version`, `status`, `remediation_cmd`).

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Machine registration via command parsing completes within 3 seconds, transferring zero credentials via command-line arguments.
- **SC-002**: Worker disconnects exceeding 60 seconds trigger a native system notification with 100% reliability.
- **SC-003**: 100% of human user tokens are persisted in the OS keychain; zero plaintext tokens are stored in configuration files or unencrypted application storage.
- **SC-004**: Local documentation generation runs strictly within the user-selected folder, with zero leakage of hub machine tokens to child processes.
- **SC-005**: All 8 screens pass accessibility checks: responsive down to 360 px width, full keyboard navigation, and visible focus rings.
- **SC-006**: Skill synchronization detects 100% of local file modifications, preventing unintended overwrites.

---

## Assumptions

- Developers have at least one supported agent CLI (`claude` or `codex`) installed and authenticated on their workstation for doc generation.
- The host operating system provides a standard secure credential service (Keychain on macOS, Secret Service on Linux, Credential Vault on Windows).
- Network access allows outbound WebSocket connections from the worker to the hub.
- The project leader will update `docs/decisions.md` upon merging this specification and ADR 0016.

---

## Technical Investigation & Clarifications

### 1. User Identity & Role Mapping

- **How does the app obtain human identity?**
  The worker machine token (`hwm_…`; `hwr_…` is the one-time registration token) is strictly an infrastructure credential belonging to the host device; it has no human identity and MUST NOT be used for user actions. The app authenticates the human user via a **personal MCP token** (`hive_pat_…`), generated from `/admin/mcp` (as specified in `specs/003-mcp-tools-admin`) and pasted into the app settings. Alternatively, future versions may implement a local OAuth loopback on `http://127.0.0.1:<port>/callback`.
- **Where is the personal token stored?**
  Stored in the native operating system keychain using the Rust `keyring` crate (macOS Keychain via Security Framework, Linux via Secret Service / libsecret, Windows via Credential Manager).
- **Role mapping to Hub permissions:**
  In `AppNav`, the navigation profiles map to hub tenancy roles as follows:
  - `lead`: Organization `owner`/`admin`, or Team `admin`. Full permissions: `docs.read`, `docs.write`, `docs.propose`, `skills.read`, `skills.write`, `skills.sync`, `tokens.read`, `env.manage`, `runs.local`, `work.mine`.
  - `dev`: Team `member`. Permissions: `docs.read`, `docs.propose`, `skills.read`, `skills.sync`, `tokens.read`, `env.manage`, `runs.local`, `work.mine`.
  - `writer`: Team `viewer`. Today a viewer is read-only in the hub (TEAM_RANK viewer < member), so `writer` gets `docs.read`, `skills.read`, `tokens.read` only. **[NEEDS CLARIFICATION]** The design lets writers edit documents; that needs a doc-writer permission from custom roles (specs/001-custom-roles) rather than widening `viewer`.
  - Client screens of ADR 0017 (US9–US12): Write docs, Awaiting my review and Knowledge need `docs.read` (every profile;
    the hub decides who may edit or decide). My work needs `work.mine` (`dev`, `lead`): starting a run needs team
    `member` or above, so `writer` does not see it.

### 2. AppTray Worker States: 7 States vs 4 Worker Statuses

`AppTray` defines 7 states: `stopped`, `starting`, `connecting`, `online`, `disconnected`, `stopping`, and `failed`.
Currently, `hive-worker run --status-json` outputs 4 JSON states via `c.status`: `connecting`, `online`, `disconnected`, and `stopped`.

The 3 additional states originate as follows:
1. `starting`: Managed by the Tauri state machine in `worker.rs` when the user triggers `Start` and Tauri spawns the child process, before the worker outputs its first stdout line.
2. `stopping`: Managed by the Tauri state machine when the user triggers `Stop` and Tauri writes `stop\n` to stdin. *Worker improvement*: The Go worker can also emit `{"status":"stopping"}` immediately upon reading `stop\n` while it drains active runs.
3. `failed`: Managed by the Tauri state machine when the child process terminates abnormally with a non-zero exit code (`Event::Exited(Some(code))`) or signal.

### 3. AppDocs Local CLI Execution & Sandbox Isolation

To generate documentation from local code without passing hub secrets:
- **Claude Code**:
  - Command: `claude -p --output-format=stream-json --restricted --tools "Read,Edit,Write,Glob,Grep" --permission-prompts none "<prompt>"`
  - Working directory (`cwd`): Set strictly to the user-selected folder.
  - `--restricted`: Restricts tool access strictly to the workspace directory (`cwd`) and disables arbitrary shell execution (`Bash`, REPL).
  - Environment: Scrubbed of `HIVE_MACHINE_TOKEN`, `HIVE_REGISTRATION_TOKEN`, and hub database secrets.
- **Codex CLI**:
  - Command: `codex exec -C "<folder>" -s workspace-write --approve-for-me --json "<prompt>"`
  - Working directory (`cwd`): Set strictly to the user-selected folder.
  - `-s workspace-write`: Enforces workspace boundary sandboxing for all file modifications.
  - `--approve-for-me`: Automates benign workspace-write reviews while escalating network or external file accesses.
  - `--json`: Emits streaming JSONL events for real-time UI rendering.
  - Environment: Scrubbed of all hub credentials.

### 4. AppTokens Data Sources & Realistic Scope

- **Claude Code**:
  - `claude -p "/context"` outputs structured markdown containing exact token breakdowns by category: `System prompt`, `System tools`, `MCP tools`, `Memory files`, `Skills`, `Messages`, `Autocompact buffer`, and `Free space`.
  - `claude -p "/usage"` outputs 24h and 7d limit driver metrics: % sessions >150k context, % subagent-heavy sessions, top subagents, top MCP servers.
  - Both commands execute synchronously in non-interactive print mode (`-p`) and are fully supported.
- **Codex CLI**:
  - Codex CLI does **NOT** offer equivalent non-interactive `/context` or `/usage` breakdown commands.
  - *Realistic Scope*: For Codex, `AppTokens` parses local session JSONL logs in `~/.codex/sessions` to calculate total input/output tokens, cache rates, and model usage over time. The category breakdown displays context remaining percentage (from `/status` or turn metadata) and clearly labels category breakdowns as "Chỉ hỗ trợ Claude Code" (Claude Code only).

### 5. AppSkills Synchronization Lifecycle

- **Target directories**:
  - Project scope: `<workspace>/.claude/skills/<skill-name>/` and `<workspace>/.agents/skills/<skill-name>/`
  - Account scope: `~/.claude/skills/<skill-name>/` and `~/.codex/skills/<skill-name>/`
- **File structure**: Each skill directory contains `SKILL.md` (YAML frontmatter + markdown instructions) plus optional helper scripts.
- **Overwrite policy**:
  - The app calculates SHA-256 hashes of local files. If a file has been modified locally since last sync, the app shows a visual diff and prompts the user: Overwrite, Keep Local, or Create Backup (`.bak`).
  - Unmodified files are updated atomically (write to temp file and rename).
- **Deletion policy**:
  - Disabling a skill ("Tắt với tôi") prompts for confirmation and removes `<workspace>/.claude/skills/<skill-name>/` and `<workspace>/.agents/skills/<skill-name>/`.
  - Deleted skills can be recorded in a local ignore manifest (`.skills-manifest.json`).

### 6. AppSetup Detection & Execution Safety

- **Rust detection commands**:
  - Executed via `tokio::process::Command` checking binary presence on `$PATH` (`which <binary>` or probing standard paths).
  - Version inspection: runs `<binary> --version` or `<binary> version` (e.g. `go version`, `node -v`, `claude --version`, `codex --version`, `pnpm --version`, `docker info`).
  - Project parsing: reads `go.mod` (Go version, dependencies), `package.json` (`engines`, `packageManager`), and `.hive/setup.sh`.
- **Execution safety**:
  - Commands requiring elevated privileges (`sudo`, admin access) are **NEVER** run automatically by the app. They are marked with an administrative badge, and the app provides a "Chép lệnh" (Copy command) button.
  - Safe developer commands (e.g., `pnpm install`, `go mod download`, `codex update`) can be executed via an embedded terminal or spawned process **only after** an explicit user confirmation dialog displaying the exact command line.

### 7. Application Updates vs Worker Self-Updates

- The desktop app uses `tauri-plugin-updater` targeting `/api/v1/desktop/updates/{os}/{arch}/{version}`.
- When an update is downloaded, Tauri replaces the entire desktop application bundle, including the embedded `binaries/hive-worker` sidecar.
- In desktop sidecar mode (`--stdin-control`), worker self-update is explicitly disabled (`SelfUpdate: false`). This guarantees that the worker binary version always matches the Tauri application version and prevents sidecar executable corruption.


### 8. How the App Calls the Hub for Client Features

Today the app calls the hub only through MCP tools with the personal token (`hub_tool`). The document editor, tasks,
runs and reviews already have typed REST contracts used by the web. Writing an MCP tool per screen would duplicate those
contracts. Decision: the hub accepts the personal token as a bearer credential on the user-scoped REST API (FR-026),
resolved to the same user session the web gets, limited by the token's expiry and revocation; the app calls the
OpenAPI routes through a typed client generated from `packages/contracts`. Machine tokens (`hwm_`) and run tokens stay
limited to the worker channel and MCP.

### 9. Designs for the New Screens

There are no `App*` design files yet for the document editor, my tasks, reviews and knowledge in the app. They follow
the web designs (`DocEditor.dc.html`, `Reviews.dc.html`, task and run screens) inside the `AppNav` shell, at app widths
(900–1280 px, down to 360 px). New `App*.dc.html` files are added with each screen's PR.
