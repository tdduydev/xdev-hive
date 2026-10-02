// Launches the built app with a throwaway config and data dir, screenshots a few pages, then exits.
// Seeds a task and a queued run whose first subscription "runs out of quota", so the Board shows a real rotation,
// then a cross-review and a merge request on a mock GitLab (through Electron's net.fetch) with a bare repo as origin.
// Then the MR's pipeline fails on GitLab: the app queues a fix run with the job's log (board-ci.png).
// Last, T-002 runs as two candidates on two Codex subscriptions and the Gemini judge keeps one (board-best.png).
//   npm run smoke -w @xdev-hive/desktop [-- <output dir>]      (HIVE_SMOKE_LOCALE=en for the English interface,
//   HIVE_SMOKE_THEME=dark for the dark theme)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { SqliteHive } from "@xdev-hive/core/node";
import { RunStore } from "../src/main/runner/store.ts";
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
// A wrapper as the CLI, so sign-in checks (`<bin> auth status --json`) reach the fake agent as well.
const cli = path.join(work, "fake-cli");
writeFileSync(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
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
      agent("claude-max-1", "claude", 10, "limit", "Claude Max (gói 1)", { env: { FAKE_MODE: "limit", FAKE_USAGE: "41,83" } }),
      // Signed out (roadmap 2d): shown on its card, never picked. Lowest priority so it cannot win the first tick.
      agent("claude-max-2", "claude", 40, "ok", "Claude Max (gói 2)", { env: { FAKE_MODE: "ok", FAKE_LOGIN: "out", CLAUDE_CONFIG_DIR: "~/.claude-2" } }),
      agent("codex-plus", "codex", 20, "ok", "Codex (ChatGPT Plus)"),
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
// A team skill and the project's own of the same name (roadmap 14c): the Skills page marks which one demo uses.
const skill = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
await hive.call("docs.save", { key: "org/skills/review-pr", content: skill("review-pr", "Review a pull request: run the tests, read the diff, report a verdict.", "1. Run the tests.\n2. Read the diff."), baseVersion: 0 }, admin);
await hive.call("docs.save", { key: "project/demo/skills/review-pr", content: skill("review-pr", "Review a demo PR: also check the settings page screenshots.", "1. Run npm test.\n2. Compare the screenshots."), baseVersion: 0 }, admin);
await hive.call(
  "docs.save",
  { key: "project/demo/so-do", title: "Sơ đồ", content: "# Sơ đồ\n\n```mermaid\nflowchart LR\n  A[Yêu cầu] --> B{Máy rảnh?}\n  B -- có --> C[Chạy agent]\n```\n", baseVersion: 0 },
  admin,
);
hive.close();
new RunStore(path.join(work, "runs.db")).insert(
  { project: "demo", taskId: "T-001", taskTitle: "Thêm trang cài đặt workspace", role: "implement", attempt: 1, maxAttempts: 3, reviewAfter: true },
  new Date().toISOString(),
);

async function shoot(name, page, delay, extra = {}) {
  const shot = path.join(out, `${name}.png`);
  // Async spawn: the mock GitLab in this process must keep answering while the app runs.
  const child = spawn(electron, ["."], {
    cwd: appDir,
    stdio: "inherit",
    env: {
      ...process.env,
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

for (const [page, delay] of [["board", 6000], ["runs", 3000], ["agents", 1500], ["setup", 4000], ["projects", 1500], ["tools", 1500], ["docs", 1500], ["skills", 1500]]) await shoot(page, page, delay);
// Another Claude account on this machine (roadmap 24b): the form, before the CLI's own sign-in opens.
await shoot("agents-account", "agents", 1500, { HIVE_SMOKE_CLICK: '[data-add-account="claude"]', HIVE_SMOKE_SCROLL: "#acc-label" });
// The GitHub card and the project's GitLab / GitHub fields (roadmap 13a).
await shoot("projects-github", "projects", 1500, { HIVE_SMOKE_CLICK: "main button[aria-expanded]", HIVE_SMOKE_SCROLL: "#gh-url" });
// The repositories of the demo's GitLab group, with their keys and folders (roadmap 19a).
await shoot("projects-import", "projects", 1500, { HIVE_SMOKE_CLICK: "#import-list", HIVE_SMOKE_SCROLL: "#import-group" });
// The app checks open MRs as it starts (right away in smoke mode): the failed job goes to a fix run.
gitlab.jobs[7] = [{ id: 71, name: "test", stage: "test", status: "failed", trace: "not ok 2 - settings page renders\n" }];
for (const mr of gitlab.mrs) mr.head_pipeline = { id: 7, status: "failed", web_url: `${gitlab.base}/group/demo/-/pipelines/7` };
await shoot("board-ci", "board", 5000);
// Hôm nay (roadmap 22c): the failed pipeline, T-001 waiting for review and this machine's setup gaps.
await shoot("today", "today", 4000);

// The run form of the next task (T-002), with its number of candidates (roadmap 12): open its card, then the form.
await shoot("board-run", "board", 3000, { HIVE_SMOKE_CLICK: 'section[aria-label="Chưa làm"] [role="button"] && [data-run-here]' });

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
// The first run (Claude, out of quota): its log follows Claude Code's steps (stream-json), by level.
await shoot("runs-log", "runs", 3000, { HIVE_SMOKE_CLICK: '[data-run-status="rate_limited"]' });

// The Docs page in the app (goals QA-2): the diagram is drawn under the app's CSP, and Sửa opens the Tiptap editor.
const soDo = `docs?doc=${encodeURIComponent("project/demo/so-do")}`;
await shoot("docs-mermaid", soDo, 2500, { HIVE_SMOKE_EXPECT: '[data-mermaid] [role="img"] svg' });
await shoot("docs-editor", soDo, 2500, { HIVE_SMOKE_CLICK: '[role="radio"][data-value="edit"]', HIVE_SMOKE_EXPECT: '.ProseMirror && .ProseMirror [data-mermaid] [role="img"] svg' });
// Đồng bộ on the Projects page mirrors the README's sections into Hive (roadmap 26).
await shoot("projects-mirror", "projects", 3000, { HIVE_SMOKE_CLICK: '[data-sync-project="demo"]', HIVE_SMOKE_SCROLL: '[data-sync-project="demo"]' });
const failures = [];
{
  const local = new SqliteHive(path.join(work, "local.db"));
  const chay = await local.call("docs.get", { key: "project/demo/chay" }, admin);
  if (chay?.mirror?.from !== "README.md#Chạy" || chay.parent !== "project/demo/huong-dan") failures.push(`mirror: project/demo/chay is ${JSON.stringify(chay && { mirror: chay.mirror, parent: chay.parent })}`);
  local.close();
}
// One more account of each (roadmap 24b): its own sign-in folder, a sign-in script with the CLI's command, and no run
// until it signs in. The CLIs are the fake one, so the check does not need Claude Code or Codex on the machine.
const accountBin = path.join(work, "bin");
mkdirSync(accountBin);
for (const name of ["claude", "codex"]) writeFileSync(path.join(accountBin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
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
