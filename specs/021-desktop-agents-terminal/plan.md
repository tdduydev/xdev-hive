# Agent trên máy và Terminal theo dự án: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Agent trên máy" screen (every Claude Code / Codex / `agy` process on the machine, with what it is
doing) and a per-project "Terminal" workspace to the desktop app.

**Architecture:** Rust reads processes with `sysinfo`, classifies them with pure functions (`agents/classify.rs`),
reads the CLIs' own session files read-only (`agents/activity.rs`), and exposes three Tauri commands
(`agents.rs`). React maps rows to local projects and agent plans (`lib/machine-agents.ts`) and renders the screen. The
terminal store (`lib/pty.ts`) gains a selected folder, per-project defaults and plan restart; a new full-bleed screen
groups tabs by project.

**Tech Stack:** Rust 2024 + Tauri 2, `sysinfo` 0.39.6, React 19 + Vitest + Testing Library, xterm.js.

**Spec:** [spec.md](spec.md)

## Global Constraints

- UI text Vietnamese (with `en` entries in each `Dict`), comments explain why, not what.
- Nothing from the Agents screen is sent to the hub. Session-file content stays in the app window.
- Environment of other processes: keep only `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HIVE_PROJECT`. Never return a command
  line to the UI.
- Prompt cut to 300 chars, step to 160 chars, one line. Transcript tail read: at most 256 KB.
- Agents screen polls every 3 s, home card every 10 s, `hive ls` cached 10 s.
- Stop: own OS user only; re-verify pid, start time, still an agent; Windows `taskkill /T /F`, Unix SIGTERM then
  SIGKILL after 5 s.
- `pty.rs` rules unchanged: no arbitrary commands, plan from `hive-worker accounts`, max 8 terminals.
- `sysinfo = { version = "=0.39.6", default-features = false, features = ["system", "user"] }`; `rust-version = "1.95"`.
- New commands are declared in `build.rs`, registered in `generate_handler!` and allowed in `capabilities/app.json`
  (`capabilities_audit.rs` checks all three).
- Import with `@/…` aliases and `.ts`/`.tsx` extensions. Run desktop scripts as `corepack pnpm --filter @xdev-hive/desktop …`.

## Review Focus

1. A Claude Desktop binary named `claude.exe` (WindowsApps / AnthropicClaude) or `Claude.app/Contents/MacOS/Claude`
   must never count as Claude Code. Test in Task 1.
2. A stale `sessions/<pid>.json` from a dead process whose pid was reused must not be shown. Test in Task 2.
3. Stop with a pid whose start time changed (pid reused) or another user's process must be refused. Test in Task 3.
4. A process tree with parent-pid loops (Windows reuses pids) must not hang the scan. Test in Task 1.
5. Switching plan on a tab must not keep "bỏ hỏi quyền" and must ignore late output and exit of the old PTY. Test in
   Task 5.

---

### Task 1: Process classification (pure Rust)

**Files:**
- Create: `apps/desktop/src-tauri/src/agents/classify.rs`, and `apps/desktop/src-tauri/src/agents.rs` holding only
  `pub(crate) mod classify;` (Task 2 adds `activity`, Task 3 fills the rest)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`mod agents;`)

**Interfaces:**
- Produces:
  - `pub(crate) struct Proc { pid: u32, parent: Option<u32>, name: String, exe: Option<String>, cmd: Vec<String>, cwd: Option<String>, start: u64, cpu: f32, memory: u64, own: bool }`
  - `#[serde(rename_all = "lowercase")] pub enum Cli { Claude, Codex, Antigravity }` (Serialize, Copy, Eq, Hash)
  - `pub(crate) struct Match { cli: Cli, shim: bool, background: bool, bypass: bool }`
  - `pub(crate) fn match_cli(p: &Proc) -> Option<Match>`
  - `pub(crate) fn is_claude_desktop_exe(path: &str) -> bool`
  - `pub(crate) fn run_of(cwd: &str) -> Option<String>`
  - `pub(crate) fn other_app(name: &str) -> Option<&'static str>`
  - `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")] pub enum Source { Run { run_id: String }, Hive { session_id: Option<String>, hub_id: Option<String> }, App { pty: Option<String> }, ClaudeDesktop, OtherApp { name: String }, Terminal }`
  - `pub(crate) struct HiveSession { id: String, pid: u32, hub_id: Option<String> }`
  - `pub(crate) struct Context<'a> { app_pid: u32, ptys: &'a [(String, u32)], hive: &'a [HiveSession] }`
  - `pub(crate) struct Row { pid: u32, pids: Vec<u32>, m: Match, start: u64, cpu: f32, memory: u64, own: bool, cwd: Option<String>, source: Source, children: usize, under_worker: bool }`
  - `pub(crate) fn rows(procs: &[Proc], ctx: &Context) -> Vec<Row>`
  - `pub(crate) fn subtree(procs: &[Proc], root: u32) -> Vec<u32>` (descendants first, root last)

- [ ] **Step 1: Write failing tests** in `classify.rs` `mod tests`:
  - `matches_cli_binaries_and_skips_claude_desktop`: `claude.exe` under `C:\Users\a\.local\bin` → Claude;
    `C:\Program Files\WindowsApps\Claude_2.42304.0.0_x64__pzs8sxrjxfjjc\app\claude.exe` → None;
    `…\AnthropicClaude\app-1.0\claude.exe` → None; `/Applications/Claude.app/Contents/MacOS/Claude` → None;
    `C:\Users\a\AppData\Roaming\Claude\claude-code\2.1.299\x\claude.exe` → Claude; `codex.exe`,
    `codex-x86_64-pc-windows-msvc.exe`, `codex-aarch64-apple-darwin` → Codex; `codex-computer-use-swift.exe` → None;
    `agy` → Antigravity; `node` with arg `/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js` → Claude, `shim`
    false; `node` with `…\node_modules\@openai\codex\bin\codex.js` → Codex, `shim` true; plain `node server.js` → None.
  - `flags_background_and_bypass`: `claude -p hi` and `--print` → background; `codex exec …` → background;
    `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo` → bypass.
  - `reads_run_id_from_worker_folder`: `/home/a/.cache/xdev-hive/worker/runs/0b7c…-uuid-2` → that uuid;
    `C:\Users\a\AppData\Local\xdev-hive\worker\runs\abc-1\sub` → `abc`; `/home/a/code` → None.
  - `merges_node_shim_but_keeps_nested_agents`: node(@openai/codex) → codex-x86_64… child = one row with pid of node,
    `pids` = [node, child]; claude → claude `-p` child = two rows, parent `children == 1`; CPU and RAM of a row include
    rg/MCP descendants but not a nested agent's subtree.
  - `assigns_sources_in_order`: cwd in `runs/` → Run; ancestor pid in `ctx.hive` → Hive with id and hub id; ancestor
    `hive-worker.exe` not in runs and not in hive → `Hive { session_id: None, .. }`, `under_worker` true; ancestor is
    `ctx.app_pid` with pty pid matching → `App { pty: Some("pty-3") }`; ancestor Claude Desktop exe → ClaudeDesktop;
    ancestor `ChatGPT.exe` → `OtherApp { name: "Codex Desktop" }`; otherwise Terminal.
  - `survives_parent_loops`: procs 1→2→1 (parents point at each other) return in under a second with one row each.
  - `subtree_lists_descendants_before_root`.
- [ ] **Step 2: Run** `cargo test --lib agents::classify` in Docker (command in Task 8). Expected: compile errors / FAIL.
- [ ] **Step 3: Implement.** `is_claude_desktop_exe` handles both `\` and `/` paths (same WindowsApps / AnthropicClaude
  rule as `claude_desktop/win.rs::is_desktop_exe`, plus `/Claude.app/`). File stem is lowercase without `.exe`.
  Ancestor walks stop after 64 steps or a repeated pid. `other_app` names: `chatgpt`/`codex` (Electron app, not the CLI
  stem rule) → "Codex Desktop", `code`/`code - insiders` → "VS Code", `cursor` → "Cursor", `antigravity` →
  "Antigravity IDE", `idea64`/`idea`/`webstorm64`/`pycharm64` → "JetBrains".
- [ ] **Step 4: Run tests again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): classify agent CLI processes`.

### Task 2: Session activity readers (pure Rust, file system only)

**Files:**
- Create: `apps/desktop/src-tauri/src/agents/activity.rs`

**Interfaces:**
- Produces:
  - `#[serde(rename_all = "camelCase")] pub struct Activity { title: Option<String>, status: Option<String>, prompt: Option<String>, step: Option<String>, at: Option<String>, guessed: bool, #[serde(skip)] entrypoint: Option<String> }`
  - `pub(crate) fn encode_project_dir(cwd: &str) -> String`
  - `pub(crate) fn one_line(s: &str, max: usize) -> String`
  - `pub(crate) fn claude_activity(config: &Path, pids: &[u32], cwd: Option<&str>, start: u64) -> Option<Activity>`
  - `pub(crate) fn codex_activity(home: &Path, cwd: &str, start: u64, now: u64) -> Option<Activity>`

- [ ] **Step 1: Write failing tests** with a temp dir per test:
  - `encodes_like_claude_code`: `E:\Codes\xDev\xdev-hive` → `E--Codes-xDev-xdev-hive`;
    `E:\Codes\xDev\xdev-hive\.claude\worktrees\a` → `E--Codes-xDev-xdev-hive--claude-worktrees-a`; `/Users/ha/dự án`
    → `-Users-ha-d--n` (one `-` per UTF-16 unit of each non-ASCII-alphanumeric char).
  - `claude_reads_session_file_then_transcript_tail`: `sessions/4242.json` {pid 4242, sessionId, cwd, name "Sửa login",
    status "busy", entrypoint "claude-desktop", startedAt = start*1000}; transcript with `last-prompt`, an assistant
    `tool_use` `Edit` {file_path "/a/src/login.ts"}, then a `Bash` {description "Chạy test"}. Expect title
    "Sửa login", status "busy", prompt from `lastPrompt`, step "Bash: Chạy test", `at` = that line's `timestamp`,
    `guessed` false, `entrypoint` Some("claude-desktop").
  - `claude_ignores_session_file_of_reused_pid`: `startedAt` 10 minutes before `start` → falls back to newest
    transcript in the folder modified after `start`, `guessed` true; none modified after → None.
  - `claude_tail_skips_partial_first_line_and_bad_json`: 300 KB transcript; result still found.
  - `codex_picks_newest_rollout_for_cwd`: two rollouts on the start day, one with other `session_meta.payload.cwd`;
    expect the matching one, prompt from `event_msg` `user_message`, step from `response_item` `function_call`
    `shell` with `{"command":["bash","-lc","cargo test"]}` → "shell: cargo test", status "busy" when the last
    `task_started` is after the last `task_complete`, `guessed` true.
  - `one_line_collapses_and_cuts`: newlines and runs of spaces → one space; 400 chars → 300 with trailing `…`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Session id must pass `cli::valid_session` before it becomes a path. JSON files read with
  a 64 KB cap; rollout first line with a 1 MB cap; tails with 256 KB. Long encoded dirs (> 200 chars): if the exact
  dir is missing, use the first dir under `projects/` whose name starts with the first 200 chars. Codex day folders:
  `sessions/YYYY/MM/DD` for each UTC day from `start - 1 day` to `now + 1 day` (max 8 days; civil-from-days helper).
  Step detail priority: `description`, file name of `file_path`/`notebook_path`/`path`, `pattern`, first line of
  `command`, `url`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): read latest prompt and step from CLI session files`.

### Task 3: Scan, counts and stop commands (Rust + sysinfo)

**Files:**
- Create/modify: `apps/desktop/src-tauri/src/agents.rs` (module root)
- Modify: `apps/desktop/src-tauri/Cargo.toml` (sysinfo, rust-version), `Cargo.lock`, `src/lib.rs` (manage
  `agents::Agents`, register commands), `build.rs`, `capabilities/app.json` (permissions + description sentence),
  `src/pty.rs` (`Ptys::pids`), `src/remote.rs` (`hive_json` → `pub(crate)`)

**Interfaces:**
- Consumes: Task 1 and Task 2 items.
- Produces:
  - `#[serde(rename_all = "camelCase")] pub struct Agent { pid: u32, cli: Cli, background: bool, bypass: bool, started_at: u64, cpu: f32, memory: u64, cwd: Option<String>, config_dir: Option<String>, hive_project: Option<String>, source: Source, own: bool, children: usize, activity: Option<Activity> }`
  - `pub struct Scan { agents: Vec<Agent>, home: Option<String> }`, `pub struct Counts { claude: usize, codex: usize, antigravity: usize }`
  - `pub(crate) fn stop_targets(procs: &[Proc], rows: &[Row], pid: u32, started_at: u64) -> Result<Vec<u32>, String>`
  - `impl Ptys { pub fn pids(&self) -> Vec<(String, u32)> }`
  - Commands: `machine_agents() -> Scan`, `machine_agent_counts() -> Counts`,
    `machine_agent_stop(pid: u32, started_at: u64) -> ()` (JSON args `pid`, `startedAt`)

- [ ] **Step 1: Write failing tests:**
  - `stop_refuses_unknown_reused_or_foreign`: pid not a row → Err; same pid, different start → Err "đã thoát";
    `own: false` → Err; good → Ok(subtree, root last).
  - `real_scan_runs_and_finds_no_agent_in_test_process`: `collect(&mut System::new())` returns `Vec<Proc>` containing
    the current pid with `own` true and a start time > 0.
  - `cpu_is_share_of_machine`: `machine_cpu(400.0, 8) == 50.0`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `collect(sys)`: `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().without_tasks().with_cpu().with_memory().with_exe(OnlyIfNotSet).with_cmd(OnlyIfNotSet).with_user(OnlyIfNotSet))`;
    then for matched pids only, a second refresh with `.with_cwd(Always).with_environ(OnlyIfNotSet)`. `own` compares
    `user_id()` with the app's own process. Environ filtered to the three keys right there.
  - `machine_agents`: rows with empty hive; if any non-Run row is `under_worker`, call `hive ls --json` (cached 10 s,
    errors → empty) and rebuild rows. Activity only for `own` rows: Claude config = env or `~/.claude`, Codex =
    env or `~/.codex`. A Terminal row whose activity entrypoint is `claude-desktop` becomes ClaudeDesktop. Activity
    reads cached by (path, mtime, len). All blocking work in `spawn_blocking`.
  - `machine_agent_stop`: fresh collect, `stop_targets`, then Windows `taskkill /T /F /PID` via
    `doctor::run_with_timeout`; Unix SIGTERM each target, poll up to 5 s, SIGKILL survivors whose start time is unchanged.
- [ ] **Step 4: Run tests** (whole crate, including `capabilities_audit`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): list, count and stop agent processes on this machine`.

### Task 4: Agent data helpers (TypeScript)

**Files:**
- Create: `apps/desktop/src/lib/machine-agents.ts`, `apps/desktop/src/lib/machine-agents.test.ts`

**Interfaces:**
- Produces: types `AgentCli`, `AgentSource`, `AgentActivity`, `MachineAgent`, `AgentScan`, `AgentCounts` mirroring
  Task 3 JSON; `machineAgents()`, `machineAgentCounts()`, `stopMachineAgent(pid, startedAt)`;
  `normPath(p: string, home: string | null): string`; `projectOf(a: MachineAgent, projects: LocalProject[], home):
  LocalProject | null`; `planOf(a: MachineAgent, plans: CliProfile[], home): CliProfile | "default" | null`;
  `CLI_LABEL: Record<AgentCli, string>`; `formatBytes(n: number): string`.

- [ ] **Step 1: Write failing tests:** `projectOf` picks the longest existing folder containing cwd, case-insensitive
  for `C:\` paths, not `E:\a\bc` for folder `E:\a\b`; `planOf` matches `~/.xdev-hive/accounts/claude-2` against
  env `C:\Users\ha\.xdev-hive\accounts\claude-2\` with home `C:\Users\ha`, returns "default" when `configDir` null,
  null for an unknown dir, ignores plans of another CLI; `formatBytes(734003200) === "700 MB"`.
- [ ] **Step 2: Run** `corepack pnpm --filter @xdev-hive/desktop test machine-agents`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): map agent processes to projects and plans`.

### Task 5: Terminal store and pane: folders, defaults, plan switch

**Files:**
- Create: `apps/desktop/src/lib/term-defaults.ts` (+ test)
- Modify: `apps/desktop/src/lib/pty.ts`, `apps/desktop/src/components/terminal-pane.tsx`,
  `apps/desktop/src/screens/docs-screen.test.tsx` (only if a selector changes)
- Test: `apps/desktop/src/components/terminal-pane.test.tsx` (new)

**Interfaces:**
- Produces:
  - `termDefault(folder: string): { cli: TermCli; planId: string | null } | null`, `rememberTermDefault(folder, d)`
    (localStorage `hive.terminal.defaults`, try/catch)
  - `pty.ts`: snapshot gains `folder: string | null`; `selectFolder(folder: string | null)`;
    `inFolder(s: TermSession, folder: string): boolean`; `restartTerminal(key: string, plan: { planId: string | null; label: string })`;
    `openProjectTerminal(folder: string): void` (select folder; select its last tab or open one from `termDefault`,
    else Claude Code with default sign-in)
  - `TerminalPane` shows and opens only tabs of `folder`; new select "Đổi gói" on a running or exited non-shell tab.

- [ ] **Step 1: Write failing tests** (`terminal-pane.test.tsx`, fake xterm as in `docs-screen.test.tsx`):
  - tabs of another folder are hidden;
  - opening a tab remembers `{cli, planId}` for the folder; bypass is not stored;
  - "Đổi gói" to `claude-3` calls `pty_close` for the old id then `pty_open` with `planId: "claude-3"`,
    `bypass: false`, same folder; tab label becomes "Claude Code · claude-3"; a separator line is written; a late
    `pty:exit` / `pty:data` for the old id leaves the tab running.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** this test and `docs-screen.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): per-project terminal tabs, defaults and plan switch`.

### Task 6: Terminal screen, menu and project buttons

**Files:**
- Create: `apps/desktop/src/screens/terminal-screen.tsx` (+ test)
- Modify: `apps/desktop/src/lib/nav.ts` (+ `nav.test.ts`), `apps/desktop/src/screens/index.ts`,
  `apps/desktop/src/screens/projects-screen.tsx` (+ test)

**Interfaces:**
- Consumes: Task 5 store functions, `localProjects()`.
- Produces: `ScreenId` gains `"agents" | "terminal"`; group `run` = agents (`ActivityIcon`, "Agent trên máy"),
  terminal (`SquareTerminalIcon`, "Terminal"), runs, remote; no `needs`. `FULL_BLEED` gains `"terminal"`.
  `SCREENS.agents` temporarily points to a placeholder until Task 7.

- [ ] **Step 1: Write failing tests:**
  - nav: every profile sees "Agent trên máy" and "Terminal" first in "Chạy";
  - terminal screen: lists existing local projects plus folders that have tabs; picking one shows its pane;
    "Thư mục khác…" opens the folder dialog; open a tab, unmount the screen, render again: same tab, `pty_open`
    called once;
  - projects screen: "Terminal" on a bound project row and on a local repo row calls `openProjectTerminal(folder)`
    and sets `location.hash` to `#/terminal`; hidden when the folder is missing.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three test files and `app-shell.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Terminal workspace grouped by project`.

### Task 7: Agents screen and home card

**Files:**
- Create: `apps/desktop/src/screens/agents-screen.tsx` (+ test)
- Modify: `apps/desktop/src/screens/index.ts`, `apps/desktop/src/screens/home-screen.tsx` (+ test)

**Interfaces:**
- Consumes: Task 4 helpers, Task 5 `openTerminal`/`selectFolder`/`selectTerminal`/`closeTerminal`, `cliProfiles()`,
  `localProjects()`, `invoke("open_hub_page")`, `invoke("remote_session_kill")`.

- [ ] **Step 1: Write failing tests:**
  - one row per agent with CLI, PID, project name, plan label + email, source label, CPU %, RAM, prompt and step;
    "(đoán theo thư mục)" when `guessed`;
  - count chips per CLI; source filter narrows rows;
  - Run row "Mở run trên web" → `open_hub_page` `/runs/<id>`; Hive row with hub id → `/leader/terminal/<hubId>`;
  - "Terminal ở thư mục này" opens a shell tab in cwd and goes to `#/terminal`;
  - App row "Mở tab" selects the tab with that `ptyId` and its folder, and goes to `#/terminal`;
  - "Dừng…" absent when `own` false; dialog shows warnings for Run and ClaudeDesktop and "cũng dừng 2 agent con";
    confirm → `machine_agent_stop {pid, startedAt}`; Hive row → `remote_session_kill {id}`; App row whose tab is a CLI
    → `pty_close`; App row whose tab is a shell → `machine_agent_stop` (shell stays open);
  - polling: second `machine_agents` call after 3 s (fake timers), none after unmount;
  - home: card "Agent đang chạy" shows counts from `machine_agent_counts` and links to `#/agents`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Agent trên máy screen and home counts`.

### Task 8: Verification

- [ ] `corepack pnpm --filter @xdev-hive/desktop typecheck` → exit 0.
- [ ] `corepack pnpm --filter @xdev-hive/desktop test` → all pass.
- [ ] Biome on changed files with `--line-ending=crlf` (checkout is CRLF) → no errors.
- [ ] `corepack pnpm deps` → no violations.
- [ ] Rust in Docker (repo mounted, registry volume `hive-cargo-registry`, placeholder `dist/` and sidecar files as in
  the ssh-keys hand-over): `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` → pass.
- [ ] Try `cargo check --target x86_64-pc-windows-msvc`; report if the toolchain in the image cannot do it.
