import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AGENT_TEMPLATES, type Actor, type AgentProfile, type HiveBackend, type RunnerSettings } from "@xdev-hive/core";
import { CODEGRAPH_MCP, SUPERPOWERS_PLUGIN } from "../src/main/installer.ts";
import { buildCommand } from "../src/main/runner/command.ts";
import { outputFormat, parseClaudeResult } from "../src/main/runner/usage.ts";
import { checkLogin, LoginMonitor, loginCommand, parseLogin } from "../src/main/runner/login.ts";
import { SqliteHive } from "@xdev-hive/core/node";
import { parseResetTime, detectRateLimit } from "../src/main/runner/rate-limit.ts";
import { Runner, type HubUpdate, type RunnerHost } from "../src/main/runner/runner.ts";
import { setMainLocale } from "../src/main/i18n.ts";
import { pickProfile, waitingReason, type ProfileLoad } from "../src/main/runner/schedule.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "fake-agent.mjs");
const admin: Actor = { name: "duy", role: "admin" };
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `hive-${p}-`));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function profile(id: string, kind: AgentProfile["kind"], priority: number, mode: string, extra: Partial<AgentProfile> = {}): AgentProfile {
  return {
    ...AGENT_TEMPLATES.claude,
    id,
    label: id,
    kind,
    priority,
    bin: process.execPath,
    args: [FAKE, "{prompt}"],
    env: { FAKE_MODE: mode },
    ...extra,
  };
}

async function setup(
  profiles: AgentProfile[],
  settings: Partial<RunnerSettings> = {},
  mode: "local" | "hub" = "local",
  /** Pass another setup's hive to simulate a second machine on the same hub. */
  machine: { name?: string; hive?: SqliteHive; report?: RunnerHost["report"]; login?: RunnerHost["login"] } = {},
) {
  const repo = tmp("repo");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const hive = machine.hive ?? new SqliteHive(":memory:");
  const record = path.join(tmp("rec"), "calls.jsonl");
  // A hub names actors "<label>@<token name>"; mimic that to test hub mode without a server.
  const hubLike: HiveBackend = { call: (m, i, a) => hive.call(m, i, { ...a, name: `${a.name}@duy-macbook` }) };
  const host: RunnerHost = {
    backend: () => (mode === "hub" ? hubLike : hive),
    profiles: () => profiles.map((p) => ({ ...p, env: { ...p.env, FAKE_RECORD: record } })),
    settings: () => ({ worktreeRoot: null, maxParallel: 2, maxAttempts: 3, ...settings }),
    projects: () => [{ name: "demo", repo }],
    mode: () => mode,
    machine: () => machine.name ?? "duy-mbp",
    env: () => ({ ...process.env }),
    report: machine.report,
    login: machine.login,
  };
  const dataDir = tmp("data");
  const hubUpdates: HubUpdate[] = [];
  const runner = new Runner(host, { dataDir, user: "duy", tickMs: 60_000, onHub: (u) => hubUpdates.push(u) });
  if (!machine.hive) await hive.call("tasks.create", { id: "T-1", project: "demo", title: "Thêm trang cài đặt" }, admin);
  const calls = () =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { agent: string; prompt: string; cwd: string; args: string[]; readOnly: string | null })
      : [];
  const task = async () => (await hive.call("tasks.list", { project: "demo" }, admin)).find((t) => t.id === "T-1")!;
  return { repo, hive, runner, dataDir, calls, task, hubUpdates };
}

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("rate-limit detection", () => {
  const now = new Date("2026-09-27T08:00:00Z");
  it("reads reset times from common CLI messages", () => {
    assert.equal(parseResetTime("Claude AI usage limit reached|1790000000", now)?.getTime(), 1790000000 * 1000);
    assert.equal(parseResetTime("Try again in 2 hours 13 minutes.", now)?.toISOString(), "2026-09-27T10:13:00.000Z");
    assert.equal(parseResetTime("429 RESOURCE_EXHAUSTED, retry in 30s", now)?.toISOString(), "2026-09-27T08:00:30.000Z");
    assert.equal(parseResetTime("limit resets at 2026-09-28T01:00:00Z", now)?.toISOString(), "2026-09-28T01:00:00.000Z");
    const pm = parseResetTime("5-hour limit reached ∙ resets 3pm", now)!;
    assert.equal(pm.getHours(), 15);
    assert.ok(pm > now);
    assert.equal(parseResetTime("nothing here", now), null);
  });

  it("recognises quota errors and ignores normal output", () => {
    assert.ok(detectRateLimit("Error: You've hit your usage limit."));
    assert.ok(detectRateLimit('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'));
    assert.ok(detectRateLimit("Claude AI usage limit reached|1790000000"));
    assert.equal(detectRateLimit("Implemented rate limiting middleware; tests fail on lint."), null);
  });
});

describe("pickProfile", () => {
  const now = new Date("2026-09-27T08:00:00Z");
  const load = (p: AgentProfile, extra: Partial<ProfileLoad> = {}): ProfileLoad => ({ profile: p, running: 0, cooldownUntil: null, lastUsedAt: null, ...extra });
  const needs = { role: "implement" as const, preferredProfile: null, avoidKinds: [], excludedProfiles: [] };
  const a = profile("claude-a", "claude", 10, "ok");

  it("says why a run waits in the interface language", () => {
    const resting = [load(a, { cooldownUntil: "2026-09-27T09:00:00Z" })];
    assert.match(waitingReason(resting, needs, now), /^Mọi gói đang nghỉ vì quota/);
    setMainLocale("en");
    try {
      assert.match(waitingReason(resting, needs, now), /^Every subscription is resting/);
      assert.match(waitingReason([load(a, { installed: false })], needs, now), /^This machine lacks the CLI/);
    } finally {
      setMainLocale("vi");
    }
  });
  const b = profile("claude-b", "claude", 10, "ok");
  const c = profile("codex-a", "codex", 20, "ok");

  it("rotates equal-priority subscriptions by least recent use", () => {
    const pick = pickProfile([load(a, { lastUsedAt: "2026-09-27T07:59:00Z" }), load(b, { lastUsedAt: "2026-09-27T07:00:00Z" }), load(c)], needs, now);
    assert.equal(pick?.profile.id, "claude-b");
  });

  it("skips busy and resting profiles, falls back to the next priority", () => {
    const pick = pickProfile([load(a, { running: 1 }), load(b, { cooldownUntil: "2026-09-27T09:00:00Z" }), load(c)], needs, now);
    assert.equal(pick?.profile.id, "codex-a");
    const expired = pickProfile([load(a, { cooldownUntil: "2026-09-27T07:00:00Z" })], needs, now);
    assert.equal(expired?.profile.id, "claude-a");
  });

  it("prefers another vendor for reviews and honours pins and roles", () => {
    assert.equal(pickProfile([load(a), load(c)], { ...needs, role: "review", avoidKinds: ["claude"] }, now)?.profile.id, "codex-a");
    assert.equal(pickProfile([load(a, { running: 1 }), load(c)], { ...needs, preferredProfile: "claude-a" }, now), null);
    const planOnly = { ...c, roles: ["plan" as const] };
    assert.equal(pickProfile([load(planOnly)], needs, now), null);
    assert.equal(pickProfile([load(a), load(b)], { ...needs, excludedProfiles: ["claude-a"] }, now)?.profile.id, "claude-b");
  });
});

describe("sign-in checks", () => {
  const now = new Date("2026-09-28T04:00:00Z");

  it("reads what Claude Code and Codex say, and never guesses", () => {
    assert.deepEqual(parseLogin("claude", 0, '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'), { loggedIn: true, method: "claude.ai · max" });
    assert.deepEqual(parseLogin("claude", 0, '{"loggedIn":false,"authMethod":"none"}'), { loggedIn: false, method: null });
    assert.deepEqual(parseLogin("claude", 1, "error: unknown command 'auth'"), { loggedIn: null, method: null }, "an older CLI");
    assert.deepEqual(parseLogin("codex", 0, "Logged in using ChatGPT\n"), { loggedIn: true, method: "ChatGPT" });
    assert.deepEqual(parseLogin("codex", 1, "Not logged in"), { loggedIn: false, method: null });
    assert.deepEqual(parseLogin("codex", 2, "error: unexpected argument"), { loggedIn: null, method: null });
    assert.deepEqual(parseLogin("gemini", 0, "anything"), { loggedIn: null, method: null });
  });

  it("gives the sign-in command with the profile's login dir only", () => {
    const second = { ...AGENT_TEMPLATES.claude, env: { CLAUDE_CONFIG_DIR: "~/.claude-2", ANTHROPIC_API_KEY: "never-shown" } };
    assert.equal(loginCommand(second), "CLAUDE_CONFIG_DIR=~/.claude-2 claude auth login");
    assert.equal(loginCommand({ ...AGENT_TEMPLATES.codex, env: { CODEX_HOME: "~/.codex-2" } }), "CODEX_HOME=~/.codex-2 codex login");
    assert.equal(loginCommand(AGENT_TEMPLATES.gemini), null);
  });

  it("keeps the last check of each enabled profile and forgets removed ones", async () => {
    let profiles = [
      { ...AGENT_TEMPLATES.codex, bin: process.execPath },
      { ...AGENT_TEMPLATES.claude, id: "claude-off", bin: process.execPath, enabled: false },
    ];
    const run = async () => ({ code: 0, output: "Logged in using ChatGPT" });
    const logins = new LoginMonitor(() => profiles, () => ({ PATH: path.dirname(process.execPath) }), run);
    await logins.refresh();
    assert.deepEqual([logins.get("codex-1")?.loggedIn, logins.get("claude-off")], [true, undefined]);
    profiles = [];
    await logins.refresh();
    assert.equal(logins.get("codex-1"), undefined);
  });

  it("asks the CLI with the profile's env, and skips CLIs that are missing or have no status command", async () => {
    const seen: Array<{ args: string[]; dir: string | undefined }> = [];
    const run = async (_bin: string, args: string[], env: NodeJS.ProcessEnv) => {
      seen.push({ args, dir: env.CLAUDE_CONFIG_DIR });
      return { code: 0, output: '{"loggedIn":false}' };
    };
    const env = { PATH: path.dirname(process.execPath) };
    const p = { ...AGENT_TEMPLATES.claude, bin: process.execPath, env: { CLAUDE_CONFIG_DIR: "/tmp/claude-2" } };
    assert.equal((await checkLogin(p, env, now, run)).loggedIn, false);
    assert.deepEqual(seen, [{ args: ["auth", "status", "--json"], dir: "/tmp/claude-2" }]);
    assert.equal((await checkLogin({ ...p, bin: "/nonexistent/claude" }, env, now, run)).loggedIn, null);
    assert.equal((await checkLogin({ ...AGENT_TEMPLATES.gemini, bin: process.execPath }, env, now, run)).loggedIn, null);
    assert.equal(seen.length, 1);
  });
});

describe("run usage", () => {
  it("reads Claude Code's JSON result: final message, cost and tokens", () => {
    const line = JSON.stringify({ type: "result", result: "Done.", total_cost_usd: 0.31, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 42 } });
    assert.deepEqual(parseClaudeResult(`warming up\n${line}\n`), { text: "Done.", costUsd: 0.31, inputTokens: 100, outputTokens: 42 });
    assert.deepEqual(parseClaudeResult(JSON.stringify({ type: "result", result: "x" })), { text: "x", costUsd: null, inputTokens: null, outputTokens: null });
    assert.equal(parseClaudeResult('{"type":"system"}\nplain text'), null);
    assert.equal(parseClaudeResult('{"type":"result", cut off'), null);
  });

  it("asks Claude Code for JSON unless the profile picked a format", () => {
    const vars = { prompt: "Do T-1", worktree: "/wt", task: "T-1", project: "demo", branch: "ai/T-1" };
    const json = buildCommand(AGENT_TEMPLATES.claude, vars);
    assert.equal(json.claudeJson, true);
    assert.deepEqual(json.args.slice(4, 6), ["--output-format", "json"], "before the MCP flags, which take several values");
    const text = buildCommand({ ...AGENT_TEMPLATES.claude, args: [...AGENT_TEMPLATES.claude.args, "--output-format=text"] }, vars);
    assert.equal(text.claudeJson, undefined);
    assert.equal(outputFormat(text.args), "text");
    assert.equal(buildCommand(AGENT_TEMPLATES.codex, vars).claudeJson, undefined);
  });
});

describe("buildCommand", () => {
  const vars = { prompt: "Do T-1", worktree: "/wt", task: "T-1", project: "demo", branch: "ai/T-1" };
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;

  it("starts Claude Code with the user's settings only, no hooks, and the app's MCP servers", () => {
    const { args } = buildCommand(AGENT_TEMPLATES.claude, vars);
    assert.deepEqual(args.slice(0, 4), ["-p", "Do T-1", "--permission-mode", "acceptEdits"]);
    assert.deepEqual(JSON.parse(flag(args, "--settings")), { disableAllHooks: true });
    assert.equal(flag(args, "--setting-sources"), "user");
    // Project settings stay off, but the worktree's CLAUDE.md (and @AGENTS.md) still loads.
    assert.equal(flag(args, "--add-dir"), "/wt");
    assert.deepEqual(buildCommand(AGENT_TEMPLATES.claude, vars).env, { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
    assert.equal(buildCommand(AGENT_TEMPLATES.codex, vars).env, undefined);
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args.at(-2), "--mcp-config", "last, since it takes several values");
    assert.deepEqual(JSON.parse(args.at(-1)!), {
      mcpServers: { "xdev-hive": { command: "hive-mcp", args: [], env: { HIVE_AGENT: "claude-1", HIVE_PROJECT: "demo", HIVE_TASK: "T-1" } } },
    });
  });

  it("adds codegraph and superpowers only when setup turned them on for the repo", () => {
    const { args } = buildCommand(AGENT_TEMPLATES.claude, vars, { codegraph: true, superpowers: true });
    assert.deepEqual(JSON.parse(args.at(-1)!).mcpServers.codegraph, CODEGRAPH_MCP);
    assert.deepEqual(JSON.parse(flag(args, "--settings")), { disableAllHooks: true, enabledPlugins: { [SUPERPOWERS_PLUGIN]: true } });
  });

  it("tells a read-only profile's MCP server so, and drops the write steps from the prompt", () => {
    const { args } = buildCommand({ ...AGENT_TEMPLATES.claude, readOnly: true }, vars);
    assert.equal(JSON.parse(args.at(-1)!).mcpServers["xdev-hive"].env.HIVE_READONLY, "1");
    assert.equal(JSON.parse(buildCommand(AGENT_TEMPLATES.claude, vars).args.at(-1)!).mcpServers["xdev-hive"].env.HIVE_READONLY, undefined);
  });

  it("leaves other CLIs' arguments as the profile has them", () => {
    assert.deepEqual(buildCommand(AGENT_TEMPLATES.codex, vars).args, ["exec", "--full-auto", "Do T-1"]);
    assert.deepEqual(buildCommand({ ...AGENT_TEMPLATES.claude, kind: "custom" }, vars).args, ["-p", "Do T-1", "--permission-mode", "acceptEdits"]);
  });
});

describe("Runner", () => {
  it("runs an agent in its own worktree, commits leftovers and moves the task to review", async () => {
    const { repo, runner, calls, task, dataDir } = await setup([profile("claude-a", "claude", 10, "ok")]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    assert.equal(run.taskTitle, "Thêm trang cài đặt");
    await runner.settle();

    const done = runner.store.get(run.id)!;
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.equal(done.profileId, "claude-a");
    assert.equal(done.commits, 1);
    assert.equal(done.worktree, path.join(dataDir, "worktrees", "demo", "T-1"));
    assert.match(git(repo, "show", "--name-only", "--format=%s", "ai/T-1"), /ai\(T-1\): work by claude-a\n+work-claude-a\.txt/);
    assert.equal(git(repo, "status", "--porcelain"), "", "main checkout untouched");

    const [call] = calls();
    assert.equal(call!.agent, "claude-a");
    assert.match(call!.prompt, /task T-1 of project "demo"/);
    assert.match(call!.prompt, /Thêm trang cài đặt/);

    const t = await task();
    assert.equal(t.status, "review");
    assert.equal(t.owner, null);
    assert.match(t.note ?? "", /Implemented T-1/);
    assert.match(t.note ?? "", /Branch ai\/T-1, 1 commit/);
    // Claude Code runs print one JSON result; the log adds its message and the cost after it.
    assert.match(runner.log(run.id), /## Prompt[\s\S]*## Output\n\{"type":"result"[\s\S]*## Result\nImplemented T-1\. Tests pass\.\n# cost \$0\.0425 · tokens in 6000 out 850/);
    assert.equal(done.summary, "Implemented T-1. Tests pass.", "the final message, not the raw JSON");
    assert.deepEqual([done.costUsd, done.inputTokens, done.outputTokens], [0.0425, 6000, 850]);
    assert.equal(runner.profileStatuses()[0]!.stats.costUsd, 0.0425);
  });

  it("gives Claude Code the app's MCP entries for what the repo set up, whatever the working copy says", async () => {
    const { repo, runner, calls } = await setup([profile("claude-a", "claude", 10, "ok")]);
    mkdirSync(path.join(repo, ".claude"));
    writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { codegraph: { command: "evil" }, other: { command: "evil" } } }));
    writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [SUPERPOWERS_PLUGIN]: true } }));
    await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const { args } = calls()[0]!;
    assert.deepEqual(Object.keys(JSON.parse(args.at(-1)!).mcpServers), ["xdev-hive", "codegraph"]);
    assert.deepEqual(JSON.parse(args.at(-1)!).mcpServers.codegraph, CODEGRAPH_MCP);
    const env = JSON.parse(args.at(-1)!).mcpServers["xdev-hive"].env;
    assert.equal(env.HIVE_AGENT, "claude-a");
    assert.deepEqual([env.HIVE_TASK, env.HIVE_RUN], ["T-1", runner.list()[0]!.id], "so the agent's writes carry its task and run");
    assert.match(calls()[0]!.prompt, /Read AGENTS\.md in the working copy first/);
  });

  it("runs no git hook the agent left in the working copy, and keeps rendered docs out of its commit", async () => {
    const mark = path.join(tmp("mark"), "hook-ran");
    const { repo, runner, dataDir } = await setup([profile("codex-a", "codex", 10, "plant", { env: { FAKE_MODE: "plant", FAKE_MARK: mark } })]);
    writeFileSync(path.join(repo, "AGENTS.md"), "# demo\n");
    git(repo, "add", "AGENTS.md");
    git(repo, "commit", "-qm", "docs");
    git(repo, "config", "core.hooksPath", ".githooks");
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();

    const done = runner.store.get(run.id)!;
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.equal(done.error, null);
    assert.equal(existsSync(mark), false, "the planted pre-commit hook must not run");
    assert.deepEqual(git(repo, "show", "--name-only", "--format=", "ai/T-1").split("\n").sort(), [".githooks/pre-commit", "work.txt"]);
    assert.equal(git(path.join(dataDir, "worktrees", "demo", "T-1"), "status", "--porcelain"), "M AGENTS.md");
  });

  it("runs a read-only profile with HIVE_READONLY and a prompt without Hive writes, then reports for it", async () => {
    const { runner, calls, task } = await setup([profile("codex-a", "codex", 10, "ok", { readOnly: true })]);
    await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const [call] = calls();
    assert.equal(call!.readOnly, "1");
    assert.match(call!.prompt, /xDev Hive is read-only for this run/);
    assert.doesNotMatch(call!.prompt, /memory_write|task_update|doc_propose/);
    const t = await task();
    assert.equal(t.status, "review", "the runner still moves the task");
    assert.match(t.note ?? "", /Implemented T-1/);
  });

  it("skips a signed-out subscription, shows it, and says why a run waits when none is signed in", async () => {
    const signedOut = { loggedIn: false, method: null, loginCommand: "claude auth login", checkedAt: "2026-09-28T04:00:00.000Z" };
    const login = (id: string) => (id === "claude-a" ? signedOut : undefined);
    const { runner } = await setup([profile("claude-a", "claude", 1, "ok"), profile("claude-b", "claude", 10, "ok")], {}, "local", { login });
    assert.deepEqual(runner.profileStatuses().find((p) => p.id === "claude-a")!.login, signedOut);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    assert.equal(runner.store.get(run.id)!.profileId, "claude-b", "claude-a has the better priority but is signed out");

    const none = await setup([profile("claude-a", "claude", 1, "ok")], {}, "local", { login });
    const waiting = await none.runner.enqueue({ project: "demo", taskId: "T-1" });
    await none.runner.settle();
    assert.equal(none.runner.store.get(waiting.id)!.status, "queued");
    assert.match(none.runner.list()[0]!.error ?? "", /Chưa gói phù hợp nào đăng nhập CLI \(claude-a\)/);
    none.runner.cancel(waiting.id);
  });

  it("rotates to the next subscription when one hits its quota, continuing on the same branch", async () => {
    const { runner, calls, task, repo } = await setup([profile("claude-a", "claude", 10, "limit"), profile("codex-a", "codex", 20, "ok")]);
    const first = await runner.enqueue({ project: "demo", taskId: "T-1" });
    const before = Date.now();
    await runner.settle();

    const limited = runner.store.get(first.id)!;
    assert.equal(limited.status, "rate_limited");
    assert.match(limited.error ?? "", /usage limit/);
    const claude = runner.profileStatuses().find((p) => p.id === "claude-a")!;
    const rest = new Date(claude.cooldownUntil!).getTime() - before;
    assert.ok(rest > 2 * 3600_000 && rest < 2.5 * 3600_000, `cooldown ${rest}ms`);
    assert.equal(claude.stats.rateLimited, 1);

    const second = runner.list().find((r) => r.parentRunId === first.id)!;
    assert.equal(second.status, "succeeded");
    assert.equal(second.profileId, "codex-a");
    assert.equal(second.attempt, 2);
    assert.match(calls()[1]!.prompt, /attempt 2\. The previous agent \(claude-a\) stopped/);
    assert.match(git(repo, "log", "--format=%s", "ai/T-1"), /work by codex-a\nai\(T-1\): wip by claude-a/);
    assert.equal((await task()).status, "review");
  });

  it("queues a cross-review on another vendor after success", async () => {
    const { runner, task } = await setup([profile("claude-a", "claude", 10, "ok"), profile("codex-a", "codex", 50, "review")]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1", reviewAfter: true });
    await runner.settle();
    const review = runner.list().find((r) => r.parentRunId === run.id)!;
    assert.equal(review.role, "review");
    assert.equal(review.profileId, "codex-a", "review goes to a different vendor despite lower priority");
    assert.equal(review.status, "succeeded");
    const t = await task();
    assert.equal(t.status, "review");
    assert.match(t.note ?? "", /Implemented T-1[\s\S]*Review \(Run R-\w+ · codex-a\):\nVerdict: approve/);
  });

  it("skips a profile whose CLI is not installed, and says so when none is", async () => {
    const { runner } = await setup([
      profile("gemini-a", "gemini", 1, "ok", { bin: "/nonexistent/gemini" }),
      profile("claude-a", "claude", 10, "ok"),
    ]);
    const statuses = runner.profileStatuses();
    assert.equal(statuses.find((p) => p.id === "gemini-a")!.cliPath, null);
    assert.equal(statuses.find((p) => p.id === "claude-a")!.cliPath, process.execPath);

    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const done = runner.store.get(run.id)!;
    assert.equal(done.status, "succeeded");
    assert.equal(done.profileId, "claude-a", "gemini-a has a better priority but no CLI");
    assert.equal(runner.profileStatuses().find((p) => p.id === "gemini-a")!.cooldownUntil, null);

    const none = await setup([profile("gemini-a", "gemini", 1, "ok", { bin: "/nonexistent/gemini" })]);
    const waiting = await none.runner.enqueue({ project: "demo", taskId: "T-1" });
    await none.runner.settle();
    assert.equal(none.runner.store.get(waiting.id)!.status, "queued");
    assert.match(none.runner.list()[0]!.error ?? "", /chưa cài CLI cho gói phù hợp \(\/nonexistent\/gemini\)/);
    none.runner.cancel(waiting.id);
  });

  it("cancels a running agent and gives the task back", async () => {
    const { runner, task } = await setup([profile("claude-a", "claude", 10, "sleep")]);
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await until(() => runner.log(run.id).includes("thinking"));
    assert.equal((await task()).status, "doing");
    runner.cancel(run.id);
    await runner.settle();
    assert.equal(runner.store.get(run.id)!.status, "cancelled");
    const t = await task();
    assert.equal(t.status, "todo");
    assert.equal(t.owner, null);
  });

  it("reports back to a hub that renames actors", async () => {
    const { runner, task } = await setup([profile("claude-a", "claude", 10, "ok")], {}, "hub");
    await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    const t = await task();
    assert.equal(t.status, "review");
    assert.match(t.note ?? "", /Implemented T-1/);
  });

  it("keeps two machines on one hub token from taking the same task", async () => {
    const a = await setup([profile("claude-1", "claude", 10, "sleep")], {}, "hub", { name: "duy-mbp" });
    const b = await setup([profile("claude-1", "claude", 10, "ok")], {}, "hub", { name: "duy-imac", hive: a.hive });
    const first = await a.runner.enqueue({ project: "demo", taskId: "T-1" });
    await until(() => a.runner.log(first.id).includes("thinking"));
    assert.equal((await a.task()).owner, "claude-1.duy-mbp@duy-macbook");

    const second = await b.runner.enqueue({ project: "demo", taskId: "T-1" });
    await b.runner.settle();
    const blocked = b.runner.store.get(second.id)!;
    assert.equal(blocked.status, "failed");
    assert.match(blocked.error ?? "", /claude-1\.duy-mbp@duy-macbook/);
    assert.equal(b.calls().length, 0, "the second machine never starts the agent");

    a.runner.cancel(first.id);
    await a.runner.settle();
    assert.equal((await a.task()).owner, null);
  });

  it("sends each finished run's cost to the hub once, after the hub answered", async () => {
    const { runner, hive } = await setup([profile("claude-a", "claude", 10, "ok", { account: "claude-max-duy" })], {}, "hub");
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    assert.equal(runner.store.unreportedCosts().map((r) => r.id).join(), run.id);
    await runner.heartbeat();
    assert.deepEqual(runner.store.unreportedCosts(), []);
    await runner.heartbeat();
    const s = await hive.call("costs.summary", {}, admin);
    assert.deepEqual(s.total, { usd1: 0.0425, usd7: 0.0425, usd30: 0.0425, runs30: 1 });
    assert.deepEqual(s.profiles.map((p) => [p.machine, p.profileId, p.account]), [["duy-mbp", "claude-a", "claude-max-duy"]]);
  });

  it("reports queued and running runs to the hub in its heartbeat", async () => {
    const a = await setup([profile("claude-1", "claude", 10, "sleep")], {}, "hub", { name: "duy-mbp" });
    const run = await a.runner.enqueue({ project: "demo", taskId: "T-1" });
    await until(() => a.runner.log(run.id).includes("thinking"));
    assert.equal((await a.runner.heartbeat())?.duplicate, false);
    const [m] = await a.hive.call("machines.list", {}, admin);
    assert.equal(m!.id, "runner.duy-mbp@duy-macbook");
    assert.deepEqual(m!.runs.map((r) => [r.taskId, r.status, r.profileId]), [["T-1", "running", "claude-1"]]);

    a.runner.cancel(run.id);
    await a.runner.settle();
    await a.runner.heartbeat();
    assert.deepEqual((await a.hive.call("machines.list", {}, admin))[0]!.runs, []);

    const local = await setup([profile("claude-1", "claude", 10, "ok")]);
    assert.equal(await local.runner.heartbeat(), null, "local mode has no hub to report to");
  });

  it("carries the setup report to the hub, gets an admin's request back, and reports how it went", async () => {
    const report = {
      machine: [{ id: "cli:codex", label: "Codex CLI", state: "missing" as const, detail: "Chưa cài", action: "Cài bằng npm" }],
      projects: [],
    };
    const a = await setup([profile("claude-1", "claude", 10, "ok", { account: "claude-max-duy" })], {}, "hub", {
      name: "duy-mbp",
      report: () => ({ setup: { checkedAt: "2026-09-27T08:00:00.000Z", report }, profiles: [] }),
    });
    await a.runner.heartbeat();
    const machineId = "runner.duy-mbp@duy-macbook";
    const [m] = await a.hive.call("admin.machines", {}, admin);
    assert.equal(m!.id, machineId);
    assert.deepEqual(m!.setup, report);

    const cmd = await a.hive.call("admin.commandCreate", { machineId, itemId: "cli:codex" }, admin);
    const update = await a.runner.heartbeat();
    assert.deepEqual(update?.commands.map((c) => c.id), [cmd.id]);
    assert.equal(a.hubUpdates.at(-1)?.commands[0]?.label, "Cài bằng npm: Codex CLI");

    await a.runner.reportCommand(cmd.id, "running");
    const done = await a.runner.reportCommand(cmd.id, "done", "added 1 package");
    assert.equal(done.status, "done");
    assert.deepEqual((await a.runner.heartbeat())?.commands, []);
  });

  it("shares a quota cooldown with every machine on the same account, and ends it everywhere", async () => {
    const account = { account: "claude-max-duy" };
    const a = await setup([profile("claude-1", "claude", 10, "limit", account), profile("codex-1", "codex", 20, "ok")], {}, "hub", { name: "duy-mbp" });
    const b = await setup([profile("claude-2", "claude", 10, "ok", account), profile("codex-2", "codex", 20, "ok")], {}, "hub", {
      name: "duy-imac",
      hive: a.hive,
    });
    await a.runner.enqueue({ project: "demo", taskId: "T-1" });
    await a.runner.settle();
    const shared = await a.hive.call("cooldowns.list", {}, admin);
    assert.deepEqual(shared.map((c) => [c.account, c.reportedBy]), [["claude-max-duy", "runner.duy-mbp@duy-macbook"]]);

    await b.hive.call("tasks.create", { id: "T-2", project: "demo", title: "Sửa lỗi đăng nhập" }, admin);
    await b.runner.heartbeat();
    assert.equal(b.runner.profileStatuses().find((p) => p.id === "claude-2")!.cooldownFrom, "runner.duy-mbp@duy-macbook");
    const run = await b.runner.enqueue({ project: "demo", taskId: "T-2" });
    await b.runner.settle();
    assert.equal(b.runner.store.get(run.id)!.profileId, "codex-2", "machine B skips the account that ran out on machine A");

    await b.runner.resetCooldown("claude-2");
    assert.deepEqual(await a.hive.call("cooldowns.list", {}, admin), []);
    assert.ok(a.runner.profileStatuses().find((p) => p.id === "claude-1")!.cooldownUntil, "A rests until it hears from the hub");
    await a.runner.heartbeat();
    assert.equal(a.runner.profileStatuses().find((p) => p.id === "claude-1")!.cooldownUntil, null);
  });

  it("keeps a cooldown on this machine when the profile has no account", async () => {
    const a = await setup([profile("claude-1", "claude", 10, "limit"), profile("codex-1", "codex", 20, "ok")], {}, "hub");
    await a.runner.enqueue({ project: "demo", taskId: "T-1" });
    await a.runner.settle();
    assert.ok(a.runner.profileStatuses().find((p) => p.id === "claude-1")!.cooldownUntil);
    assert.deepEqual(await a.hive.call("cooldowns.list", {}, admin), []);
  });

  it("explains why a run waits and refuses duplicates", async () => {
    const { runner } = await setup([profile("claude-a", "claude", 10, "ok")]);
    runner.store.setCooldown("claude-a", "2099-01-01T00:00:00.000Z", "usage limit");
    const run = await runner.enqueue({ project: "demo", taskId: "T-1" });
    await runner.settle();
    assert.match(runner.list()[0]!.error ?? "", /Mọi gói đang nghỉ vì quota/);
    await assert.rejects(runner.enqueue({ project: "demo", taskId: "T-1" }), /đang có run/);
    runner.cancel(run.id);
    assert.equal(runner.store.get(run.id)!.status, "cancelled");
  });
});
