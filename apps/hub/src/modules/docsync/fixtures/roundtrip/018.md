# 0016. Build desktop local UI with React, Vite, Tailwind and shadcn/ui

- Status: Proposed
- Date: 2026-10-12
- Deciders: maintainers

## Context

The current desktop application (`apps/desktop`) is a minimal Tauri 2 wrapper. It includes a tray icon, a background
Go worker (`hive-worker`) running as a sidecar, and a single registration window written in vanilla TypeScript without a
bundler (`apps/desktop/src/`). Once registered, it opens the remote web window of the hub.

Design system v2 specifies 8 comprehensive screens for the desktop application:
`AppNav`, `AppRegister`, `AppTray`, `AppHome`, `AppDocs`, `AppSkills`, `AppTokens`, and `AppSetup`
([docs/design-system/screens/README.md](../design-system/screens/README.md)).
These screens handle local machine workflows:
- Local folder selection and codebase exploration.
- Driving local agent CLIs (`claude`, `codex`) in non-interactive streaming mode to generate documentation proposals without passing hub secrets.
- Synchronizing skills from the hub to project directories (`.claude/skills/`, `.agents/skills/`) and user home directories.
- Inspecting token and context consumption (`/context`, `/usage`) directly from local CLI sessions.
- Diagnosing local toolchains, runtimes, and dependencies (AppSetup).
- Managing worker sidecar state machine transitions and system tray actions (AppTray).

Implementing 8 interactive screens with data tables, tabs, modals, streaming logs, and light/dark theme requires a
modern reactive component framework. We must decide the UI architecture for the desktop app.

## Decision

We build the local desktop interface as a dedicated frontend in `apps/desktop` using:
1. **React 19 + Vite 8 + Tailwind 4**: Matching the core UI stack adopted in `apps/web`
   ([ADR 0013](0013-ui-shadcn-base-ui.md)).
2. **shadcn/ui base-nova components copied into `apps/desktop`**: Components (`apps/desktop/src/components/ui/`)
   are managed directly within the desktop workspace via the shadcn CLI with Base UI primitives (`@base-ui/react`),
   following shadcn's standard architecture of component ownership.
3. **Shared design tokens**: Colors, typography, spacing, and shadows are generated from
   `docs/design-system/tokens.json` into CSS variables (`tokens.css`), identical to `apps/web`.
4. **Bilingual copy**: Uses the lightweight dictionary pattern (`const text: Dict<...> = { vi: {...}, en: {...} }` and
   `const t = useT(text)`) matching `apps/web/src/lib/i18n.ts`.
5. **Strict window capability isolation**:
   - The local desktop application window (`app` / `register`) loads local bundled assets (`frontendDist: "../dist"`)
     and is granted granular Tauri IPC capabilities (`parse_registration`, `register_worker`, file dialogs, CLI execution,
     keychain storage).
   - The remote hub web window (`main`) remains an external webview loading the remote hub URL with **zero** Tauri
     capabilities, preventing remote web content from executing host commands.

*Note on documentation sync*: This ADR proposes replacing the Desktop row in `docs/decisions.md` ("App nhẹ bằng Tauri (gói worker + cửa sổ web)"). As specified in project rules, `docs/decisions.md` is maintained by the project leader and will be updated upon merging.

## Consequences

### Good
- **Rich, reactive interface**: Enables fast implementation of data tables, file pickers, streaming diff viewers, and permission modals across all 8 screens.
- **Consistent design**: Leverages design tokens and shadcn base-nova components, ensuring the desktop app feels native to the xDev Hive design system.
- **Strong security isolation**: The remote webview has no access to Tauri IPC commands; only local code bundled inside the app can invoke Rust host operations.
- **Decoupled dependencies**: `apps/desktop` remains lightweight and independent from web-only dependencies (e.g. `@xyflow/react`, Mermaid, Vite PWA, TanStack Router file-routes).

### Bad
- **Component duplication**: Basic shadcn primitives (Button, Input, Dialog, etc.) are duplicated between `apps/web` and `apps/desktop`, rather than shared in a package.
- **Build step in desktop**: `pnpm prepare:app` now runs a Vite build for the frontend before Tauri compiles.

## Alternatives considered

### 1. Extract a shared `packages/ui` package
- *Description*: Create a shared workspace package containing compiled shadcn/ui components used by both `apps/web` and `apps/desktop`.
- *Why rejected*:
  - Contradicts the shadcn/ui design philosophy, which emphasizes owning source components inside each application so they can be adapted freely.
  - Introduces monorepo build friction, dual packaging/transpilation steps, and CSS bundle orchestration between two apps with different bundler plugins and lifecycles.
  - `apps/web` and `apps/desktop` have distinct target environments: desktop requires Tauri IPC integrations and native OS window handling, while web requires browser-only routing and web workers.
  - The shared tokens (`tokens.json`) and brand SVG assets already provide the necessary single source of truth for design cohesion.

### 2. Continue with vanilla TypeScript (no framework/bundler)
- *Description*: Expand `apps/desktop/src/` with vanilla DOM manipulation for all 8 screens.
- *Why rejected*: Managing complex reactive state (DataTable filtering, live CLI log streaming, modal dialogs, multi-step environment fixes) in vanilla DOM is error-prone, hard to test, and significantly slower to develop.

### 3. Load all 8 screens from the remote Hub web application
- *Description*: Expose desktop screens on the Hub web server and load them in the Tauri webview.
- *Why rejected*: Remote pages cannot securely access the host filesystem, execute local CLI commands (`claude`, `codex`), or read/write local skill directories without granting dangerous capabilities to remote origins. Furthermore, desktop utilities (like inspecting local environment tools or checking worker status) must remain accessible even when the hub is unreachable or offline.

## Links

- [0013. Rebuild the web UI with shadcn/ui on Base UI](0013-ui-shadcn-base-ui.md)
- [docs/design-system/screens/README.md](../design-system/screens/README.md)
- [docs/srs.md](../srs.md) (DESK-01)
- [specs/008-desktop-v2/spec.md](../../specs/008-desktop-v2/spec.md)
