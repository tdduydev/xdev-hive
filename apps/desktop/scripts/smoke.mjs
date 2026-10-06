// Launches the built app with a throwaway config and data dir, screenshots a few pages, then exits.
// Seeds a task and a queued run whose first subscription "runs out of quota", so the Board shows a real rotation,
// then a cross-review and a merge request on a mock GitLab (through Electron's net.fetch) with a bare repo as origin.
// Then the MR's pipeline fails on GitLab: the app queues a fix run with the job's log (board-ci.png).
// Last, T-002 runs as two candidates on two Codex subscriptions and the Gemini judge keeps one (board-best.png).
//   npm run smoke -w @xdev-hive/desktop [-- <output dir>]      (HIVE_SMOKE_LOCALE=en for the English interface,
//   HIVE_SMOKE_THEME=dark for the dark theme)
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { HubBackend } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { RunStore } from "../src/main/runner/store.ts";
import { resetText } from "../src/main/runner/usage.ts";
import { startMockGitLab } from "../test/fixtures/mock-gitlab.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const work = mkdtempSync(path.join(os.tmpdir(), "hive-smoke-"));
const out = path.resolve(process.argv[2] ?? path.join(work, "shots"));
mkdirSync(out, { recursive: true });

const repo = path.join(work, "demo-repo");
mkdirSync(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo });
git("init", "-q", "-b", "main");
git("config", "user.email", "smoke@example.com");
git("config", "user.name", "Smoke");
writeFileSync(path.join(repo, "README.md"), "# demo\n\n## Chạy\n\nnpm ci\n\n## Phát hành\n\nnpm run release\n");
// Its README as pages of Hive (roadmap 26): the Projects page's Đồng bộ mirrors them (projects-mirror.png).
mkdirSync(path.join(repo, ".xdev-hive"));
writeFileSync(path.join(repo, ".xdev-hive", "docs.json"), JSON.stringify({ docs: [{ file: "README.md", split: "##", folder: "huong-dan", folderTitle: "Hướng dẫn" }] }));
git("add", ".");
git("commit", "-qm", "init");
const origin = path.join(work, "origin.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
git("remote", "add", "origin", origin);
git("push", "-q", "origin", "main");
const token = "mock-gitlab-smoke-token";
const gitlab = await startMockGitLab(token);

const fake = path.join(appDir, "test", "fixtures", "fake-agent.mjs");
const shellWord = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
// A wrapper as the CLI, so sign-in checks (`<bin> auth status --json`) reach the fake agent as well.
const cli = path.join(work, "fake-cli");
writeFileSync(cli, `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(fake)} "$@"\n`, { mode: 0o755 });
// Quota with resets ahead of the smoke's own clock (roadmap 52): /usage's text for Claude, and a Codex session file as
// Codex writes it, so codex-plus shows these numbers and not this machine's real ~/.codex.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const inMinutes = (m) => new Date(Date.now() + m * 60_000);
const claudeResets = `${resetText(inMinutes(2 * 60 + 15), zone)}|${resetText(inMinutes(3 * 1440 + 5 * 60), zone)}`;
const codexHome = path.join(work, "codex-plus");
{
  const day = new Date();
  const dir = path.join(codexHome, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const limit = (used_percent, minutes, resetIn) => ({ used_percent, window_minutes: minutes, resets_at: Math.floor(inMinutes(resetIn).getTime() / 1000) });
  const rate_limits = { limit_id: "codex", primary: limit(37, 300, 3 * 60 + 40), secondary: limit(62, 10080, 4 * 1440 + 9 * 60), plan_type: "plus" };
  writeFileSync(
    path.join(dir, "rollout-smoke.jsonl"),
    `${JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", info: null, rate_limits } })}\n`,
  );
}
const agyBin = path.join(work, "agy-bin");
mkdirSync(agyBin, { recursive: true });
writeFileSync(path.join(agyBin, "agy"), `#!/bin/sh
export FAKE_AGY=1 FAKE_AGY_VERSION='agy 1.2.17' FAKE_LOGIN=out
exec ${shellWord(process.execPath)} ${shellWord(fake)} "$@"
`, { mode: 0o755 });
const agent = (id, kind, priority, mode, label, extra = {}) => ({
  id, label, kind, bin: cli, args: ["{prompt}"], env: { FAKE_MODE: mode },
  enabled: true, priority, roles: ["plan", "implement", "review"], maxConcurrent: 1, cooldownMinutes: 60, timeoutMinutes: 5,
  ...extra,
});
writeFileSync(
  path.join(work, "config.json"),
  JSON.stringify({
    mode: "local",
    // The main process starts in the language the screenshots use (tray, notifications, setup items).
    locale: process.env.HIVE_SMOKE_LOCALE ?? "vi",
    projects: [{ name: "demo", repo, gitlabProject: "group/demo" }],
    gitlab: { url: gitlab.base, token, mr: { enabled: true } },
    agents: [
      // Claude in a container (roadmap 11b): first so the Agents shot shows its token box; off, so no run picks it.
      agent("claude-box", "claude", 98, "ok", "Claude (container)", { container: { image: "xdev-hive-agent" }, enabled: false }),
      // Plan usage (roadmap 3c): the week is high but under the 90% threshold, so the runner still uses it.
      agent("claude-max-1", "claude", 10, "limit", "Claude Max (gói 1)", { env: { FAKE_MODE: "limit", FAKE_USAGE: "41,83", FAKE_USAGE_RESETS: claudeResets } }),
      // Signed out (roadmap 2d): shown on its card, never picked. Lowest priority so it cannot win the first tick.
      agent("claude-max-2", "claude", 40, "ok", "Claude Max (gói 2)", { env: { FAKE_MODE: "ok", FAKE_LOGIN: "out", CLAUDE_CONFIG_DIR: "~/.claude-2" } }),
      agent("codex-plus", "codex", 20, "ok", "Codex (ChatGPT Plus)", { env: { FAKE_MODE: "ok", CODEX_HOME: codexHome } }),
      // Kept over its stop threshold so the quota sample cannot take a run from the existing rotation scenarios.
      agent("antigravity-google", "antigravity", 96, "ok", "Antigravity (Google)", { env: { FAKE_MODE: "ok", FAKE_AGY: "1", FAKE_AGY_USAGE: "98,46" } }),
      // A second Codex subscription: the other best-of-n candidate (roadmap 12).
      agent("codex-team", "codex", 25, "ok", "Codex (ChatGPT Team)"),
      // The reviewer only reads Hive (roadmap 2c), and judges the candidates.
      agent("gemini-pro", "gemini", 30, "review", "Gemini Pro", { readOnly: true, roles: ["review"] }),
      // Runs in Docker (roadmap 11a): last in line and a Codex, which the review avoids, so the smoke never picks it.
      agent("codex-box", "codex", 99, "ok", "Codex (container)", { container: { image: "xdev-hive-agent" } }),
    ],
  }, null, 2),
);

const hive = new SqliteHive(path.join(work, "local.db"));
hive.seed();
const admin = { name: "smoke", role: "admin" };
await hive.call("tasks.create", { id: "T-001", project: "demo", title: "Thêm trang cài đặt workspace" }, admin);
await hive.call("tasks.create", { id: "T-002", project: "demo", title: "Sửa lỗi phân trang danh sách" }, admin);
// Waits on T-002 (roadmap 7): shown as blocked, and T-002 is the next ready task.
await hive.call("tasks.create", { id: "T-003", project: "demo", title: "Viết test cho API đăng nhập", dependsOn: ["T-002"] }, admin);
hive.close();

async function shoot(name, page, delay, extra = {}) {
  const shot = path.join(out, `${name}.png`);
  // Async spawn: the mock GitLab in this process must keep answering while the app runs.
  // The throwaway dir as cwd, as a packaged app has none in the repo: what the app starts without a cwd of its own
  // (a CLI's --version) writes there, not into apps/desktop.
  const child = spawn(electron, [appDir], {
    cwd: work,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${agyBin}${path.delimiter}${process.env.PATH ?? ""}`,
      SHELL: "/usr/bin/false",
      HIVE_CONFIG: path.join(work, "config.json"),
      HIVE_SMOKE_SCREENSHOT: shot,
      HIVE_SMOKE_HASH: `/${page}`,
      HIVE_SMOKE_DELAY_MS: String(delay),
      ...extra,
    },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const code = await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(timer);
  if (code !== 0 || !existsSync(shot)) {
    console.error(`smoke failed on ${name}`, code, existsSync(shot) ? "" : "(no screenshot)");
    process.exit(1);
  }
}

async function antigravityShots() {
  await shoot("agents-antigravity", "agents", 2500, { HIVE_SMOKE_SCROLL: '[data-profile="antigravity-google"]', HIVE_SMOKE_EXPECT: '[data-profile="antigravity-google"] [role="meter"] && [data-add-account="antigravity"]' });
  await shoot("agents-antigravity-account", "agents", 1500, { HIVE_SMOKE_CLICK: '[data-add-account="antigravity"]', HIVE_SMOKE_SCROLL: '#acc-label', HIVE_SMOKE_EXPECT: '#acc-way' });
  await shoot("agents-antigravity-form", "agents", 1500, { HIVE_SMOKE_CLICK: '[data-row-menu="antigravity-google"] && [data-edit-profile="antigravity-google"]', HIVE_SMOKE_SCROLL: '#pf-agy-project', HIVE_SMOKE_EXPECT: '#pf-agy-project' });
  await shoot("agents-antigravity-mobile", "agents", 1500, { HIVE_SMOKE_SIZE: "390x844", HIVE_SMOKE_CLICK: '[data-add-account="antigravity"]', HIVE_SMOKE_SCROLL: '#acc-label', HIVE_SMOKE_EXPECT: '#acc-way', HIVE_SMOKE_ASSERT: 'window.innerWidth === 390 && document.documentElement.scrollWidth <= window.innerWidth && document.querySelector("#acc-label").getBoundingClientRect().height >= 44' });
  await shoot("agents-antigravity-form-mobile", "agents", 1500, { HIVE_SMOKE_SIZE: "390x844", HIVE_SMOKE_CLICK: '[data-row-menu="antigravity-google"] && [data-edit-profile="antigravity-google"]', HIVE_SMOKE_SCROLL: '#pf-agy-project', HIVE_SMOKE_EXPECT: '#pf-agy-project', HIVE_SMOKE_ASSERT: 'window.innerWidth === 390 && document.documentElement.scrollWidth <= window.innerWidth && document.querySelector("#pf-agy-project").getBoundingClientRect().height >= 44 && parseFloat(getComputedStyle(document.querySelector("#pf-agy-project")).fontSize) >= 16' });
  await shoot("agents-antigravity-add-login", "agents", 2000, { HIVE_SMOKE_CLICK: '[data-add-account="antigravity"] && form:has(#acc-label) button[type="submit"]', HIVE_SMOKE_EXPECT: '[data-profile="antigravity-1"][data-state="signedOut"]' });
  const added = JSON.parse(readFileSync(path.join(work, "config.json"), "utf8")).agents.find((p) => p.id === "antigravity-1");
  if (!added || added.kind !== "antigravity") throw new Error("Antigravity account was not saved");
  const scripts = path.join(work, "login", "antigravity-1");
  const script = readdirSync(scripts).map((name) => readFileSync(path.join(scripts, name), "utf8")).join("\n");
  if (!script.includes(path.join(agyBin, "agy"))) throw new Error("Antigravity login did not open the fake agy binary");
  if (process.platform !== "linux" && added.env.HOME) throw new Error("Antigravity must not claim separate OS keyring accounts on this platform");
}

// Repeat the new forms after a UI fix without rerunning the unrelated MR / chat scenarios.
if (process.env.HIVE_SMOKE_AGY_ONLY === "1") {
  await antigravityShots();
  await gitlab.close();
  process.exit(0);
}

const failures = [];

// Roadmap 39h: Skill and Memory with nothing in them yet — before the skills below are seeded, and before a run is
// queued, so the pages are quiet. EXPECT asserts the empty state's button is really there, not only in the picture.
for (const page of ["skills", "memory"]) await shoot(`${page}-empty`, page, 1500, { HIVE_SMOKE_EXPECT: "[data-empty-action]" });

{
  const local = new SqliteHive(path.join(work, "local.db"));
  // A team skill and the project's own of the same name (roadmap 14c): the Skills page marks which one demo uses.
  const skill = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  await local.call("docs.save", { key: "org/skills/review-pr", content: skill("review-pr", "Review a pull request: run the tests, read the diff, report a verdict.", "1. Run the tests.\n2. Read the diff."), baseVersion: 0 }, admin);
  await local.call("docs.save", { key: "project/demo/skills/review-pr", content: skill("review-pr", "Review a demo PR: also check the settings page screenshots.", "1. Run npm test.\n2. Compare the screenshots."), baseVersion: 0 }, admin);
  await local.call(
    "docs.save",
    { key: "project/demo/so-do", title: "Sơ đồ", content: "# Sơ đồ\n\n```mermaid\nflowchart LR\n  A[Yêu cầu] --> B{Máy rảnh?}\n  B -- có --> C[Chạy agent]\n```\n", baseVersion: 0 },
    admin,
  );
  local.close();
}
new RunStore(path.join(work, "runs.db")).insert(
  { project: "demo", taskId: "T-001", taskTitle: "Thêm trang cài đặt workspace", role: "implement", attempt: 1, maxAttempts: 3, reviewAfter: true },
  new Date().toISOString(),
);


// Roadmap 39f: Board is the Task page now and Tool a part of Dự án & công cụ, so those two shots load the address
// each page had before and check where it landed. HIVE_SMOKE_VIEW keeps the Task page on the board whatever view the
// machine's localStorage remembers.
for (const [name, page, delay, extra] of [
  ["board", "board", 6000, { HIVE_SMOKE_VIEW: "kanban", HIVE_SMOKE_EXPECT: 'nav a[href="#/tasks"][aria-current="page"] && [data-task-view="kanban"][aria-checked="true"]' }],
  ["runs", "runs", 3000],
  ["setup", "setup", 4000],
  // Same wait as the setup shot above: the address lands there, and its checks take a moment.
  ["tools", "tools", 4000, { HIVE_SMOKE_EXPECT: 'nav a[href="#/setup"][aria-current="page"] && [data-project-tools]' }],
  ["docs", "docs", 1500],
  // The Skills panel must have the skill's SKILL.md on screen, not only its frame (roadmap 39h: blank in the 3/10 shot).
  ["skills", "skills", 1500, { HIVE_SMOKE_EXPECT: "[data-skill-doc]" }],
]) await shoot(name, page, delay, extra ?? {});
// The menu of this mode at 1440×900 (roadmap 39f): twelve entries and Chat (48), none of them Board, Tool or Đợt
// chạy, and the list fits without scrolling.
await shoot("local-nav", "today", 3000, {
  HIVE_SMOKE_SIZE: "1440x900",
  HIVE_SMOKE_SIDEBAR: "open",
  HIVE_SMOKE_EXPECT: 'nav a[href="#/tasks"] && nav a[href="#/chat"] && nav a[href="#/runs"] && nav a[href="#/setup"] && nav a[href="#/systems"]',
  HIVE_SMOKE_ABSENT: 'nav a[href="#/board"] && nav a[href="#/tools"] && nav a[href="#/batches"] && nav a[href="#/machines"]',
  HIVE_SMOKE_ASSERT:
    'document.querySelectorAll("[data-nav-list] a").length === 13 && (() => { const l = document.querySelector("[data-nav-list]"); return l.scrollHeight <= l.clientHeight; })()',
});
// This machine's own chat (roadmap 48): a thread in the local database whose leader proposed a task, waiting for
// Xác nhận / Bỏ qua. The reply is written here as the app's runner would report it, so no Claude plan is used.
const user = os.userInfo().username;
const localRunner = `runner@${user}`;
let localThread = 0;
{
  const local = new SqliteHive(path.join(work, "local.db"), { local: true });
  const plan = { id: "claude-max-1", label: "Claude Max (gói 1)", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 };
  local.setChatMachine(() => ({
    id: localRunner, machine: "smoke-mac", version: "", lastSeen: new Date().toISOString(), online: true, duplicate: false,
    runs: [], profiles: [plan], projects: ["demo"], acceptsRuns: true, owner: null, profileChanges: [],
  }));
  const sent = await local.call("chat.send", { project: "demo", machineId: localRunner, text: "Trang cài đặt còn thiếu gì?" }, admin);
  const leader = { name: `claude-max-1@${user}`, role: "agent", chatReply: sent.reply.id };
  await local.call("chat.propose", { action: { kind: "task.create", id: "T-004", title: "Thêm nút Lưu cho trang cài đặt", dependsOn: [] }, reason: "T-001 làm trang nhưng chưa lưu được" }, leader);
  await local.call(
    "chat.finish",
    { replyId: sent.reply.id, status: "done", text: "T-001 đang làm trang cài đặt; trang chưa có nút **Lưu**. Tôi đề xuất thêm task T-004 cho việc đó.", steps: "▶ task_get T-001\n", sessionId: "smoke-session", costUsd: 0.02, error: null },
    { name: localRunner, role: "agent" },
  );
  localThread = sent.thread.id;
  local.close();
}
await shoot("local-chat", `chat?thread=${localThread}`, 3000, {
  HIVE_SMOKE_EXPECT: `nav a[href="#/chat"][aria-current="page"] && [data-chat-thread="${localThread}"] [data-action-status="proposed"] button`,
});
// Chat mới on this machine: the one machine is this one, with its Claude plan.
await shoot("local-chat-new", "chat", 3000, {
  HIVE_SMOKE_CLICK: "[data-chat-new]",
  HIVE_SMOKE_EXPECT: `#chat-machine option[value="${localRunner}"] && #chat-plan`,
  HIVE_SMOKE_ABSENT: "[data-chat-here]",
});
// The other view of Task on this machine: the list, with the switch next to it.
await shoot("local-task-list", "tasks", 3000, { HIVE_SMOKE_VIEW: "list", HIVE_SMOKE_EXPECT: '[data-task-view="list"][aria-checked="true"]' });
// Token và cache on Agent và quota (roadmap 46): finished runs with tokens, a Claude one, a Codex one and one from
// before 28c (no cache split), on a task the board has not, marked reported so a hub never gets their costs.
{
  const store = new RunStore(path.join(work, "runs.db"));
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  for (const [profileId, hours, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens] of [
    ["claude-max-1", 2, 12_400, 38_000, 412_000, 9_800],
    ["claude-max-1", 50, 8_100, 21_000, 268_000, 6_200],
    ["codex-plus", 5, 31_000, 0, 96_000, 4_100],
    ["claude-max-1", 20 * 24, 54_000, null, null, 3_000],
  ]) {
    const r = store.insert({ project: "demo", taskId: "T-900", taskTitle: "Token mẫu", role: "implement", attempt: 1, maxAttempts: 1 }, hoursAgo(hours + 1));
    store.update(r.id, { status: "succeeded", profileId, startedAt: hoursAgo(hours + 1), finishedAt: hoursAgo(hours), inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, costReported: 1 });
  }
  // The quota line (roadmap 52): codex-plus hit its limit once since its counter was reset yesterday, and
  // claude-max-1 rests (the board's rotation gave it a rest already; this one ends at a known time).
  const limited = store.insert({ project: "demo", taskId: "T-900", taskTitle: "Token mẫu", role: "implement", attempt: 1, maxAttempts: 1 }, hoursAgo(4));
  store.update(limited.id, { status: "rate_limited", profileId: "codex-plus", startedAt: hoursAgo(4), finishedAt: hoursAgo(3.5), costReported: 1 });
  store.resetStats("codex-plus", hoursAgo(30));
  store.setCooldown("claude-max-1", new Date(Date.now() + 100 * 60_000).toISOString(), "You've hit your usage limit");
  store.db.close();
}
await shoot("agents-tokens", "agents", 2500, {
  HIVE_SMOKE_CLICK: '[data-token-window="d30"]',
  HIVE_SMOKE_SCROLL: "[data-token-stats]",
  HIVE_SMOKE_EXPECT: '[data-token-row="claude-max-1"] && [data-token-row="codex-plus"] && [data-token-total] && [data-token-window="d30"][data-state="on"]',
});
// A subscription's numbers open Lượt chạy on its runs only.
await shoot("agents-tokens-runs", "agents", 2500, {
  HIVE_SMOKE_CLICK: '[data-token-row="codex-plus"]',
  HIVE_SMOKE_EXPECT: '[data-profile-filter="codex-plus"]',
  HIVE_SMOKE_ASSERT: 'document.querySelectorAll("[data-run-index]").length >= 1',
});
// Agent và quota (roadmap 39c): one row per subscription, with a signed-out one, the fold of the off ones and bars
// on the subscription whose CLI reports usage. The expect waits for the sign-in check, which lands after first paint.
const agentsTable = '[data-profile="claude-max-2"][data-state="signedOut"] && [data-off-group] && [data-profile="claude-max-1"] [role="meter"]';
await shoot("agents", "agents", 2500, { HIVE_SMOKE_EXPECT: agentsTable });
// Every row's quota (roadmap 52): claude-max-1 resting with Bỏ nghỉ next to its countdowns, codex-plus with the
// numbers of its session file, a reset counter ("từ <ngày>") and a limit hit, and Đọc lại quota above Quản lý gói.
await shoot("agents-quota", "agents", 3000, {
  HIVE_SMOKE_EXPECT: [
    '[data-profile="claude-max-1"] [data-resting] [data-end-rest]',
    '[data-profile="claude-max-1"] [data-meter="session"] [data-reset-left]',
    '[data-profile="claude-max-1"] [data-meter="week"] [data-reset-left]',
    '[data-profile="claude-max-1"] [data-stat-line] .text-warning',
    '[data-profile="codex-plus"] [data-meter="session"] [data-reset-left]',
    '[data-profile="codex-plus"] [data-meter="week"] [data-reset-at]',
    '[data-profile="codex-plus"] [data-stats-since]:not([data-stats-since=""])',
    '[data-profile="codex-plus"] [data-read-usage]',
    "[data-read-usage-all]",
  ].join(" && "),
});
// The off subscriptions unfolded, then the Chi tiết of one: its container token box, command and autonomy.
await antigravityShots();
await shoot("agents-off", "agents", 2500, { HIVE_SMOKE_CLICK: "[data-off-group]", HIVE_SMOKE_EXPECT: '[data-profile="claude-box"][data-state="off"]' });
await shoot("agents-detail", "agents", 2500, {
  HIVE_SMOKE_CLICK: '[data-off-group] && [data-profile-toggle="claude-box"]',
  HIVE_SMOKE_SCROLL: '[data-profile="claude-box"]',
  HIVE_SMOKE_EXPECT: '[data-token="claude-box"]',
});
// Đăng nhập in the row runs the same sign-in as the button on the old card (roadmap 2e): the CLI's own command, with
// the subscription's sign-in folder. In smoke the script is written but no terminal window opens.
await shoot("agents-login", "agents", 2500, { HIVE_SMOKE_CLICK: '[data-login="claude-max-2"]' });
{
  const dir = path.join(os.homedir(), ".claude-2");
  const scripts = path.join(work, "login", "claude-max-2");
  const script = existsSync(scripts) ? readdirSync(scripts).map((f) => readFileSync(path.join(scripts, f), "utf8")).join("\n") : "";
  // The script quotes each word (sh: 'auth' 'login'; Windows: "auth" "login").
  if (!/['"]?auth['"]? ['"]?login['"]?/.test(script) || !script.includes(dir)) failures.push(`row login: the sign-in script of claude-max-2 does not run "auth login" with ${dir}`);
}
// Cài đặt with no hub (roadmap 39d): the Kết nối card offers the browser sign-in, everything else is folded away.
await shoot("projects", "projects", 1500, { HIVE_SMOKE_EXPECT: '[data-hub-link="none"] && [data-connect-browser]' });
// What Nâng cao holds: this machine's name and config.json, the two switches, and the one-off copy to or from the hub.
await shoot("projects-advanced", "projects", 1500, { HIVE_SMOKE_CLICK: '[data-fold="advanced"]', HIVE_SMOKE_EXPECT: '[data-transfer="push"]' });
// The hub's tools on Cài đặt máy (roadmap 28b-2): the Tool từ hub card, and the tool's own tool:rtk item, required by
// demo and waiting for this machine's user to allow it. The catalog stands in for a heartbeat's (local mode).
const smokeTools = path.join(work, "tools.json");
writeFileSync(
  smokeTools,
  JSON.stringify({
    entries: [
      {
        id: "rtk", name: "RTK", description: "", kind: "cli", package: { registry: "npm", name: "rtk-cli", version: "0.9.0" },
        mcp: null, plugin: null, hooks: [], agents: ["claude"], check: ["rtk", "--version"], install: ["npm", "install", "-g", "{package}"],
        prepare: null, env: { RTK_TELEMETRY: "0" }, secretEnv: [], license: "MIT", homepage: null, handler: null, enabledByDefault: false,
      },
    ],
    projects: { demo: [{ id: "rtk", enabled: true, effective: true, required: true }] },
  }),
);
// data-project-tools: the catalog Tool had a page of its own for, at the foot of this one since 39f.
await shoot("setup-tools", "setup", 4000, { HIVE_SMOKE_TOOLS: smokeTools, HIVE_SMOKE_EXPECT: '[data-hub-tools] && [data-setup-item="tool:rtk"] && [data-project-tools]' });
// Another Claude account on this machine (roadmap 24b): the form, before the CLI's own sign-in opens.
await shoot("agents-account", "agents", 1500, { HIVE_SMOKE_CLICK: '[data-add-account="claude"]', HIVE_SMOKE_SCROLL: "#acc-label" });
// The GitHub card (roadmap 13a), which 39d folds: its heading says Chưa cấu hình until the form below is filled in.
await shoot("projects-github", "projects", 1500, { HIVE_SMOKE_CLICK: '[data-fold="github"]', HIVE_SMOKE_SCROLL: "#gh-url", HIVE_SMOKE_EXPECT: "#gh-url" });
// The repositories of the demo's GitLab group, with their keys and folders (roadmap 19a).
await shoot("projects-import", "setup", 4000, { HIVE_SMOKE_CLICK: "#import-list", HIVE_SMOKE_SCROLL: "#import-group" });
// A folder that is no repository but holds some (roadmap 38d): Chọn thư mục offers each repository under it with its
// key and target branch. The repository inside a repository and the one in node_modules stay out of the list.
{
  const multi = path.join(work, "many-repos");
  for (const rel of ["app/backend/svc-a", "app/frontend/svc-b", "iam", "node_modules/dep", "app/backend/svc-a/vendor"]) {
    const dir = path.join(multi, rel);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  }
  await shoot("projects-subrepos", "setup", 4000, {
    HIVE_SMOKE_PICK_FOLDER: multi,
    HIVE_SMOKE_CLICK: "[data-pick-folder]",
    // The form, which is there before the click: the panel renders right under it, and scrolling runs before the wait.
    HIVE_SMOKE_SCROLL: "[data-pick-folder]",
    HIVE_SMOKE_EXPECT: '[data-sub-repo="app/backend/svc-a"] && [data-sub-repo="app/frontend/svc-b"] && [data-sub-repo="iam"] && [data-add-sub-repos]',
    HIVE_SMOKE_ABSENT: '[data-sub-repo="node_modules/dep"] && [data-sub-repo="app/backend/svc-a/vendor"]',
  });
}
// The app checks open MRs as it starts (right away in smoke mode): the failed job goes to a fix run.
gitlab.jobs[7] = [{ id: 71, name: "test", stage: "test", status: "failed", trace: "not ok 2 - settings page renders\n" }];
for (const mr of gitlab.mrs) mr.head_pipeline = { id: 7, status: "failed", web_url: `${gitlab.base}/group/demo/-/pipelines/7` };
await shoot("board-ci", "board", 5000, { HIVE_SMOKE_VIEW: "kanban" });
// Hôm nay (roadmap 22c): the failed pipeline, T-001 waiting for review and this machine's setup gaps.
await shoot("today", "today", 4000);

// The run form of the next task (T-002), with its number of candidates (roadmap 12): open its card, then the form.
await shoot("board-run", "board", 3000, { HIVE_SMOKE_VIEW: "kanban", HIVE_SMOKE_CLICK: 'section[aria-label="Chưa làm"] [role="button"] && [data-run-here]' });

// The Board at the two widths it has to work at (roadmap 39g). At 1100 there is no room for five columns, so Xong
// and Bị chặn are rails with their count and the board fits without scrolling sideways; at 1440 the three columns
// with work in them are open, Bị chặn too (T-003 waits for T-002), and only the empty Xong stays a rail.
await shoot("board-1100", "board", 5000, {
  HIVE_SMOKE_SIZE: "1100x800",
  HIVE_SMOKE_EXPECT: '[data-board-fit="narrow"] && [data-column-rail="done"] && [data-column-rail="blocked"] && [data-profile-chip]',
});
await shoot("board-1440", "board", 5000, {
  HIVE_SMOKE_SIZE: "1440x820",
  HIVE_SMOKE_EXPECT: '[data-board-fit="wide"] && [data-column-rail="done"]',
  HIVE_SMOKE_ABSENT: '[data-column-rail="blocked"]',
});

// Best-of-n (roadmap 12): the container Codex stays out of it, since this machine may have no Docker, and so does
// the signed-out Claude: the second candidate prefers another vendor over priority, and the first tick comes
// before the sign-in check.
const config = JSON.parse(readFileSync(path.join(work, "config.json"), "utf8"));
for (const a of config.agents) if (a.id === "codex-box" || a.id === "claude-max-2") a.enabled = false;
writeFileSync(path.join(work, "config.json"), JSON.stringify(config, null, 2));
const from = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const store = new RunStore(path.join(work, "runs.db"));
const group = "B-smoke1";
for (const n of [1, 2]) {
  store.insert(
    {
      project: "demo", taskId: "T-002", taskTitle: "Sửa lỗi phân trang danh sách", role: "implement", attempt: 1, maxAttempts: 3,
      baseSha: from, bestOf: { group, n, of: 2, from, pick: null, reason: null },
    },
    new Date().toISOString(),
  );
}
store.db.close();
// The kept candidate on Lượt chạy, next to the judge and the other candidate.
await shoot("runs-best", "runs", 6000, { HIVE_SMOKE_CLICK: '[data-best="kept"]' });
// The first run (Claude, out of quota): its log follows Claude Code's steps (stream-json), by level. The detail opens
// on Tóm tắt now (roadmap 39e), so the log is one click away.
await shoot("runs-log", "runs", 3000, {
  HIVE_SMOKE_CLICK: '[data-run-status="rate_limited"] && [data-run-tab="log"]',
  HIVE_SMOKE_EXPECT: '[data-run-tab="log"][aria-selected="true"]',
});

// Lượt chạy as 39e wants it read (runs-list.png): the list has a run xong, a run lỗi and a run đang chạy at once, and
// the detail of a finished run opens on its summary. A run left running when the app closed comes back failed
// (RunStore.failInterrupted), and a profile whose CLI sleeps keeps one run going while the screenshot is taken.
{
  const file = path.join(work, "config.json");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(before), agents: [...JSON.parse(before).agents, agent("claude-slow", "claude", 97, "sleep", "Claude (chạy lâu)")] }, null, 2));
  const seed = new RunStore(path.join(work, "runs.db"));
  const at = new Date().toISOString();
  // T-001, which has no task waiting on it: the run starts without the Board's dependency getting in the way.
  const task = { project: "demo", taskId: "T-001", taskTitle: "Thêm trang cài đặt workspace", role: "implement", attempt: 1, maxAttempts: 1 };
  const interrupted = seed.insert(task, at);
  seed.update(interrupted.id, { status: "running", profileId: "codex-plus", startedAt: at });
  seed.insert({ ...task, preferredProfile: "claude-slow" }, at);
  seed.db.close();
  await shoot("runs-list", "runs", 6000, {
    HIVE_SMOKE_CLICK: '[data-run-status="succeeded"]',
    HIVE_SMOKE_EXPECT:
      '[data-run-status="succeeded"] && [data-run-status="failed"] && [data-run-status="running"] && [data-run-tab="summary"][aria-selected="true"]',
  });
  // The slow profile is only for that one shot: the Agents page and the hub shots list the profiles of the config above.
  writeFileSync(file, before);
}

// The Docs page in the app (goals QA-2): the diagram is drawn under the app's CSP, and Sửa opens the Tiptap editor.
const soDo = `docs?doc=${encodeURIComponent("project/demo/so-do")}`;
await shoot("docs-mermaid", soDo, 2500, { HIVE_SMOKE_EXPECT: '[data-mermaid] [role="img"] svg' });
await shoot("docs-editor", soDo, 2500, { HIVE_SMOKE_CLICK: '[role="radio"][data-value="edit"]', HIVE_SMOKE_EXPECT: '.ProseMirror && .ProseMirror [data-mermaid] [role="img"] svg' });
// Đồng bộ on the Projects page mirrors the README's sections into Hive (roadmap 26).
await shoot("projects-mirror", "setup", 4000, { HIVE_SMOKE_CLICK: '[data-sync-project="demo"]', HIVE_SMOKE_SCROLL: '[data-sync-project="demo"]' });
{
  const local = new SqliteHive(path.join(work, "local.db"));
  const chay = await local.call("docs.get", { key: "project/demo/chay" }, admin);
  if (chay?.mirror?.from !== "README.md#Chạy" || chay.parent !== "project/demo/huong-dan") failures.push(`mirror: project/demo/chay is ${JSON.stringify(chay && { mirror: chay.mirror, parent: chay.parent })}`);
  local.close();
}
// A profile's CLI in the project's repo (roadmap 32a): the script starts there, and Hive's server carries the profile's id.
// Mở CLI sits in the row's … menu since 39c, so the shot opens the menu first.
await shoot("agents-cli", "agents", 2000, {
  HIVE_SMOKE_CLICK: '[data-row-menu="claude-max-1"] && [data-open-cli="claude-max-1:demo"]',
  HIVE_SMOKE_SCROLL: '[data-profile="claude-max-1"]',
});
{
  const dir = path.join(work, "cli", "claude-max-1");
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const script = files.filter((f) => f.startsWith("cli.")).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
  const mcp = files.includes("mcp.json") ? JSON.parse(readFileSync(path.join(dir, "mcp.json"), "utf8")) : null;
  if (!script.includes(repo)) failures.push(`open-cli: the script of claude-max-1 does not start in ${repo}`);
  if (mcp?.mcpServers?.["xdev-hive"]?.env?.HIVE_AGENT !== "claude-max-1") failures.push(`open-cli: mcp.json is ${JSON.stringify(mcp)}`);
}
// One more account of each (roadmap 24b): its own sign-in folder, a sign-in script with the CLI's command, and no run
// until it signs in. The CLIs are the fake one, so the check does not need Claude Code or Codex on the machine.
const accountBin = path.join(work, "bin");
mkdirSync(accountBin);
for (const name of ["claude", "codex"]) writeFileSync(path.join(accountBin, name), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(fake)} "$@"\n`, { mode: 0o755 });
const withBin = { PATH: `${accountBin}${path.delimiter}${process.env.PATH}` };
for (const [kind, dirEnv, login] of [["claude", "CLAUDE_CONFIG_DIR", "auth login"], ["codex", "CODEX_HOME", "login"]]) {
  await shoot(`agents-account-${kind}`, "agents", 2000, { ...withBin, HIVE_SMOKE_CLICK: `[data-add-account="${kind}"] && form:has(#acc-label) button[type="submit"]` });
  const added = JSON.parse(readFileSync(path.join(work, "config.json"), "utf8")).agents.find((a) => a.id === `${kind}-1`);
  const dir = added?.env?.[dirEnv]?.replace(/^~/, os.homedir());
  const scripts = path.join(work, "login", `${kind}-1`);
  const script = existsSync(scripts) ? readdirSync(scripts).map((f) => readFileSync(path.join(scripts, f), "utf8")).join("\n") : "";
  if (!added) failures.push(`account: no ${kind}-1 in config.json`);
  else if (!dir || !existsSync(dir) || dir === os.homedir()) failures.push(`account: ${kind}-1 has no sign-in folder of its own (${dirEnv}=${added.env[dirEnv]})`);
  // The script quotes each word (sh: 'auth' 'login'; Windows: "auth" "login").
  else if (!new RegExp(login.split(" ").map((w) => `['"]?${w}['"]?`).join(" ")).test(script) || !script.includes(dir)) failures.push(`account: the sign-in script of ${kind}-1 does not run "${login}" with ${dir}`);
}
// Roadmap 35a: connected to a hub, the app shows this machine's work only (Mở web); the rest is the web's. Roadmap 44
// brought the Board of this machine's projects back.
{
  const webDir = path.resolve(appDir, "..", "web");
  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  // The hub wants a bootstrap token of 32 characters at least.
  const bootstrap = randomBytes(16).toString("hex");
  // Development mode: the hub serves its API without a built web client.
  const hub = spawn(process.execPath, ["src/server.ts"], {
    cwd: webDir,
    stdio: "ignore",
    env: { ...process.env, NODE_ENV: "development", HIVE_PORT: String(port), HIVE_DB: path.join(work, "hub.db"), HIVE_BOOTSTRAP_TOKEN: bootstrap, HIVE_ADMIN_USER: "smoke" },
  });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) failures.push("hub mode: the hub did not start");
  else {
    const file = path.join(work, "config.json");
    const local = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(local), mode: "hub", hub: { url: `http://127.0.0.1:${port}`, token: bootstrap } }, null, 2));
    // Task is in the menu again as this machine's Board (roadmap 44); #/board is only an old address of it.
    // Chat is in it since roadmap 48, the hub's threads.
    const webPages = ["board", "docs", "memory", "proposals", "skills", "specs", "batches", "machines", "members", "tokens", "systems", "tools", "admin"];
    // hub-agents also proves the 39c table in hub mode: here three subscriptions are off, so only the fold shows them.
    // Lượt chạy has the same shape in hub mode, and only this machine's runs in it (roadmap 35a, 39e).
    // Connected (roadmap 39d): Cài đặt is one line about the hub, the account and this machine, with no form.
    const absent = webPages.map((p) => `nav a[href="#/${p}"]`).join(" && ");
    const pages = [
      ["hub-today", "today"],
      ["hub-runs", "runs", '[data-run-tab="summary"][aria-selected="true"]'],
      ["hub-agents", "agents", '[data-off-group] && [data-profile="claude-max-1"] [role="meter"]'],
      ["hub-setup", "setup"],
      ["hub-projects", "projects", '[data-hub-link="connected"]'],
    ];
    for (const [name, page, also] of pages) {
      await shoot(name, page, 3000, { HIVE_SMOKE_EXPECT: also ? `[data-open-web] && ${also}` : "[data-open-web]", HIVE_SMOKE_ABSENT: absent });
    }
    // Roadmap 44: the Board of the projects with a repo here. The hub also has a project this machine does not clone,
    // which the picker leaves out (it is on the web, behind Mở trên web).
    const api = new HubBackend(`http://127.0.0.1:${port}`, bootstrap);
    const seeder = { name: "smoke", role: "admin" };
    await api.call("tasks.create", { id: "T-001", project: "demo", title: "Thêm trang cài đặt workspace" }, seeder);
    await api.call("tasks.create", { id: "T-002", project: "demo", title: "Sửa lỗi phân trang danh sách" }, seeder);
    await api.call("tasks.update", { id: "T-002", status: "doing" }, seeder);
    await api.call("tasks.create", { id: "T-003", project: "demo", title: "Viết test cho API đăng nhập", dependsOn: ["T-002"] }, seeder);
    await api.call("tasks.create", { id: "O-001", project: "other", title: "Việc của máy khác" }, seeder);
    const board = 'nav a[href="#/tasks"][aria-current="page"] && [data-open-web-board] && section[aria-label="Chưa làm"] [role="button"]';
    await shoot("hub-board", "tasks", 4000, {
      HIVE_SMOKE_EXPECT: `[data-open-web] && ${board}`,
      HIVE_SMOKE_ABSENT: `${absent} && option[value="other"] && [data-task-view]`,
    });
    // The old address lands on it too, and a card opens its panel with the run form of this machine.
    await shoot("hub-board-task", "board", 4000, {
      HIVE_SMOKE_CLICK: 'section[aria-label="Chưa làm"] [role="button"]',
      HIVE_SMOKE_EXPECT: `${board} && aside[aria-label^="T-00"]`,
    });
    // Roadmap 48: the hub's chat in the app. Another machine of the team holds a thread (the web sees the same), and
    // Chat mới says this machine does not take runs from the hub yet, with the switch to turn it on.
    await api.call(
      "machines.heartbeat",
      {
        machine: "box", instance: randomBytes(8).toString("hex"), version: "0.130.0", projects: ["demo"], acceptsRuns: true, runs: [], costs: [],
        profiles: [{ id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 }],
      },
      { name: "runner.box", role: "agent" },
    );
    const box = (await api.call("machines.list", {}, seeder)).find((m) => m.machine === "box");
    const hubThread = box ? (await api.call("chat.send", { project: "demo", machineId: box.id, text: "Tuần này còn task nào chưa ai nhận?" }, seeder)).thread.id : 0;
    if (!box) failures.push("hub chat: the hub lists no machine box");
    await shoot("hub-chat", `chat?thread=${hubThread}`, 3000, {
      HIVE_SMOKE_EXPECT: `[data-open-web] && nav a[href="#/chat"][aria-current="page"] && [data-chat-thread="${hubThread}"] && button[aria-current="true"]`,
      HIVE_SMOKE_ABSENT: absent,
    });
    await shoot("hub-chat-new", "chat", 3000, {
      HIVE_SMOKE_CLICK: "[data-chat-new]",
      HIVE_SMOKE_EXPECT: '[data-open-web] && [data-chat-here="off"] button && a[href="#/agents"]',
      HIVE_SMOKE_ABSENT: absent,
    });
    // A machine with no project: the Board says where to add one.
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), projects: [] }, null, 2));
    await shoot("hub-board-empty", "tasks", 3000, { HIVE_SMOKE_EXPECT: '[data-board-empty] a[href="#/setup"]' });
    writeFileSync(file, JSON.stringify({ ...JSON.parse(local), mode: "hub", hub: { url: `http://127.0.0.1:${port}`, token: bootstrap } }, null, 2));
    // Đổi kết nối brings the sign-in form back over that summary.
    await shoot("hub-projects-change", "projects", 3000, { HIVE_SMOKE_CLICK: "[data-hub-change]", HIVE_SMOKE_EXPECT: '[data-hub-link="changing"] && [data-connect-browser]' });
    writeFileSync(file, local);
  }
  hub.kill();
}
if (failures.length) {
  console.error(`smoke checks failed:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
}

const runs = new RunStore(path.join(work, "runs.db")).list({ project: "demo" });
console.log(
  runs
    .map(
      (r) =>
        `${r.id} ${r.role} ${r.profileId} ${r.status} attempt ${r.attempt}${r.error ? ` (${r.error})` : ""}` +
        `${r.bestOf ? ` · best-of ${r.bestOf.n ? `c${r.bestOf.n}` : "judge"}/${r.bestOf.of}${r.bestOf.pick ? ` kept c${r.bestOf.pick}: ${r.bestOf.reason}` : ""}` : ""}` +
        `${r.mrState ? ` · MR ${r.mrState} ${r.mrUrl ?? r.mrNote}` : ""}${r.mrStatus ? ` · GitLab ${r.mrStatus}, CI ${r.pipelineStatus ?? "-"}` : ""}${r.ciFix ? ` · CI fix ${r.ciFix.n}/${r.ciFix.max} (${r.ciFix.jobs.map((j) => j.name).join(", ")})` : ""}`,
    )
    .join("\n"),
);
console.log(`mock GitLab MRs: ${gitlab.mrs.map((m) => `!${m.iid} "${m.title}" ${m.source_branch}→${m.target_branch}`).join(", ") || "none"}`);
for (const b of ["ai/T-001", "ai/T-002"]) console.log(`origin has ${b}: ${execFileSync("git", ["-C", origin, "branch", "--list", b], { encoding: "utf8" }).trim() || "no"}`);
await gitlab.close();
console.log(`screenshots in ${out}\ndata in ${work}`);
