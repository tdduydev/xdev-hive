# Implementation Plan: Desktop Application v2

**Branch**: `ai/SPEC-desktop-v2` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-desktop-v2/spec.md` and design system screens in `docs/design-system/screens/`

---

## Summary

Build the next-generation xDev Hive desktop application (`apps/desktop`) using Tauri 2 and a modern local frontend
(React 19, Vite 8, Tailwind 4, and shadcn/ui on Base UI primitives). The desktop app provides an integrated developer
environment across 8 screens (`AppNav`, `AppRegister`, `AppTray`, `AppHome`, `AppDocs`, `AppSkills`, `AppTokens`, `AppSetup`),
seamlessly driving local agent CLIs (`claude`, `codex`) in non-interactive streaming mode, managing background worker
sidecars, synchronizing skill packages, and optimizing token context allocations while maintaining strict security isolation.

---

## Technical Context

**Language/Version**:
- Frontend: TypeScript 5.8+, React 19.3, Vite 8.3, Tailwind 4.3
- Host/Desktop Backend: Rust 1.85 (edition 2024), Tauri 2.12
- Sidecar Worker: Go 1.27.2 (`hive-worker`)

**Primary Dependencies**:
- Desktop Frontend: `@tauri-apps/api` 2.12, `@base-ui/react` 1.9, `lucide-react`, `clsx`, `tailwind-merge`
- Desktop Rust Backend: `tauri` 2.12 (with `tray-icon`), `tauri-plugin-shell` 2.5, `tauri-plugin-notification` 2.6,
  `tauri-plugin-updater` 2.13, the Rust `keyring` crate, `tokio` 1, `serde`, `serde_json`, `url` 2
- Sidecar: Go `hive-worker` (`coder/websocket`, `kardianos/service`)

**Storage**:
- Machine Configuration: `~/.xdev-hive/worker.json` or `%APPDATA%\xdev-hive\worker.json`
- User Identity Token: Operating System native keychain (macOS Keychain via Security Framework, Linux via Secret Service / libsecret, Windows via Credential Vault)
- Local Cache / Manifests: `<workspace>/.skills-manifest.json`, local session caches

**Testing**:
- Frontend: Vitest + Playwright Component / E2E
- Rust: `cargo test` for worker state machine, command parsers, and diagnostic routines
- Monorepo Verification: `pnpm check` (lint, typecheck, module boundaries, unit tests)

**Target Platform**:
- macOS (darwin-aarch64, darwin-x86_64)
- Linux (linux-x86_64, linux-aarch64)
- Windows (windows-x86_64)

**Project Type**:
- Desktop Application (Tauri 2 multi-window hybrid app)

**Performance Goals**:
- Initial window launch under 400ms from cold start.
- Memory footprint under 90MB RSS for desktop UI shell (excluding sidecar and CLI processes).
- Zero frame drop (60 fps) during live CLI JSON event streaming and document diff highlighting.

**Constraints**:
- Strict capability sandboxing: Remote hub web window (`main`) MUST have ZERO Tauri capabilities.
- Secret isolation: Hub machine tokens and database secrets MUST NEVER be injected into spawned agent CLI processes.
- Non-interactive execution: Agent CLIs (`claude`, `codex`) MUST be executed with strict working-directory boundaries (`--restricted` or `-s workspace-write`).
- Administrative safety: Commands requiring elevated permissions (`sudo`) MUST NOT be auto-executed; only copied.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| **I. Contract first** | Hub APIs used by desktop (`/rpc`, `/api/v1/desktop/updates/...`) conform to contracts in `packages/contracts`. | PASS |
| **II. Tenant isolation** | User personal tokens (`hive_pat_…`) enforce organization/team RLS on all hub requests; machine tokens do not leak user permissions. | PASS |
| **III. Module boundaries** | `apps/desktop` does not perform forbidden deep imports across monorepo boundaries. | PASS |
| **IV. Tested before merged** | Unit tests cover Rust command parsing, worker state machine transitions, and UI component behavior. `pnpm check` passes. | PASS |
| **V. Secure by default** | Personal tokens stored strictly in OS keychain; machine tokens stored in dedicated config; remote webview has zero IPC capability; CLI runs sandboxed to workspace. | PASS |
| **VI. Vietnamese for people, English for code** | All code, types, filenames, Rust modules in English; all UI copy, error messages, and alerts in Vietnamese with English toggle (`useT`). | PASS |
| **VII. Simple to self-host** | Desktop connects directly to standard self-hosted hub over HTTPS/WSS; no external cloud SaaS required. | PASS |

---

## Project Structure

### Documentation (this feature)

```text
specs/008-desktop-v2/
├── spec.md              # Feature specification and technical analysis
├── plan.md              # This implementation plan
└── tasks.md             # Phased, independent task breakdown
```

### Source Code (`apps/desktop/`)

```text
apps/desktop/
├── package.json         # React 19, Vite 8, Tailwind 4 dependencies & scripts
├── vite.config.ts       # Vite bundler configuration (output to dist/)
├── tsconfig.json        # TypeScript configuration for React + Vite
├── src/
│   ├── index.html       # HTML entry point for local desktop app
│   ├── main.tsx         # React root mounting App shell
│   ├── App.tsx          # Root routing and window controller
│   ├── lib/
│   │   ├── i18n.ts      # Bilingual dictionary hook (useT)
│   │   ├── tauri.ts     # Typed wrappers for Tauri IPC commands
│   │   └── utils.ts     # Class merging (cn) and formatting helpers
│   ├── components/
│   │   ├── ui/          # shadcn/ui Base UI primitives (button, input, dialog, card, badge, etc.)
│   │   ├── AppNav.tsx   # Left navigation shell with role profiles & worker badge
│   │   └── Topbar.tsx   # Window header with window controls, VI/EN toggle, theme switch
│   └── screens/
│       ├── AppRegister.tsx # Machine registration screen (5 states)
│       ├── AppTray.tsx     # Tray menu controller & notification listener
│       ├── AppHome.tsx     # Workspace overview dashboard
│       ├── AppDocs.tsx     # Local CLI documentation engine & review pane
│       ├── AppSkills.tsx   # Skill catalog & local directory sync
│       ├── AppTokens.tsx   # Token and context analytics viewer
│       └── AppSetup.tsx    # Environment doctor & remediation runner
├── src-tauri/
│   ├── Cargo.toml       # Rust dependencies: tauri, tokio, keyring, etc.
│   ├── tauri.conf.json  # Tauri app config: windows (register, app), security CSP, updater
│   ├── capabilities/
│   │   ├── default.json # Permissions for local desktop windows (register, app)
│   │   └── remote.json  # Sandboxed zero-permission profile for remote hub window (main)
│   ├── src/
│   │   ├── main.rs      # Desktop executable entrypoint
│   │   ├── lib.rs       # App setup, IPC handlers, tray setup, window management
│   │   ├── register.rs  # Command parser & registration logic
│   │   ├── worker.rs    # 7-state worker lifecycle state machine
│   │   ├── cli.rs       # Agent CLI runner (claude, codex exec) with stream handling
│   │   ├── skills.rs    # Skill file writer, hash checker, conflict detector
│   │   ├── doctor.rs    # System environment scanner (PATH binaries, package files)
│   │   └── keychain.rs  # OS keychain integration for personal user tokens
│   └── binaries/        # Staging folder for compiled hive-worker sidecar
└── scripts/
    ├── build-frontend.ts # Invokes Vite build -> dist/
    └── build-sidecar.ts  # Compiles Go hive-worker sidecar into binaries/
```

---

## Architecture & Technical Decisions

### 1. Dual Window Architecture (Local App vs Remote Hub)
- **Local App Window (`app`)**:
  - URL: Local bundle (`tauri://localhost` or `app://localhost` from `dist/`).
  - Capabilities: Full access to registered Tauri commands (`parse_registration`, `register_worker`, `run_cli_stream`, `sync_skill`, `run_doctor_check`, `keychain_get/set`).
  - Content: The 8 redesigned screens (`AppNav`, `AppRegister`, `AppHome`, etc.).
- **Remote Hub Window (`main`)**:
  - URL: External remote web URL (`https://hive.acme.vn`).
  - Capabilities: **ZERO** permissions granted in `capabilities/`.
  - Content: Full web interface of the Hub (runs, projects, admin settings). Even if compromised, it cannot invoke any host Rust functions or access local files.

### 2. Sidecar Worker State Machine Alignment
- The Go worker emits connection events on stdout: `connecting`, `online`, `disconnected`, and `stopped`.
- The Rust state machine in `worker.rs` maps internal lifecycle events to complete the 7 `AppTray` states:
  - User starts worker -> `Status::Starting` -> worker emits `connecting` -> `Status::Connecting` -> worker emits `online` -> `Status::Online`.
  - Disconnect detected -> `Status::Disconnected` -> if >60s elapsed, trigger `Action::Notify`.
  - User stops worker -> `Status::Stopping` -> write `stop\n` to stdin -> worker drains runs -> emits `stopped` -> `Status::Stopped`.
  - Process exits unexpectedly -> `Status::Failed` -> exponential backoff retry.

### 3. Agent CLI Execution Sandboxing in AppDocs
- When user runs doc generation:
  - Rust spawns `claude` with `-p --output-format=stream-json --restricted --tools "Read,Edit,Write,Glob,Grep" --permission-prompts none` or `codex` with `exec -C <folder> -s workspace-write --approve-for-me --json`.
  - Child process `cwd` is locked to the selected directory.
  - Process environment excludes `HIVE_MACHINE_TOKEN`, `HIVE_REGISTRATION_TOKEN`, and hub master keys.
  - JSON events are parsed line-by-line and piped to the frontend via Tauri event channel `cli:event`.

### 4. Skill Synchronization & Conflict Management
- Hierarchy: `projects/<key>/` shadows `teams/<team>/` which shadows `org/`.
- Prior to updating skill files in `.claude/skills/` and `.agents/skills/`:
  - Compute SHA-256 hash of existing local `SKILL.md`.
  - If hash matches previously recorded sync hash, overwrite safely.
  - If hash differs, signal conflict to UI for user resolution (Overwrite / Backup / Cancel).

---

## Complexity Tracking

| Component | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| React 19 + Vite in `apps/desktop` | Needed to build 8 interactive screens with live streaming, complex tables, and theme switching | Vanilla DOM manipulation in TypeScript is brittle, unmaintainable, and does not scale to 8 screens. |
| Separate `capabilities/` for windows | Critical security requirement: prevents remote Hub web code from executing host shell commands | Giving global capabilities to all windows would expose developer workstations to remote code execution risks. |
| Dual skill directories (`.claude/` & `.agents/`) | Developers on the same team may use either Claude Code or Codex CLI | Installing to only one directory breaks agent discovery for developers using the alternative toolchain. |
